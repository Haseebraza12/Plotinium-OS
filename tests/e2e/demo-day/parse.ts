/**
 * Pure parsers for what the Demo Day rehearsal reads off the Terminal (spec §17.1; testing
 * §3.16.3–§3.16.5). Every format comes from the spec that owns the command: shell-and-terminal
 * §3.14 (free, vmstat, top, fsck, quota, lsof, bootlog, debug, rm), boot-and-services §5.8
 * (`bootlog --critical-path`), rag-semantic-search §3.5 (semsearch), agentic-shell §3.3 (ai) and
 * predictive-prefetch §3.8 (predict). The Playwright scripts only drive the OS; every judgement
 * about the text is made here, so it is unit-tested without a browser (parse.test.ts).
 */
import type { AppId } from '../../support/selectors.ts';

// ---------------------------------------------------------------------------------------------
// Terminal buffer: command output and exit status
// ---------------------------------------------------------------------------------------------

/** A shell prompt line (`alice@plotinium:~$ `, `root@plotinium:/home/alice# `), nothing after it. */
export const PROMPT = /^[\w.-]+@plotinium:[^\n]*[$#]\s*$/;

/** Typed after every scripted command so the rehearsal reads `$?` from the screen. */
export const STATUS_COMMAND = 'echo "rc=$?"';

/**
 * One shell word for any text, with POSIX single quotes (the shell's `'x'` quoting): plain when
 * it holds only safe characters, else single-quoted with each `'` written as `'\''`. Hidden
 * prompts are typed through this, so an examiner's quote, `$` or `~` cannot change the command.
 */
export function shellQuote(text: string): string {
  if (/^[\w@%+=:,./-]+$/.test(text)) return text;
  return `'${text.replaceAll("'", "'\\''")}'`;
}

export interface CommandRun {
  /** Lines the command printed, without its echo, the status command or prompts. */
  output: string;
  /** `$?` after the command. */
  status: number;
}

/**
 * Line index where the first occurrence of `needle` at or after `fromLine` ends. The search runs
 * over the lines joined without separators, so a command the terminal hard-wrapped over two
 * lines is still found. Returns `[startLine, endLine]` or undefined.
 */
function findSpan(
  lines: readonly string[],
  needle: string,
  fromLine = 0,
): [number, number] | undefined {
  const starts: number[] = [];
  let flat = '';
  for (let i = 0; i < lines.length; i++) {
    starts.push(flat.length);
    flat += lines[i] ?? '';
  }
  const offset = fromLine < starts.length ? (starts[fromLine] ?? 0) : flat.length;
  const at = flat.indexOf(needle, offset);
  if (at < 0) return undefined;
  const end = at + needle.length - 1;
  let startLine = 0;
  let endLine = 0;
  for (let i = 0; i < starts.length; i++) {
    const s = starts[i] ?? 0;
    if (s <= at) startLine = i;
    if (s <= end) endLine = i;
  }
  return [startLine, endLine];
}

function dropPrompts(lines: readonly string[]): string[] {
  const out = [...lines];
  while (out.length > 0 && PROMPT.test(out[out.length - 1] ?? '')) out.pop();
  while (out.length > 0 && (out[out.length - 1] ?? '').trim() === '') out.pop();
  return out;
}

/**
 * Splits a Terminal buffer (after `clear`, then `command`, then {@link STATUS_COMMAND}) into the
 * command's output and its exit status. Throws with the buffer when either echo is missing, so a
 * failing rehearsal shows what was on the screen.
 */
export function splitRun(
  buffer: string,
  command: string,
  statusCommand = STATUS_COMMAND,
): CommandRun {
  const lines = buffer.split('\n');
  const cmd = findSpan(lines, command);
  if (cmd === undefined)
    throw new Error(`command echo not found: ${command}\n--- screen ---\n${buffer}`);
  const st = findSpan(lines, statusCommand, cmd[1] + 1);
  if (st === undefined)
    throw new Error(`status echo not found after: ${command}\n--- screen ---\n${buffer}`);
  const after = lines.slice(st[1] + 1).join('\n');
  const rc = /^rc=(\d+)\s*$/m.exec(after);
  if (rc === null) throw new Error(`no rc= line after: ${command}\n--- screen ---\n${buffer}`);
  const body = dropPrompts(lines.slice(cmd[1] + 1, st[0]));
  return { output: body.join('\n'), status: Number(rc[1]) };
}

// ---------------------------------------------------------------------------------------------
// Boot: verbose log (BOOT-05) and bootlog --critical-path (BOOT-11)
// ---------------------------------------------------------------------------------------------

export type LogLevel = 'WARN' | 'DEGRADED' | 'FAIL' | 'KERNEL PANIC';

export interface VerboseLine {
  /** Seconds since t0. */
  t: number;
  subsystem: string;
  message: string;
  level: LogLevel | null;
}

const VERBOSE_LINE = /^\[\s*(\d+\.\d{3})\]\s+([\w.:-]+):\s?(.*)$/;
const LEVELS: readonly LogLevel[] = ['KERNEL PANIC', 'DEGRADED', 'WARN', 'FAIL'];

/** Boot §3.7: every klog line is `[ssss.mmm] subsystem: message`, with text level prefixes. */
export function parseVerboseLog(text: string): VerboseLine[] {
  const out: VerboseLine[] = [];
  for (const raw of text.split('\n')) {
    const m = VERBOSE_LINE.exec(raw.trim());
    if (m === null) continue;
    const message = m[3] ?? '';
    const level = LEVELS.find((l) => message.startsWith(l)) ?? null;
    out.push({ t: Number(m[1]), subsystem: m[2] ?? '', message, level });
  }
  return out;
}

export function timestampsNonDecreasing(lines: readonly VerboseLine[]): boolean {
  return lines.every((l, i) => i === 0 || l.t >= (lines[i - 1]?.t ?? 0));
}

export interface CriticalRow {
  kind: 'stage' | 'svc';
  name: string;
  /** Seconds since t0. */
  start: number;
  end: number;
  ms: number;
  gatedBy: string | null;
}

export interface CriticalPath {
  seq: number;
  profile: string;
  kind: string;
  /** Seconds to the target (desktop-interactive or recovery). */
  totalS: number;
  target: string;
  rows: CriticalRow[];
  offPath: string | null;
}

const CP_HEADER = /^boot #(\d+)\s+·\s+(\S+)\s+·\s+(\S+)\s+·\s+(\d+(?:\.\d+)?)\s*s to ([\w-]+)/;
const CP_ROW = /^(stage|svc)\s+(\S+)\s+(\d+(?:\.\d+)?)\s+→\s+(\d+(?:\.\d+)?)\s+(\d+)\s*ms\b(.*)$/;

/** Boot §5.8 sample output. Returns undefined when the header is missing. */
export function parseCriticalPath(text: string): CriticalPath | undefined {
  const lines = text.split('\n').map((l) => l.trim());
  const header = lines.map((l) => CP_HEADER.exec(l)).find((m) => m !== null);
  if (header === undefined || header === null) return undefined;
  const rows: CriticalRow[] = [];
  let offPath: string | null = null;
  for (const line of lines) {
    const m = CP_ROW.exec(line);
    if (m !== null) {
      const gated = /gated by (\S+)/.exec(m[6] ?? '');
      rows.push({
        kind: m[1] === 'stage' ? 'stage' : 'svc',
        name: m[2] ?? '',
        start: Number(m[3]),
        end: Number(m[4]),
        ms: Number(m[5]),
        gatedBy: gated?.[1] ?? null,
      });
    } else if (line.startsWith('off the path:')) {
      offPath = line.slice('off the path:'.length).trim();
    }
  }
  return {
    seq: Number(header[1]),
    profile: header[2] ?? '',
    kind: header[3] ?? '',
    totalS: Number(header[4]),
    target: header[5] ?? '',
    rows,
    offPath,
  };
}

/**
 * BOOT-11 checks on a parsed critical path; returns the list of problems (empty when it holds):
 * the service chain starts at `kernel` and ends at `desktop` (or `recovery`), each service is
 * gated by the one before it, the rows are contiguous in time, the last row ends at the reported
 * boot time and the row durations add up to it, each within `toleranceMs` (boot spec: 5 ms).
 */
export function criticalPathProblems(cp: CriticalPath, toleranceMs = 5): string[] {
  const problems: string[] = [];
  const svc = cp.rows.filter((r) => r.kind === 'svc');
  if (svc.length === 0) return ['no svc rows'];
  const last = svc[svc.length - 1];
  const target = cp.target === 'recovery' ? 'recovery' : 'desktop';
  if (last?.name !== target) problems.push(`the path ends at ${last?.name ?? '?'}, not ${target}`);
  if (svc[0]?.name !== 'kernel')
    problems.push(`the path starts at ${svc[0]?.name ?? '?'}, not kernel`);
  for (let i = 1; i < svc.length; i++) {
    const prev = svc[i - 1];
    const cur = svc[i];
    if (prev === undefined || cur === undefined) continue;
    if (cur.gatedBy !== prev.name)
      problems.push(`${cur.name} is gated by ${cur.gatedBy ?? 'nothing'}, not by ${prev.name}`);
  }
  const all = cp.rows;
  // A row is printed with millisecond precision, so allow half a millisecond of rounding per row.
  const slackS = (toleranceMs + 0.5 * all.length) / 1000;
  for (let i = 1; i < all.length; i++) {
    const prev = all[i - 1];
    const cur = all[i];
    if (prev === undefined || cur === undefined) continue;
    if (cur.start + slackS < prev.end) problems.push(`${cur.name} starts before ${prev.name} ends`);
  }
  const endS = all[all.length - 1]?.end ?? 0;
  if (Math.abs(endS - cp.totalS) * 1000 > toleranceMs)
    problems.push(`the last row ends at ${endS} s but the boot took ${cp.totalS} s`);
  const sumMs = all.reduce((acc, r) => acc + r.ms, 0);
  if (Math.abs(sumMs - cp.totalS * 1000) > toleranceMs + 0.5 * all.length)
    problems.push(
      `the row durations add up to ${sumMs} ms, not ${Math.round(cp.totalS * 1000)} ms`,
    );
  return problems;
}

// ---------------------------------------------------------------------------------------------
// Sizes, free, vmstat, top (PROC-05, MEM-06, MEM-07)
// ---------------------------------------------------------------------------------------------

const UNIT_MIB: Readonly<Record<string, number>> = {
  B: 1 / (1024 * 1024),
  K: 1 / 1024,
  M: 1,
  G: 1024,
  T: 1024 * 1024,
};

/** `256.0M`, `1.2G`, `512K`, `1,204`, `812.0MiB` → MiB (a bare number is taken as MiB). */
export function parseSizeMiB(s: string): number | undefined {
  const m = /^(-?[\d,]*\.?\d+)\s*([BKMGT])?(?:i?B)?$/i.exec(s.trim());
  if (m === null) return undefined;
  const n = Number((m[1] ?? '').replaceAll(',', ''));
  const unit = (m[2] ?? 'M').toUpperCase();
  const f = UNIT_MIB[unit];
  return Number.isFinite(n) && f !== undefined ? n * f : undefined;
}

export interface FreeReport {
  budget: number;
  accounted: number;
  free: number;
  reclaimable: number;
  speculative: number;
  kernel: number;
  paging?: { faults: number; hitPct: number; inMiB: number; outMiB: number };
}

/** Shell §3.14.30 `free` (MiB). */
export function parseFree(text: string): FreeReport | undefined {
  const lines = text.split('\n');
  const header = lines.find((l) => /\bbudget\b/.test(l) && /\baccounted\b/.test(l));
  const mem = lines.find((l) => /^\s*Mem:/.test(l));
  if (header === undefined || mem === undefined) return undefined;
  const cols = header.trim().split(/\s+/);
  const vals = mem.trim().split(/\s+/).slice(1).map(parseSizeMiB);
  const at = (name: string): number | undefined => {
    const i = cols.indexOf(name);
    return i < 0 ? undefined : vals[i];
  };
  const budget = at('budget');
  const accounted = at('accounted');
  if (budget === undefined || accounted === undefined) return undefined;
  const report: FreeReport = {
    budget,
    accounted,
    free: at('free') ?? 0,
    reclaimable: at('reclaimable') ?? 0,
    speculative: at('speculative') ?? 0,
    kernel: at('kernel') ?? 0,
  };
  const paging = lines.find((l) => /^\s*Paging:/.test(l));
  if (paging !== undefined) {
    const faults = /faults\s+([\d,]+)/.exec(paging);
    const hit = /hit ratio\s+([\d.]+)%/.exec(paging);
    const inM = /\bin\s+([\d.,]+[BKMGT]?)/.exec(paging);
    const outM = /\bout\s+([\d.,]+[BKMGT]?)/.exec(paging);
    report.paging = {
      faults: Number((faults?.[1] ?? '0').replaceAll(',', '')),
      hitPct: Number(hit?.[1] ?? 0),
      inMiB: parseSizeMiB(inM?.[1] ?? '0') ?? 0,
      outMiB: parseSizeMiB(outM?.[1] ?? '0') ?? 0,
    };
  }
  return report;
}

export type VmstatRow = Record<string, number>;

/** Shell §3.14.31 `vmstat` system mode: one object per numeric row, keyed by the column names. */
export function parseVmstat(text: string): VmstatRow[] {
  const lines = text.split('\n');
  const hi = lines.findIndex((l) => /\bacct\b/.test(l) && /\bso\b/.test(l));
  if (hi < 0) return [];
  const cols = (lines[hi] ?? '').trim().split(/\s+/);
  const rows: VmstatRow[] = [];
  for (const line of lines.slice(hi + 1)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length !== cols.length || !parts.every((p) => /^-?[\d.]+$/.test(p))) continue;
    const row: VmstatRow = {};
    cols.forEach((c, i) => {
      row[c] = Number(parts[i]);
    });
    rows.push(row);
  }
  return rows;
}

