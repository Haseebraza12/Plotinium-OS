/**
 * The accounting model (specs/03-kernel/memory-and-paging.md §3.2, MEM-01, KMM-01, KMM-02).
 *
 *   accounted(pid)  = stateBytes(pid)          if the state page is resident (last encoded size)
 *                   + Σ size(resident data pages of pid)   (logical pages and 256 KiB chunks)
 *                   + declaredAssets(pid)                  (ImageBitmap w·h·4, WebAssembly memory,
 *                                                           large ArrayBuffers, via mem.declare)
 *                   + OVERHEAD_PROC            if the process is resident on an executor
 *   accounted(ai.embed) = its declared worker page while resident, else 0
 *   committed       = Σ accounted(pid) + Σ outstanding reservations          (the budget applies here)
 *   kernel line     = Σ entries × measured bytes/entry + I/O buffers in flight  (reported, NOT charged)
 *
 * The state page is page 0 of kind 'state', so "Σ resident page sizes" covers both the state and
 * the data pages. `accountedOf` is O(1): the per-process sums are maintained incrementally by the
 * memory manager and re-derived by `recountResident` in the invariant checks.
 */
import type { Ticket } from './reserve.ts';
import type { PinReason, PTE, Loc } from './types.ts';

export interface ProcMem {
  readonly pid: number;
  uid: number;
  app: string;
  /** Command line for vmstat -p / pmap. */
  label: string;
  /** UUIDv7 of the OS session: part of every swap key. */
  osSession: string;
  checkpointable: boolean;
  /** Special worker (ai.embed): charged only its worker page, no OVERHEAD_PROC. */
  special: boolean;
  /** Owns at least one window (its checkpoints upload first, §3.11 step 4). */
  window: boolean;
  pageTable: Map<number, PTE>;
  nextPageId: number;
  /** Declared assets by label (mem.declare); not paged, released on suspend. */
  declared: Map<string, number>;
  declaredBytes: number;
  /** Σ size of resident pages, state page included. */
  residentBytes: number;
  /** OVERHEAD_PROC while resident on an executor (0 when SUSPENDED or special). */
  overheadCharged: number;
  /** Standing STATE_HEADROOM reservation of a resident checkpointable process. */
  headroom: Ticket | null;
  /** On an executor (false = SUSPENDED, charged 0; INV-M4). */
  resident: boolean;
  /** Admitted (spawn reservation committed). */
  admitted: boolean;
  softLimit: number;
  overSoftLimit: boolean;
  minimised: boolean;
  /** Process-level pin reasons: P1 focus, P2 service, P3 np-section. */
  procPins: Set<PinReason>;
  /** Page-level pin reasons by page id: P4 io, P5 ai-search, P6 non-restartable. */
  pagePins: Map<number, PinReason[]>;
  /** A non-restartable call is in flight (P6: explicit page-out answers EBUSY). */
  nonRestartable: boolean;
  /** The codec rejected the state or it exceeds STATE_MAX: the state page is pinned. */
  nonPageable: boolean;
  stateWarned: boolean;
  /** Page ids that were resident when the process was suspended (its working set). */
  wsAtSuspend: number[];
  faults: number;
  hits: number;
  bytesIn: number;
  bytesOut: number;
  lastPageInMs: number | null;
}

export interface NewProcMem {
  pid: number;
  uid: number;
  app: string;
  label?: string;
  osSession: string;
  checkpointable?: boolean;
  special?: boolean;
  window?: boolean;
  softLimit: number;
}

export function newProcMem(o: NewProcMem): ProcMem {
  return {
    pid: o.pid,
    uid: o.uid,
    app: o.app,
    label: o.label ?? o.app,
    osSession: o.osSession,
    checkpointable: o.checkpointable ?? true,
    special: o.special ?? false,
    window: o.window ?? false,
    pageTable: new Map(),
    nextPageId: 0,
    declared: new Map(),
    declaredBytes: 0,
    residentBytes: 0,
    overheadCharged: 0,
    headroom: null,
    resident: false,
    admitted: false,
    softLimit: o.softLimit,
    overSoftLimit: false,
    minimised: false,
    procPins: new Set(),
    pagePins: new Map(),
    nonRestartable: false,
    nonPageable: false,
    stateWarned: false,
    wsAtSuspend: [],
    faults: 0,
    hits: 0,
    bytesIn: 0,
    bytesOut: 0,
    lastPageInMs: null,
  };
}

/** accounted(pid) of §3.2.1, O(1). */
export function accountedOf(p: ProcMem): number {
  return p.residentBytes + p.declaredBytes + p.overheadCharged;
}

/** Re-derive Σ resident page sizes from the page table (invariant checks). O(pages). */
export function recountResident(p: ProcMem): number {
  let n = 0;
  for (const pte of p.pageTable.values()) if (pte.loc === 'RESIDENT') n += pte.size;
  return n;
}

/**
 * A resident page is clean when it is not dirty and a valid copy of its current generation
 * exists: a valid local copy, an acknowledged remote copy, or a durable backing (§3.4).
 */
