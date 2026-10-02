import { describe, expect, it } from 'vitest';

import { budget } from './budgets.ts';
import type { Budget, BudgetFile } from './budgets.schema.ts';
import {
  compare,
  currentWeek,
  DEFAULT_BUDGETS,
  evaluate,
  isHard,
  main,
  regression,
  summaryMarkdown,
  type Io,
} from './check-budgets.ts';
import type { PerfResult } from './result.ts';

function result(budgetId: string, value: number, patch: Partial<PerfResult> = {}): PerfResult {
  return {
    budgetId,
    commit: 'a1f93c2',
    build: '0.3.0+a1f93c2',
    machine: {
      class: 'lab-spec',
      cpu: 'Intel Core i5-12500',
      hwc: 12,
      ramGiB: 16,
      os: 'linux 6.8',
    },
    chrome: { version: '153.0.7310.12', channel: 'stable' },
    startedAt: '2026-10-20T21:30:00Z',
    durationMs: 60_000,
    runs: [{ n: 1200, p50: 16.6, p95: value, p99: value, max: value, valid: true }],
    value,
    verdict: 'pass',
    ...patch,
  };
}

const file = (...ids: string[]): BudgetFile => ({
  schema: 1,
  updated: '2026-09-25',
  budgets: ids.map((id) => budget(id)),
});
const one = (b: Budget): BudgetFile => ({ schema: 1, updated: '2026-09-25', budgets: [b] });
const results = (...rs: PerfResult[]): Map<string, unknown> =>
  new Map(rs.map((r) => [r.budgetId, r]));

describe('TST-04 check-budgets', () => {
  it('TST-04 check-budgets exits 1 when a hard budget is exceeded', () => {
    const r = evaluate(file('WM-03.drag-frame'), results(result('WM-03.drag-frame', 33.3)), {
      week: 9,
    });
    expect(r.exitCode).toBe(1);
    expect(r.rows[0]).toMatchObject({ verdict: 'fail', hard: true, value: 33.3 });
  });

  it('TST-04 check-budgets exits 0 when every measured budget passes', () => {
    const r = evaluate(
      file('WM-03.drag-frame', 'WM-03.drag-loaf'),
      results(result('WM-03.drag-frame', 16.67), result('WM-03.drag-loaf', 0)),
      { week: 9 },
    );
    expect(r.exitCode).toBe(0);
    expect(r.rows.map((x) => x.verdict)).toEqual(['pass', 'pass']);
  });

  it('TST-04 check-budgets exits 2 when a lab-only budget has only a hosted result', () => {
    const hosted = result('WM-03.drag-frame', 10, {
      machine: { class: 'hosted', cpu: 'AMD EPYC', hwc: 4, ramGiB: 16, os: 'linux' },
    });
    const r = evaluate(file('WM-03.drag-frame'), results(hosted), { week: 9 });
    expect(r.exitCode).toBe(2);
    expect(r.rows[0]?.note).toMatch(/never gate evidence/);
  });

  it('TST-04 a lab-matched result counts only when the instructor approved it', () => {
    const matched = result('WM-03.drag-frame', 10, {
      machine: { class: 'lab-matched', cpu: 'x', hwc: 12, ramGiB: 16, os: 'linux' },
    });
    expect(evaluate(file('WM-03.drag-frame'), results(matched), { week: 9 }).exitCode).toBe(2);
    expect(
      evaluate(file('WM-03.drag-frame'), results(matched), { week: 9, approvedLabMatched: true })
        .exitCode,
    ).toBe(0);
  });

  it('TST-04 check-budgets exits 2 when a budget due in this cadence was not measured', () => {
    const r = evaluate(
      file('WM-03.drag-frame', 'BOOT-10.boot-js'),
      results(result('WM-03.drag-frame', 10)),
      { week: 9, cadence: 'nightly', machine: 'lab-spec' },
    );
    expect(r.exitCode).toBe(0);
    const pr = evaluate(file('WM-03.drag-frame', 'BOOT-10.boot-js'), new Map(), {
      week: 9,
      cadence: 'pr',
    });
    expect(pr.exitCode).toBe(2);
    expect(pr.rows).toEqual([
      expect.objectContaining({ id: 'BOOT-10.boot-js', verdict: 'missing' }),
    ]);
  });

  it('TST-04 a result for a budget that does not exist is rejected (Q-1)', () => {
    const r = evaluate(file('WM-03.drag-frame'), results(result('WM-03.made-up', 1)), { week: 9 });
    expect(r.exitCode).toBe(2);
    expect(r.rows[0]?.note).toMatch(/no such budget/);
  });

  it('TST-04 more than two invalid runs make the result an infrastructure failure', () => {
    const run = { n: 1000, p50: 16, p95: 16, p99: 17, max: 20, valid: false };
    const r = evaluate(
      file('WM-03.drag-frame'),
      results(result('WM-03.drag-frame', 16, { runs: [run, run, run] })),
      { week: 9 },
    );
    expect(r.exitCode).toBe(2);
    const two = evaluate(
      file('WM-03.drag-frame'),
      results(result('WM-03.drag-frame', 16, { runs: [run, run, { ...run, valid: true }] })),
      { week: 9 },
    );
    expect(two.exitCode).toBe(0);
  });

  it('TST-04 report-only budgets never fail the build and warn levels are flagged', () => {
    expect(
      evaluate(file('RAG-05.cold-reload'), results(result('RAG-05.cold-reload', 9_999)), {
        week: 15,
      }).exitCode,
    ).toBe(0);
    const warm = evaluate(file('BOOT-10.warm'), results(result('BOOT-10.warm', 1300)), { week: 9 });
    expect(warm.rows[0]).toMatchObject({ verdict: 'pass', warn: true });
    expect(summaryMarkdown(warm)).toContain('beyond warn level');
  });

  it('TST-04 a result for another budget or with a mismatched id is invalid', () => {
    const r = evaluate(
      file('WM-03.drag-frame'),
      new Map([['WM-03.drag-frame', result('WM-03.flush', 1)]]),
      { week: 9 },
    );
    expect(r.rows[0]?.note).toMatch(/result is for WM-03\.flush/);
  });

  it('TST-04 a VPS-only budget rejects a result from any other machine', () => {
    const r = evaluate(file('AGT-07.time-to-plan'), results(result('AGT-07.time-to-plan', 10)), {
      week: 15,
    });
    expect(r.rows[0]?.note).toMatch(/production VPS/);
  });
});

