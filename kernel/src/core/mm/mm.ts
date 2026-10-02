/**
 * The memory manager (specs/03-kernel/memory-and-paging.md; MEM-01…07, WM-05 paging side,
 * KMM-01…13). Runs in the kernel worker; thread-agnostic: the executors, the swap devices, the
 * clock and the scheduler are reached through the interfaces below, so the whole manager runs
 * unchanged under the Node loopback host and in unit tests.
 *
 *   Accounting (§3.2)          ./accounting.ts — accounted(pid), committed, the Kernel line
 *   Admission (§3.7)           ./reserve.ts    — reservations, INV-M1, maxOverBudgetMs
 *   Global LRU (§3.5)          ./lru.ts        — HOT / COLD / SPEC over dsa/lru; pins P1-P6
 *   Reclaim (§3.6)             ./reclaim.ts    — watermarks and victim handling (this file runs it)
 *   Codec (§3.8)               ./codec.ts      — the executors encode; blkio and mm verify
 *   Tier 1 / tier 2 (§3.10-11) ./swap.ts, ./remote.ts, ./writebehind.ts
 *   Thrashing guard (§3.14)    ./thrash.ts
 *   free / vmstat / pmap       ./stats.ts
 *
 * Page-out protocol (§3.9.1, MEM-03): a victim is made busy (out of the LRU, P4); the executor
 * hashes and transfers its bytes; tier 1 writes, reads back and verifies; ONLY THEN is the charge
 * removed (INV-M2). A fault on a page in transit waits for the write and gets the buffer back
 * with no read. A clean page with a valid copy is dropped without any write (Spec §9.2).
 */
import type { EventData, MemStat } from '@plotinium/protocol';

import {
  accountedOf,
  DEFAULT_CALIBRATION,
  dropLocation,
  isClean,
  kernelLine,
  newProcMem,
  recountResident,
} from './accounting.ts';
import type { CalibrationConstants, KernelStructure, ProcMem } from './accounting.ts';
import { encodeRaw, joinPageFile, sha256Hex } from './codec.ts';
import { MmError } from './errors.ts';
import { PageLru, pageKey, splitPageKey } from './lru.ts';
import type { LruFactory } from './lru.ts';
import {
  BUDGET_MAX,
  BUDGET_MIN,
  PAGE_HEADER_BYTES,
  resolveParams,
  SOFT_LIMIT_MIN,
} from './params.ts';
import type { MmParams } from './params.ts';
import {
  hintSkips,
  reclaimNeed,
  segmentFor,
  shouldStartBackground,
  victimAction,
  watermarks,
} from './reclaim.ts';
import { Reservations } from './reserve.ts';
import type { HeapFactory, MmClock, Ticket } from './reserve.ts';
import { pmapReport, vmstatProcRow } from './stats.ts';
import type { FreeReport, PmapReport, VmCounters, VmstatProcRow } from './stats.ts';
import type { ProgressFn, RemoteSwap, SwapDevice, SwapKey } from './swap.ts';
import { ThrashingGuard } from './thrash.ts';
import type {
  KlogMem,
  KlogMemEvent,
  MemSummary,
  PageKind,
  PinReason,
  PTE,
  ReclaimMode,
  SwapTier,
} from './types.ts';
import { WriteBehindQueue } from './writebehind.ts';

// ---------------------------------------------------------------------------------------------
// Ports (implemented by the host: kernel/src/host and the executor runtime)
// ---------------------------------------------------------------------------------------------

/** One page transferred out of an executor (`pagedOut` frame, §4.3). */
export interface ExecPage {
  pageId: number;
  header: ArrayBuffer;
  body: ArrayBuffer;
  sha256: string;
}

export type CheckpointResult =
  | { ok: true; header: ArrayBuffer; body: ArrayBuffer; sha256: string; bytes: number }
  | { ok: false; errno: 'EINVAL'; msg: string };

/** The executor page frames of §4.3, as async calls. */
export interface MemExecutorPort {
  /** `pageOut`: hash and transfer these dirty data pages (sets PREEMPT and waits for the slice end). */
  pageOut(pid: number, pageIds: number[]): Promise<ExecPage[]>;
  /** `checkpoint`: encode `st` now with the codec. With `release` the generator stays alive until `release`. */
  checkpoint(pid: number, release: boolean): Promise<CheckpointResult>;
  /** `pageIn`: transfer a verified body to the executor. */
  pageIn(pid: number, pageId: number, body: ArrayBuffer, sha256: string): Promise<void>;
  /** `release`: drop clean pages, or the whole process (generator, st, declared assets). */
  release(pid: number, pageIds: number[], dropProcess: boolean): Promise<{ bytes: number }>;
  /** Whole-process page-in: place on an executor and load from the state page (§3.13.2). */
  restore(
    pid: number,
    page: { header: ArrayBuffer; body: ArrayBuffer; sha256: string },
    from: 'page-in' | 'session',
  ): Promise<void>;
  /** Special worker pages (ai.embed, §3.15.1): eviction = terminate, page-in = respawn. */
  terminateWorker?(pid: number): Promise<void>;
  respawnWorker?(pid: number): Promise<void>;
}

/** Durable source of BACKED pages (vector segments, mmap chunks). */
export interface BackingSource {
  read(
    backing: { store: string; ref: string },
    sha256: string,
    onProgress?: ProgressFn,
  ): Promise<{ ok: true; body: ArrayBuffer } | { ok: false; errno: 'EIO' | 'ENOENT' }>;
}

export type WaitingOn = 'mem' | `page:${number}` | null;
export type MemTopic = 'mem.fault' | 'mem.evict' | 'mem.pressure';

/** Notifications to the scheduler, the compositor bridge, the event bus and klog. */
export interface MmHooks {
  /** The process's `waitingOn` (BLOCKED `mem` or `page:<id>`; null when it may run). */
  setWaiting?(pid: number, on: WaitingOn): void;
  /** READY/BLOCKED → SUSPENDED (reason `page-out`). */
  suspended?(pid: number): void;
  /** SUSPENDED → READY (reason `page-in`). */
  resumed?(pid: number): void;
  /** "Restoring… done / total" for the process's windows, at least every RESTORE_PROGRESS_MS. */
  restoring?(pid: number, doneBytes: number, totalBytes: number): void;
  /** "Restored x MB in y ms". */
  restored?(pid: number, bytes: number, ms: number): void;
  event?<T extends MemTopic>(topic: T, data: EventData[T]): void;
  klog?(rec: KlogMem): void;
  /** Desktop notice (once per thrashing episode). */
  notice?(kind: 'thrashing', text: string): void;
  softLimit?(pid: number, over: boolean): void;
}

export interface MemoryManagerDeps {
  clock: MmClock;
  executor: MemExecutorPort;
  device: SwapDevice;
  remote?: RemoteSwap;
  backing?: BackingSource;
  hooks?: MmHooks;
  params?: Partial<MmParams>;
  lruFactory?: LruFactory<PTE>;
  heapFactory?: HeapFactory;
  /** Kernel structures for the Kernel line (entries × bytes/entry). */
  kernelStructures?: () => KernelStructure[];
  /** LOCAL_SWAP_CAP for `free` (the device enforces it). */
  localCap?: number;
  calibration?: CalibrationConstants;
}

export interface RegisterOptions {
  uid: number;
  app: string;
  label?: string;
  osSession: string;
  checkpointable?: boolean;
  special?: boolean;
  window?: boolean;
  softLimit?: number;
  /** P2: a service whose manifest has `pinned: true`. */
  pinnedService?: boolean;
}

export interface AllocRequest {
  kind: 'logical' | 'chunk' | 'segment';
  size: number;
  label?: string;
  prio?: number;
}

/** One page of the `os_sessions` page map (§3.12.2). */
export interface PageMapEntry {
  pageId: number;
  gen: number;
  sha256: string;
  size: number;
  kind: 'state' | 'logical' | 'chunk';
  label: string;
  copies: Array<'local' | 'remote'>;
}

export interface ProcPageMap {
  osSessionId: string;
  pid: number;
  uid: number;
  checkpointable: true;
  stateSha256: string;
  savedAt: number;
  pages: PageMapEntry[];
}

interface PageIo {
  kind: 'out' | 'drop' | 'in';
  done: Promise<void>;
  resolve: () => void;
  wantBack: boolean;
}

type ReadResult =
  | {
      ok: true;
      header: ArrayBuffer;
      body: ArrayBuffer;
      tier: 'local' | 'remote' | 'backed' | 'kernel';
    }
  | { ok: false; errno: 'EIO' | 'EACCES' | 'ENOENT' };

interface Counters {
  faults: number;
  hits: number;
  pagesIn: number;
  pagesOut: number;
  bytesSwapIn: number;
  bytesSwapOut: number;
  drops: number;
  suspends: number;
  prefetchHits: number;
  prefetchMisses: number;
}

const noop = (): void => undefined;
const THRASH_TEXT =
  'Plotinium is short of memory and is paging heavily. Large apps will not start until it settles. Close some windows or stop memhog to recover.';

export class MemoryManager {
  readonly params: MmParams;
  private readonly clock: MmClock;
  private readonly exec: MemExecutorPort;
  private readonly device: SwapDevice;
  private readonly remote: RemoteSwap | undefined;
  private readonly backing: BackingSource | undefined;
  private readonly hooks: MmHooks;
  private readonly res: Reservations;
  private readonly lru: PageLru<PTE>;
  private readonly thrash: ThrashingGuard;
  private readonly uploads: WriteBehindQueue | undefined;
  private readonly procs = new Map<number, ProcMem>();
  private readonly io = new Map<number, PageIo>();
  /** Speculative pages of SUSPENDED processes, held by the kernel until the page-in (§3.15.3). */
  private readonly held = new Map<number, { header: ArrayBuffer; body: ArrayBuffer }>();
  private readonly chains = new Map<number, Promise<unknown>>();
  private readonly kernelStructures: () => KernelStructure[];
  private readonly calibration: CalibrationConstants;
  private readonly localCap: number;
  private softLimitDefault: number;
  private tier: SwapTier = 'auto';
  private online = false;
  private onlineUids = new Set<number>();
  private degraded = false;
  private hint: { app: string; until: number } | null = null;
  private background = false;
  private loopRunning = false;
  /** Set when reclaim was requested while a pass was ending (no lost wake-ups). */
  private reclaimAgain = false;
  private inflightOps = 0;
  private freeing = 0;
  private readonly slotWaiters: Array<() => void> = [];
  private readonly passSkipped = new Set<number>();
  private pressureLevel: 'ok' | 'reclaim' | 'blocked' = 'ok';
  private readonly counters: Counters = {
    faults: 0,
    hits: 0,
    pagesIn: 0,
    pagesOut: 0,
    bytesSwapIn: 0,
    bytesSwapOut: 0,
    drops: 0,
    suspends: 0,
    prefetchHits: 0,
    prefetchMisses: 0,
  };
  private rateSnap: { t: number; c: Counters; uploaded: number };
  private rates = { pagesIn: 0, pagesOut: 0, bytesIn: 0, bytesOut: 0, upload: 0 };

