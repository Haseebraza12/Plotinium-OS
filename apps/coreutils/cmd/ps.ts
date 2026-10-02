/**
 * `ps [-e | -A] [-f] [-l] [-u USER] [-p PID] [-t TTY] [-o FIELD] [--sort [-]FIELD] [--no-headers]
 * [--json]` (processes-and-scheduling.md §3.18.2; shell-and-terminal.md §3.14.22). Rows come from
 * `proc.list` in pages of 1,024.
 */
import { defineCommand, parseFor } from '../lib/command.ts';
import { describe } from '../lib/errors.ts';
import { escapeName } from '../lib/format.ts';
import type { FieldEnv, ProcRow, SortKey } from '../lib/procs.ts';
import { fieldName, listProcs, renderTable, sortRows } from '../lib/procs.ts';
import { findUid, loadUsers } from '../lib/users.ts';

export interface PsOpts {
  readonly all: boolean;
  readonly fields: readonly string[];
  readonly users: readonly string[];
  readonly pids: readonly number[];
  readonly ttys: readonly number[];
  readonly sort: readonly SortKey[];
  readonly headers: boolean;
  readonly json: boolean;
  /** An unknown field or a bad value, printed with status 2. */
  readonly problem: string | null;
}

export const DEFAULT_FIELDS = ['pid', 'tty', 'stat', 'time', 'comm'] as const;
export const FULL_FIELDS = [
  'uid',
  'pid',
  'ppid',
  'pgid',
  'sid',
  'pri',
  'ni',
  'cls',
  'stat',
  'pcpu',
  'rss',
  'swap',
  'tty',
  'time',
  'args',
] as const;
export const LONG_FIELDS = [
  'stat',
  'uid',
  'pid',
  'ppid',
  'cls',
  'pri',
  'ni',
  'eprio',
  'rss',
  'swap',
  'wchan',
  'tty',
  'time',
  'args',
] as const;

const list = (values: readonly string[]): string[] =>
  values.flatMap((v) => v.split(',')).filter((v) => v.length > 0);

/** `-pcpu,+pid` → sort keys; undefined names are reported by the caller. */
export function sortKeys(spec: readonly string[]): { keys: SortKey[]; unknown: string | null } {
  const keys: SortKey[] = [];
  for (const item of list(spec)) {
    const desc = item.startsWith('-');
    const name = item.replace(/^[+-]/, '');
    const field = fieldName(name);
    if (field === undefined) return { keys, unknown: name };
    keys.push({ field, desc });
  }
  return { keys, unknown: null };
}

export function parsePs(args: readonly string[]): PsOpts {
  const p = parseFor('ps', args);
  const problem = (message: string): PsOpts => ({
    all: false,
    fields: [],
    users: [],
    pids: [],
    ttys: [],
    sort: [],
    headers: true,
    json: false,
    problem: message,
  });
  if (p.operands.length > 0) return problem(`garbage option '${p.operands[0] ?? ''}'`);
  const requested = list(p.values('o'));
  const fields: string[] = [];
  for (const name of requested) {
    const field = fieldName(name);
    if (field === undefined) return problem(`unknown field '${name}'`);
    fields.push(field);
  }
  const sort = sortKeys(p.values('sort'));
  if (sort.unknown !== null) return problem(`unknown field '${sort.unknown}'`);
  const pids = list(p.values('p')).map(Number);
  if (pids.some((n) => !Number.isInteger(n) || n < 1))
    return problem('process ID list syntax error');
  const ttys = list(p.values('t')).map((t) => Number(t.replace(/^tty/, '')));
  if (ttys.some((n) => !Number.isInteger(n) || n < 1)) return problem('TTY list syntax error');
  const format =
    requested.length > 0
      ? fields
      : p.has('l')
        ? [...LONG_FIELDS]
        : p.has('f')
          ? [...FULL_FIELDS]
          : [...DEFAULT_FIELDS];
  return {
    all: p.has('e') || p.has('A'),
    fields: format,
    users: list(p.values('u')),
    pids,
    ttys,
    sort: sort.keys,
    headers: !p.has('no-headers'),
    json: p.has('json'),
    problem: null,
  };
}

interface Caller {
  readonly uid: number;
  readonly sid: number;
  readonly tty: number | null;
}

/**
 * Selection (§3.18.2): options select the union of their matches; with none, the caller's
 * processes on the caller's terminal. Rows without a TTY field fall back to uid and session.
 */
export function select(
  rows: readonly ProcRow[],
  opts: PsOpts,
  uids: readonly number[],
  me: Caller,
): ProcRow[] {
  if (opts.all) return [...rows];
  const filtered = uids.length > 0 || opts.pids.length > 0 || opts.ttys.length > 0;
  return rows.filter((r) => {
    if (filtered) {
      return (
        uids.includes(r.uid) ||
        opts.pids.includes(r.pid) ||
        (r.tty != null && opts.ttys.includes(r.tty))
      );
    }
    if (r.tty !== undefined) return me.tty !== null && r.tty === me.tty && r.uid === me.uid;
    return r.uid === me.uid && (r.sid === undefined || r.sid === me.sid);
  });
}

export default defineCommand<PsOpts>({
  name: 'ps',
  parse: parsePs,
  *run(io, opts) {
    if (opts.problem !== null) {
      yield* io.error(opts.problem);
      return 2;
    }
    const uids: number[] = [];
    if (opts.users.length > 0) {
      const db = yield* loadUsers(io.sys);
      const missing = opts.users.find((u) => findUid(db, u) === undefined);
      if (missing !== undefined) {
        yield* io.error(`no such user '${missing}'`);
        return 1;
      }
      uids.push(...opts.users.map((u) => findUid(db, u) ?? -1));
    }
    let rows: ProcRow[];
    try {
      rows = yield* listProcs(io.sys);
    } catch (e) {
      yield* io.error(describe(e));
      return 1;
    }
    const env: FieldEnv = { now: yield* io.wallClock(), tz: yield* io.tzOffset() };
    const selected = select(rows, opts, uids, {
      uid: io.ctx.uid,
      sid: io.ctx.sid,
      tty: io.ctx.tty,
    });
    sortRows(selected, opts.sort, env);
    // A selection that matched nothing (`ps -p 99999`) ends with status 1, as in procps.
    const selecting = opts.users.length > 0 || opts.pids.length > 0 || opts.ttys.length > 0;
    const status = selecting && selected.length === 0 ? 1 : 0;
    if (opts.json) {
      yield* io.line(JSON.stringify(selected));
      return status;
    }
    const tty = yield* io.isTty(1);
    const lines = renderTable(selected, opts.fields, env, { headers: opts.headers });
    yield* io.lines(lines.map((l) => escapeName(l, tty)));
    return status;
  },
});
