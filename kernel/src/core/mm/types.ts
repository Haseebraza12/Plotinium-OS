/**
 * Page-table and memory-statistics types (specs/03-kernel/memory-and-paging.md §4.1, §4.6).
 *
 * `[spec]` marks the §9.2 page-table fields (location, dirty bit, last-access time, size, checksum).
 * Everything else is Plotinium design (KMM-03 dual location for write-behind, KMM-04 segments).
 */

/** Page kinds (§3.4). */
export type PageKind = 'state' | 'logical' | 'chunk' | 'worker' | 'segment' | 'mmap';

/** [spec] Where the authoritative bytes are, plus BACKED for clean re-creatable pages. */
export type Loc = 'RESIDENT' | 'LOCAL_SWAP' | 'REMOTE_SWAP' | 'BACKED';

/** Pinning rules P1..P6 of §3.5.2. */
export type PinReason = 'focus' | 'service' | 'np-section' | 'io' | 'ai-search' | 'non-restartable';

/** The LRU segments of §3.5.1, from the MRU end to the LRU end: HOT, COLD, SPEC. */
export type LruSeg = 'HOT' | 'COLD' | 'SPEC';

export type LocalCopy = 'none' | 'valid' | 'stale';
export type RemoteCopy = 'none' | 'pending' | 'acked' | 'stale' | 'failed';

export interface PTE {
  pageId: number;
  kind: PageKind;
  label: string;
  /** [spec] size in bytes (body). */
  size: number;
  /** [spec] where the authoritative bytes are. */
  loc: Loc;
  /** [spec] dirty bit. */
  dirty: boolean;
  /** [spec] last-access time (kernel monotonic ms). */
  lastAccess: number;
  /** [spec] SHA-256 hex of the current generation's body ('' before the first encoding). */
  sha256: string;
  /** Generation: increments at every page-out of a dirty page (swap files carry it). */
  gen: number;
  /** State of the tier-1 copy of the current generation. */
  local: LocalCopy;
  /** State of the tier-2 copy of the current generation. */
  remote: RemoteCopy;
  /** Swap key of a page restored from another OS session (§3.12.3). */
  origin?: { osSessionId: string; pid: number };
  /** BACKED pages: the durable source (`model`, a vector segment store, a file for mmap). */
  backing?: { store: string; ref: string };
  /** Effective pin count (process-level plus page-level reasons). */
  pins: number;
  pinReasons: PinReason[];
  speculative: boolean;
  /** A page-out or page-in is in flight (pinning rule P4). */
  busy: boolean;
  /** -1 when the page is not in the LRU; 0 when it is (dsa/lru keeps its slot index private). */
  lruSlot: number;
  seg: LruSeg;
  faults: number;
  hits: number;
}

export interface ProcMemStats {
  faults: number;
  hits: number;
  bytesIn: number;
  bytesOut: number;
  lastPageInMs: number | null;
  /** Σ size of pages with a valid local copy (resident or not). */
  swapLocalBytes: number;
  /** Σ size of pages with an acknowledged remote copy. */
  swapRemoteBytes: number;
  /** Σ size of pages that are not resident (the ps SWAP column). */
  pagedOutBytes: number;
  minimised: boolean;
  overSoftLimit: boolean;
}

export type SwapTier = 'auto' | 'local' | 'remote';
export type ReclaimMode = 'idle' | 'background' | 'direct';

export interface MemSummary {
  budget: number;
  accounted: number;
  reserved: number;
  committed: number;
  free: number;
  avail: number;
  pinned: number;
  speculative: number;
  kernelBytes: number;
  swapLocal: {
    device: 'opfs' | 'idb' | 'memory';
    bytes: number;
    cap: number;
    pages: number;
    degraded: boolean;
  };
  swapRemote: {
    bytes: number;
    pages: number;
    pending: number;
    failed: number;
    tier: SwapTier;
    online: boolean;
  };
  faultsPerSec: number;
  hitRatio: number;
  pagesInPerSec: number;
  pagesOutPerSec: number;
  bytesInPerSec: number;
  bytesOutPerSec: number;
  uploadPerSec: number;
  thrashing: boolean;
  reclaim: ReclaimMode;
  blocked: number;
  oldestBlockedMs: number;
  maxOverBudgetMs: number;
  hint: { app: string; ttlMs: number } | null;
}

export type KlogMemEvent =
  | 'reserve-block'
  | 'reserve-grant'
  | 'reserve-timeout'
  | 'page-out'
  | 'page-in'
  | 'drop'
  | 'fault'
  | 'suspend'
  | 'checkpoint'
  | 'upload'
  | 'upload-fail'
  | 'verify-fail'
  | 'thrash-on'
  | 'thrash-off'
  | 'hint-skip'
  | 'over-budget'
  | 'device-degraded'
  | 'sweep'
  | 'soft-limit'
  | 'state-soft';

/**
 * klog memory record (§4.6) without `seq`, which the klog ring assigns. `soft-limit` and
 * `state-soft` are the §3.3 and §3.2.2 warnings. TODO(protocol): move beside the klog types when
 * the klog module lands.
 */
export interface KlogMem {
  t: number;
  kind: 'mem';
  ev: KlogMemEvent;
  pid?: number;
  pageId?: number;
  bytes?: number;
  ms?: number;
  detail?: string;
}