  constructor(deps: MemoryManagerDeps) {
    this.params = resolveParams(deps.params);
    this.clock = deps.clock;
    this.exec = deps.executor;
    this.device = deps.device;
    this.remote = deps.remote;
    this.backing = deps.backing;
    this.hooks = deps.hooks ?? {};
    this.kernelStructures = deps.kernelStructures ?? (() => []);
    this.calibration = deps.calibration ?? {
      ...DEFAULT_CALIBRATION,
      overheadProc: this.params.overheadProc,
    };
    this.localCap = deps.localCap ?? 2 * 1_073_741_824;
    this.softLimitDefault = this.params.softLimit;
    this.lru = new PageLru<PTE>(deps.lruFactory);
    this.res = new Reservations(
      this.params.budget,
      this.clock,
      this.params.memWaitMaxMs,
      {
        onBlock: (pid, bytes, why) => {
          this.hooks.setWaiting?.(pid, 'mem');
          this.log('reserve-block', { pid, bytes, detail: why });
          this.updatePressure();
        },
        onWake: (pid, granted) => {
          if (granted) this.log('reserve-grant', { pid });
          this.updatePressure();
        },
        onDeficit: () => this.later(() => this.maybeReclaim()),
        onOverBudget: (over, ms) => this.log('over-budget', { ms, detail: over ? 'start' : 'end' }),
        onTimeout: (pid, bytes, why, waited) =>
          this.log('reserve-timeout', { pid, bytes, ms: waited, detail: why }),
      },
      deps.heapFactory,
    );
    this.thrash = new ThrashingGuard(this.params, this.clock.now(), (on, _at, rate) => {
      this.log(on ? 'thrash-on' : 'thrash-off', { detail: `${rate}/s` });
      if (on) this.hooks.notice?.('thrashing', THRASH_TEXT);
    });
    if (this.remote) {
      this.uploads = new WriteBehindQueue(
        this.remote,
        (key, gen, sha) => this.readForUpload(key, gen, sha),
        this.clock,
        this.params,
        {
          acked: (key, gen) => this.onUploadAcked(key, gen),
          failed: (key, gen) => this.onUploadFailed(key, gen),
          attemptFailed: (key, _gen, status) =>
            this.log('upload-fail', { pid: key.pid, pageId: key.pageId, detail: `HTTP ${status}` }),
        },
      );
    }
    this.rateSnap = { t: this.clock.now(), c: { ...this.counters }, uploaded: 0 };
  }

  // -------------------------------------------------------------------------------------------
  // Process lifecycle
  // -------------------------------------------------------------------------------------------

  /** Create the memory record of a new process (NEW). No memory is charged until `admit`. */
  register(pid: number, o: RegisterOptions): void {
    if (this.procs.has(pid))
      throw new MmError('EINVAL', undefined, `pid ${pid} already registered`);
    const p = newProcMem({
      pid,
      uid: o.uid,
      app: o.app,
      ...(o.label === undefined ? {} : { label: o.label }),
      osSession: o.osSession,
      checkpointable: o.checkpointable ?? true,
      special: o.special ?? false,
      window: o.window ?? false,
      softLimit: o.softLimit ?? this.softLimitDefault,
    });
    if (o.pinnedService === true) p.procPins.add('service');
    this.procs.set(pid, p);
  }

  has(pid: number): boolean {
    return this.procs.has(pid);
  }

  /**
   * Spawn admission (§3.7.2): reserve initialStateBytes + OVERHEAD_PROC + STATE_HEADROOM; the
   * child waits in NEW until it fits. A heavy spawn fails with EAGAIN `thrashing` while the
   * thrashing guard is on (§3.14).
   */
  async admit(
    pid: number,
    o: { initialStateBytes?: number; heavy?: boolean; prio?: number } = {},
  ): Promise<void> {
    const p = this.proc(pid);
    if (p.admitted) return;
    const initial = p.checkpointable ? (o.initialStateBytes ?? this.params.initialStateBytes) : 0;
    const overhead = p.special ? 0 : this.params.overheadProc;
    const headroom = p.checkpointable ? this.params.stateHeadroom : 0;
    const total = initial + overhead + headroom;
    if (
      (o.heavy === true || total > this.params.heavyBytes) &&
      this.thrash.isOn(this.clock.now())
    ) {
      this.hooks.notice?.('thrashing', THRASH_TEXT);
      throw new MmError('EAGAIN', 'thrashing', 'heavy spawn refused while the system is thrashing');
    }
    const ticket = await this.res.reserve(pid, total, {
      ...(o.prio === undefined ? {} : { prio: o.prio }),
      why: 'spawn',
    });
    if (this.procs.get(pid) !== p) {
      this.res.cancel(ticket);
      throw new MmError('ESRCH');
    }
    this.hooks.setWaiting?.(pid, null);
    const rest = this.res.consume(ticket, initial + overhead);
    if (headroom > 0) p.headroom = rest;
    else this.res.cancel(rest);
    if (p.checkpointable) {
      const st = this.newPte(0, 'state', 'process state', initial);
      p.pageTable.set(0, st);
      p.nextPageId = 1;
      p.residentBytes += initial;
      this.applyPins(p, st);
      this.lruInsert(p, st);
    }
    p.overheadCharged = overhead;
    p.resident = true;
    p.admitted = true;
    this.softLimitCheck(p);
    this.maybeReclaim();
  }

  /**
   * The process exited or was killed: every charge, reservation and swap copy is freed; a
   * SUSPENDED process is not paged in (§6 "Kill of a SUSPENDED process").
   */
  exit(pid: number): void {
    const p = this.procs.get(pid);
    if (!p) return;
    this.res.cancelWaiters(pid);
    let freed = p.declaredBytes + p.overheadCharged;
    for (const pte of p.pageTable.values()) {
      const key = pageKey(pid, pte.pageId);
      this.lruRemove(p, pte);
      this.held.delete(key);
      if (pte.loc === 'RESIDENT') freed += pte.size;
      this.forgetCopies(p, pte);
      pte.loc = 'BACKED';
    }
    if (p.headroom) this.res.cancel(p.headroom);
    p.headroom = null;
    p.residentBytes = 0;
    p.declaredBytes = 0;
    p.overheadCharged = 0;
    this.procs.delete(pid);
    this.chains.delete(pid);
    if (freed > 0) this.res.uncharge(freed);
    this.updatePressure();
  }

  // -------------------------------------------------------------------------------------------
  // mem.alloc / mem.declare / mem.free / mem.setBacking
  // -------------------------------------------------------------------------------------------

  /**
   * mem.alloc (§4.2): reserve first (BLOCKED `mem` until reclaim frees space), then create the
   * pages resident and dirty (no swap copy yet). Chunks are 256 KiB (the last may be shorter);
   * the reservation is rounded up to whole chunks.
   */
  async alloc(pid: number, req: AllocRequest): Promise<{ pageIds: number[] }> {
    const p = this.proc(pid);
    const size = req.size;
    if (!Number.isSafeInteger(size) || size <= 0)
      throw new MmError('EINVAL', undefined, 'size must be a positive integer');
    if (req.kind !== 'logical' && req.kind !== 'chunk' && req.kind !== 'segment')
      throw new MmError('EINVAL', undefined, 'bad page kind');
    if (req.kind !== 'chunk' && size > this.params.logicalPageMax) {
      throw new MmError(
        'EINVAL',
        undefined,
        `a ${req.kind} page is at most ${this.params.logicalPageMax} bytes; allocate chunks`,
      );
    }
    const chunk = this.params.pageChunk;
    const sizes: number[] = [];
    if (req.kind === 'chunk') {
      for (let left = size; left > 0; left -= chunk) sizes.push(Math.min(chunk, left));
    } else sizes.push(size);
    if (p.nextPageId + sizes.length > this.params.pagesPerProcess)
      throw new MmError('EINVAL', undefined, 'too many pages');
    const reserveBytes = req.kind === 'chunk' ? sizes.length * chunk : size;
    const ticket = await this.res.reserve(pid, reserveBytes, {
      ...(req.prio === undefined ? {} : { prio: req.prio }),
      why: 'alloc',
    });
    if (this.procs.get(pid) !== p) {
      this.res.cancel(ticket);
      throw new MmError('ESRCH');
    }
    this.hooks.setWaiting?.(pid, null);
    const label = req.label ?? req.kind;
    const pageIds: number[] = [];
    let total = 0;
    sizes.forEach((s, i) => {
      const id = p.nextPageId++;
      const pte = this.newPte(id, req.kind, sizes.length > 1 ? `${label}[${i}]` : label, s);
      p.pageTable.set(id, pte);
      this.applyPins(p, pte);
      pageIds.push(id);
      total += s;
    });
    this.res.commit(ticket, total);
    p.residentBytes += total;
    for (const id of pageIds) {
      const pte = p.pageTable.get(id);
      if (pte) this.lruInsert(p, pte);
    }
    this.softLimitCheck(p);
    this.maybeReclaim();
    return { pageIds };
  }

  /**
   * mem.declare: charge a large asset held outside the pager, before it is created. Re-declaring
   * a label reserves only the delta; a smaller size releases the difference.
   */
  async declare(
    pid: number,
    label: string,
    bytes: number,
    o: { prio?: number } = {},
  ): Promise<void> {
    const p = this.proc(pid);
    if (!Number.isSafeInteger(bytes) || bytes < 0)
      throw new MmError('EINVAL', undefined, 'bytes must be a non-negative integer');
    const old = p.declared.get(label) ?? 0;
    const delta = bytes - old;
    if (delta <= 0) {
      p.declared.set(label, bytes);
      p.declaredBytes += delta;
      if (delta < 0) this.res.uncharge(-delta);
      this.softLimitCheck(p);
      return;
    }
    const ticket = await this.res.reserve(pid, delta, {
      ...(o.prio === undefined ? {} : { prio: o.prio }),
      why: 'declare',
    });
    if (this.procs.get(pid) !== p) {
      this.res.cancel(ticket);
      throw new MmError('ESRCH');
    }
    this.hooks.setWaiting?.(pid, null);
    this.res.commit(ticket, delta);
    p.declared.set(label, (p.declared.get(label) ?? 0) + delta);
    p.declaredBytes += delta;
    this.softLimitCheck(p);
    this.maybeReclaim();
  }

  /** mem.undeclare: the asset is gone; its charge is removed. */
  undeclare(pid: number, label: string): number {
    const p = this.proc(pid);
    const bytes = p.declared.get(label);
    if (bytes === undefined)
      throw new MmError('EINVAL', 'unknown-segment', `no declaration ${label}`);
    p.declared.delete(label);
    p.declaredBytes -= bytes;
    this.res.uncharge(bytes);
    this.softLimitCheck(p);
    return bytes;
  }

  /** mem.free: remove pages; resident bytes are uncharged and swap copies deleted. */
  free(pid: number, pageIds: readonly number[]): { freedBytes: number } {
    const p = this.proc(pid);
    for (const id of pageIds) {
      const pte = p.pageTable.get(id);
      if (!pte || pte.kind === 'state')
        throw new MmError('EINVAL', 'unknown-segment', `no page ${id}`);
    }
    let freed = 0;
    for (const id of pageIds) {
      const pte = p.pageTable.get(id);
      if (!pte) continue;
      this.lruRemove(p, pte);
      this.held.delete(pageKey(pid, id));
      if (pte.loc === 'RESIDENT') freed += pte.size;
      this.forgetCopies(p, pte);
      p.pageTable.delete(id);
      p.pagePins.delete(id);
    }
    p.residentBytes -= freed;
    if (freed > 0) this.res.uncharge(freed);
    this.softLimitCheck(p);
    return { freedBytes: freed };
  }

  /**
   * mem.setBacking: the owner wrote a durable copy (a vector segment): the page becomes clean and
   * BACKED, so eviction drops it and page-in re-reads and verifies it (§3.15.2).
   */
  setBacking(
    pid: number,
    pageId: number,
    backing: { store: string; ref: string },
    sha256: string,
  ): void {
    const p = this.proc(pid);
    const pte = this.pte(p, pageId);
    if (!/^[0-9a-f]{64}$/.test(sha256))
      throw new MmError('EINVAL', undefined, 'sha256 must be 64 hex digits');
    pte.backing = { ...backing };
    pte.sha256 = sha256;
    pte.dirty = false;
    if (pte.loc !== 'RESIDENT') pte.loc = 'BACKED';
  }

