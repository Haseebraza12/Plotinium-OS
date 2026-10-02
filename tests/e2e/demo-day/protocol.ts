/**
 * The Demo Day protocol as data (spec §17.1; testing §3.16), and the rehearsal record every
 * scripted run appends to (TST-18: machine, network, Chrome version, time per segment, drills).
 *
 * Pure Node: no browser, so protocol.test.ts checks the schedule, the order of the
 * system-under-test items and the report without a stack.
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import { dirname, join } from 'node:path';

import type { Env } from '../../support/env.ts';
import { REPO_ROOT } from '../../support/stack.ts';

export type Role = 'R1' | 'R2' | 'R3' | 'R4' | 'R5' | 'all';

export type SegmentId = 'bringup' | 'boot' | 'sut' | 'viva' | 'questions';

export interface Segment {
  id: SegmentId;
  /** Offsets from the start of the 30-minute slot, seconds. */
  startS: number;
  endS: number;
  title: string;
  /** Spec §17.1 wording, shortened. */
  what: string;
  lead: Role;
}

/** Spec §17.1, 30 minutes on a machine the team does not control. */
export const PROTOCOL: readonly Segment[] = [
  {
    id: 'bringup',
    startS: 0,
    endS: 300,
    title: 'Clean bring-up',
    what: 'examiner clones and starts the system with at most three documented commands within five minutes, then opens the production URL; scored before we speak',
    lead: 'R5',
  },
  {
    id: 'boot',
    startS: 300,
    endS: 480,
    title: 'Boot',
    what: 'cold boot in verbose mode; bootlog --critical-path; network disconnected and rebooted to show offline boot and the core utilities',
    lead: 'R5',
  },
  {
    id: 'sut',
    startS: 480,
    endS: 1080,
    title: 'System under test',
    what: 'examiner-driven Appendix A checks: CPU + drag with the frame meter, 2x memory with paging, fault-injected rm -r, two users on a lock, hidden AI prompts',
    lead: 'all',
  },
  {
    id: 'viva',
    startS: 1080,
    endS: 1560,
    title: 'Individual viva',
    what: 'each member questioned on a subsystem chosen by the examiners',
    lead: 'all',
  },
  {
    id: 'questions',
    startS: 1560,
    endS: 1800,
    title: "Judges' questions",
    what: 'architecture, trade-offs, limitations, what we would do differently',
    lead: 'all',
  },
];

export function segment(id: SegmentId): Segment {
  const s = PROTOCOL.find((x) => x.id === id);
  if (s === undefined) throw new RangeError(`no segment ${id}`);
  return s;
}

export function slotMs(id: SegmentId): number {
  const s = segment(id);
  return (s.endS - s.startS) * 1000;
}

/** `m:ss` for a number of seconds, as the stopwatch shows it. */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export type ItemId =
  'semantic-query' | 'agent' | 'prefetch' | 'cpu-drag' | 'memory' | 'fault-rm' | 'lock';

export interface SutItem {
  id: ItemId;
  /** Row number in testing §3.16.5. */
  n: number;
  check: string;
  instance: 'production' | 'either' | 'local';
  narrator: Role;
  req: readonly string[];
  /** The script in this folder that automates it. */
  script: string;
}

/**
 * Testing §3.16.5 in its normative order. AIS-11: the hidden semantic query comes before the 2x
 * memory workload, so the workload cannot evict `ai.embed` before the query is judged.
 */
