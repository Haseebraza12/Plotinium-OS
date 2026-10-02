import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  gitCommit,
  machineClass,
  machineInfo,
  resultsDir,
  validatePerfResult,
  writePerfResult,
  type PerfResult,
} from './result.ts';

const good: PerfResult = {
  budgetId: 'BOOT-10.warm',
  commit: 'a1f93c2',
  build: '0.3.0+a1f93c2',
  machine: {
    class: 'lab-spec',
    cpu: 'Intel Core i5-12500',
    hwc: 12,
    ramGiB: 16,
    os: 'linux 6.8',
    refreshHz: 60,
    dpr: 1,
  },
  chrome: { version: '153.0.7310.12', channel: 'stable' },
  startedAt: '2026-10-20T21:30:00Z',
  durationMs: 42_000,
  runs: [{ n: 20, p50: 700, p95: 820, p99: 820, max: 820, valid: true }],
  value: 820,
  verdict: 'pass',
};

describe('TST-06 performance result files', () => {
  it('TST-06 a complete result is accepted', () => {
    expect(validatePerfResult(good, 'boot-harness')).toEqual([]);
  });

  it('TST-06 a result file without machine, Chrome version or commit is rejected', () => {
    const { machine: _m, ...noMachine } = good;
    expect(validatePerfResult(noMachine)).toContain('machine missing');
    const { chrome: _c, ...noChrome } = good;
    expect(validatePerfResult(noChrome, 'boot-harness')).toContain(
      'chrome version missing for browser method boot-harness',
    );
    expect(validatePerfResult(noChrome, 'db-bench')).toEqual([]);
    expect(validatePerfResult({ ...good, commit: '' })).toContain(
      'commit missing or not a git sha',
    );
  });

  it('TST-06 malformed machine, chrome, time and runs fields are each reported', () => {
    const bad = {
      ...good,
      budgetId: '',
      build: 3,
      machine: { class: 'desk', cpu: '', hwc: 'many' },
      chrome: { version: '153' },
      startedAt: 'yesterday',
      durationMs: Number.NaN,
      runs: [{ n: 0 }],
      value: 'fast',
    };
    expect(validatePerfResult(bad)).toEqual([
      'budgetId missing',
      'build missing',
      'machine.class missing or unknown',
      'machine.cpu missing',
      'machine.hwc, ramGiB or os missing',
      'chrome must carry version and channel',
      'startedAt missing',
      'durationMs missing',
      'every run needs a sample count n and valid',
      'value missing',
    ]);
    expect(validatePerfResult([])).toEqual(['result is not an object']);
    expect(validatePerfResult({ ...good, runs: [] })).toContain('runs missing');
  });

  it('TST-06 only an explicit lab runner is lab-spec; everything else is hosted', () => {
    expect(machineClass({ PLT_MACHINE_CLASS: 'lab-spec' })).toBe('lab-spec');
    expect(machineClass({ PLT_MACHINE_CLASS: 'vps' })).toBe('vps');
    expect(machineClass({ PLT_MACHINE_CLASS: 'my-laptop' })).toBe('hosted');
    expect(machineClass({})).toBe('hosted');
    const m = machineInfo('hosted', { refreshHz: 120 });
    expect(m.hwc).toBeGreaterThan(0);
    expect(m.refreshHz).toBe(120);
    expect(gitCommit({ GITHUB_SHA: 'abc1234' })).toBe('abc1234');
    expect(gitCommit({})).toBe('0000000');
    expect(resultsDir({ PLT_PERF_RESULTS: '/x' })).toBe('/x');
    expect(resultsDir({})).toBe(join('test-results', 'perf'));
  });

  it('TST-06 results are written as <budget-id>.json and invalid ones are refused', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'plt-perf-'));
    try {
      const file = await writePerfResult(good, dir);
      expect(file).toBe(join(dir, 'BOOT-10.warm.json'));
      expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(good);
      await expect(writePerfResult({ ...good, commit: 'x' }, dir)).rejects.toThrow(
        /invalid result/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