describe('TST-19 ratchet budgets', () => {
  const ratchet = (): BudgetFile => file('WM-03.drag-frame');
  const base = { value: 10, commit: 'b2c3d4e5f6', date: '2026-10-01' };

  it('TST-19 a 12% regression against the lab baseline fails a ratchet budget and a 9% regression passes', () => {
    const baselines = new Map([['WM-03.drag-frame', base]]);
    const bad = evaluate(ratchet(), results(result('WM-03.drag-frame', 11.2)), {
      week: 5,
      baselines,
    });
    expect(bad.rows[0]).toMatchObject({ verdict: 'ratchet-fail', hard: false });
    expect(bad.exitCode).toBe(1);
    const ok = evaluate(ratchet(), results(result('WM-03.drag-frame', 10.9)), {
      week: 5,
      baselines,
    });
    expect(ok.rows[0]?.verdict).toBe('ratchet-pass');
    expect(ok.exitCode).toBe(0);
  });

  it('TST-19 before its hard week a budget over the absolute threshold only needs to hold the ratchet', () => {
    const r = evaluate(
      ratchet(),
      results(
        result('WM-03.drag-frame', 30, {
          baseline: { value: 29, commit: 'c0ffee1', date: '2026-10-01' },
        }),
      ),
      { week: 6 },
    );
    expect(r.rows[0]?.verdict).toBe('ratchet-pass');
  });

  it('TST-19 the first result without a baseline passes and becomes the baseline', () => {
    const r = evaluate(ratchet(), results(result('WM-03.drag-frame', 30)), { week: 6 });
    expect(r.rows[0]).toMatchObject({
      verdict: 'ratchet-pass',
      note: expect.stringMatching(/no lab baseline/) as unknown,
    });
  });

  it('TST-19 regression direction follows the budget operator', () => {
    expect(regression(0.7, 0.8, '>=', 10)).toBe(true);
    expect(regression(0.75, 0.8, '>=', 10)).toBe(false);
    expect(regression(1, 0, '==', 10)).toBe(true);
    expect(regression(112, 100, '<', 10)).toBe(true);
    const pure = one({ ...budget('PRE-04.boot-unchanged') });
    expect(
      evaluate(pure, results(result('PRE-04.boot-unchanged', 1.2)), {
        week: 18,
        baselines: new Map([
          ['PRE-04.boot-unchanged', { value: 1, commit: 'abcdef1', date: '2026-12-01' }],
        ]),
      }).exitCode,
    ).toBe(1);
  });

  it('TST-19 a hard budget switches on at its hardFrom week', () => {
    const b = budget('WM-03.drag-frame');
    expect(isHard(b, 6)).toBe(false);
    expect(isHard(b, 7)).toBe(true);
    expect(isHard(budget('PRE-04.boot-unchanged'), 18)).toBe(false);
    expect(compare(1, '<', 1)).toBe(false);
    expect(compare(1, '>', 0)).toBe(true);
    expect(compare(2, '==', 2)).toBe(true);
  });

  it('TST-19 the semester week is counted from the Monday of W1', () => {
    const start = '2026-09-07T00:00:00+05:00';
    expect(currentWeek(start, Date.parse('2026-09-07T09:00:00+05:00'))).toBe(1);
    expect(currentWeek(start, Date.parse('2026-10-20T09:00:00+05:00'))).toBe(7);
    expect(() => currentWeek('someday')).toThrow(RangeError);
  });
});