export const SUT_ITEMS: readonly SutItem[] = [
  {
    id: 'semantic-query',
    n: 1,
    check: 'Hidden semantic query',
    instance: 'production',
    narrator: 'R4',
    req: ['RAG-03', 'RAG-04', 'RAG-06'],
    script: '02-hidden-ai.spec.ts',
  },
  {
    id: 'agent',
    n: 2,
    check: 'Agent with destructive confirmation',
    instance: 'production',
    narrator: 'R4',
    req: ['AGT-03', 'AGT-05', 'AGT-08'],
    script: '02-hidden-ai.spec.ts',
  },
  {
    id: 'prefetch',
    n: 3,
    check: 'Pre-fetch',
    instance: 'production',
    narrator: 'R4',
    req: ['PRE-02', 'PRE-03', 'PRE-06'],
    script: '02-hidden-ai.spec.ts',
  },
  {
    id: 'cpu-drag',
    n: 4,
    check: 'CPU load + drag',
    instance: 'either',
    narrator: 'R3',
    req: ['PROC-05', 'WM-03'],
    script: '03-cpu-drag.spec.ts',
  },
  {
    id: 'memory',
    n: 5,
    check: '2x memory',
    instance: 'either',
    narrator: 'R1',
    req: ['MEM-06', 'MEM-03', 'MEM-05', 'MEM-07'],
    script: '04-memory.spec.ts',
  },
  {
    id: 'fault-rm',
    n: 6,
    check: 'Fault-injected rm -r',
    instance: 'local',
    narrator: 'R2',
    req: ['DB-02'],
    script: '05-fault-rm.spec.ts',
  },
  {
    id: 'lock',
    n: 7,
    check: 'Two users contend',
    instance: 'either',
    narrator: 'R2',
    req: ['VFS-09'],
    script: '06-lock-contention.spec.ts',
  },
];

/** Problems with an item order; empty when it respects testing §3.16.5 and AIS-11. */
export function orderProblems(items: readonly SutItem[]): string[] {
  const problems: string[] = [];
  const at = (id: ItemId): number => items.findIndex((i) => i.id === id);
  for (const id of [
    'semantic-query',
    'agent',
    'prefetch',
    'cpu-drag',
    'memory',
    'fault-rm',
    'lock',
  ] as const)
    if (at(id) < 0) problems.push(`missing item ${id}`);
  if (at('semantic-query') > at('memory'))
    problems.push('AIS-11: the semantic query must come before the 2x memory workload');
  if (items.some((it, i) => i > 0 && it.n <= (items[i - 1]?.n ?? 0)))
    problems.push('items are not in testing §3.16.5 order');
  const scripts = items.map((i) => i.script);
  if (scripts.some((s, i) => i > 0 && s < (scripts[i - 1] ?? '')))
    problems.push('the scripts would not run in item order (Playwright sorts files by name)');
  return problems;
}

// ---------------------------------------------------------------------------------------------
// Rehearsal record (TST-18)
// ---------------------------------------------------------------------------------------------

export type EntryStatus = 'passed' | 'failed' | 'timedOut' | 'skipped' | 'interrupted';

export interface RehearsalEntry {
  run: string;
  network: string;
  machine: string;
  chrome: string | null;
  segment: SegmentId;
  item: string;
  title: string;
  req: string | null;
  status: EntryStatus;
  startedAt: string;
  durationMs: number;
  /** Numbers and facts the script read off the screen (`measure:` annotations). */
  measurements: Record<string, string>;
}

const ID_SHAPE = /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+$/;

/** C18: the first whitespace-delimited token of a test title, when it has the shape of an ID. */
export function requirementOf(title: string): string | null {
  const token = title.trimStart().split(/\s/, 1)[0] ?? '';
  return ID_SHAPE.test(token) && /\d/.test(token) ? token : null;
}

export const MEASURE_PREFIX = 'measure:';

/** `measure:<name>` annotations of a Playwright test → `{ name: value }`. */
export function measurementsFrom(
  annotations: ReadonlyArray<{ type: string; description?: string }>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of annotations) {
    if (a.type.startsWith(MEASURE_PREFIX))
      out[a.type.slice(MEASURE_PREFIX.length)] = a.description ?? '';
  }
  return out;
}

/** Hardware and OS of the machine, for TST-18 (no user or host names). */
export function machineSummary(): string {
  const gib = os.totalmem() / 1024 ** 3;
  return `${os.type()} ${os.release()} ${os.arch()} · ${os.cpus().length} CPUs · ${gib.toFixed(1)} GiB`;
}

