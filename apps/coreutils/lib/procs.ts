/**
 * Process rows for `ps`, `top`, `renice` and `vmstat -p` (processes-and-scheduling.md §3.18.1).
 *
 * `ProcInfo` does not carry every column of §3.18.1 yet; the optional `ProcExtra` fields are read
 * when the kernel supplies them and shown as `-`/`?` otherwise.
 * TODO(R1): add sid, tty, fg, leader, boosted, exclusive, overSoftLimit, pinned, overruns, kind and
 * exit to protocol `ProcInfo` (syscall-abi.md §4.4.1) and drop the optional reads.
 */
import type { ProcInfo } from '@plotinium/protocol';

import { basename } from './path.ts';
import { binSize, byCodePoint, clock, cpuPlus, hms } from './format.ts';
import type { Sys, SysGen } from './sys.ts';

export interface ProcExtra {
  readonly sid: number;
  /** TTY number, or null for no controlling terminal. */
  readonly tty: number | null;
  readonly fg: boolean;
  readonly leader: boolean;
  readonly boosted: boolean;
  readonly exclusive: boolean;
  readonly overSoftLimit: boolean;
  readonly pinned: boolean;
  readonly stopped: boolean;
  readonly overruns: number;
  readonly kind: 'user' | 'kthread' | 'special';
  readonly exit: string;
}

export type ProcRow = ProcInfo & Partial<ProcExtra>;

export const PROC_PAGE = 1_024;

export function* listProcs(
  sys: Sys,
  filter: { uid?: number; pgid?: number } = {},
): SysGen<ProcRow[]> {
  const rows: ProcRow[] = [];
  let cursor: string | undefined;
  do {
    const page = yield* sys.call('proc.list', {
      ...filter,
      limit: PROC_PAGE,
      ...(cursor === undefined ? {} : { cursor }),
    });
    rows.push(...page.procs);
    cursor = page.next;
  } while (cursor !== undefined);
  return rows;
}

/** What a field needs besides the row: the clock and the time-zone offset. */
export interface FieldEnv {
  readonly now: number;
  readonly tz: number;
}

export interface Field {
  readonly header: string;
  readonly right: boolean;
  readonly min: number;
  text(row: ProcRow, env: FieldEnv): string;
  key(row: ProcRow, env: FieldEnv): number | string;
}

const STATE3 = {
  NEW: 'NEW',
  READY: 'RDY',
  RUNNING: 'RUN',
  BLOCKED: 'BLK',
  SUSPENDED: 'SUS',
  TERMINATED: 'ZMB',
} as const;

export function pri(row: ProcRow): number {
  return Math.min(39, Math.max(0, row.priority + row.nice));
}

export function cls(row: ProcRow): string {
  if (row.kind === 'kthread') return 'kth';
  if (row.kind === 'special') return 'spc';
  const base = pri(row);
  return base < 10 ? 'int' : base < 30 ? 'nor' : 'bkg';
}

/** `RUN+`, `BLKs`, `RDYN`: the 3-letter state and its flags. */
export function statCode(row: ProcRow): string {
  const stopped = row.state === 'BLOCKED' && (row.stopped === true || row.waitingOn === 'sigcont');
  let code: string = stopped ? 'STP' : STATE3[row.state];
  if (row.fg === true) code += '+';
  if (row.leader === true) code += 's';
  if (row.boosted === true) code += '<';
  if (row.nice > 0) code += 'N';
  if (row.exclusive === true) code += 'X';
  if (row.overSoftLimit === true) code += '!';
  if (row.pinned === true) code += 'P';
  return code;
}

export function ttyName(row: ProcRow): string {
  return row.tty === undefined || row.tty === null ? '?' : `tty${row.tty}`;
}

export function commandLine(row: ProcRow): string {
  const text = row.argv.join(' ');
  return row.kind === 'kthread' ? `[${text}]` : text;
}

function exe(row: ProcRow): string {
  if (row.state === 'SUSPENDED') return '-';
  if (row.executor !== null) return `e${row.executor}`;
  return row.kind === 'kthread' || row.class === 'system' ? 'kern' : '-';
}

const num = (header: string, min: number, get: (r: ProcRow) => number): Field => ({
  header,
  right: true,
  min,
  text: (r) => String(get(r)),
  key: (r) => get(r),
});

const txt = (header: string, min: number, get: (r: ProcRow) => string, right = false): Field => ({
  header,
  right,
  min,
  text: (r) => get(r),
  key: (r) => get(r),
});

