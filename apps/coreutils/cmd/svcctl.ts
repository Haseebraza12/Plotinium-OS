/**
 * `svcctl status [NAME] | graph | verify | retry NAME | start|stop|restart NAME |
 * require NAME DEP... [--force] | unrequire NAME DEP... | restore-defaults`
 * (shell-and-terminal.md §3.14.49, boot-and-services.md §4.7). Manifests are edited through the
 * VFS with an `expectedVersion` write and take effect at the next boot. Cycle detection is the
 * kernel's (`svc.verify`); this command never evaluates the service graph itself.
 */
import { defineCommand, parseFor, UsageError } from '../lib/command.ts';
import { describe, mustErrno } from '../lib/errors.ts';
import { table } from '../lib/format.ts';
import type { Io } from '../lib/io.ts';
import { decodeText, encodeText, extCall } from '../lib/sys.ts';
import type { SysGen } from '../lib/sys.ts';

type Sub =
  | 'status'
  | 'graph'
  | 'verify'
  | 'retry'
  | 'start'
  | 'stop'
  | 'restart'
  | 'require'
  | 'unrequire'
  | 'restore-defaults';

export interface SvcctlOpts {
  readonly sub: Sub;
  readonly name: string | null;
  readonly deps: readonly string[];
  readonly force: boolean;
}

const SUBS: readonly Sub[] = [
  'status',
  'graph',
  'verify',
  'retry',
  'start',
  'stop',
  'restart',
  'require',
  'unrequire',
  'restore-defaults',
];

export function parseSvcctl(args: readonly string[]): SvcctlOpts {
  const p = parseFor('svcctl', args);
  const [word, name, ...deps] = p.operands;
  const sub = word === 'defaults' ? 'restore-defaults' : word;
  if (sub === undefined) throw new UsageError('missing command');
  if (!(SUBS as readonly string[]).includes(sub)) throw new UsageError(`unknown command '${sub}'`);
  const s = sub as Sub;
  const needsName = s !== 'status' && s !== 'graph' && s !== 'verify' && s !== 'restore-defaults';
  if (needsName && name === undefined) throw new UsageError(`${s}: missing service name`);
  if ((s === 'require' || s === 'unrequire') && deps.length === 0)
    throw new UsageError(`${s}: missing dependency`);
  return { sub: s, name: name ?? null, deps, force: p.has('force') };
}

export interface ServiceRow {
  readonly name: string;
  readonly state: string;
  readonly critical: boolean;
  readonly pid?: number;
  readonly restarts: number;
  readonly level?: number;
  readonly attempts?: number;
  readonly nextRetryAt?: number | null;
}

export function statusLines(rows: readonly ServiceRow[], nowSinceT0: number | null): string[] {
  const next = (r: ServiceRow): string =>
    r.nextRetryAt == null || nowSinceT0 === null
      ? '-'
      : `in ${Math.max(0, Math.ceil((r.nextRetryAt - nowSinceT0) / 1000))} s`;
  return table(
    [
      ['SERVICE', 'LEVEL', 'CRIT', 'STATE', 'ATTEMPTS', 'NEXT RETRY', 'PID'],
      ...rows.map((r) => [
        r.name,
        r.level === undefined ? '-' : String(r.level),
        r.critical ? 'yes' : 'no',
        r.state,
        String(r.attempts ?? r.restarts),
        next(r),
        r.pid === undefined ? '-' : String(r.pid),
      ]),
    ],
    new Set([1, 4, 6]),
    2,
  );
}

export function graphLines(
  levels: readonly (readonly string[])[],
  cycle: readonly string[] | undefined,
): string[] {
  const lines = levels.map((names, i) => `L${i} ${names.join(' ')}`);
  if (cycle !== undefined && cycle.length > 0)
    lines.push(`cycle: ${[...cycle, cycle[0] ?? ''].join(' → ')}`);
  return lines;
}

const manifestPath = (name: string): string => `/system/services/${name}.json`;

function* readManifest(io: Io, name: string): SysGen<{ text: string; version: number }> {
  const { fd, version } = yield* io.sys.call('open', { path: manifestPath(name), flags: 'r' });
  const parts: string[] = [];
  try {
    for (;;) {
      const buf = yield* io.sys.call('read', { fd, len: 65_536 });
      if (buf.byteLength === 0) break;
      parts.push(decodeText(buf));
    }
  } finally {
    yield* io.sys.call('close', { fd });
  }
  return { text: parts.join(''), version };
}