export function recordFile(env: Env = process.env): string {
  const dir = env['PLT_DEMO_RECORD_DIR'];
  return join(
    dir === undefined || dir === '' ? join(REPO_ROOT, 'test-results', 'demo-day') : dir,
    'rehearsal.jsonl',
  );
}

export async function appendEntry(
  entry: RehearsalEntry,
  file: string = recordFile(),
): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(entry)}\n`, 'utf8');
}

function isEntry(v: unknown): v is RehearsalEntry {
  if (typeof v !== 'object' || v === null) return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e['run'] === 'string' &&
    typeof e['segment'] === 'string' &&
    typeof e['title'] === 'string' &&
    typeof e['status'] === 'string' &&
    typeof e['durationMs'] === 'number'
  );
}

/** Parses the JSON-lines record; a line that is not an entry is ignored. */
export function parseEntries(text: string): RehearsalEntry[] {
  const out: RehearsalEntry[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const v: unknown = JSON.parse(line);
      if (isEntry(v)) out.push(v);
    } catch {
      // A truncated last line after an interrupted run: skip it.
    }
  }
  return out;
}

export async function readEntries(file: string = recordFile()): Promise<RehearsalEntry[]> {
  try {
    return parseEntries(await readFile(file, 'utf8'));
  } catch {
    return [];
  }
}

function cell(s: string): string {
  return s.replaceAll('|', '\\|').replaceAll('\n', ' ');
}

/**
 * Markdown for `docs/evidence/defence/rehearsal-<n>.md`: one table per run with every scripted
 * check, then the scripted time per segment against its §17.1 slot. Scripted time is not the
 * stopwatch time of the live rehearsal (the examiner types slower than Playwright); it shows
 * which checks are slow or failing before the rehearsal.
 */
export function renderReport(entries: readonly RehearsalEntry[]): string {
  const runs = [...new Set(entries.map((e) => e.run))];
  const out: string[] = [];
  for (const run of runs) {
    const list = entries.filter((e) => e.run === run);
    const first = list[0];
    if (first === undefined) continue;
    out.push(`## Rehearsal ${run}`, '');
    out.push(`- Machine: ${first.machine}`);
    out.push(`- Network: ${first.network}`);
    out.push(`- Chrome: ${list.find((e) => e.chrome !== null)?.chrome ?? 'unknown'}`);
    const passed = list.filter((e) => e.status === 'passed').length;
    const failed = list.filter((e) => e.status === 'failed' || e.status === 'timedOut').length;
    const skipped = list.filter((e) => e.status === 'skipped').length;
    out.push(
      `- Checks: ${list.length} (${passed} passed, ${failed} failed, ${skipped} skipped)`,
      '',
    );
    out.push('| Segment | Item | Check | Status | Time | Measured |', '|---|---|---|---|---|---|');
    for (const e of list) {
      const m = Object.entries(e.measurements)
        .map(([k, v]) => `${k}=${v}`)
        .join('; ');
      out.push(
        `| ${e.segment} | ${cell(e.item)} | ${cell(e.title)} | ${e.status} | ${(e.durationMs / 1000).toFixed(1)} s | ${cell(m)} |`,
      );
    }
    out.push('', '| Segment | Slot | Scripted time | Within slot |', '|---|---|---|---|');
    for (const s of PROTOCOL) {
      const inSeg = list.filter((e) => e.segment === s.id);
      if (inSeg.length === 0) continue;
      const ms = inSeg.reduce((acc, e) => acc + e.durationMs, 0);
      const within = ms <= slotMs(s.id) ? 'yes' : 'NO';
      out.push(
        `| ${s.title} | ${clock(s.startS)}–${clock(s.endS)} | ${clock(ms / 1000)} | ${within} |`,
      );
    }
    out.push('');
  }
  return out.join('\n');
}
