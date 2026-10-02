/**
 * `ai [-n | --dry-run] [--json] "INSTRUCTION"`, `ai log [-n N] [--json] [--all] [TXN]`,
 * `ai undo TXN`, `ai status` (agentic-shell.md §3.3; shell-and-terminal.md §3.14.46).
 *
 * This is the front end only: parsing, `ai log` and `ai status` formatting and the error texts.
 * The plan, dry run, kernel-owned confirmation and batch run in the `ai.agent` process started
 * from the manifest below, whose exit status is passed through.
 * TODO(R4): confirm the agent manifest path and argv contract with ai/src/agent.
 */
import type { AuditRecord } from '@plotinium/protocol';

import { aiError, aiUnavailable } from '../lib/ai.ts';
import { defineCommand, parseFor, UsageError } from '../lib/command.ts';
import { mustErrno } from '../lib/errors.ts';
import { dateTime, table } from '../lib/format.ts';
import type { Io } from '../lib/io.ts';
import { errnoOf, extCall } from '../lib/sys.ts';
import type { CoreExtraCalls, SysGen } from '../lib/sys.ts';
import { loadUsers, userName } from '../lib/users.ts';
import { spawnAndWait } from '../lib/exec.ts';

export const AGENT_MANIFEST = '/bin/lib/ai.agent.json';

/**
 * Where the agent program's manifest may be, in order: the Terminal host's library overlay
 * (`ai.agent`), the name @plotinium/ai registers (`ai-agent`, AGENT_MANIFEST_PATH), and the
 * `/bin` seed of the volume.
 */
export const AGENT_MANIFESTS = [
  AGENT_MANIFEST,
  '/bin/lib/ai-agent.json',
  '/bin/ai-agent.json',
] as const;

/** The `ai.agent` system service as `svc.status` reports it, or null when it cannot be read. */
export interface AgentService {
  readonly state: string;
  readonly lastError?: string;
}

/**
 * Why the agent cannot run, from the service's state (UI-055): the words after
 * `ai: agent unavailable (`.
 */
export function unavailableReason(service: AgentService | null): string {
  if (service !== null && service.state !== 'running') {
    const why =
      service.lastError === undefined || service.lastError === '' ? '' : `: ${service.lastError}`;
    return `ai.agent is ${service.state}${why}`;
  }
  return 'the agent program is not installed in this terminal';
}

function* agentService(io: Io): SysGen<AgentService | null> {
  try {
    const { services } = yield* io.sys.call('svc.status', {});
    const svc = services.find((s) => s.name === 'ai.agent');
    if (svc === undefined) return null;
    return svc.lastError === undefined
      ? { state: svc.state }
      : { state: svc.state, lastError: svc.lastError };
  } catch (e) {
    mustErrno(e);
    return null;
  }
}

/** The first agent manifest that exists, or null. */
function* findAgent(io: Io): SysGen<string | null> {
  for (const path of AGENT_MANIFESTS) {
    try {
      yield* io.sys.call('stat', { path });
      return path;
    } catch (e) {
      mustErrno(e);
    }
  }
  return null;
}

/** agentic-shell.md §3.3 exit statuses. */
export const EXIT = { ok: 0, declined: 1, failed: 2, clarify: 3, unavailable: 4 } as const;

export type AiOpts =
  | {
      readonly sub: 'run';
      readonly instruction: string;
      readonly dryRun: boolean;
      readonly json: boolean;
    }
  | {
      readonly sub: 'log';
      readonly limit: number;
      readonly json: boolean;
      readonly all: boolean;
      readonly id: string | null;
    }
  | { readonly sub: 'undo'; readonly txn: string }
  | { readonly sub: 'status' };

export function parseAi(args: readonly string[]): AiOpts {
  const first = args.find((a) => !a.startsWith('-'));
  if (first === 'log' && args[0] === 'log') {
    const p = parseFor('ai', args.slice(1));
    if (p.has('dry-run')) throw new UsageError("log: unrecognized option '--dry-run'");
    const limit = Number(p.value('n') ?? '20');
    if (!Number.isInteger(limit) || limit < 1 || limit > 200)
      throw new UsageError(`log: invalid count '${p.value('n') ?? ''}'`);
    if (p.operands.length > 1) throw new UsageError(`log: extra operand '${p.operands[1] ?? ''}'`);
    return { sub: 'log', limit, json: p.has('json'), all: p.has('all'), id: p.operands[0] ?? null };
  }
  if (args[0] === 'undo') {
    if (args.length !== 2) throw new UsageError('undo: expected one TXN');
    return { sub: 'undo', txn: args[1] ?? '' };
  }
  if (args[0] === 'status') {
    if (args.length !== 1) throw new UsageError(`status: extra operand '${args[1] ?? ''}'`);
    return { sub: 'status' };
  }
  let dryRun = false;
  let json = false;
  const words: string[] = [];
  let options = true;
  for (const a of args) {
    if (options && a === '--') options = false;
    else if (options && (a === '-n' || a === '--dry-run')) dryRun = true;
    else if (options && a === '--json') json = true;
    else if (options && a.startsWith('-') && a.length > 1)
      throw new UsageError(
        a.startsWith('--') ? `unrecognized option '${a}'` : `invalid option -- '${a.slice(1, 2)}'`,
      );
    else words.push(a);
  }
  if (words.length === 0) throw new UsageError('missing instruction');
  if (words.length > 1) throw new UsageError('the instruction is one argument; quote it');
  return { sub: 'run', instruction: words[0] ?? '', dryRun, json };
}

function short(id: string | undefined): string {
  return id === undefined ? '-' : id.replace(/-/g, '').slice(0, 8);
}