/** The manifest with DEPs added to or removed from `requires`. */
export function editRequires(text: string, deps: readonly string[], add: boolean): string {
  const manifest = JSON.parse(text) as Record<string, unknown>;
  const current = Array.isArray(manifest.requires)
    ? manifest.requires.filter((d): d is string => typeof d === 'string')
    : [];
  const next = add
    ? [...current, ...deps.filter((d) => !current.includes(d))]
    : current.filter((d) => !deps.includes(d));
  return `${JSON.stringify({ ...manifest, requires: next }, null, 2)}\n`;
}

function* edit(io: Io, opts: SvcctlOpts): SysGen<number> {
  const name = opts.name ?? '';
  let manifest: { text: string; version: number };
  try {
    manifest = yield* readManifest(io, name);
  } catch (e) {
    if (mustErrno(e) === 'ENOENT') {
      yield* io.error(`unknown service '${name}'`);
      return 1;
    }
    throw e;
  }
  const text = editRequires(manifest.text, opts.deps, opts.sub === 'require');
  const written = yield* io.sys.call('writeFile', {
    path: manifestPath(name),
    data: encodeText(text),
    expectedVersion: manifest.version,
  });
  if (opts.sub !== 'require') return 0;
  let check;
  try {
    check = yield* extCall(io.sys, 'svc.verify', { source: 'volume' });
  } catch (e) {
    yield* io.error(`cannot verify the service graph: ${describe(e)}`);
    return 0;
  }
  if (check.ok) return 0;
  const cycle =
    check.cycle === undefined
      ? 'invalid manifests'
      : [...check.cycle, check.cycle[0] ?? ''].join(' → ');
  if (opts.force) {
    yield* io.error(
      `warning: this creates a dependency cycle (${cycle}); the next boot will stop at a kernel panic`,
    );
    return 0;
  }
  yield* io.sys.call('writeFile', {
    path: manifestPath(name),
    data: encodeText(manifest.text),
    expectedVersion: written.version,
  });
  yield* io.error(
    `refused: this creates a dependency cycle (${cycle}); use --force to write it anyway`,
  );
  return 1;
}

function* status(io: Io, name: string | null): SysGen<number> {
  const { services } = yield* io.sys.call('svc.status', {});
  const rows = name === null ? services : services.filter((s) => s.name === name);
  if (rows.length === 0) {
    yield* io.error(`unknown service '${name ?? ''}'`);
    return 1;
  }
  yield* io.lines(statusLines(rows, null));
  return 0;
}

function* control(io: Io, opts: SvcctlOpts): SysGen<number> {
  const name = opts.name ?? '';
  if (opts.sub === 'stop') {
    const { services } = yield* io.sys.call('svc.status', {});
    if (services.find((s) => s.name === name)?.critical === true) {
      yield* io.error('stopping a critical service is not allowed');
      return 1;
    }
  }
  if (opts.sub === 'restart') yield* io.sys.call('svc.restart', { name });
  else
    yield* extCall(io.sys, 'svc.control', {
      name,
      action: opts.sub === 'start' ? 'start' : opts.sub === 'stop' ? 'stop' : 'retry',
    });
  return 0;
}

export default defineCommand<SvcctlOpts>({
  name: 'svcctl',
  parse: parseSvcctl,
  *run(io, opts) {
    try {
      switch (opts.sub) {
        case 'status':
          return yield* status(io, opts.name);
        case 'graph':
        case 'verify': {
          const check = yield* extCall(io.sys, 'svc.verify', { source: 'volume' });
          yield* io.lines(graphLines(check.levels, check.cycle));
          yield* io.lines(check.errors.map((e) => `${e.file}: ${e.text} (${e.rule})`));
          return check.ok ? 0 : 1;
        }
        case 'require':
        case 'unrequire':
          return yield* edit(io, opts);
        case 'restore-defaults': {
          const res = yield* extCall(io.sys, 'svc.restoreDefaults', {});
          yield* io.line(
            `svcctl: restored ${res.written} default manifests (takes effect at the next boot)`,
          );
          return 0;
        }
        case 'retry':
        case 'start':
        case 'stop':
        case 'restart':
          return yield* control(io, opts);
      }
    } catch (e) {
      const errno = mustErrno(e);
      yield* io.error(
        errno === 'ENOENT' && opts.name !== null ? `unknown service '${opts.name}'` : describe(e),
      );
      return 1;
    }
  },
});