/** KiB/s paged out (local `so` plus remote `rso`) in a vmstat row. */
export function pagedOutKiBs(row: VmstatRow): number {
  return (row['so'] ?? 0) + (row['rso'] ?? 0);
}

export interface TopProcess {
  pid: number;
  user: string;
  pri: number;
  state: string;
  command: string;
}

export interface TopReport {
  frameP95Ms: number | null;
  processes: TopProcess[];
}

/** Shell §3.14.23 `top -b`: the header's `frame p95` and the process rows. */
export function parseTop(text: string): TopReport {
  const p95 = /frame p95\s+([\d.]+)\s*ms/.exec(text);
  const lines = text.split('\n');
  const hi = lines.findIndex((l) => /^\s*PID\s+USER\s+PRI\b/.test(l));
  const processes: TopProcess[] = [];
  if (hi >= 0) {
    const cols = (lines[hi] ?? '').trim().split(/\s+/);
    const cmdAt = cols.indexOf('COMMAND');
    for (const line of lines.slice(hi + 1)) {
      const parts = line.trim().split(/\s+/);
      if (!/^\d+$/.test(parts[0] ?? '') || cmdAt < 0 || parts.length <= cmdAt) continue;
      const get = (name: string): string => parts[cols.indexOf(name)] ?? '';
      processes.push({
        pid: Number(parts[0]),
        user: get('USER'),
        pri: Number(get('PRI')),
        state: get('S'),
        command: parts.slice(cmdAt).join(' '),
      });
    }
  }
  return { frameP95Ms: p95 === null ? null : Number(p95[1]), processes };
}

