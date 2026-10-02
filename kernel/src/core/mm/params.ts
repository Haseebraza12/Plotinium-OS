/**
 * Memory-manager constants (specs/03-kernel/memory-and-paging.md §3.1).
 *
 * Every value here is the spec default. The *Settings* values (`mm.budget`, `mm.softLimit`,
 * `mm.swap.tier`) are changed at run time through `MemoryManager.setBudget` / `setSoftLimit` /
 * `setTier`; the rest are fixed design constants, overridable only for tests through
 * `resolveParams`. Sizes are binary: 1 MiB = 1,048,576 bytes; the spec's "256 MB" is 256 MiB.
 *
 * Owner: R1 Kernel. Reviewer: R2 VFS/DB.
 */

export const KiB = 1_024;
export const MiB = 1_048_576;
export const GiB = 1_073_741_824;

export interface MmParams {
  /** MM_BUDGET: global budget of `committed` (MEM-01). Settings range 64 MiB … 2 GiB. */
  readonly budget: number;
  /** MM_SOFT_LIMIT: per-process soft limit (MEM-01). Settings range 8 MiB … budget. */
  readonly softLimit: number;
  /** PAGE_CHUNK: fixed chunk size for large buffers. */
  readonly pageChunk: number;
  /** LOGICAL_PAGE_MAX: a logical page above this must be allocated as chunks (EINVAL). */
  readonly logicalPageMax: number;
  /** STATE_SOFT: encoded-state warning threshold. */
  readonly stateSoft: number;
  /** STATE_MAX: encoded-state hard limit; above it the state page is pinned (non-pageable). */
  readonly stateMax: number;
  /** STATE_HEADROOM: standing reservation per resident checkpointable process. */
  readonly stateHeadroom: number;
  /** Default initial state reservation of a spawn (§3.7.2). */
  readonly initialStateBytes: number;
  /** OVERHEAD_PROC: charged per process resident on an executor (calibrated). */
  readonly overheadProc: number;
  /** HIGH_WM: background reclaim starts when committed > highWm · budget (KMM-05). */
  readonly highWm: number;
  /** LOW_WM: background reclaim stops when committed ≤ lowWm · budget (KMM-05). */
  readonly lowWm: number;
  /** MEM_WAIT_MAX_MS: a reservation still blocked after this fails with EAGAIN `mem-pressure`. */
  readonly memWaitMaxMs: number;
  /** BLKIO_INFLIGHT: page-outs queued to blkio at once (pipelining). */
  readonly blkioInflight: number;
  /** UPLOAD_CONCURRENCY: parallel tier-2 uploads. */
  readonly uploadConcurrency: number;
  /** Tier-2 retry back-off: 1, 2, 4 … capped at this many ms. */
  readonly uploadBackoffMaxMs: number;
  /** A tier-2 upload is marked `failed` after this many attempts. */
  readonly uploadMaxAttempts: number;
  /** THRASH_ON: major faults per second above which a second counts toward the on-streak. */
  readonly thrashOnRate: number;
  /** THRASH_OFF: major faults per second below which a second counts toward the off-streak. */
  readonly thrashOffRate: number;
  /** Consecutive seconds for both hysteresis edges. */
  readonly thrashSeconds: number;
  /** HEAVY_BYTES: a spawn whose initial reservation exceeds this is heavy. */
  readonly heavyBytes: number;
  /** WS_WINDOW_MS: working-set window Δ. */
  readonly wsWindowMs: number;
  /** RESTORE_PROGRESS_MS: maximum interval between "Restoring…" updates. */
  readonly restoreProgressMs: number;
  /** SWAP_KEEP_DAYS: local swap of an unreferenced OS session is swept after this. */
  readonly swapKeepDays: number;
  /** Pages per process are addressed by uint32 ids below this bound (§3.4). */
  readonly pagesPerProcess: number;
}

export const DEFAULT_PARAMS: MmParams = Object.freeze({
  budget: 256 * MiB,
  softLimit: 64 * MiB,
  pageChunk: 256 * KiB,
  logicalPageMax: 8 * MiB,
  stateSoft: 1 * MiB,
  stateMax: 16 * MiB,
  stateHeadroom: 256 * KiB,
  initialStateBytes: 64 * KiB,
  overheadProc: 64 * KiB,
  highWm: 0.85,
  lowWm: 0.75,
  memWaitMaxMs: 10_000,
  blkioInflight: 4,
  uploadConcurrency: 2,
  uploadBackoffMaxMs: 60_000,
  uploadMaxAttempts: 5,
  thrashOnRate: 20,
  thrashOffRate: 10,
  thrashSeconds: 5,
  heavyBytes: 16 * MiB,
  wsWindowMs: 5_000,
  restoreProgressMs: 100,
  swapKeepDays: 14,
  pagesPerProcess: 2 ** 20,
});

/** Settings bounds for `mm.budget` and `mm.softLimit` (§3.1). */
export const BUDGET_MIN = 64 * MiB;
export const BUDGET_MAX = 2 * GiB;
export const SOFT_LIMIT_MIN = 8 * MiB;

/** Bytes of the 64-byte page-file header (§3.8.1). */
export const PAGE_HEADER_BYTES = 64;

/** LOCAL_SWAP_CAP = min(2 GiB, 25 % of the storage quota) (§3.1). */
export function localSwapCap(quotaBytes: number): number {
  if (!Number.isFinite(quotaBytes) || quotaBytes <= 0) return 2 * GiB;
  return Math.min(2 * GiB, Math.floor(quotaBytes * 0.25));
}

/** TIER2_PRESSURE: local quota pressure when usage / quota > 0.8 (§3.1). */
export function tier2Pressure(usageBytes: number, quotaBytes: number): boolean {
  return quotaBytes > 0 && usageBytes / quotaBytes > 0.8;
}

/** Merge test or calibration overrides into the defaults, validating the invariants. */
export function resolveParams(overrides: Partial<MmParams> = {}): MmParams {
  const p: MmParams = { ...DEFAULT_PARAMS, ...overrides };
  if (!(p.lowWm > 0 && p.lowWm < p.highWm && p.highWm <= 1)) {
    throw new RangeError(`mm params: need 0 < lowWm < highWm ≤ 1 (got ${p.lowWm}, ${p.highWm})`);
  }
  if (!(p.budget > 0) || !(p.pageChunk > 0) || !(p.blkioInflight >= 1)) {
    throw new RangeError('mm params: budget, pageChunk and blkioInflight must be positive');
  }
  return Object.freeze(p);
}
