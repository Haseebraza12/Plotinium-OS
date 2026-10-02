import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { calibrationRate, loadCalibration } from './calibration.ts';

describe('TST-21 hosted-runner calibration', () => {
  it('TST-21 calibration rate is 1 when the hosted runner is slower than the lab machine', () => {
    expect(calibrationRate([900, 1000, 1100], [2000, 2100, 1900])).toBe(1);
  });

  it('TST-21 a faster hosted runner is throttled by the ratio of median wall times', () => {
    expect(calibrationRate([4000, 4200, 3800, 4100, 3900], [2000, 1900, 2100, 2050, 1950])).toBe(2);
    expect(() => calibrationRate([], [1])).toThrow(RangeError);
  });

  it('TST-21 the committed record is consistent: no timings means no throttling', () => {
    expect(loadCalibration().rate).toBe(1);
  });

  it('TST-21 a record whose rate disagrees with its timings is rejected', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'plt-cal-'));
    try {
      const bad = join(dir, 'bad.json');
      await writeFile(
        bad,
        JSON.stringify({
          rate: 3,
          measuredAt: '2026-09-15',
          runnerImage: 'ubuntu-24.04',
          labMs: [4000],
          runnerMs: [2000],
        }),
      );
      expect(() => loadCalibration(bad)).toThrow(/does not match/);
      const orphan = join(dir, 'orphan.json');
      await writeFile(
        orphan,
        JSON.stringify({ rate: 2, measuredAt: null, runnerImage: null, labMs: [], runnerMs: [] }),
      );
      expect(() => loadCalibration(orphan)).toThrow(/no timings/);
      const ok = join(dir, 'ok.json');
      await writeFile(
        ok,
        JSON.stringify({
          rate: 2,
          measuredAt: '2026-09-15',
          runnerImage: 'ubuntu-24.04',
          labMs: [4000],
          runnerMs: [2000],
        }),
      );
      expect(loadCalibration(ok).rate).toBe(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
