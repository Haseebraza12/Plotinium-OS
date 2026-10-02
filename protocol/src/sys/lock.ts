/**
 * Locks (syscall-abi.md §4.4.7; lease protocol in offline-and-sync.md §3.14).
 *
 * Plotinium design (C6): S/X leases with TTL 30 s (15 s in the demo profile), a heartbeat at TTL/3
 * from the kernel worker, and a fencing token on every grant. Offline, leases are local advisory
 * locks (`scope: 'local'`). A process's leases are released when it exits (PROC-07).
 */
import * as v from 'valibot';

import { Count, EpochMs, Fd, Ino, Path } from './common.ts';
import { LeaseInfo, LeaseMode, LeaseScope } from './fs.ts';

/** Fencing token: a positive integer, strictly increasing per inode (offline-and-sync.md §4.2). */
const Fence = v.pipe(v.number(), v.safeInteger(), v.minValue(1));

const AcquireOptions = {
  mode: LeaseMode,
  wait: v.optional(v.boolean(), false),
  timeoutMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(600_000))),
} as const;

export const LockAcquireArgs = v.union([
  v.strictObject({ path: Path, ...AcquireOptions }),
  v.strictObject({ fd: Fd, ...AcquireOptions }),
]);
export const LockAcquireRet = v.strictObject({
  /** The lease id, a UUIDv7 (`locks.lease_id` on the server). */
  leaseId: Ino,
  fence: Fence,
  expiresAt: EpochMs,
  scope: LeaseScope,
});

export const LockReleaseArgs = v.strictObject({ leaseId: Ino });
export const LockReleaseRet = v.strictObject({});

export const LockStatusArgs = v.strictObject({ path: Path });
export const LockStatusRet = v.strictObject({ holders: v.array(LeaseInfo), queued: Count });