  /**
   * The `ai.embed` worker page (§3.15.1): reserve its declared size first; the caller spawns the
   * worker only after this resolves. Eviction terminates the worker; page-in respawns it.
   */
  async declareWorkerPage(
    pid: number,
    bytes: number,
    o: { prio?: number; label?: string } = {},
  ): Promise<number> {
    const p = this.proc(pid);
    const ticket = await this.res.reserve(pid, bytes, {
      ...(o.prio === undefined ? {} : { prio: o.prio }),
      why: 'worker',
    });
    if (this.procs.get(pid) !== p) {
      this.res.cancel(ticket);
      throw new MmError('ESRCH');
    }
    this.hooks.setWaiting?.(pid, null);
    const id = p.nextPageId++;
    const pte = this.newPte(id, 'worker', o.label ?? `${p.app} worker`, bytes);
    pte.backing = { store: 'model', ref: p.app };
    pte.dirty = false;
    p.pageTable.set(id, pte);
    this.res.commit(ticket, bytes);
    p.residentBytes += bytes;
    p.resident = true;
    p.admitted = true;
    this.applyPins(p, pte);
    this.lruInsert(p, pte);
    this.softLimitCheck(p);
    this.maybeReclaim();
    return id;
  }

  // -------------------------------------------------------------------------------------------
  // Slices, faults and state measurement
  // -------------------------------------------------------------------------------------------

  /**
   * A slice ended (§4.3): `touched` pages were accessed (hits, MRU), `dirtied` were written. The
   * dispatch itself counts one hit on the state page, which the slice may have changed.
   */
  onSlice(pid: number, touched: Iterable<number> = [], dirtied: Iterable<number> = []): void {
    const p = this.procs.get(pid);
    if (!p || !p.resident) return;
    const now = this.clock.now();
    const st = p.pageTable.get(0);
    if (st && st.kind === 'state' && st.loc === 'RESIDENT') {
      this.hit(p, st, now);
      this.markDirty(st);
    }
    for (const id of touched) {
      const pte = p.pageTable.get(id);
      if (pte && pte.loc === 'RESIDENT' && pte.kind !== 'state') this.hit(p, pte, now);
    }
    for (const id of dirtied) {
      const pte = p.pageTable.get(id);
      if (pte && pte.loc === 'RESIDENT') this.markDirty(pte);
    }
  }

  /**
   * mem.fault (§3.13.1): the process is BLOCKED `page:<id>` (first `mem` if the reservation
   * waits); the page is read from tier 1, tier 2 or its backing, verified, transferred to the
   * executor and inserted at the MRU end. A page in transit is handed back with no read.
   */
  async fault(pid: number, pageId: number, o: { prio?: number } = {}): Promise<void> {
    const p = this.proc(pid);
    const pte = this.pte(p, pageId);
    const key = pageKey(pid, pageId);
    const now = this.clock.now();
    const pending = this.io.get(key);
    if (pte.loc === 'RESIDENT' && !pending) {
      this.hit(p, pte, now);
      return;
    }
    p.faults++;
    pte.faults++;
    this.counters.faults++;
    this.thrash.recordFault(now);
    this.log('fault', { pid, pageId });
    this.hooks.setWaiting?.(pid, `page:${pageId}`);
    try {
      if (pending) {
        if (pending.kind === 'out') pending.wantBack = true;
        await pending.done;
        if (pte.loc === 'RESIDENT') return;
      }
      await this.loadPage(p, pte, {
        ...(o.prio === undefined ? {} : { prio: o.prio }),
        why: 'fault',
        fault: true,
      });
    } finally {
      this.hooks.setWaiting?.(pid, null);
    }
  }

  /**
   * A new measurement of the encoded state (§3.2.2). Growth first consumes the STATE_HEADROOM
   * reservation; growth beyond it is charged at once (the only path by which committed can exceed
   * the budget; recorded in maxOverBudgetMs) and the process waits BLOCKED `mem` at this yield
   * point until the difference fits. Returns null when the process may continue at once.
   */
  measureState(pid: number, bytes: number): Promise<void> | null {
    const p = this.procs.get(pid);
    const st = p?.pageTable.get(0);
    if (!p || !st || st.kind !== 'state' || st.loc !== 'RESIDENT') return null;
    if (bytes > this.params.stateMax) {
      if (!p.nonPageable)
        this.log('state-soft', { pid, bytes, detail: 'above STATE_MAX: non-pageable' });
      this.markNonPageable(p);
    } else if (bytes > this.params.stateSoft && !p.stateWarned) {
      p.stateWarned = true;
      this.log('state-soft', { pid, bytes, detail: 'above STATE_SOFT' });
    }
    const delta = bytes - st.size;
    st.size = bytes;
    if (delta === 0) return null;
    p.residentBytes += delta;
    if (delta < 0) {
      this.res.uncharge(-delta);
      this.topUpHeadroom(p);
      this.softLimitCheck(p);
      return null;
    }
    let rest = delta;
    if (p.headroom && p.headroom.bytes > 0) {
      const take = Math.min(rest, p.headroom.bytes);
      p.headroom = this.res.consume(p.headroom, take);
      rest -= take;
    }
    if (rest > 0) this.res.chargeUnreserved(rest);
    this.topUpHeadroom(p);
    this.softLimitCheck(p);
    this.maybeReclaim();
    if (rest === 0) return null;
    const missing = this.params.stateHeadroom - (p.headroom?.bytes ?? 0);
    return this.res.reserve(pid, Math.max(0, missing), { why: 'state-growth' }).then((t) => {
      this.hooks.setWaiting?.(pid, null);
      if (this.procs.get(pid) !== p) {
        this.res.cancel(t);
        return;
      }
      p.headroom = this.res.merge(p.headroom, t);
    });
  }

  // -------------------------------------------------------------------------------------------
  // Whole-process page-out, page-in, checkpoints
  // -------------------------------------------------------------------------------------------

  /** mem.pageOut / whole-process suspend (§3.9.2). EBUSY while a non-restartable call is in flight. */
  async pageOut(pid: number): Promise<{ bytes: number; ms: number }> {
    const p = this.proc(pid);
    if (this.res.hasWaiter(pid))
      throw new MmError('EBUSY', undefined, 'the process is waiting for memory');
    return this.serial(pid, () => this.suspend(p));
  }

  /** mem.pageIn / whole-process page-in, SUSPENDED → READY (§3.13.2). */
  async pageIn(
    pid: number,
    o: { prio?: number; from?: 'page-in' | 'session' } = {},
  ): Promise<{ bytes: number; ms: number }> {
    const p = this.proc(pid);
    return this.serial(pid, () => this.pageInProcess(p, o.prio, o.from ?? 'page-in'));
  }

  /**
   * A checkpoint (§3.12.1): a page-out without release. Every dirty page and the state page are
   * written and verified; the process keeps running and its pages are clean afterwards.
   */
  async checkpoint(pid: number): Promise<{ bytes: number; ms: number }> {
    const p = this.proc(pid);
    return this.serial(pid, async () => {
      if (!p.resident || !p.checkpointable)
        throw new MmError('EINVAL', undefined, 'not a resident checkpointable process');
      const t0 = this.clock.now();
      const dirty = this.residentData(p).filter((pte) => pte.dirty && pte.kind !== 'worker');
      await this.limited(dirty, (pte) => this.pageOutData(p, pte, true));
      if (dirty.some((pte) => pte.dirty))
        throw new MmError('EIO', 'storage', 'a dirty page could not be written');
      const st = this.statePte(p);
      const stKey = pageKey(p.pid, 0);
      this.lruRemove(p, st);
      this.beginIo(stKey, 'out', p, st);
      try {
        const cp = await this.exec.checkpoint(p.pid, false);
        if (!cp.ok) {
          this.markNonPageable(p);
          throw new MmError('EINVAL', 'codec', cp.msg);
        }
        if (!(await this.writeStatePage(p, st, cp)))
          throw new MmError('EIO', 'storage', 'state page write failed');
      } finally {
        this.endIo(stKey, p, st);
        this.lruInsert(p, st);
      }
      const bytes = dirty.reduce((s, pte) => s + pte.size, 0) + st.size;
      const ms = this.clock.now() - t0;
      this.log('checkpoint', { pid, bytes, ms });
      return { bytes, ms };
    });
  }

  /**
   * Restore in a new browser session (§3.12.3): a NEW process whose PTEs point at the old pages of
   * another OS session. Call `pageIn(pid, {from: 'session'})` afterwards to load it.
   */
  adoptPageMap(pid: number, map: ProcPageMap, localGens?: ReadonlySet<string>): void {
    const p = this.proc(pid);
    if (p.admitted) throw new MmError('EINVAL', undefined, 'process already admitted');
    let maxId = -1;
    for (const e of map.pages) {
      const pte = this.newPte(e.pageId, e.kind, e.label, e.size);
      pte.gen = e.gen;
      pte.sha256 = e.sha256;
      pte.dirty = false;
      pte.origin = { osSessionId: map.osSessionId, pid: map.pid };
      const localOk =
        e.copies.includes('local') &&
        (localGens === undefined || localGens.has(`${e.pageId}@${e.gen}`));
      pte.local = localOk ? 'valid' : 'none';
      pte.remote = e.copies.includes('remote') ? 'acked' : 'none';
      pte.loc = localOk ? 'LOCAL_SWAP' : 'REMOTE_SWAP';
      p.pageTable.set(e.pageId, pte);
      this.applyPins(p, pte);
      maxId = Math.max(maxId, e.pageId);
    }
    if (!p.pageTable.has(0))
      throw new MmError('EINVAL', undefined, 'the page map has no state page');
    p.nextPageId = maxId + 1;
    p.admitted = true;
    p.resident = false;
    p.wsAtSuspend = map.pages.filter((e) => e.kind !== 'state').map((e) => e.pageId);
  }

  /** The `proc` part of the os_sessions window entry (§3.12.2), after a checkpoint. */
  pageMap(pid: number): ProcPageMap {
    const p = this.proc(pid);
    const st = this.statePte(p);
    const pages: PageMapEntry[] = [];
    for (const pte of p.pageTable.values()) {
      if (pte.kind !== 'state' && pte.kind !== 'logical' && pte.kind !== 'chunk') continue;
      const copies: Array<'local' | 'remote'> = [];
      if (pte.local === 'valid') copies.push('local');
      if (pte.remote === 'acked') copies.push('remote');
      pages.push({
        pageId: pte.pageId,
        gen: pte.gen,
        sha256: pte.sha256,
        size: pte.size,
        kind: pte.kind,
        label: pte.label,
        copies,
      });
    }
    pages.sort((a, b) => a.pageId - b.pageId);
    return {
      osSessionId: p.osSession,
      pid: p.pid,
      uid: p.uid,
      checkpointable: true,
      stateSha256: st.sha256,
      savedAt: this.clock.now(),
      pages,
    };
  }

  // -------------------------------------------------------------------------------------------
  // Pre-fetch and the residency hint (§3.15.3, §3.5.3)
  // -------------------------------------------------------------------------------------------