export const FIELDS: Readonly<Record<string, Field>> = {
  pid: num('PID', 5, (r) => r.pid),
  ppid: num('PPID', 5, (r) => r.ppid),
  pgid: num('PGID', 5, (r) => r.pgid),
  sid: {
    ...num('SID', 5, (r) => r.sid ?? 0),
    text: (r) => (r.sid === undefined ? '-' : String(r.sid)),
  },
  uid: num('UID', 5, (r) => r.uid),
  user: txt('USER', 8, (r) => r.user),
  pri: num('PRI', 3, pri),
  ni: num('NI', 3, (r) => r.nice),
  eprio: num('EP', 3, (r) => r.effPrio),
  cls: txt('CLS', 3, cls),
  state: txt('STATE', 5, (r) => r.state),
  stat: txt('STAT', 4, statCode),
  wchan: txt('WCHAN', 6, (r) => r.waitingOn ?? '-'),
  pcpu: {
    header: '%CPU',
    right: true,
    min: 5,
    text: (r) => r.cpuPct.toFixed(1),
    key: (r) => r.cpuPct,
  },
  time: {
    header: 'TIME',
    right: true,
    min: 7,
    text: (r) => cpuPlus(r.cpuTimeMs),
    key: (r) => r.cpuTimeMs,
  },
  etime: {
    header: 'ELAPSED',
    right: true,
    min: 7,
    text: (r, env) => hms(Math.max(0, env.now - r.startedAt)),
    key: (r) => -r.startedAt,
  },
  stime: {
    header: 'STIME',
    right: false,
    min: 5,
    text: (r, env) => clock(r.startedAt, env.tz).slice(0, 5),
    key: (r) => r.startedAt,
  },
  rss: {
    header: 'RSS',
    right: true,
    min: 6,
    text: (r) => binSize(r.residentBytes),
    key: (r) => r.residentBytes,
  },
  swap: {
    header: 'SWAP',
    right: true,
    min: 6,
    text: (r) => binSize(r.swappedBytes),
    key: (r) => r.swappedBytes,
  },
  flt: num('FLT', 4, (r) => r.faults),
  hit: {
    header: 'HIT%',
    right: true,
    min: 5,
    text: (r) => (r.hitRatio * 100).toFixed(1),
    key: (r) => r.hitRatio,
  },
  exe: txt('EXE', 3, exe),
  ovr: {
    ...num('OVR', 3, (r) => r.overruns ?? 0),
    text: (r) => (r.overruns === undefined ? '-' : String(r.overruns)),
  },
  tty: txt('TTY', 5, ttyName),
  comm: txt('COMMAND', 7, (r) => basename(r.argv[0] ?? '?')),
  args: txt('COMMAND', 7, commandLine),
  exit: txt('EXIT', 4, (r) => r.exit ?? '-'),
};

export const FIELD_ALIASES: Readonly<Record<string, string>> = {
  cmd: 'args',
  command: 'args',
  ep: 'eprio',
  epri: 'eprio',
  acct: 'rss',
  res: 'rss',
  s: 'stat',
  '%cpu': 'pcpu',
};

/** The canonical field name, or undefined for an unknown one. */
export function fieldName(name: string): string | undefined {
  const lower = name.toLowerCase();
  const canonical = FIELD_ALIASES[lower] ?? lower;
  return canonical in FIELDS ? canonical : undefined;
}

export interface SortKey {
  readonly field: string;
  readonly desc: boolean;
}

/** Sorts in place by the keys, then by pid. */
export function sortRows(rows: ProcRow[], keys: readonly SortKey[], env: FieldEnv): void {
  rows.sort((a, b) => {
    for (const k of keys) {
      const field = FIELDS[k.field];
      if (field === undefined) continue;
      const x = field.key(a, env);
      const y = field.key(b, env);
      const d =
        typeof x === 'number' && typeof y === 'number' ? x - y : byCodePoint(String(x), String(y));
      if (d !== 0) return k.desc ? -d : d;
    }
    return a.pid - b.pid;
  });
}

/** Aligned table lines; the last column is left unpadded. Headers may be overridden per column. */
export function renderTable(
  rows: readonly ProcRow[],
  names: readonly string[],
  env: FieldEnv,
  options: { headers?: boolean; headerOverride?: Readonly<Record<string, string>> } = {},
): string[] {
  const fields = names.map((n) => FIELDS[n]).filter((f): f is Field => f !== undefined);
  const heads = names.map((n, i) => options.headerOverride?.[n] ?? fields[i]?.header ?? n);
  const cells = rows.map((row) => fields.map((f) => f.text(row, env)));
  const widths = fields.map((f, i) =>
    Math.max(f.min, heads[i]?.length ?? 0, ...cells.map((c) => [...(c[i] ?? '')].length)),
  );
  const line = (values: readonly string[]): string =>
    values
      .map((v, i) => {
        const f = fields[i];
        const w = widths[i] ?? 0;
        if (i === values.length - 1 && f?.right !== true) return v;
        return f?.right === true ? v.padStart(w) : v.padEnd(w);
      })
      .join(' ');
  const out = cells.map(line);
  if (options.headers !== false) out.unshift(line(heads));
  return out;
}
