/**
 * Time (syscall-abi.md §4.4.6). In test mode `time.now` reads a frozen clock fixture, so agent
 * envelopes and cassettes are reproducible (C12).
 */
import * as v from 'valibot';

import { Count, EpochMs, Finite, TimeZone } from './common.ts';

export const TimeNowArgs = v.strictObject({});
export const TimeNowRet = v.strictObject({
  epochMs: EpochMs,
  monotonicMs: v.pipe(v.number(), v.minValue(0)),
  tz: TimeZone,
  tzOffsetMin: v.pipe(v.number(), v.integer(), v.minValue(-840), v.maxValue(840)),
});

export const SleepArgs = v.strictObject({
  ms: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(2_147_483_647)),
});
export const SleepRet = v.strictObject({ sleptMs: v.pipe(v.number(), v.minValue(0)) });

export const UptimeArgs = v.strictObject({});
export const UptimeRet = v.strictObject({
  bootAt: EpochMs,
  uptimeMs: v.pipe(v.number(), v.minValue(0)),
  users: Count,
  load: v.strictTuple([Finite, Finite, Finite]),
});