  /**
   * mem.prefetch: page in speculatively. Never waits and never evicts: each page is admitted only
   * if committed + bytes ≤ LOW_WM · budget (EAGAIN `no-free-memory` otherwise), and nothing runs
   * while the thrashing guard is on (EAGAIN `thrashing`). Pages enter the SPEC segment.
   */
  async prefetch(
    pid: number,
    pageIds?: readonly number[],
  ): Promise<{ bytes: number; pages: number }> {
    const p = this.proc(pid);
    if (this.thrash.isOn(this.clock.now())) throw new MmError('EAGAIN', 'thrashing');
    const ids =
      pageIds ??
      (p.resident
        ? [...p.pageTable.values()]
            .filter((x) => x.kind !== 'state' && x.loc !== 'RESIDENT')
            .map((x) => x.pageId)
        : [0, ...p.wsAtSuspend]);
    const limit = watermarks(this.res.budget, this.params).low;
    let bytes = 0;
    let pages = 0;
    let refused = false;
    for (const id of ids) {
      const pte = p.pageTable.get(id);
      if (!pte || pte.loc === 'RESIDENT' || this.io.has(pageKey(pid, id)) || pte.kind === 'worker')
        continue;
      if (pte.kind === 'state' && p.resident) continue;
      const ticket = this.res.tryReserve(pid, pte.size, limit, 'prefetch');
      if (!ticket) {
        refused = true;
        break;
      }
      const key = pageKey(pid, id);
      this.beginIo(key, 'in', p, pte);
      let r: ReadResult;
      try {
        r = await this.readPage(p, pte);
      } catch {
        r = { ok: false, errno: 'EIO' };
      }
      if (!r.ok || this.procs.get(pid) !== p) {
        this.res.cancel(ticket);
        this.endIo(key, p, pte);
        continue;
      }
      if (p.resident && pte.kind !== 'state') {
        await this.exec.pageIn(pid, id, r.body, pte.sha256);
      } else {
        this.held.set(key, { header: r.header, body: r.body });
      }
      if (!this.alive(p, pte)) {
        this.res.cancel(ticket);
        this.held.delete(key);
        this.endIo(key, p, pte);
        continue;
      }
      this.res.commit(ticket, pte.size);
      pte.loc = 'RESIDENT';
      pte.speculative = true;
      pte.dirty = false;
      p.residentBytes += pte.size;
      this.counters.bytesSwapIn += r.tier === 'local' || r.tier === 'remote' ? pte.size : 0;
      this.endIo(key, p, pte);
      this.lruInsert(p, pte);
      bytes += pte.size;
      pages++;
    }
    if (pages === 0 && refused) throw new MmError('EAGAIN', 'no-free-memory');
    this.softLimitCheck(p);
    return { bytes, pages };
  }

  /** mem.hint: keep the predicted app resident while the hint lasts (§3.5.3). */
  setHint(app: string, ttlMs: number): void {
    if (!(ttlMs > 0)) throw new MmError('EINVAL');
    this.hint = { app, until: this.clock.now() + ttlMs };
  }

  // -------------------------------------------------------------------------------------------
  // Window-process coupling and pins (§3.16, §3.5.2)
  // -------------------------------------------------------------------------------------------

  /** Every window of the process is minimised (or one was restored): pages move to COLD / back. */
  setMinimised(pid: number, minimised: boolean): void {
    const p = this.proc(pid);
    if (p.minimised === minimised) return;
    p.minimised = minimised;
    this.resegment(p);
  }

  /**
   * `restored {wid}`: if SUSPENDED or its working set is not resident, page in BEFORE focus is
   * delivered (with "Restoring…" progress), then move its pages back to HOT.
   */
  async restoreWindow(pid: number): Promise<{ bytes: number; ms: number }> {
    const p = this.proc(pid);
    let r = { bytes: 0, ms: 0 };
    if (!p.resident) r = await this.pageIn(pid, { prio: 0 });
    this.setMinimised(pid, false);
    await this.pageInWorkingSet(p);
    return r;
  }

  /** P1: pin every page of the focused processes; unpin the previously focused ones. */
  setFocus(pids: readonly number[]): void {
    const next = new Set(pids);
    for (const p of this.procs.values()) {
      const want = next.has(p.pid);
      if (want !== p.procPins.has('focus')) this.setProcPin(p, 'focus', want);
    }
  }

  /** P2: a pinned system service. */
  setServicePinned(pid: number, on: boolean): void {
    this.setProcPin(this.proc(pid), 'service', on);
  }

  /** P3: inside a non-pre-emptive kernel section. */
  setNpSection(pid: number, on: boolean): void {
    this.setProcPin(this.proc(pid), 'np-section', on);
  }

  /** P6: a non-restartable call is in flight: the state page is pinned; explicit page-out → EBUSY. */
  setNonRestartable(pid: number, on: boolean): void {
    const p = this.proc(pid);
    p.nonRestartable = on;
    const st = p.pageTable.get(0);
    if (st && st.kind === 'state' && !p.nonPageable) this.setPagePin(p, st, 'non-restartable', on);
  }

  /** P5: the ai.embed page or vector segments while a search box has focus or a query scans them. */
  setSearchPin(pid: number, pageIds: readonly number[], on: boolean): void {
    const p = this.proc(pid);
    for (const id of pageIds) this.setPagePin(p, this.pte(p, id), 'ai-search', on);
  }

  // -------------------------------------------------------------------------------------------
  // Settings, tiers, online state, periodic work
  // -------------------------------------------------------------------------------------------

