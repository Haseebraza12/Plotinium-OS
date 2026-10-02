import { describe, expect, it } from 'vitest';

import {
  between,
  distinctValues,
  isNonDecreasing,
  valueAt,
  type ProgressSample,
} from './progress.ts';

const run: ProgressSample[] = [
  { t: 10, v: 3 },
  { t: 120, v: 9 },
  { t: 480, v: 20 },
  { t: 900, v: 64 },
  { t: 1400, v: 100 },
];

describe('BOOT-02 progress sample analysis', () => {
  it('BOOT-02 valueAt returns the last value shown at or before t and 0 before the first sample', () => {
    expect(valueAt(run, 0)).toBe(0);
    expect(valueAt(run, 10)).toBe(3);
    expect(valueAt(run, 500)).toBe(20);
    expect(valueAt(run, 10_000)).toBe(100);
  });

  it('BOOT-02 a run that moves backwards is detected', () => {
    expect(isNonDecreasing(run)).toBe(true);
    expect(isNonDecreasing([])).toBe(true);
    expect(
      isNonDecreasing([
        { t: 1, v: 40 },
        { t: 2, v: 39 },
      ]),
    ).toBe(false);
  });

  it('BOOT-02 distinct values and windows count the progress steps of a download', () => {
    expect(distinctValues(run)).toBe(5);
    expect(
      distinctValues([
        { t: 1, v: 5 },
        { t: 2, v: 5 },
      ]),
    ).toBe(1);
    expect(between(run, 100, 900).map((s) => s.v)).toEqual([9, 20]);
  });
});
