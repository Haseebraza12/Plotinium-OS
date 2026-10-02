/**
 * Memory (syscall-abi.md §4.4.5; semantics in memory-and-paging.md).
 *
 * Plotinium design (C13, MEM-06): admission is reservation-based. `mem.alloc`, `mem.declare` and
 * every page-in reserve budget first and BLOCK (`waitingOn = 'mem'`) until reclaim has freed space.
 * A request that can never fit answers EINVAL `exceeds-budget` (ENOMEM is only requested, C3).
 * `mmap`, `msync` and `munmap` exist only if MEM-08 (MAY) is built.
 */
import * as v from 'valibot';

import { AppId, Count, Ino, Path, Pid, Ratio, SyncState } from './common.ts';

/** A reservation key, unique per process (at most 128 characters). */
export const MemKey = v.pipe(v.string(), v.minLength(1), v.maxLength(128));
export const SegId = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(0xffff_ffff));
/** Page ids are dense integers per process (memory-and-paging.md). */
export const PageId = Count;

export const MemAllocArgs = v.strictObject({
  /** 1..budget; the budget itself is a runtime value checked by the handler. */
  bytes: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
  key: v.optional(MemKey),
  kind: v.optional(v.picklist(['state', 'buffer'])),
});
export const MemAllocRet = v.strictObject({ segId: SegId, bytes: Count });

export const MemDeclareArgs = v.strictObject({
  key: MemKey,
  kind: v.picklist(['arraybuffer', 'imagebitmap', 'wasm', 'other']),
  bytes: Count,
});
/** Re-declaring a key reserves only the delta. */
export const MemDeclareRet = v.strictObject({ key: MemKey, bytes: Count });

export const MemFreeArgs = v.union([
  v.strictObject({ segId: SegId }),
  v.strictObject({ key: MemKey }),
]);
export const MemFreeRet = v.strictObject({ bytes: Count });

export const MemStat = v.strictObject({
  budget: Count,
  accounted: Count,
  reservedWaiting: Count,
  resident: Count,
  swappedLocal: Count,
  swappedRemote: Count,
  speculative: Count,
  embed: v.strictObject({ bytes: Count, state: v.picklist(['absent', 'resident', 'evicted']) }),
  kernel: Count,
  faults: Count,
  faultsPerSec: v.pipe(v.number(), v.minValue(0)),
  hitRatio: Ratio,
  bytesIn: Count,
  bytesOut: Count,
  procs: v.optional(
    v.array(
      v.strictObject({
        pid: Pid,
        accounted: Count,
        resident: Count,
        swapped: Count,
        faults: Count,
        hitRatio: Ratio,
        softLimit: Count,
      }),
    ),
  ),
});

export const MemStatArgs = v.strictObject({ pid: v.optional(Pid) });
export const MemStatRet = MemStat;

/** Every prefetched page is speculative: evicted first, adopted by a later spawn (PRE-04). */
export const MemPrefetchArgs = v.union([
  v.strictObject({ app: AppId }),
  v.strictObject({ ino: Ino, offset: v.optional(Count), len: v.optional(Count) }),
  v.strictObject({ pid: Pid, pages: v.optional(v.pipe(v.array(PageId), v.maxLength(4096))) }),
]);
export const MemPrefetchRet = v.strictObject({ bytes: Count, pages: Count });

export const MemHintArgs = v.strictObject({
  app: AppId,
  ttlMs: v.pipe(v.number(), v.integer(), v.minValue(1000), v.maxValue(600_000)),
});
export const MemHintRet = v.strictObject({});

export const MmapHandle = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(0xffff_ffff));

export const MmapArgs = v.strictObject({ path: Path, flags: v.picklist(['r', 'rw']) });
export const MmapRet = v.strictObject({ handle: MmapHandle, size: Count, pageSize: Count });

export const MsyncArgs = v.strictObject({
  handle: MmapHandle,
  pages: v.optional(v.pipe(v.array(PageId), v.maxLength(4096))),
});
export const MsyncRet = v.strictObject({ version: Count, opId: Ino, sync: SyncState });

export const MunmapArgs = v.strictObject({ handle: MmapHandle });
export const MunmapRet = v.strictObject({});

export type MemStat = v.InferOutput<typeof MemStat>;