// ---------------------------------------------------------------------------------------------
// Fault-injected rm -r (DB-02)
// ---------------------------------------------------------------------------------------------

export interface Armed {
  op: string;
  node: number;
  target: string;
}

/** Shell §3.14.50: `debug: armed rm fault at node 500 (target both, one-shot)`. */
export function parseArmed(text: string): Armed | undefined {
  const m = /debug: armed (\S+) fault at node (\d+) \(target (\w+), one-shot\)/.exec(text);
  return m === null ? undefined : { op: m[1] ?? '', node: Number(m[2]), target: m[3] ?? '' };
}

export interface RolledBack {
  path: string;
  node: number;
}

/** Shell §3.14.3 exact form: `rm: cannot remove '…': Input/output error (injected fault at node N) — rolled back`. */
export function parseRolledBack(text: string): RolledBack | undefined {
  const m =
    /rm: cannot remove '([^']+)': Input\/output error \(injected fault at node (\d+)\) — rolled back/.exec(
      text,
    );
  return m === null ? undefined : { path: m[1] ?? '', node: Number(m[2]) };
}

export interface TreeChecksum {
  sha256: string;
  path: string;
  nodes: number | null;
}

/** `fsck --checksum`: `sha256:3f1a09c2…  /home/alice/fixtures/tree1000 (1,000 nodes)`. */
export function parseChecksum(text: string): TreeChecksum | undefined {
  const m = /sha256:([0-9a-f]+)…?\s+(\S+)(?:\s+\(([\d,]+) nodes\))?/.exec(text);
  if (m === null) return undefined;
  return {
    sha256: m[1] ?? '',
    path: m[2] ?? '',
    nodes: m[3] === undefined ? null : Number(m[3].replaceAll(',', '')),
  };
}