function prompt(r: AuditRecord): string {
  const text = r.request ?? (r.errno === undefined ? r.call : `${r.errno} ${r.argsSummary}`);
  return [...text].length > 45 ? `${[...text].slice(0, 45).join('')}…` : text;
}

export function logTable(records: readonly AuditRecord[], tz: number): string[] {
  return table(
    [
      ['TXN', 'WHEN', 'OUTCOME', 'STEPS', 'INODES', 'PROMPT'],
      ...records.map((r) => [
        short(r.txnId ?? r.promptId),
        dateTime(r.t, tz),
        r.outcome,
        '-',
        r.inodes === undefined ? '-' : String(r.inodes),
        prompt(r),
      ]),
    ],
    new Set(),
    2,
  );
}

export function recordLines(r: AuditRecord, tz: number): string[] {
  const rows: [string, string | undefined][] = [
    ['txn', r.txnId],
    ['prompt id', r.promptId],
    ['when', dateTime(r.t, tz)],
    ['user', String(r.uid)],
    ['request', r.request],
    ['call', r.call],
    ['plan', r.planHash],
    ['dry run', r.dryRunHash],
    ['confirmation', r.confirmation],
    ['outcome', r.outcome],
    ['errno', r.errno],
    ['inodes', r.inodes === undefined ? undefined : String(r.inodes)],
    ['undo', r.undoId],
  ];
  return rows
    .filter((row): row is [string, string] => row[1] !== undefined)
    .map(([k, v]) => `${`${k}:`.padEnd(14)}${v}`);
}

function matchesId(r: AuditRecord, id: string): boolean {
  const want = id.replace(/-/g, '');
  return [r.txnId, r.promptId, r.auditId].some(
    (x) => x !== undefined && x.replace(/-/g, '').startsWith(want),
  );
}

/** The agent never runs as root; from an `su` shell it drops to the login user (AGT-04). */
function* checkRoot(io: Io): SysGen<number | null> {
  const cred = yield* io.sys.call('proc.cred', {});
  if (cred.ruid === 0) {
    yield* io.error(
      'the agent never runs as root (§3.4); log in as a regular user and use su for elevation',
    );
    return EXIT.failed;
  }
  if (cred.uid === 0) {
    const name = userName(yield* loadUsers(io.sys), cred.ruid);
    yield* io.error(`running as ${name} (login user), not root`);
  }
  return null;
}

function* unavailable(io: Io): SysGen<number> {
  const reason = unavailableReason(yield* agentService(io));
  yield* io.error(`agent unavailable (${reason}) — nothing was run`);
  return EXIT.unavailable;
}

function* runAgent(io: Io, argv: readonly string[]): SysGen<number> {
  const refused = yield* checkRoot(io);
  if (refused !== null) return refused;
  const manifest = yield* findAgent(io);
  if (manifest === null) return yield* unavailable(io);
  try {
    return yield* spawnAndWait(io, manifest, argv);
  } catch (e) {
    // The manifest is there but no program behind it can start here (ENOENT from `spawn`).
    const errno = errnoOf(e);
    if (errno === 'ENOENT' || errno === 'ENOSYS') return yield* unavailable(io);
    throw e;
  }
}

/** `ai status` when the kernel has no `ai.status` call yet: what the service table says. */
function* statusFromServices(io: Io): SysGen<number> {
  const service = yield* agentService(io);
  const runnable = (yield* findAgent(io)) !== null;
  const agent =
    service === null
      ? 'unknown'
      : `${service.state}${service.lastError === undefined || service.lastError === '' ? '' : ` (${service.lastError})`}`;
  yield* io.lines([
    `agent: ai.agent ${agent}${runnable ? '' : ' · not installed in this terminal'}`,
    'gateway: not reported (ai.status is not available yet)',
  ]);
  return service?.state === 'running' && runnable ? 0 : EXIT.unavailable;
}

function* log(io: Io, opts: Extract<AiOpts, { sub: 'log' }>): SysGen<number> {
  const res = yield* io.sys.call('ai.agent.log', { limit: opts.id === null ? opts.limit : 200 });
  const records =
    opts.id === null ? res.records : res.records.filter((r) => matchesId(r, opts.id ?? ''));
  const tz = yield* io.tzOffset();
  if (opts.json) {
    yield* io.lines(records.map((r) => JSON.stringify(r)));
    return 0;
  }
  if (opts.id !== null) {
    const record = records[0];
    if (record === undefined) {
      yield* io.error(`log: no record ${opts.id}`);
      return 1;
    }
    yield* io.lines(recordLines(record, tz));
    return 0;
  }
  yield* io.lines(logTable(records, tz));
  return 0;
}

export default defineCommand<AiOpts>({
  name: 'ai',
  parse: parseAi,
  *run(io, opts) {
    try {
      switch (opts.sub) {
        case 'run':
          return yield* runAgent(io, [
            'ai',
            ...(opts.dryRun ? ['--dry-run'] : []),
            ...(opts.json ? ['--json'] : []),
            opts.instruction,
          ]);
        case 'undo':
          return yield* runAgent(io, ['ai', 'undo', opts.txn]);
        case 'log':
          return yield* log(io, opts);
        case 'status': {
          let s: CoreExtraCalls['ai.status']['ret'];
          try {
            s = yield* extCall(io.sys, 'ai.status', {});
          } catch (e) {
            if (errnoOf(e) === 'ENOSYS') return yield* statusFromServices(io);
            throw e;
          }
          yield* io.lines([
            `gateway: ${s.gateway}`,
            `model: ${s.model ?? '-'}`,
            `budget left: ${s.budgetLeft ?? '-'}`,
          ]);
          return 0;
        }
      }
    } catch (e) {
      yield* io.error(aiError(e));
      return aiUnavailable(e) === null ? EXIT.failed : EXIT.unavailable;
    }
  },
});
