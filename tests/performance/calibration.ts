/**
 * Hosted-runner calibration (spec §3.13, TST-21). The CPU-score workload runs 5 times on the lab
 * machine and on a hosted runner; the CDP CPU-throttling rate for hosted smoke runs is
 * `max(1, t_lab / t_runner)` over median wall times. A hosted result is never gate evidence.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { median } from '../support/percentile.ts';

export interface CalibrationRecord {
  /** The throttling rate hosted perf smoke runs apply. */
  rate: number;
  measuredAt: string | null;
  runnerImage: string | null;
  labMs: number[];
  runnerMs: number[];
  note?: string;
}

export const CALIBRATION_PATH = fileURLToPath(new URL('./calibration.json', import.meta.url));

export function calibrationRate(labMs: readonly number[], runnerMs: readonly number[]): number {
  if (labMs.length === 0 || runnerMs.length === 0)
    throw new RangeError('calibration needs lab and runner timings');
  return Math.max(1, median(labMs) / median(runnerMs));
}

/** Reads the committed record; an unmeasured record (no timings yet) throttles by 1 (none). */
export function loadCalibration(path: string = CALIBRATION_PATH): CalibrationRecord {
  const rec = JSON.parse(readFileSync(path, 'utf8')) as CalibrationRecord;
  if (rec.labMs.length > 0 && rec.runnerMs.length > 0) {
    const expected = calibrationRate(rec.labMs, rec.runnerMs);
    if (Math.abs(expected - rec.rate) > 1e-9) {
      throw new RangeError(
        `calibration.json rate ${rec.rate} does not match its timings (${expected})`,
      );
    }
  } else if (rec.rate !== 1) {
    throw new RangeError('calibration.json has a rate but no timings');
  }
  return rec;
}