export interface FsckReport {
  inodes: number;
  unreachable: number;
  wrongLinks: number;
  cycles: number;
  dangling: number;
  clean: boolean;
}

/** Shell §3.14.39 exact layout. */
export function parseFsck(text: string): FsckReport | undefined {
  const checked = /fsck: checked ([\d,]+) inodes/.exec(text);
  const counts =
    /fsck: unreachable (\d+) · wrong link counts (\d+) · directory cycles (\d+) · dangling dentries (\d+)/.exec(
      text,
    );
  if (checked === null || counts === null) return undefined;
  return {
    inodes: Number((checked[1] ?? '0').replaceAll(',', '')),
    unreachable: Number(counts[1]),
    wrongLinks: Number(counts[2]),
    cycles: Number(counts[3]),
    dangling: Number(counts[4]),
    clean: /^fsck: clean\s*$/m.test(text),
  };
}

export interface QuotaReport {
  bytesUsedMiB: number;
  inodesUsed: number;
  source: string;
}

/** Shell §3.14.20 `quota`. */
export function parseQuota(text: string): QuotaReport | undefined {
  const bytes = /bytes used\s+(\S+)/.exec(text);
  const inodes = /inodes used\s+([\d,]+)/.exec(text);
  if (bytes === null || inodes === null) return undefined;
  const mib = parseSizeMiB(bytes[1] ?? '');
  if (mib === undefined) return undefined;
  return {
    bytesUsedMiB: mib,
    inodesUsed: Number((inodes[1] ?? '0').replaceAll(',', '')),
    source: /source:\s+(.*)$/m.exec(text)?.[1]?.trim() ?? '',
  };
}

