/**
 * Rate classes (backend-api.md §3.9 table, SRV-09). Starting points, to be tuned from the W10 k6
 * measurements; load tests raise capacities through configuration, never through a code path.
 */
import { perPeriod, type BucketSpec } from './bucket.ts';

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MIB = 1024 * 1024;

export type RateKeyKind = 'ip' | 'uid' | 'user-ip' | 'session-target' | 'connection' | 'global';

export interface RateClass {
  /** Keyed buckets (one per key). */
  readonly spec: BucketSpec;
  readonly key: RateKeyKind;
  /** A global bucket shared by every key of the class, for classes that must hold under a key flood. */
  readonly global?: BucketSpec;
}

export const RATE_CLASSES = {
  'login-ip': { key: 'ip', spec: perPeriod(10, MINUTE), global: perPeriod(100, MINUTE) },
  'login-user': { key: 'user-ip', spec: perPeriod(5, 15 * MINUTE) },
  'guest-ip': { key: 'ip', spec: perPeriod(3, HOUR) },
  su: { key: 'session-target', spec: perPeriod(5, 15 * MINUTE) },
  api: { key: 'uid', spec: perPeriod(20, SECOND, 100) },
  ops: { key: 'uid', spec: perPeriod(5, SECOND, 20) },
  snapshot: { key: 'uid', spec: perPeriod(5, SECOND, 20) },
  blob: { key: 'uid', spec: perPeriod(20, SECOND, 100) },
  'blob-bytes': { key: 'uid', spec: perPeriod(100 * MIB, MINUTE) },
  swap: { key: 'uid', spec: perPeriod(20, SECOND, 100) },
  index: { key: 'uid', spec: perPeriod(10, SECOND, 50) },
  verify: { key: 'uid', spec: perPeriod(20, SECOND, 50) },
  llm: { key: 'uid', spec: perPeriod(6, MINUTE, 3) },
  'llm-hour': { key: 'uid', spec: perPeriod(60, HOUR) },
  'llm-examiner-day': { key: 'uid', spec: perPeriod(100, DAY) },
  'llm-demo-day': { key: 'global', spec: perPeriod(20, DAY) },
  telemetry: { key: 'uid', spec: perPeriod(6, MINUTE, 3) },
  admin: { key: 'uid', spec: perPeriod(10, MINUTE) },
  health: { key: 'ip', spec: perPeriod(60, MINUTE) },
  'ws-upgrade': { key: 'ip', spec: perPeriod(30, MINUTE, 10) },
  'ws-frames': { key: 'connection', spec: perPeriod(50, SECOND, 200) },
} as const satisfies Record<string, RateClass>;

export type RateClassName = keyof typeof RATE_CLASSES;

/** Per-class replacements, as `RateLimiterOptions.overrides` takes them. */
export type RateOverrides = Partial<Record<RateClassName, Partial<RateClass>>>;

/** Guest sign-ins per hour per IP outside production (UI-005). */
export const LOCAL_GUEST_PER_HOUR = 60;

/**
 * Class overrides for a deployment profile (`PLOTINIUM_ENV`). Production keeps the table above
 * (guest-ip 3 per hour per IP, §3.9). The `local` and `ci` stacks run every browser on the
 * machine behind one IP (the Docker proxy), so 3 guest sign-ins per hour would lock out a demo,
 * a QA run or an examiner after the third try: there `guest-ip` allows 60 per hour. The profile
 * is configuration, never a code path in a route (§3.9: raised capacities for CI load tests).
 */
export function rateOverridesFor(env: 'local' | 'ci' | 'production'): RateOverrides {
  if (env === 'production') return {};
  return { 'guest-ip': { spec: perPeriod(LOCAL_GUEST_PER_HOUR, HOUR) } };
}

/** Keys per class before the least recently used is evicted (§3.9). */
export const KEYS_PER_CLASS = 10_000;