export function isClean(pte: PTE): boolean {
  if (pte.dirty) return false;
  return pte.local === 'valid' || pte.remote === 'acked' || pte.backing !== undefined;
}

/** Where the authoritative bytes are once a clean page is dropped (§3.6 step 2). */
export function dropLocation(pte: PTE): Loc {
  if (pte.local === 'valid') return 'LOCAL_SWAP';
  if (pte.remote === 'acked') return 'REMOTE_SWAP';
  return 'BACKED';
}

/** Bytes of distinct pages accessed within the working-set window Δ (§3.13.4). O(pages). */
export function wsBytes(p: ProcMem, now: number, windowMs: number): number {
  let n = 0;
  for (const pte of p.pageTable.values()) if (pte.lastAccess >= now - windowMs) n += pte.size;
  return n;
}

/** One kernel structure on the Kernel line: entries × measured bytes per entry (§3.2.1). */
export interface KernelStructure {
  readonly name: string;
  readonly entries: number;
  readonly bytesPerEntry: number;
}

/** The Kernel line of `free`: reported, never charged to the budget (KMM-01 rule 1). */
export function kernelLine(
  structures: readonly KernelStructure[],
  ioInFlightBytes: number,
): { bytes: number; parts: Array<{ name: string; bytes: number }> } {
  const parts = structures.map((s) => ({
    name: s.name,
    bytes: Math.round(s.entries * s.bytesPerEntry),
  }));
  if (ioInFlightBytes > 0) parts.push({ name: 'io', bytes: ioInFlightBytes });
  return { bytes: parts.reduce((sum, x) => sum + x.bytes, 0), parts };
}

/**
 * Calibration constants (§3.2.3 step 3), loaded from kernel/core/mm/calibration.json at boot.
 * M = committed + κ · kernelLine + B_main + B_exec · executors + B_special · specialWorkers.
 */
export interface CalibrationConstants {
  overheadProc: number;
  kappa: number;
  bMain: number;
  bExec: number;
  bSpecial: number;
  /** The last calibration's error report, when one exists. */
  lastError?: { max: number; mean: number; date: string };
}

export const DEFAULT_CALIBRATION: CalibrationConstants = Object.freeze({
  overheadProc: 64 * 1_024,
  kappa: 1,
  bMain: 0,
  bExec: 0,
  bSpecial: 0,
});

/**
 * Validate `kernel/core/mm/calibration.json` (written by the nightly calibration job, §3.2.3
 * step 5). Anything malformed falls back to the defaults, so a bad file never stops the boot.
 */
export function loadCalibration(json: unknown): { constants: CalibrationConstants; ok: boolean } {
  const num = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
  if (typeof json !== 'object' || json === null)
    return { constants: DEFAULT_CALIBRATION, ok: false };
  const r = json as Record<string, unknown>;
  const overheadProc = num(r.overheadProc);
  const kappa = num(r.kappa);
  const bMain = num(r.bMain);
  const bExec = num(r.bExec);
  const bSpecial = num(r.bSpecial);
  if (
    overheadProc === undefined ||
    kappa === undefined ||
    bMain === undefined ||
    bExec === undefined ||
    bSpecial === undefined
  ) {
    return { constants: DEFAULT_CALIBRATION, ok: false };
  }
  const c: CalibrationConstants = { overheadProc, kappa, bMain, bExec, bSpecial };
  const e = r.lastError;
  if (typeof e === 'object' && e !== null) {
    const er = e as Record<string, unknown>;
    const max = num(er.max);
    const mean = num(er.mean);
    if (max !== undefined && mean !== undefined && typeof er.date === 'string')
      c.lastError = { max, mean, date: er.date };
  }
  return { constants: c, ok: true };
}

/** The whole-page memory the model predicts for one scenario (§3.2.3 step 3). */
export function modelEstimate(
  c: CalibrationConstants,
  s: { committed: number; kernelBytes: number; executors: number; specialWorkers: number },
): number {
  return (
    s.committed +
    c.kappa * s.kernelBytes +
    c.bMain +
    c.bExec * s.executors +
    c.bSpecial * s.specialWorkers
  );
}

/** err = |M − measured| / measured (§3.2.3 step 4). */
export function modelError(model: number, measured: number): number {
  if (!(measured > 0)) throw new RangeError('measured memory must be positive');
  return Math.abs(model - measured) / measured;
}

/** Maximum and mean error over scenarios; `ok` when the maximum is under the 25 % target. */
export function errorReport(pairs: ReadonlyArray<{ model: number; measured: number }>): {
  max: number;
  mean: number;
  ok: boolean;
} {
  if (pairs.length === 0) return { max: 0, mean: 0, ok: true };
  const errs = pairs.map((p) => modelError(p.model, p.measured));
  const max = Math.max(...errs);
  const mean = errs.reduce((a, b) => a + b, 0) / errs.length;
  return { max, mean, ok: max < 0.25 };
}