// ---------------------------------------------------------------------------------------------
// Locks (VFS-09)
// ---------------------------------------------------------------------------------------------

export interface LeaseRow {
  user: string;
  mode: 'X' | 'S';
  path: string;
  fence: number | null;
  expiresInS: number | null;
  waiting: boolean;
}

/** Shell §3.14.40 `lsof`: rows whose LEASE column names a lease on `path`. */
export function parseLeases(text: string, path: string): LeaseRow[] {
  const out: LeaseRow[] = [];
  for (const line of text.split('\n')) {
    if (!line.includes(path)) continue;
    const lease = /\b([XS]) · (.*)$/.exec(line);
    if (lease === null) continue;
    const cols = line.trim().split(/\s+/);
    const rest = lease[2] ?? '';
    const fence = /fence (\d+)/.exec(rest);
    const exp = /expires in (\d+(?:\.\d+)?) s/.exec(rest);
    out.push({
      user: cols[2] ?? '',
      mode: lease[1] === 'X' ? 'X' : 'S',
      path,
      fence: fence === null ? null : Number(fence[1]),
      expiresInS: exp === null ? null : Number(exp[1]),
      waiting: /waiting/.test(rest),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Hidden AI prompts: semsearch (RAG-03, RAG-06), ai (AGT-03, AGT-05, AGT-08), predict (PRE-03, PRE-06)
// ---------------------------------------------------------------------------------------------

export interface SearchHit {
  path: string;
  lineStart: number;
  lineEnd: number;
  score: number;
  snippet: string;
}

export interface SearchReport {
  hits: SearchHit[];
  notices: string[];
}

/** RAG §3.5: `path:lineStart-lineEnd  score  snippet`, then `semsearch: …` notices. */
export function parseSemsearch(text: string): SearchReport {
  const hits: SearchHit[] = [];
  const notices: string[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t.startsWith('semsearch:')) {
      notices.push(t.slice('semsearch:'.length).trim());
      continue;
    }
    const m = /^(\S+):(\d+)-(\d+)\s+(\d(?:\.\d+)?)\s+(.*)$/.exec(t);
    if (m === null) continue;
    hits.push({
      path: m[1] ?? '',
      lineStart: Number(m[2]),
      lineEnd: Number(m[3]),
      score: Number(m[4]),
      snippet: m[5] ?? '',
    });
  }
  return { hits, notices };
}

export function scoresNonIncreasing(hits: readonly SearchHit[]): boolean {
  return hits.every((h, i) => i === 0 || h.score <= (hits[i - 1]?.score ?? Infinity));
}

/** Hits that live in `owner`'s home (absolute form; the caller's own home prints as `~/`). */
export function hitsInHomeOf(hits: readonly SearchHit[], owner: string): SearchHit[] {
  return hits.filter((h) => h.path === `/home/${owner}` || h.path.startsWith(`/home/${owner}/`));
}

export interface AgentRun {
  planned: boolean;
  blastRadius: string | null;
  prompted: boolean;
  committed: { ms: number; txn: string } | null;
  unavailable: boolean;
  nothingRun: boolean;
}

/** Agentic-shell §3.3 example session and §3.11 error table. */
export function parseAgentRun(text: string): AgentRun {
  const blast = /^Blast radius:\s*(.*)$/m.exec(text);
  const committed = /✓ committed in (\d+) ms · txn ([0-9a-f]+)/.exec(text);
  return {
    planned: /^Plan · \d+ steps?/m.test(text),
    blastRadius: blast?.[1]?.trim() ?? null,
    prompted: /Proceed\? \[y\/N\/e/.test(text),
    committed: committed === null ? null : { ms: Number(committed[1]), txn: committed[2] ?? '' },
    unavailable: /ai: .*unavailable.* — nothing was run/.test(text),
    nothingRun: /nothing was run|nothing changed/.test(text),
  };
}

/** The outcome words of `ai log` rows (agentic-shell §4 audit outcomes). */
export const AGENT_OUTCOMES = [
  'committed',
  'dry_run_only',
  'rejected_invalid',
  'declined',
  'confirm_timeout',
  'no_tty',
  'needs_clarification',
  'cannot_comply',
  'refused_model',
  'unavailable',
  'stale_plan',
  'killed_before_execute',
  'killed_rolled_back',
  'rejected_on_sync',
  'failed_rolled_back',
  'undone',
] as const;
export type AgentOutcome = (typeof AGENT_OUTCOMES)[number];

/** Outcomes in `ai log` output, newest first as printed. */
export function parseAgentLogOutcomes(text: string): AgentOutcome[] {
  const out: AgentOutcome[] = [];
  for (const line of text.split('\n')) {
    const words = line.trim().split(/\s+/);
    const hit = AGENT_OUTCOMES.find((o) => words.includes(o));
    if (hit !== undefined) out.push(hit);
  }
  return out;
}

export interface Prediction {
  rank: number;
  app: string;
  confidence: number;
  reason: string;
  prefetched: boolean;
}

export interface PredictReport {
  model: string | null;
  predictions: Prediction[];
  prefetch: { app: string; pid: number } | null;
}

/**
 * `predict` as printed by predictive-prefetch §3.8 (`  1  Editor  0.58  after … pre-fetched`) and
 * by shell §3.14.48 (` 1  editor  0.62  after …`): rank, app name (may contain one space),
 * confidence in [0, 1], reason.
 */
export function parsePredict(text: string): PredictReport {
  const predictions: Prediction[] = [];
  let model: string | null = null;
  let prefetch: PredictReport['prefetch'] = null;
  for (const line of text.split('\n')) {
    const t = line.trim();
    const mm = /^(?:MODEL\s+|model\s+)(.*)$/.exec(t);
    if (mm !== null && model === null) model = mm[1] ?? '';
    const pf = /prefetch:([\w-]+)\s+\(pid (\d+)\)/.exec(t);
    if (pf !== null && prefetch === null) prefetch = { app: pf[1] ?? '', pid: Number(pf[2]) };
    const m = /^(\d+)\s+(\S+(?: \S+)?)\s+(0(?:\.\d+)?|1(?:\.0+)?)\s+(.*)$/.exec(t);
    if (m === null) continue;
    const reason = (m[4] ?? '').trim();
    predictions.push({
      rank: Number(m[1]),
      app: m[2] ?? '',
      confidence: Number(m[3]),
      reason: reason.replace(/\s+pre-fetched$/, ''),
      prefetched: /\bpre-fetched$/.test(reason),
    });
  }
  return { model, predictions, prefetch };
}

/** Maps a `predict` app name (`Editor`, `taskmgr`, `Task Manager`) to its dock `data-app` id. */
export function appIdOf(name: string): AppId | undefined {
  const key = name.toLowerCase().replace(/[\s_-]+/g, '');
  const map: Readonly<Record<string, AppId>> = {
    terminal: 'terminal',
    files: 'files',
    fileexplorer: 'files',
    editor: 'editor',
    texteditor: 'editor',
    taskmgr: 'task-manager',
    taskmanager: 'task-manager',
    settings: 'settings',
    about: 'about',
  };
  return map[key];
}

export interface LaunchLatency {
  withPrefetchMs: number | null;
  withoutPrefetchMs: number | null;
}

/**
 * `predict --latency` (predictive-prefetch §3.9: "medians for pre-fetch hits and for launches
 * without pre-fetch"). The exact layout is not fixed by the spec yet, so this reads the first
 * `… ms` figure on the line that names pre-fetch hits and on the line that names launches
 * without pre-fetch.
 */
export function parseLaunchLatency(text: string): LaunchLatency {
  let withMs: number | null = null;
  let withoutMs: number | null = null;
  // One figure per segment: a line may carry both medians separated by `·`, `;`, `,` or `|`.
  for (const segment of text.split(/[\n·;,|]/)) {
    const ms = /(\d+(?:\.\d+)?)\s*ms/.exec(segment);
    if (ms === null) continue;
    const v = Number(ms[1]);
    if (/without pre-?fetch|no pre-?fetch|\bnone\b|\bmiss(?:es)?\b/i.test(segment)) withoutMs ??= v;
    else if (/pre-?fetch(?:ed)? hits?|with pre-?fetch|\bhits?\b/i.test(segment)) withMs ??= v;
  }
  return { withPrefetchMs: withMs, withoutPrefetchMs: withoutMs };
}

// ---------------------------------------------------------------------------------------------
// Bring-up: credentials block and Compose (OPS-05)
// ---------------------------------------------------------------------------------------------

/**
 * The FIRST-START CREDENTIALS block that the app's seed prints once (server/src/seed/demo.ts,
 * C10), read from `docker compose logs app`. Compose prefixes each line with `app-1  | `.
 * Returns username → password; never written anywhere by the harness.
 */
export function parseCredentials(logs: string): Map<string, string> {
  const out = new Map<string, string>();
  const lines = logs.split('\n').map((l) => l.replace(/^[\w.-]+\s*\|\s?/, ''));
  const title = lines.findIndex((l) => l.includes('FIRST-START CREDENTIALS'));
  if (title < 0) return out;
  let rules = 0;
  for (const line of lines.slice(title + 1)) {
    if (/^={20,}\s*$/.test(line.trim())) {
      rules++;
      if (rules >= 2) break;
      continue;
    }
    if (rules !== 1) continue;
    const m = /^\s{2}([a-z_][\w-]*)\s{2,}(\S+)/.exec(line);
    if (m !== null) out.set(m[1] ?? '', m[2] ?? '');
  }
  return out;
}

/** `Docker Compose version v2.29.7` (or `2.29.7-desktop.1`) → [2, 29, 7]. */
export function parseComposeVersion(text: string): [number, number, number] | undefined {
  const m = /v?(\d+)\.(\d+)\.(\d+)/.exec(text);
  return m === null ? undefined : [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function versionAtLeast(
  v: readonly [number, number, number],
  min: readonly [number, number, number],
): boolean {
  for (let i = 0; i < 3; i++) {
    const a = v[i] ?? 0;
    const b = min[i] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

/** `docker compose ls --all --format json` → project names. */
export function parseComposeProjects(json: string): string[] {
  const text = json.trim();
  if (text === '') return [];
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) return [];
  const names: string[] = [];
  for (const row of parsed as unknown[]) {
    if (typeof row === 'object' && row !== null && 'Name' in row) {
      const name = row.Name;
      if (typeof name === 'string') names.push(name);
    }
  }
  return names;
}

export interface VersionInfo {
  name: string;
  version: string;
  build: string;
}

/** Identity §4.2 `/version.json`: `{ name: 'Plotinium', version, build, … }`. */
export function parseVersionJson(v: unknown): VersionInfo | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const o = v as Record<string, unknown>;
  const { name, version, build } = o;
  if (typeof name !== 'string' || typeof version !== 'string' || typeof build !== 'string')
    return undefined;
  return { name, version, build };
}
