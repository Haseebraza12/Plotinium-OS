/**
 * check-budgets (spec §5.4; TST-04, TST-06, TST-19). Compares perf result files with budgets.json.
 *
 *   node tests/performance/check-budgets.ts --results test-results/perf --cadence nightly \
 *        --machine lab-spec --week 9 [--baselines baselines.json] [--summary file]
 *
 * Exit codes (spec §6.2): 0 pass; 1 a requirement failed (a real regression); 2 infrastructure
 * (a budget due in this run was not measured, a lab-only budget has no lab result, a result file is
 * not evidence, runs were invalid more than twice, or the week is unknown). 2 wins over 1: a run
 * that is not trustworthy proves nothing either way.
 *
 * The spec places this tool at tools/check-budgets.ts; it lives here until the harness is folded
 * into the root tooling, and `tools/check-budgets.ts` can re-export `main`.
 */
import { appendFile, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import {
  parseBudgetFile,
  weekNumber,
  type Budget,
  type BudgetFile,
  type Cadence,
  type MachineClass,
  type Op,
} from './budgets.schema.ts';
import { validatePerfResult, type PerfResult, type Verdict } from './result.ts';

export interface Baseline {
  value: number;
  commit: string;
  date: string;
}

export interface CheckOptions {
  week: number;
  /** This run's cadence: a budget due in it but not measured is an infrastructure failure. */
  cadence?: Cadence;
  /** Restrict to budgets measured on this machine class (plus machine `any`). */
  machine?: MachineClass;
  /** Whether the instructor accepted `lab-matched` machines as evidence (open question 2). */
  approvedLabMatched?: boolean;
  /** Last accepted lab baselines on main, by budget id. */
  baselines?: ReadonlyMap<string, Baseline>;
}

export type RowVerdict = Verdict | 'missing' | 'skipped';

export interface Row {
  id: string;
  verdict: RowVerdict;
  hard: boolean;
  value?: number;
  threshold: number;
  op: Op;
  unit: string;
  warn: boolean;
  note?: string;
}

export interface Report {
  rows: Row[];
  exitCode: 0 | 1 | 2;
}

export const DEFAULT_RATCHET_PCT = 10;

export function compare(value: number, op: Op, threshold: number): boolean {
  switch (op) {
    case '<=':
      return value <= threshold;
    case '<':
      return value < threshold;
    case '>=':
      return value >= threshold;
    case '>':
      return value > threshold;
    case '==':
      return value === threshold;
  }
}

/** §5.4: a regression of more than `pct` percent against the baseline, in the budget's direction. */
export function regression(value: number, base: number, op: Op, pct: number): boolean {
  if (op === '>=' || op === '>') return value < base * (1 - pct / 100);
  if (op === '==') return value !== base;
  return value > base * (1 + pct / 100);
}

export function isHard(b: Budget, week: number): boolean {
  return b.kind === 'hard' && b.hardFrom !== undefined && week >= weekNumber(b.hardFrom);
}

/** Week of the semester (W1 starts on `startIso`), for the hardFrom switch (§3.11.5). */
export function currentWeek(startIso: string, now: number = Date.now()): number {
  const start = Date.parse(startIso);
  if (Number.isNaN(start)) throw new RangeError(`not a date: ${startIso}`);
  return Math.floor((now - start) / (7 * 24 * 3600 * 1000)) + 1;
}

function inScope(b: Budget, opts: CheckOptions): boolean {
  if (opts.cadence !== undefined && !b.cadence.includes(opts.cadence)) return false;
  return opts.machine === undefined || b.machine === opts.machine || b.machine === 'any';
}

function machineOk(b: Budget, r: PerfResult, opts: CheckOptions): string | undefined {
  const cls = r.machine.class;
  if (
    b.machine === 'lab-spec' &&
    !(cls === 'lab-spec' || (cls === 'lab-matched' && opts.approvedLabMatched === true))
  ) {
    return `lab-only budget measured on a '${cls}' machine: never gate evidence (T-5)`;
  }
  if (b.machine === 'vps' && cls !== 'vps')
    return `budget must be measured from the production VPS, got '${cls}'`;
  return undefined;
}

function evaluateOne(b: Budget, raw: unknown, opts: CheckOptions): Row {
  const hard = isHard(b, opts.week);
  const base: Row = {
    id: b.id,
    verdict: 'invalid',
    hard,
    threshold: b.threshold,
    op: b.op,
    unit: b.unit,
    warn: false,
  };
  const errors = validatePerfResult(raw, b.method);
  if (errors.length > 0) return { ...base, note: errors.join('; ') };
  const r = raw as PerfResult;
  if (r.budgetId !== b.id) return { ...base, note: `result is for ${r.budgetId}` };
  const wrongMachine = machineOk(b, r, opts);
  if (wrongMachine !== undefined) return { ...base, value: r.value, note: wrongMachine };
  const invalidRuns = r.runs.filter((run) => !run.valid).length;
  if (invalidRuns > 2) return { ...base, value: r.value, note: `${invalidRuns} invalid runs` };

  const warn = b.warn !== undefined && !compare(r.value, b.op, b.warn);
  const row: Row = { ...base, value: r.value, warn };
  if (b.kind === 'report') return { ...row, verdict: 'report' };
  if (hard) return { ...row, verdict: compare(r.value, b.op, b.threshold) ? 'pass' : 'fail' };
  const baseline = opts.baselines?.get(b.id) ?? r.baseline;
  if (baseline === undefined)
    return { ...row, verdict: 'ratchet-pass', note: 'no lab baseline yet: this result becomes it' };
  const pct = b.ratchetPct ?? DEFAULT_RATCHET_PCT;
  const regressed = regression(r.value, baseline.value, b.op, pct);
  return {
    ...row,
    verdict: regressed ? 'ratchet-fail' : 'ratchet-pass',
    note: `baseline ${baseline.value} (${baseline.commit.slice(0, 7)}, ${baseline.date}), ratchet ${pct}%`,
  };
}

export function evaluate(
  file: BudgetFile,
  results: ReadonlyMap<string, unknown>,
  opts: CheckOptions,
): Report {
  const rows: Row[] = [];
  for (const b of file.budgets) {
    const raw = results.get(b.id);
    const due = opts.cadence !== undefined && inScope(b, opts);
    if (raw === undefined) {
      if (due) {
        rows.push({
          id: b.id,
          verdict: 'missing',
          hard: isHard(b, opts.week),
          threshold: b.threshold,
          op: b.op,
          unit: b.unit,
          warn: false,
          note: `due in the ${opts.cadence} run but not measured`,
        });
      }
      continue;
    }
    rows.push(evaluateOne(b, raw, opts));
  }
  const unknown = [...results.keys()].filter((id) => !file.budgets.some((b) => b.id === id));
  for (const id of unknown) {
    rows.push({
      id,
      verdict: 'invalid',
      hard: false,
      threshold: Number.NaN,
      op: '==',
      unit: '',
      warn: false,
      note: 'no such budget in budgets.json (Q-1)',
    });
  }
  const infra = rows.some((r) => r.verdict === 'missing' || r.verdict === 'invalid');
  const failed = rows.some((r) => r.verdict === 'fail' || r.verdict === 'ratchet-fail');
  return { rows, exitCode: infra ? 2 : failed ? 1 : 0 };
}

const ICON: Record<RowVerdict, string> = {
  pass: 'pass',
  fail: '**FAIL**',
  'ratchet-pass': 'ratchet pass',
  'ratchet-fail': '**RATCHET FAIL**',
  invalid: '**INVALID**',
  report: 'report',
  missing: '**MISSING**',
  skipped: 'skipped',
};

export function summaryMarkdown(report: Report): string {
  const lines = [
    '## Performance budgets',
    '',
    `Exit code ${report.exitCode} (0 pass, 1 regression, 2 infrastructure).`,
    '',
    '| Budget | Verdict | Value | Target | Note |',
    '|---|---|---|---|---|',
  ];
  for (const r of report.rows) {
    const value = r.value === undefined ? '–' : `${r.value} ${r.unit}`;
    const target = Number.isNaN(r.threshold)
      ? '–'
      : `${r.op} ${r.threshold} ${r.unit}${r.hard ? '' : ' (not hard yet)'}`;
    const note = [r.warn ? 'beyond warn level' : '', r.note ?? '']
      .filter((s) => s !== '')
      .join('; ');
    lines.push(`| \`${r.id}\` | ${ICON[r.verdict]} | ${value} | ${target} | ${note} |`);
  }
  return `${lines.join('\n')}\n`;
}

export interface Io {
  readFile(path: string): Promise<string>;
  readdir(path: string): Promise<string[]>;
  appendFile(path: string, text: string): Promise<void>;
  out(text: string): void;
  env: Readonly<Record<string, string | undefined>>;
  now(): number;
}

export const nodeIo: Io = {
  readFile: (p) => readFile(p, 'utf8'),
  readdir: (p) => readdir(p),
  appendFile: (p, t) => appendFile(p, t),
  out: (t) => {
    process.stdout.write(t);
  },
  env: process.env,
  now: () => Date.now(),
};

export const DEFAULT_BUDGETS = fileURLToPath(new URL('./budgets.json', import.meta.url));

async function loadResults(io: Io, dir: string): Promise<Map<string, unknown>> {
  const out = new Map<string, unknown>();
  let names: string[];
  try {
    names = await io.readdir(dir);
  } catch {
    return out;
  }
  for (const name of names.filter((n) => n.endsWith('.json')).sort()) {
    const data: unknown = JSON.parse(await io.readFile(join(dir, name)));
    const id =
      typeof data === 'object' && data !== null && 'budgetId' in data ? data.budgetId : undefined;
    out.set(typeof id === 'string' ? id : name.slice(0, -'.json'.length), data);
  }
  return out;
}

const CADENCES: readonly string[] = ['pr', 'main', 'nightly', 'release', 'weekly'];
const MACHINES: readonly string[] = ['lab-spec', 'lab-matched', 'hosted', 'vps', 'any'];

function parseCli(argv: readonly string[]) {
  return parseArgs({
    args: [...argv],
    options: {
      budgets: { type: 'string', default: DEFAULT_BUDGETS },
      results: { type: 'string', default: join('test-results', 'perf') },
      cadence: { type: 'string' },
      machine: { type: 'string' },
      week: { type: 'string' },
      baselines: { type: 'string' },
      summary: { type: 'string' },
      'approved-lab-matched': { type: 'boolean', default: false },
    },
    strict: true,
  }).values;
}

/** CLI entry point; returns the exit code. */
export async function main(argv: readonly string[], io: Io = nodeIo): Promise<number> {
  let values: ReturnType<typeof parseCli>;
  try {
    values = parseCli(argv);
  } catch (err) {
    io.out(`check-budgets: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
  if (values.cadence !== undefined && !CADENCES.includes(values.cadence)) {
    io.out(`check-budgets: unknown cadence ${values.cadence}\n`);
    return 2;
  }
  if (values.machine !== undefined && !MACHINES.includes(values.machine)) {
    io.out(`check-budgets: unknown machine class ${values.machine}\n`);
    return 2;
  }
  let week: number;
  const start = io.env['PLT_SEMESTER_START'];
  if (values.week !== undefined) week = Number(values.week);
  else if (io.env['PLT_WEEK'] !== undefined) week = Number(io.env['PLT_WEEK']);
  else if (start !== undefined) week = currentWeek(start, io.now());
  else {
    io.out(
      'check-budgets: the semester week is unknown; pass --week, PLT_WEEK or PLT_SEMESTER_START\n',
    );
    return 2;
  }
  if (!Number.isInteger(week) || week < 1) {
    io.out(`check-budgets: bad week ${week}\n`);
    return 2;
  }

  const file = parseBudgetFile(JSON.parse(await io.readFile(values.budgets)));
  const baselines = new Map<string, Baseline>();
  if (values.baselines !== undefined) {
    const raw: unknown = JSON.parse(await io.readFile(values.baselines));
    if (typeof raw === 'object' && raw !== null) {
      for (const [id, b] of Object.entries(raw)) baselines.set(id, b as Baseline);
    }
  }
  const report = evaluate(file, await loadResults(io, values.results), {
    week,
    cadence: values.cadence as Cadence | undefined,
    machine: values.machine as MachineClass | undefined,
    approvedLabMatched: values['approved-lab-matched'],
    baselines,
  });
  const md = summaryMarkdown(report);
  io.out(md);
  const summary = values.summary ?? io.env['GITHUB_STEP_SUMMARY'];
  if (summary !== undefined && summary !== '') await io.appendFile(summary, md);
  return report.exitCode;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
