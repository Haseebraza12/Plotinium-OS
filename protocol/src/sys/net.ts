/**
 * Network and sync status (syscall-abi.md §4.4.8). Processes never reach the network themselves
 * (§3.2.3); `syncd` and `lockd` are the only network users and hold `net.sync`, which is
 * kernel-internal. The taskbar renders NetStatus (Spec: MUST, OFF-04).
 */
import * as v from 'valibot';

import { Count, EpochMs } from './common.ts';

export const NetState = v.picklist([
  'online',
  'offline',
  'connecting',
  'resuming',
  'auth-required',
]);

export const NetStatus = v.strictObject({
  state: NetState,
  queuedOps: Count,
  lastAckAt: v.nullable(EpochMs),
  /** Names of degraded services (OFF-04), for example `sync` and `lockd`. */
  degraded: v.pipe(v.array(v.pipe(v.string(), v.maxLength(32))), v.maxLength(32)),
  leaseTtlMs: Count,
  /** The server's build id from `hello.ok`, or null before the first connection. */
  serverBuild: v.nullable(v.pipe(v.string(), v.maxLength(64))),
});

export const NetStatusArgs = v.strictObject({});
export const NetStatusRet = NetStatus;

export const SyncFlushArgs = v.strictObject({
  timeoutMs: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(60_000)),
});
export const SyncFlushRet = v.strictObject({ remaining: v.literal(0) });

export type NetStatus = v.InferOutput<typeof NetStatus>;
export type NetState = v.InferOutput<typeof NetState>;