  /** `mm.budget` (Settings → System → Memory): 64 MiB … 2 GiB, effective at once (§3.3). */
  setBudget(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < BUDGET_MIN || bytes > BUDGET_MAX) {
      throw new MmError('EINVAL', undefined, `budget must be ${BUDGET_MIN}…${BUDGET_MAX} bytes`);
    }
    this.res.setBudget(bytes);
    this.maybeReclaim();
  }

  /** `mm.softLimit`: the default for new processes, or one process's limit (8 MiB … budget). */
  setSoftLimit(bytes: number, pid?: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < SOFT_LIMIT_MIN || bytes > this.res.budget) {
      throw new MmError('EINVAL', undefined, 'soft limit out of range');
    }
    if (pid === undefined) {
      this.softLimitDefault = bytes;
      return;
    }
    const p = this.proc(pid);
    p.softLimit = bytes;
    this.softLimitCheck(p);
  }

  /** `mm.swap.tier` / `swapctl tier`: auto (write-behind), local (no uploads), remote (remote-only). */
  setTier(tier: SwapTier): void {
    this.tier = tier;
    this.uploads?.setOnline(this.online && tier !== 'local');
    // Remote-only: local copies that have an acknowledged remote copy are dropped (§3.11 step 7).
    if (tier === 'remote') void this.dropAckedLocalCopies(Number.POSITIVE_INFINITY);
  }

  get swapTier(): SwapTier {
    return this.tier;
  }

  /** `syncd` LIVE and the uids the auth session can act as (§3.11 step 1). */
  setOnline(online: boolean, uids: Iterable<number> = []): void {
    this.online = online;
    this.onlineUids = new Set(uids);
    this.uploads?.setOnline(online && this.tier !== 'local');
  }

  /** Periodic work, at least once per second: thrashing buckets, rates, hint expiry, uploads. */
  tick(): void {
    const now = this.clock.now();
    this.thrash.tick(now);
    if (this.hint && now >= this.hint.until) this.hint = null;
    const dt = now - this.rateSnap.t;
    if (dt >= 1_000) {
      const s = dt / 1_000;
      const c = this.counters;
      const o = this.rateSnap.c;
      const uploaded = this.uploads?.bytesUploaded ?? 0;
      this.rates = {
        pagesIn: (c.pagesIn - o.pagesIn) / s,
        pagesOut: (c.pagesOut - o.pagesOut) / s,
        bytesIn: (c.bytesSwapIn - o.bytesSwapIn) / s,
        bytesOut: (c.bytesSwapOut - o.bytesSwapOut) / s,
        upload: (uploaded - this.rateSnap.uploaded) / s,
      };
      this.rateSnap = { t: now, c: { ...c }, uploaded };
    }
    this.uploads?.pump();
    this.maybeReclaim();
  }

  /** Boot sweep of tier 1 (§3.10.3), run by the `mm` service start. */
  async sweep(
    keep: Array<{ uid: number; osSession: string }>,
  ): Promise<{ files: number; bytes: number }> {
    const r = await this.device.sweep(keep, this.params.swapKeepDays * 86_400_000);
    this.log('sweep', { bytes: r.bytes, detail: `swept ${r.files} files, ${r.bytes} bytes` });
    return r;
  }

  /** Resolves when the write-behind queue is empty (tests, shutdown). */
  drainUploads(): Promise<void> {
    return this.uploads?.drain() ?? Promise.resolve();
  }

  /** True when reclaim is idle and no page I/O is in flight (tests poll this). */
  get idle(): boolean {
    return !this.loopRunning && this.inflightOps === 0 && this.io.size === 0;
  }

  // -------------------------------------------------------------------------------------------
  // Statistics (MEM-07): free, vmstat, pmap, mem.stat
  // -------------------------------------------------------------------------------------------

  get committed(): number {
    return this.res.committed;
  }
  get budget(): number {
    return this.res.budget;
  }
  get accounted(): number {
    return this.res.accounted;
  }
  get reserved(): number {
    return this.res.reserved;
  }
  maxOverBudgetMs(): number {
    return this.res.maxOverBudgetMs();
  }
  /** Number of times committed crossed above the budget (every change is checked, not sampled). */
  get overBudgetEpisodes(): number {
    return this.res.overBudgetEpisodes;
  }
  isThrashing(): boolean {
    return this.thrash.isOn(this.clock.now());
  }
  accountedOf(pid: number): number {
    return accountedOf(this.proc(pid));
  }
  /**
   * One process's numbers for `proc.list` and Task Manager (UI-133): what the budget charges it
   * (accounted, §3.2.1) and its paging counters; undefined for a pid the manager does not know.
   */
  procStats(pid: number):
    | {
        readonly accounted: number;
        readonly pagedOutBytes: number;
        readonly swapLocalBytes: number;
        readonly swapRemoteBytes: number;
        readonly faults: number;
        readonly hits: number;
        readonly bytesIn: number;
        readonly bytesOut: number;
        readonly lastPageInMs: number | null;
      }
    | undefined {
    const p = this.procs.get(pid);
    if (p === undefined) return undefined;
    let pagedOut = 0;
    let local = 0;
    let remote = 0;
    for (const pte of p.pageTable.values()) {
      if (pte.loc !== 'RESIDENT') pagedOut += pte.size;
      if (pte.local === 'valid') local += pte.size;
      if (pte.remote === 'acked') remote += pte.size;
    }
    return {
      accounted: accountedOf(p),
      pagedOutBytes: pagedOut,
      swapLocalBytes: local,
      swapRemoteBytes: remote,
      faults: p.faults,
      hits: p.hits,
      bytesIn: p.bytesIn,
      bytesOut: p.bytesOut,
      lastPageInMs: p.lastPageInMs,
    };
  }
  /** The PTE of a page (read-only view for tests and the pmap command). */
  page(pid: number, pageId: number): Readonly<PTE> {
    return this.pte(this.proc(pid), pageId);
  }
  isSuspended(pid: number): boolean {
    const p = this.proc(pid);
    return p.admitted && !p.resident;
  }
  prefetchStats(): { hits: number; misses: number } {
    return { hits: this.counters.prefetchHits, misses: this.counters.prefetchMisses };
  }

  /** MemSummary (§4.1): the data of `free`, `top` and the Task Manager Memory tab. */
  summary(): MemSummary {
    const now = this.clock.now();
    let pinned = 0;
    let spec = 0;
    let cleanUnpinned = 0;
    let localBytes = 0;
    let localPages = 0;
    let remoteBytes = 0;
    let remotePages = 0;
    let hits = 0;
    let faults = 0;
    for (const p of this.procs.values()) {
      hits += p.hits;
      faults += p.faults;
      for (const pte of p.pageTable.values()) {
        if (pte.local === 'valid') {
          localBytes += PAGE_HEADER_BYTES + pte.size;
          localPages++;
        }
        if (pte.remote === 'acked') {
          remoteBytes += pte.size;
          remotePages++;
        }
        if (pte.loc !== 'RESIDENT') continue;
        if (pte.pins > 0 || pte.busy) pinned += pte.size;
        else if (isClean(pte)) cleanUnpinned += pte.size;
        if (pte.speculative) spec += pte.size;
      }
    }
    const kernel = kernelLine(this.kernelStructures(), this.uploads?.inflightBytes ?? 0);
    const free = Math.max(0, this.res.budget - this.res.committed);
    return {
      budget: this.res.budget,
      accounted: this.res.accounted,
      reserved: this.res.reserved,
      committed: this.res.committed,
      free,
      avail: free + cleanUnpinned,
      pinned,
      speculative: spec,
      kernelBytes: kernel.bytes,
      swapLocal: {
        device: this.device.kind,
        bytes: localBytes,
        cap: this.localCap,
        pages: localPages,
        degraded: this.degraded,
      },
      swapRemote: {
        bytes: remoteBytes,
        pages: remotePages,
        pending: this.uploads?.pending ?? 0,
        failed: this.uploads?.failed ?? 0,
        tier: this.tier,
        online: this.online,
      },
      faultsPerSec: this.thrash.faultsPerSec(now),
      hitRatio: hits + faults === 0 ? 1 : hits / (hits + faults),
      pagesInPerSec: this.rates.pagesIn,
      pagesOutPerSec: this.rates.pagesOut,
      bytesInPerSec: this.rates.bytesIn,
      bytesOutPerSec: this.rates.bytesOut,
      uploadPerSec: this.rates.upload,
      thrashing: this.thrash.isOn(now),
      reclaim: this.reclaimMode(),
      blocked: this.res.blocked,
      oldestBlockedMs: this.res.oldestBlockedMs(),
      maxOverBudgetMs: this.res.maxOverBudgetMs(),
      hint: this.hint ? { app: this.hint.app, ttlMs: Math.max(0, this.hint.until - now) } : null,
    };
  }

  /** `free` (§3.17.1): the summary, the Kernel line's parts and the calibration model. */
  freeReport(): FreeReport {
    const kernel = kernelLine(this.kernelStructures(), this.uploads?.inflightBytes ?? 0);
    const c = this.calibration;
    return {
      ...this.summary(),
      kernelParts: kernel.parts,
      model: {
        overheadProc: c.overheadProc,
        kappa: c.kappa,
        bMain: c.bMain,
        bExec: c.bExec,
        bSpecial: c.bSpecial,
        lastError: c.lastError ?? null,
      },
    };
  }

  /** Cumulative counters for `vmstat` (§3.17.2); two samples make one line (stats.vmstatLine). */
  vmstatSample(): VmCounters {
    const s = this.summary();
    let suspended = 0;
    for (const p of this.procs.values()) if (p.admitted && !p.resident) suspended++;
    return {
      t: this.clock.now(),
      faults: this.counters.faults,
      hits: this.counters.hits,
      pagesIn: this.counters.pagesIn,
      pagesOut: this.counters.pagesOut,
      bytesSwapIn: this.counters.bytesSwapIn,
      bytesSwapOut: this.counters.bytesSwapOut,
      bytesUploaded: this.uploads?.bytesUploaded ?? 0,
      used: s.accounted,
      free: s.free,
      reserved: s.reserved,
      pinned: s.pinned,
      suspended,
    };
  }

  /** `vmstat -p [PID …]` rows (MEM-07). */
  vmstatProcs(pids?: readonly number[]): VmstatProcRow[] {
    const now = this.clock.now();
    const list = pids ? pids.map((pid) => this.proc(pid)) : [...this.procs.values()];
    return list.map((p) => vmstatProcRow(p, now, this.params.wsWindowMs));
  }

  /** Σ WS over all processes; `vmstat` prints `ws>budget` when it exceeds the budget. */
  workingSetTotal(): number {
    const now = this.clock.now();
    return [...this.procs.values()].reduce(
      (s, p) => s + vmstatProcRow(p, now, this.params.wsWindowMs).ws,
      0,
    );
  }

  /** `pmap PID` (§3.17.3). Another user's process: EACCES unless root. */
  pmap(pid: number, callerUid: number): PmapReport {
    const p = this.proc(pid);
    if (callerUid !== 0 && callerUid !== p.uid) throw new MmError('EACCES');
    return pmapReport(p, this.clock.now());
  }

  /** `mem.stat` in the protocol's MemStat shape (syscall-abi.md §4.4.5). */
  memStat(o: { pid?: number; callerUid?: number } = {}): MemStat {
    const s = this.summary();
    let resident = 0;
    let swappedLocal = 0;
    let swappedRemote = 0;
    let embed: MemStat['embed'] = { bytes: 0, state: 'absent' };
    const rows: NonNullable<MemStat['procs']> = [];
    for (const p of this.procs.values()) {
      let swapped = 0;
      for (const pte of p.pageTable.values()) {
        if (pte.loc === 'RESIDENT') resident += pte.size;
        else if (pte.loc === 'LOCAL_SWAP') swappedLocal += pte.size;
        else if (pte.loc === 'REMOTE_SWAP') swappedRemote += pte.size;
        if (pte.loc !== 'RESIDENT') swapped += pte.size;
        if (pte.kind === 'worker')
          embed = { bytes: pte.size, state: pte.loc === 'RESIDENT' ? 'resident' : 'evicted' };
      }
      if (o.pid !== undefined && p.pid !== o.pid) continue;
      if (o.callerUid !== undefined && o.callerUid !== 0 && o.callerUid !== p.uid) continue;
      const total = p.hits + p.faults;
      rows.push({
        pid: p.pid,
        accounted: accountedOf(p),
        resident: p.residentBytes,
        swapped,
        faults: p.faults,
        hitRatio: total === 0 ? 1 : p.hits / total,
        softLimit: p.softLimit,
      });
    }
    if (o.pid !== undefined && !this.procs.has(o.pid)) throw new MmError('ESRCH');
    return {
      budget: s.budget,
      accounted: s.accounted,
      reservedWaiting: this.res.waitingBytes,
      resident,
      swappedLocal,
      swappedRemote,
      speculative: s.speculative,
      embed,
      kernel: s.kernelBytes,
      faults: this.counters.faults,
      faultsPerSec: s.faultsPerSec,
      hitRatio: s.hitRatio,
      bytesIn: this.counters.bytesSwapIn,
      bytesOut: this.counters.bytesSwapOut,
      procs: rows,
    };
  }

  /**
   * Invariant check for tests (INV-M1 bookkeeping, INV-M3, INV-M4). Throws on the first failure.
   */
  checkInvariants(): void {
    let accounted = 0;
    for (const p of this.procs.values()) {
      const resident = recountResident(p);
      if (resident !== p.residentBytes)
        throw new Error(`pid ${p.pid}: residentBytes ${p.residentBytes} ≠ Σ pages ${resident}`);
      accounted += accountedOf(p);
      for (const pte of p.pageTable.values()) {
        const inLru = this.lru.has(pageKey(p.pid, pte.pageId));
        const should = pte.loc === 'RESIDENT' && !pte.busy;
        if (inLru !== should)
          throw new Error(
            `INV-M3: pid ${p.pid} page ${pte.pageId} inLru=${inLru} resident=${pte.loc} busy=${pte.busy}`,
          );
        if (inLru && this.lru.isPinned(pageKey(p.pid, pte.pageId)) !== pte.pins > 0) {
          throw new Error(`INV-M3: pid ${p.pid} page ${pte.pageId} pin state differs`);
        }
        if (pte.speculative && pte.dirty) throw new Error('INV-M8: a speculative page is dirty');
      }
      const st = p.pageTable.get(0);
      if (
        p.admitted &&
        st &&
        st.kind === 'state' &&
        !p.resident &&
        st.loc === 'RESIDENT' &&
        !st.speculative
      ) {
        throw new Error(`INV-M4: pid ${p.pid} is suspended with a resident state page`);
      }
    }
    if (accounted !== this.res.accounted)
      throw new Error(`Σ accounted ${accounted} ≠ ledger ${this.res.accounted}`);
  }

  // ===========================================================================================
  // Internals
  // ===========================================================================================

  private proc(pid: number): ProcMem {
    const p = this.procs.get(pid);
    if (!p) throw new MmError('ESRCH', undefined, `no process ${pid}`);
    return p;
  }

  private pte(p: ProcMem, pageId: number): PTE {
    const pte = p.pageTable.get(pageId);
    if (!pte) throw new MmError('EINVAL', 'unknown-segment', `pid ${p.pid} has no page ${pageId}`);
    return pte;
  }

  private statePte(p: ProcMem): PTE {
    const st = p.pageTable.get(0);
    if (!st || st.kind !== 'state')
      throw new MmError('EINVAL', undefined, `pid ${p.pid} has no state page`);
    return st;
  }

  private alive(p: ProcMem, pte: PTE): boolean {
    return this.procs.get(p.pid) === p && p.pageTable.get(pte.pageId) === pte;
  }

  private newPte(pageId: number, kind: PageKind, label: string, size: number): PTE {
    return {
      pageId,
      kind,
      label,
      size,
      loc: 'RESIDENT',
      dirty: true,
      lastAccess: this.clock.now(),
      sha256: '',
      gen: 0,
      local: 'none',
      remote: 'none',
      pins: 0,
      pinReasons: [],
      speculative: false,
      busy: false,
      lruSlot: -1,
      seg: 'HOT',
      faults: 0,
      hits: 0,
    };
  }

  private residentData(p: ProcMem): PTE[] {
    return [...p.pageTable.values()].filter(
      (pte) => pte.kind !== 'state' && pte.loc === 'RESIDENT' && !pte.busy,
    );
  }

  /** Swap key for reads (a restored page keeps its origin until its next page-out) or writes. */
  private swapKey(p: ProcMem, pte: PTE, forWrite = false): SwapKey {
    if (!forWrite && pte.origin)
      return {
        uid: p.uid,
        osSession: pte.origin.osSessionId,
        pid: pte.origin.pid,
        pageId: pte.pageId,
      };
    return { uid: p.uid, osSession: p.osSession, pid: p.pid, pageId: pte.pageId };
  }

  private log(ev: KlogMemEvent, rest: Omit<KlogMem, 't' | 'kind' | 'ev'> = {}): void {
    this.hooks.klog?.({ t: this.clock.now(), kind: 'mem', ev, ...rest });
  }

  private later(fn: () => void): void {
    void Promise.resolve().then(fn);
  }

  private serial<T>(pid: number, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(pid) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.chains.set(pid, next.then(noop, noop));
    return next;
  }

  private async limited<T>(items: readonly T[], fn: (item: T) => Promise<unknown>): Promise<void> {
    let i = 0;
    const worker = async (): Promise<void> => {
      while (i < items.length) {
        const item = items[i++];
        if (item !== undefined) await fn(item).catch(noop);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(this.params.blkioInflight, items.length) }, worker),
    );
  }

  // --- LRU, pins, segments ---------------------------------------------------------------------

  private lruInsert(p: ProcMem, pte: PTE): void {
    if (pte.loc !== 'RESIDENT' || pte.busy || this.procs.get(p.pid) !== p) return;
    const key = pageKey(p.pid, pte.pageId);
    const seg = segmentFor(pte, p);
    this.lru.insert(key, pte, seg);
    pte.seg = seg;
    pte.lruSlot = 0;
    if (pte.pins > 0) this.lru.pin(key);
  }

  private lruRemove(p: ProcMem, pte: PTE): void {
    if (pte.lruSlot < 0) return;
    this.lru.remove(pageKey(p.pid, pte.pageId));
    pte.lruSlot = -1;
  }

  private applyPins(p: ProcMem, pte: PTE): void {
    const reasons: PinReason[] = [...p.procPins, ...(p.pagePins.get(pte.pageId) ?? [])];
    const was = pte.pins > 0;
    pte.pinReasons = reasons;
    pte.pins = reasons.length;
    if (pte.lruSlot < 0 || was === pte.pins > 0) return;
    const key = pageKey(p.pid, pte.pageId);
    if (pte.pins > 0) this.lru.pin(key);
    else this.lru.unpin(key);
  }

  private setProcPin(p: ProcMem, reason: PinReason, on: boolean): void {
    if (on === p.procPins.has(reason)) return;
    if (on) p.procPins.add(reason);
    else p.procPins.delete(reason);
    for (const pte of p.pageTable.values()) this.applyPins(p, pte);
  }

  private setPagePin(p: ProcMem, pte: PTE, reason: PinReason, on: boolean): void {
    const list = p.pagePins.get(pte.pageId) ?? [];
    const idx = list.indexOf(reason);
    if (on && idx < 0) list.push(reason);
    else if (!on && idx >= 0) list.splice(idx, 1);
    else return;
    if (list.length > 0) p.pagePins.set(pte.pageId, list);
    else p.pagePins.delete(pte.pageId);
    this.applyPins(p, pte);
  }

  private markNonPageable(p: ProcMem): void {
    if (p.nonPageable) return;
    p.nonPageable = true;
    const st = p.pageTable.get(0);
    if (st && st.kind === 'state') this.setPagePin(p, st, 'non-restartable', true);
  }

  private resegment(p: ProcMem): void {
    for (const pte of p.pageTable.values()) {
      if (pte.lruSlot < 0 || pte.speculative) continue;
      const seg = segmentFor(pte, p);
      if (seg === pte.seg) continue;
      this.lru.move(pageKey(p.pid, pte.pageId), seg);
      pte.seg = seg;
    }
  }

  private softLimitCheck(p: ProcMem): void {
    const over = accountedOf(p) > p.softLimit;
    if (over === p.overSoftLimit) return;
    p.overSoftLimit = over;
    this.log('soft-limit', { pid: p.pid, bytes: accountedOf(p), detail: over ? 'over' : 'under' });
    this.hooks.softLimit?.(p.pid, over);
    this.resegment(p);
  }

  private hit(p: ProcMem, pte: PTE, now: number): void {
    p.hits++;
    pte.hits++;
    this.counters.hits++;
    pte.lastAccess = now;
    if (pte.speculative) {
      // First real access: HOT (or COLD), flag cleared, a prefetch hit (PRE-03).
      pte.speculative = false;
      this.counters.prefetchHits++;
      if (pte.lruSlot >= 0) {
        const seg = segmentFor(pte, p);
        this.lru.move(pageKey(p.pid, pte.pageId), seg);
        pte.seg = seg;
      }
      return;
    }
    if (pte.lruSlot >= 0) this.lru.touch(pageKey(p.pid, pte.pageId));
  }

  private markDirty(pte: PTE): void {
    pte.dirty = true;
    if (pte.local === 'valid') pte.local = 'stale';
    if (pte.remote === 'acked' || pte.remote === 'pending') pte.remote = 'stale';
  }

  private topUpHeadroom(p: ProcMem): void {
    if (!p.checkpointable || !p.resident) return;
    const missing = this.params.stateHeadroom - (p.headroom?.bytes ?? 0);
    if (missing <= 0) return;
    const t = this.res.tryReserve(p.pid, missing, this.res.budget, 'headroom');
    if (t) p.headroom = this.res.merge(p.headroom, t);
  }

  // --- page I/O bookkeeping --------------------------------------------------------------------

  private beginIo(key: number, kind: PageIo['kind'], p: ProcMem, pte: PTE): PageIo {
    let resolve: () => void = noop;
    const done = new Promise<void>((r) => {
      resolve = r;
    });
    const io: PageIo = { kind, done, resolve, wantBack: false };
    this.io.set(key, io);
    this.lruRemove(p, pte);
    pte.busy = true;
    this.setPagePin(p, pte, 'io', true);
    return io;
  }

  private endIo(key: number, p: ProcMem, pte: PTE): void {
    const io = this.io.get(key);
    this.io.delete(key);
    pte.busy = false;
    if (this.procs.get(p.pid) === p) this.setPagePin(p, pte, 'io', false);
    io?.resolve();
  }

  /** Remove a resident page's charge after its bytes were dropped or verified out (INV-M2). */
  private releaseResident(p: ProcMem, pte: PTE, loc: PTE['loc']): void {
    this.lruRemove(p, pte);
    if (pte.loc === 'RESIDENT') {
      p.residentBytes -= pte.size;
      pte.loc = loc;
      if (pte.speculative) {
        pte.speculative = false;
        this.counters.prefetchMisses++;
      }
      this.res.uncharge(pte.size);
      this.softLimitCheck(p);
    } else {
      pte.loc = loc;
    }
  }

  private forgetCopies(p: ProcMem, pte: PTE): void {
    const key = this.swapKey(p, pte, true);
    this.uploads?.remove(key);
    if (pte.local !== 'none' || pte.gen > 0) void this.device.delete(key).catch(noop);
    if (this.remote && pte.remote !== 'none' && this.online)
      void this.remote.delete(key).catch(noop);
  }

  // --- reading pages ---------------------------------------------------------------------------

  private async readPage(p: ProcMem, pte: PTE, onProgress?: ProgressFn): Promise<ReadResult> {
    const key = pageKey(p.pid, pte.pageId);
    const held = this.held.get(key);
    if (held) {
      this.held.delete(key);
      return { ok: true, header: held.header, body: held.body, tier: 'kernel' };
    }
    const sk = this.swapKey(p, pte);
    let err: 'EIO' | 'EACCES' | 'ENOENT' = 'ENOENT';
    if (pte.local === 'valid') {
      const r = await this.device.read(sk, pte.gen, pte.sha256, onProgress);
      if (r.ok) return { ok: true, header: r.header, body: r.body, tier: 'local' };
      err = 'EIO';
      this.log('verify-fail', {
        pid: p.pid,
        pageId: pte.pageId,
        detail: `tier 1 ${r.errno}${r.reason ? ` ${r.reason}` : ''}`,
      });
      pte.local = 'none';
    }
    if (pte.remote === 'acked' && this.remote) {
      const r = await this.remote.get(sk, pte.gen, pte.sha256, onProgress);
      if (r.ok) return { ok: true, header: r.header, body: r.body, tier: 'remote' };
      err = r.errno;
      if (r.errno === 'EIO')
        this.log('verify-fail', { pid: p.pid, pageId: pte.pageId, detail: 'tier 2' });
    }
    if (pte.backing && this.backing) {
      const r = await this.backing.read(pte.backing, pte.sha256, onProgress);
      if (r.ok) {
        if (sha256Hex(r.body) !== pte.sha256) {
          this.log('verify-fail', { pid: p.pid, pageId: pte.pageId, detail: 'backing' });
          return { ok: false, errno: 'EIO' };
        }
        const enc = encodeRaw(r.body, { sha256: pte.sha256 });
        return { ok: true, header: enc.header, body: r.body, tier: 'backed' };
      }
      err = r.errno === 'EIO' ? 'EIO' : err;
    }
    return { ok: false, errno: err };
  }

  private progress(pid: number, total: number): { update: ProgressFn; finish: () => void } {
    const hooks = this.hooks;
    if (!hooks.restoring) return { update: noop, finish: noop };
    const restoring = (p: number, d: number, t: number): void => hooks.restoring?.(p, d, t);
    let done = 0;
    let tot = total;
    let cancel: () => void = noop;
    const emit = (): void => restoring(pid, done, tot);
    const arm = (): void => {
      cancel = this.clock.schedule(this.params.restoreProgressMs, () => {
        emit();
        arm();
      });
    };
    emit();
    arm();
    return {
      update: (d, t) => {
        done = d;
        tot = Math.max(tot, t);
        cancel();
        emit();
        arm();
      },
      finish: () => {
        cancel();
        done = tot;
        emit();
      },
    };
  }

  /** Reserve, read, verify and hand a page to its executor (or hold it for a SUSPENDED process). */
  private async loadPage(
    p: ProcMem,
    pte: PTE,
    o: { prio?: number; why: string; fault?: boolean },
  ): Promise<void> {
    const key = pageKey(p.pid, pte.pageId);
    const ticket: Ticket = await this.res.reserve(p.pid, pte.size, {
      ...(o.prio === undefined ? {} : { prio: o.prio }),
      why: o.why,
    });
    if (!this.alive(p, pte)) {
      this.res.cancel(ticket);
      throw new MmError('ESRCH');
    }
    if (o.fault === true) this.hooks.setWaiting?.(p.pid, `page:${pte.pageId}`);
    const other = this.io.get(key);
    if (other) await other.done;
    if (pte.loc === 'RESIDENT') {
      this.res.cancel(ticket);
      return;
    }
    const t0 = this.clock.now();
    this.beginIo(key, 'in', p, pte);
    const prog =
      o.fault === true || p.window
        ? this.progress(p.pid, pte.size)
        : { update: noop, finish: noop };
    let r: ReadResult;
    try {
      if (pte.kind === 'worker') {
        await this.exec.respawnWorker?.(p.pid);
        r = { ok: true, header: new ArrayBuffer(0), body: new ArrayBuffer(0), tier: 'backed' };
      } else {
        r = await this.readPage(p, pte, prog.update);
      }
    } catch {
      r = { ok: false, errno: 'EIO' };
    }
    if (!r.ok || !this.alive(p, pte)) {
      prog.finish();
      this.res.cancel(ticket);
      this.endIo(key, p, pte);
      if (!this.alive(p, pte)) throw new MmError('ESRCH');
      const errno = r.ok ? 'EIO' : r.errno === 'EACCES' ? 'EACCES' : 'EIO';
      this.log('verify-fail', { pid: p.pid, pageId: pte.pageId, detail: `page lost (${errno})` });
      throw new MmError(
        errno,
        errno === 'EIO' ? 'checksum' : undefined,
        `page ${pte.pageId} of pid ${p.pid} could not be read`,
      );
    }
    try {
      if (pte.kind !== 'worker') {
        if (p.resident && pte.kind !== 'state')
          await this.exec.pageIn(p.pid, pte.pageId, r.body, pte.sha256);
        else this.held.set(key, { header: r.header, body: r.body });
      }
    } catch (e) {
      prog.finish();
      this.res.cancel(ticket);
      this.endIo(key, p, pte);
      throw e;
    }
    if (!this.alive(p, pte)) {
      // Freed or exited while the executor was receiving it: nothing may be charged.
      prog.finish();
      this.res.cancel(ticket);
      this.held.delete(key);
      this.endIo(key, p, pte);
      throw new MmError('ESRCH');
    }
    this.res.commit(ticket, pte.size);
    pte.loc = 'RESIDENT';
    pte.dirty = false;
    pte.lastAccess = this.clock.now();
    p.residentBytes += pte.size;
    const ms = this.clock.now() - t0;
    p.bytesIn += pte.size;
    this.counters.pagesIn++;
    if (r.tier === 'local' || r.tier === 'remote') this.counters.bytesSwapIn += pte.size;
    this.endIo(key, p, pte);
    this.lruInsert(p, pte);
    prog.finish();
    this.hooks.event?.('mem.fault', {
      pid: p.pid,
      pageId: pte.pageId,
      tier: r.tier === 'remote' ? 'remote' : 'local',
      bytes: pte.size,
      ms,
    });
    this.log('page-in', { pid: p.pid, pageId: pte.pageId, bytes: pte.size, ms, detail: r.tier });
    this.softLimitCheck(p);
    this.maybeReclaim();
  }

  private async pageInWorkingSet(p: ProcMem): Promise<void> {
    const ids = p.wsAtSuspend;
    p.wsAtSuspend = [];
    for (const id of ids) {
      const pte = p.pageTable.get(id);
      if (!pte || pte.loc === 'RESIDENT' || !p.resident || this.procs.get(p.pid) !== p) continue;
      await this.loadPage(p, pte, { why: 'working-set' }).catch(noop);
    }
  }

  // --- writing pages ---------------------------------------------------------------------------

  private canUpload(uid: number): boolean {
    return (
      this.remote !== undefined && this.tier !== 'local' && this.online && this.onlineUids.has(uid)
    );
  }

  private async putRemote(
    key: SwapKey,
    gen: number,
    header: ArrayBuffer,
    body: ArrayBuffer,
    sha: string,
  ): Promise<boolean> {
    if (!this.remote) return false;
    try {
      const r = await this.remote.put(key, gen, joinPageFile(header, body), sha);
      if (!r.ok)
        this.log('upload-fail', { pid: key.pid, pageId: key.pageId, detail: `HTTP ${r.status}` });
      return r.ok;
    } catch {
      return false;
    }
  }

  /**
   * Write generation `gen` to swap: tier 1 (verified), or tier 2 in remote-only mode or when
   * local swap is full (after dropping local copies that have an acknowledged remote copy).
   */
  private async writeTiers(
    p: ProcMem,
    pte: PTE,
    gen: number,
    header: ArrayBuffer,
    body: ArrayBuffer,
    sha: string,
  ): Promise<
    { ok: true; where: 'local' | 'remote'; body: ArrayBuffer } | { ok: false; body: ArrayBuffer }
  > {
    const key = this.swapKey(p, pte, true);
    if (this.tier === 'remote' && this.canUpload(p.uid)) {
      if (await this.putRemote(key, gen, header, body, sha))
        return { ok: true, where: 'remote', body };
    }
    let r = await this.device.write(key, gen, header, body, sha);
    if (!r.ok && r.errno === 'EDQUOT') {
      await this.dropAckedLocalCopies(PAGE_HEADER_BYTES + body.byteLength);
      r = await this.device.write(key, gen, header, r.body, sha);
      if (!r.ok && r.errno === 'EDQUOT' && this.canUpload(p.uid)) {
        if (await this.putRemote(key, gen, header, r.body, sha))
          return { ok: true, where: 'remote', body: r.body };
      }
    }
    if (r.ok) {
      this.counters.bytesSwapOut += body.byteLength;
      return { ok: true, where: 'local', body: r.body };
    }
    if (r.errno === 'EIO') {
      if (!this.degraded)
        this.log('device-degraded', { pid: p.pid, pageId: pte.pageId, detail: this.device.kind });
      this.degraded = true;
    }
    this.log('verify-fail', { pid: p.pid, pageId: pte.pageId, detail: `write ${r.errno}` });
    return { ok: false, body: r.body };
  }

  /** Local swap is full: drop local copies whose remote copy is acknowledged, oldest first (§3.10.3). */
  private async dropAckedLocalCopies(needed: number): Promise<number> {
    const cands: Array<{ p: ProcMem; pte: PTE }> = [];
    for (const p of this.procs.values()) {
      for (const pte of p.pageTable.values())
        if (pte.local === 'valid' && pte.remote === 'acked' && !pte.busy) cands.push({ p, pte });
    }
    cands.sort((a, b) => a.pte.lastAccess - b.pte.lastAccess);
    let freed = 0;
    for (const { p, pte } of cands) {
      if (freed >= needed) break;
      await this.device.delete(this.swapKey(p, pte, true), [pte.gen]).catch(noop);
      pte.local = 'none';
      if (pte.loc === 'LOCAL_SWAP') pte.loc = 'REMOTE_SWAP';
      freed += PAGE_HEADER_BYTES + pte.size;
    }
    return freed;
  }

  private queueUpload(p: ProcMem, pte: PTE): void {
    if (!this.uploads || this.tier !== 'auto' || !this.canUpload(p.uid)) return;
    pte.remote = 'pending';
    this.uploads.enqueue(this.swapKey(p, pte, true), pte.gen, pte.sha256, {
      window: p.window && pte.kind === 'state',
    });
  }

  private async readForUpload(
    key: SwapKey,
    gen: number,
    sha: string,
  ): Promise<{ header: ArrayBuffer; body: ArrayBuffer } | null> {
    const p = this.procs.get(key.pid);
    const pte = p?.pageTable.get(key.pageId);
    if (!p || !pte || pte.gen !== gen || pte.local !== 'valid' || pte.sha256 !== sha) return null;
    const r = await this.device.read(key, gen, sha);
    return r.ok ? { header: r.header, body: r.body } : null;
  }

  private onUploadAcked(key: SwapKey, gen: number): void {
    const pte = this.procs.get(key.pid)?.pageTable.get(key.pageId);
    if (!pte || pte.gen !== gen || pte.remote !== 'pending') return;
    pte.remote = 'acked';
    this.log('upload', { pid: key.pid, pageId: key.pageId, bytes: pte.size });
  }

  private onUploadFailed(key: SwapKey, gen: number): void {
    const pte = this.procs.get(key.pid)?.pageTable.get(key.pageId);
    if (!pte || pte.gen !== gen || pte.remote !== 'pending') return;
    pte.remote = 'failed';
  }

  /**
   * Page out one dirty data page (§3.9.1). Returns true when its memory was released. With
   * `keep` (a checkpoint) the verified body goes back to the executor and the page stays resident
   * and clean. A fault that arrives meanwhile also gets the body back with no read.
   */
  private async pageOutData(p: ProcMem, pte: PTE, keep: boolean): Promise<boolean> {
    const key = pageKey(p.pid, pte.pageId);
    if (pte.loc !== 'RESIDENT' || this.io.has(key)) return false;
    const io = this.beginIo(key, 'out', p, pte);
    io.wantBack = keep;
    let page: ExecPage | undefined;
    try {
      [page] = await this.exec.pageOut(p.pid, [pte.pageId]);
    } catch {
      page = undefined;
    }
    if (!page) {
      this.endIo(key, p, pte);
      this.lruInsert(p, pte);
      return false;
    }
    const gen = pte.gen + 1;
    const w = await this.writeTiers(p, pte, gen, page.header, page.body, page.sha256);
    if (!this.alive(p, pte)) {
      // Freed or exited while writing: the charge is already gone; delete the orphan copy.
      if (w.ok) void this.device.delete(this.swapKey(p, pte, true)).catch(noop);
      this.endIo(key, p, pte);
      return false;
    }
    if (!w.ok) {
      // MEM-03: nothing is released; the bytes go back, the page stays RESIDENT and dirty.
      await this.exec.pageIn(p.pid, pte.pageId, w.body, page.sha256).catch(noop);
      this.endIo(key, p, pte);
      this.lruInsert(p, pte);
      return false;
    }
    pte.gen = gen;
    pte.sha256 = page.sha256;
    pte.dirty = false;
    delete pte.origin;
    pte.local = w.where === 'local' ? 'valid' : 'none';
    pte.remote = w.where === 'remote' ? 'acked' : 'none';
    if (w.where === 'local') this.queueUpload(p, pte);
    p.bytesOut += pte.size;
    this.counters.pagesOut++;
    if (io.wantBack) {
      await this.exec.pageIn(p.pid, pte.pageId, w.body, pte.sha256).catch(noop);
      pte.lastAccess = this.clock.now();
      this.endIo(key, p, pte);
      this.lruInsert(p, pte);
      return false;
    }
    // Only now: drop the last reference and remove the charge (INV-M2).
    this.releaseResident(p, pte, dropLocation(pte));
    this.endIo(key, p, pte);
    this.hooks.event?.('mem.evict', {
      pid: p.pid,
      pageId: pte.pageId,
      bytes: pte.size,
      to: w.where,
    });
    this.log('page-out', { pid: p.pid, pageId: pte.pageId, bytes: pte.size, detail: w.where });
    return true;
  }

  /** Drop a clean page without any write (Spec §9.2); `ai.embed`'s page terminates its worker. */
  private async dropPage(p: ProcMem, pte: PTE): Promise<boolean> {
    const key = pageKey(p.pid, pte.pageId);
    if (pte.loc !== 'RESIDENT' || this.io.has(key)) return false;
    this.beginIo(key, 'drop', p, pte);
    try {
      if (this.held.delete(key)) {
        // A speculative page held by the kernel: nothing to tell an executor.
      } else if (pte.kind === 'worker') {
        await this.exec.terminateWorker?.(p.pid);
      } else {
        await this.exec.release(p.pid, [pte.pageId], false);
      }
    } catch {
      this.endIo(key, p, pte);
      this.lruInsert(p, pte);
      return false;
    }
    if (!this.alive(p, pte)) {
      this.endIo(key, p, pte);
      return false;
    }
    this.releaseResident(p, pte, dropLocation(pte));
    this.counters.drops++;
    this.endIo(key, p, pte);
    this.hooks.event?.('mem.evict', {
      pid: p.pid,
      pageId: pte.pageId,
      bytes: pte.size,
      to: 'drop',
    });
    this.log('drop', { pid: p.pid, pageId: pte.pageId, bytes: pte.size });
    return true;
  }

  /** Write a checkpointed state page unless its valid copy already has the same hash. */
  private async writeStatePage(
    p: ProcMem,
    st: PTE,
    cp: Extract<CheckpointResult, { ok: true }>,
  ): Promise<boolean> {
    void this.measureState(p.pid, cp.body.byteLength);
    const sameCopy =
      (st.local === 'valid' ||
        st.local === 'stale' ||
        st.remote === 'acked' ||
        st.remote === 'stale') &&
      st.sha256 === cp.sha256;
    if (sameCopy && (st.local !== 'none' || st.remote !== 'none')) {
      if (st.local === 'stale') st.local = 'valid';
      if (st.remote === 'stale') st.remote = 'acked';
      st.dirty = false;
      return true;
    }
    const gen = st.gen + 1;
    const w = await this.writeTiers(p, st, gen, cp.header, cp.body, cp.sha256);
    if (!w.ok) return false;
    st.gen = gen;
    st.sha256 = cp.sha256;
    st.dirty = false;
    delete st.origin;
    st.local = w.where === 'local' ? 'valid' : 'none';
    st.remote = w.where === 'remote' ? 'acked' : 'none';
    if (w.where === 'local') this.queueUpload(p, st);
    p.bytesOut += st.size;
    this.counters.pagesOut++;
    return true;
  }

  /**
   * Whole-process suspend (§3.9.2): page out every dirty data page, drop every clean one, then
   * checkpoint the state with release, write and verify it LAST, and only then release the
   * process and remove its charges. If any step fails nothing more is released and the process
   * keeps running.
   */
  private async suspend(p: ProcMem): Promise<{ bytes: number; ms: number }> {
    if (!p.resident || this.procs.get(p.pid) !== p) return { bytes: 0, ms: 0 };
    if (p.nonRestartable)
      throw new MmError('EBUSY', undefined, 'a non-restartable call is in flight');
    if (!p.checkpointable)
      throw new MmError('EBUSY', undefined, 'the process is not checkpointable');
    if (p.nonPageable) throw new MmError('EBUSY', undefined, 'the process state is not pageable');
    const t0 = this.clock.now();
    const before = accountedOf(p);
    const st = this.statePte(p);
    const stKey = pageKey(p.pid, 0);
    if (this.io.has(stKey)) throw new MmError('EBUSY', undefined, 'state page busy');
    this.beginIo(stKey, 'out', p, st);
    try {
      const data = this.residentData(p);
      p.wsAtSuspend = data.map((pte) => pte.pageId);
      await this.limited(data, (pte) =>
        pte.kind === 'worker' || isClean(pte)
          ? this.dropPage(p, pte)
          : this.pageOutData(p, pte, false),
      );
      if (
        this.residentData(p).length > 0 ||
        [...p.pageTable.values()].some((x) => x.kind !== 'state' && x.busy)
      ) {
        throw new MmError('EBUSY', undefined, 'some pages could not be paged out');
      }
      const cp = await this.exec.checkpoint(p.pid, true);
      if (!cp.ok) {
        this.markNonPageable(p);
        this.log('checkpoint', { pid: p.pid, detail: `codec rejected the state: ${cp.msg}` });
        throw new MmError('EINVAL', 'codec', cp.msg);
      }
      if (!(await this.writeStatePage(p, st, cp)))
        throw new MmError('EIO', 'storage', 'state page write failed');
      await this.exec.release(p.pid, [], true);
      if (this.procs.get(p.pid) !== p) return { bytes: 0, ms: 0 };
      const freed = st.size + p.declaredBytes + p.overheadCharged;
      st.loc = dropLocation(st);
      p.residentBytes -= st.size;
      p.declared.clear();
      p.declaredBytes = 0;
      p.overheadCharged = 0;
      p.resident = false;
      if (p.headroom) this.res.cancel(p.headroom);
      p.headroom = null;
      this.endIo(stKey, p, st);
      this.res.uncharge(freed);
      this.counters.suspends++;
      const ms = this.clock.now() - t0;
      this.hooks.suspended?.(p.pid);
      this.hooks.event?.('mem.evict', {
        pid: p.pid,
        pageId: 0,
        bytes: st.size,
        to: st.loc === 'REMOTE_SWAP' ? 'remote' : 'local',
      });
      this.log('suspend', { pid: p.pid, bytes: before, ms });
      this.softLimitCheck(p);
      return { bytes: before, ms };
    } finally {
      if (this.io.has(stKey)) {
        this.endIo(stKey, p, st);
        this.lruInsert(p, st);
      }
    }
  }

  private async pageInProcess(
    p: ProcMem,
    prio: number | undefined,
    from: 'page-in' | 'session',
  ): Promise<{ bytes: number; ms: number }> {
    if (p.resident || this.procs.get(p.pid) !== p) return { bytes: 0, ms: 0 };
    const st = this.statePte(p);
    const stKey = pageKey(p.pid, 0);
    const heldState = st.loc === 'RESIDENT' && this.held.has(stKey);
    const overhead = p.special ? 0 : this.params.overheadProc;
    const headroom = this.params.stateHeadroom;
    const need = (heldState ? 0 : st.size) + overhead + headroom;
    const t0 = this.clock.now();
    const ticket = await this.res.reserve(p.pid, need, {
      ...(prio === undefined ? {} : { prio }),
      why: 'page-in',
    });
    if (this.procs.get(p.pid) !== p) {
      this.res.cancel(ticket);
      throw new MmError('ESRCH');
    }
    const prog = this.progress(p.pid, st.size);
    let page: { header: ArrayBuffer; body: ArrayBuffer };
    if (heldState) {
      const h = this.held.get(stKey);
      if (!h) throw new MmError('EIO');
      this.held.delete(stKey);
      page = h;
      this.lruRemove(p, st);
      if (st.speculative) {
        st.speculative = false;
        this.counters.prefetchHits++;
      }
    } else {
      this.beginIo(stKey, 'in', p, st);
      let r: ReadResult;
      try {
        r = await this.readPage(p, st, prog.update);
      } catch {
        r = { ok: false, errno: 'EIO' };
      }
      this.endIo(stKey, p, st);
      if (this.procs.get(p.pid) !== p) {
        prog.finish();
        this.res.cancel(ticket);
        throw new MmError('ESRCH');
      }
      if (!r.ok) {
        prog.finish();
        this.res.cancel(ticket);
        throw new MmError(
          r.errno === 'EACCES' ? 'EACCES' : 'EIO',
          r.errno === 'EACCES' ? undefined : 'checksum',
          'the state page could not be read',
        );
      }
      page = r;
    }
    try {
      await this.exec.restore(
        p.pid,
        { header: page.header, body: page.body, sha256: st.sha256 },
        from,
      );
    } catch (e) {
      prog.finish();
      this.res.cancel(ticket);
      if (heldState) this.held.set(stKey, page);
      throw e;
    }
    if (this.procs.get(p.pid) !== p) {
      prog.finish();
      this.res.cancel(ticket);
      throw new MmError('ESRCH');
    }
    const rest = this.res.consume(ticket, (heldState ? 0 : st.size) + overhead);
    if (!heldState) {
      st.loc = 'RESIDENT';
      p.residentBytes += st.size;
    }
    st.dirty = false;
    st.lastAccess = this.clock.now();
    p.overheadCharged = overhead;
    p.headroom = rest;
    p.resident = true;
    this.lruInsert(p, st);
    // Speculative data pages the kernel held go to the executor now.
    for (const pte of p.pageTable.values()) {
      const k = pageKey(p.pid, pte.pageId);
      const h = this.held.get(k);
      if (!h || pte.kind === 'state') continue;
      this.held.delete(k);
      await this.exec.pageIn(p.pid, pte.pageId, h.body, pte.sha256).catch(noop);
    }
    const ms = this.clock.now() - t0;
    p.lastPageInMs = ms;
    p.bytesIn += st.size;
    this.counters.pagesIn++;
    if (!heldState) this.counters.bytesSwapIn += st.size;
    prog.finish();
    this.hooks.resumed?.(p.pid);
    this.hooks.restored?.(p.pid, st.size, ms);
    this.log('page-in', { pid: p.pid, pageId: 0, bytes: st.size, ms, detail: from });
    this.softLimitCheck(p);
    // The working set follows in the background (§3.13.2).
    void this.pageInWorkingSet(p);
    this.maybeReclaim();
    return { bytes: st.size, ms };
  }

  // --- reclaim ---------------------------------------------------------------------------------

  private reclaimMode(): ReclaimMode {
    if (this.res.blocked > 0) return 'direct';
    return this.loopRunning || this.background ? 'background' : 'idle';
  }

  private updatePressure(): void {
    const level =
      this.res.blocked > 0 ? 'blocked' : this.loopRunning || this.background ? 'reclaim' : 'ok';
    if (level === this.pressureLevel) return;
    this.pressureLevel = level;
    this.hooks.event?.('mem.pressure', {
      accounted: this.res.accounted,
      budget: this.res.budget,
      level,
    });
  }

  /** Start background reclaim above HIGH_WM, or direct reclaim for a blocked reservation. */
  private maybeReclaim(): void {
    if (!this.background && shouldStartBackground(this.res.committed, this.res.budget, this.params))
      this.background = true;
    if (!(this.background || this.res.headDeficit() > 0)) return;
    if (this.loopRunning) {
      this.reclaimAgain = true;
      return;
    }
    this.loopRunning = true;
    this.reclaimAgain = false;
    this.updatePressure();
    void this.reclaimLoop().finally(() => {
      this.loopRunning = false;
      this.updatePressure();
      if (this.reclaimAgain) {
        this.reclaimAgain = false;
        this.maybeReclaim();
      }
    });
  }

  private need(): number {
    if (this.background && this.res.committed <= watermarks(this.res.budget, this.params).low)
      this.background = false;
    return reclaimNeed({
      committed: this.res.committed,
      budget: this.res.budget,
      background: this.background,
      headDeficit: this.res.headDeficit(),
      freeing: this.freeing,
      params: this.params,
    });
  }

  private slot(): Promise<void> {
    return new Promise((resolve) => this.slotWaiters.push(resolve));
  }

  /** Count the bytes as being freed BEFORE the operation starts (it may free them synchronously). */
  private startOp(bytes: number, run: () => Promise<unknown>): void {
    this.inflightOps++;
    this.freeing += bytes;
    let op: Promise<unknown>;
    try {
      op = run();
    } catch (e) {
      op = Promise.reject(e instanceof Error ? e : new Error(String(e)));
    }
    void op.catch(noop).finally(() => {
      this.inflightOps--;
      this.freeing -= bytes;
      this.slotWaiters.shift()?.();
      this.maybeReclaim();
    });
  }

  private async reclaimLoop(): Promise<void> {
    this.passSkipped.clear();
    // State pages of processes that cannot be suspended right now (their own reservation is
    // blocked): kept out of the list for this pass, then re-inserted, so the pass terminates.
    const deferred: Array<{ p: ProcMem; pte: PTE }> = [];
    try {
      await this.reclaimPass(deferred);
    } finally {
      for (const { p, pte } of deferred)
        if (this.alive(p, pte) && pte.lruSlot < 0) this.lruInsert(p, pte);
    }
  }

  private async reclaimPass(deferred: Array<{ p: ProcMem; pte: PTE }>): Promise<void> {
    for (;;) {
      if (this.need() <= 0) break;
      if (this.inflightOps >= this.params.blkioInflight) {
        await this.slot();
        continue;
      }
      const v = this.lru.evict();
      if (!v) {
        if (this.inflightOps > 0) {
          await this.slot();
          continue;
        }
        break; // everything resident is pinned or busy: reservations keep waiting (§3.6)
      }
      const { pid } = splitPageKey(v.key);
      const p = this.procs.get(pid);
      const pte = v.value;
      pte.lruSlot = -1;
      if (!p || p.pageTable.get(pte.pageId) !== pte) continue;
      const now = this.clock.now();
      if (hintSkips(this.hint, p.app, now, this.passSkipped.has(v.key))) {
        this.passSkipped.add(v.key);
        this.lruInsert(p, pte);
        this.log('hint-skip', { pid, pageId: pte.pageId });
        continue;
      }
      const action = victimAction(pte);
      if (action === 'suspend') {
        if (p.nonPageable || p.nonRestartable || !p.checkpointable) {
          this.lruInsert(p, pte);
          continue;
        }
        if (this.res.hasWaiter(pid) || !p.resident) {
          deferred.push({ p, pte });
          continue;
        }
        this.startOp(accountedOf(p), () =>
          this.serial(pid, () => this.suspend(p)).catch(() => {
            if (this.alive(p, pte) && pte.loc === 'RESIDENT' && !pte.busy && pte.lruSlot < 0)
              this.lruInsert(p, pte);
          }),
        );
      } else if (action === 'drop') {
        this.startOp(pte.size, () => this.dropPage(p, pte));
      } else {
        this.startOp(pte.size, () => this.pageOutData(p, pte, false));
      }
      // Yield between victims so reclaim never stalls the dispatcher for long (§3.6).
      await Promise.resolve();
    }
  }
}