function fakeIo(
  files: Record<string, string>,
  env: Record<string, string> = {},
): Io & { printed: string[]; appended: string[] } {
  const printed: string[] = [];
  const appended: string[] = [];
  return {
    printed,
    appended,
    env,
    now: () => Date.parse('2026-10-20T12:00:00Z'),
    readFile: (p) =>
      p in files ? Promise.resolve(files[p] as string) : Promise.reject(new Error(`ENOENT ${p}`)),
    readdir: (p) => {
      const names = Object.keys(files)
        .filter((f) => f.startsWith(`${p}/`))
        .map((f) => f.slice(p.length + 1));
      return names.length > 0 ? Promise.resolve(names) : Promise.reject(new Error(`ENOENT ${p}`));
    },
    appendFile: (_p, t) => {
      appended.push(t);
      return Promise.resolve();
    },
    out: (t) => {
      printed.push(t);
    },
  };
}

describe('TST-04 check-budgets command line', () => {
  const budgets = JSON.stringify(file('WM-03.drag-frame', 'WM-03.drag-loaf'));

  it('TST-04 the command exits with the evaluation code and writes the job summary', async () => {
    const io = fakeIo(
      {
        'b.json': budgets,
        'res/WM-03.drag-frame.json': JSON.stringify(result('WM-03.drag-frame', 40)),
        'res/notes.txt': '',
      },
      { GITHUB_STEP_SUMMARY: '/tmp/summary.md' },
    );
    expect(await main(['--budgets', 'b.json', '--results', 'res', '--week', '9'], io)).toBe(1);
    expect(io.printed.join('')).toContain('**FAIL**');
    expect(io.appended).toHaveLength(1);
  });

  it('TST-04 the command applies baselines and derives the week from the semester start', async () => {
    const io = fakeIo(
      {
        'b.json': budgets,
        'res/a.json': JSON.stringify(result('WM-03.drag-frame', 10.5)),
        'base.json': JSON.stringify({
          'WM-03.drag-frame': { value: 10, commit: 'abcdef1', date: '2026-09-01' },
        }),
      },
      { PLT_SEMESTER_START: '2026-09-21T00:00:00Z' },
    );
    expect(
      await main(
        ['--budgets', 'b.json', '--results', 'res', '--baselines', 'base.json', '--summary', ''],
        io,
      ),
    ).toBe(0);
    expect(io.printed.join('')).toContain('ratchet pass');
    expect(io.appended).toHaveLength(0);
  });

  it('TST-04 an unknown week, cadence or machine class is an infrastructure error', async () => {
    const io = fakeIo({ 'b.json': budgets });
    expect(await main(['--budgets', 'b.json'], io)).toBe(2);
    expect(await main(['--budgets', 'b.json', '--week', '0'], io)).toBe(2);
    expect(await main(['--budgets', 'b.json', '--week', '3', '--cadence', 'hourly'], io)).toBe(2);
    expect(await main(['--budgets', 'b.json', '--week', '3', '--machine', 'laptop'], io)).toBe(2);
    expect(await main(['--bogus'], io)).toBe(2);
    expect(io.printed.join('')).toMatch(/week is unknown/);
  });

  it('TST-04 a missing results directory with a due cadence exits 2 and PLT_WEEK is honoured', async () => {
    const io = fakeIo({ 'b.json': budgets }, { PLT_WEEK: '9' });
    expect(
      await main(['--budgets', 'b.json', '--results', 'none', '--cadence', 'nightly'], io),
    ).toBe(2);
    expect(DEFAULT_BUDGETS).toMatch(/budgets\.json$/);
  });
});
