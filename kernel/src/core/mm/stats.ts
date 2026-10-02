/**
 * Data providers for `free`, `vmstat` and `pmap` (specs/03-kernel/memory-and-paging.md §3.17,
 * MEM-07). The commands in apps/coreutils format these rows; the kernel only produces the numbers,
 * exactly as the column definitions of §3.17 describe them.
 */
import { accountedOf, wsBytes } from './accounting.ts';
import type { ProcMem } from './accounting.ts';
import type { MemSummary, PageKind, PinReason, PTE, Loc } from './types.ts';

/** `free` (§3.17.1): MemSummary plus the Kernel line's parts and the calibration model. */
export interface FreeReport extends MemSummary {
  kernelParts: Array<{ name: string; bytes: number }>;
  model: {
    overheadProc: number;
    kappa: number;
    bMain: number;
    bExec: number;
    bSpecial: number;
    lastError: { max: number; mean: number; date: string } | null;
  };
}

/** Cumulative system counters since boot; `vmstatLine` turns two samples into one line. */
export interface VmCounters {
  /** Kernel monotonic ms of the sample. */
  t: number;
  faults: number;
  hits: number;
  pagesIn: number;
  pagesOut: number;
  /** Bytes read from swap, both tiers (si). */
  bytesSwapIn: number;
  /** Bytes written to tier 1 (so). */
  bytesSwapOut: number;
  /** Bytes uploaded to tier 2 (ro). */
  bytesUploaded: number;
  used: number;
  free: number;
  reserved: number;
  pinned: number;
  suspended: number;
}

/** One `vmstat` line (§3.17.2). r, b, us, ke and id come from the scheduler, not from mm. */
export interface VmstatLine {
  s: number;
  usedMiB: number;
  freeMiB: number;
  rsvMiB: number;
  pinMiB: number;
  /** Major faults per second. */
  flt: number;
  /** hits / (hits + faults) over the interval, in percent (100 when there was no access). */
  hitPct: number;
  pi: number;
  po: number;
  /** KiB/s read from swap (both tiers) / written to tier 1 / uploaded to tier 2. */
  si: number;
  so: number;
  ro: number;
  wsOverBudget: boolean;
}

const MiB = 1_048_576;
const round1 = (x: number): number => Math.round(x * 10) / 10;

/**
 * One `vmstat` line from two samples. With `prev` undefined the line covers the time since boot
 * (first line of `vmstat`).
 */
export function vmstatLine(
  cur: VmCounters,
  prev: VmCounters | undefined,
  wsTotal = 0,
  budget = Number.POSITIVE_INFINITY,
): VmstatLine {
  const base: VmCounters = prev ?? {
    ...cur,
    t: 0,
    faults: 0,
    hits: 0,
    pagesIn: 0,
    pagesOut: 0,
    bytesSwapIn: 0,
    bytesSwapOut: 0,
    bytesUploaded: 0,
  };
  const secs = Math.max((cur.t - base.t) / 1_000, 1e-9);
  const df = cur.faults - base.faults;
  const dh = cur.hits - base.hits;
  const rate = (d: number): number => Math.round(d / secs);
  return {
    s: cur.suspended,
    usedMiB: round1(cur.used / MiB),
    freeMiB: round1(cur.free / MiB),
    rsvMiB: round1(cur.reserved / MiB),
    pinMiB: round1(cur.pinned / MiB),
    flt: rate(df),
    hitPct: dh + df === 0 ? 100 : round1((100 * dh) / (dh + df)),
    pi: rate(cur.pagesIn - base.pagesIn),
    po: rate(cur.pagesOut - base.pagesOut),
    si: Math.round((cur.bytesSwapIn - base.bytesSwapIn) / 1_024 / secs),
    so: Math.round((cur.bytesSwapOut - base.bytesSwapOut) / 1_024 / secs),
    ro: Math.round((cur.bytesUploaded - base.bytesUploaded) / 1_024 / secs),
    wsOverBudget: wsTotal > budget,
  };
}

/** `vmstat -p` row (§3.17.2), cumulative since the process started. */
export interface VmstatProcRow {
  pid: number;
  uid: number;
  res: number;
  swapL: number;
  swapR: number;
  ws: number;
  flt: number;
  hitPct: number;
  bytesIn: number;
  bytesOut: number;
  lastInMs: number | null;
  command: string;
  accounted: number;
  softLimit: number;
  overSoftLimit: boolean;
  suspended: boolean;
}

export function vmstatProcRow(p: ProcMem, now: number, wsWindowMs: number): VmstatProcRow {
  let swapL = 0;
  let swapR = 0;
  for (const pte of p.pageTable.values()) {
    if (pte.local === 'valid') swapL += pte.size;
    if (pte.remote === 'acked') swapR += pte.size;
  }
  const total = p.hits + p.faults;
  return {
    pid: p.pid,
    uid: p.uid,
    res: p.residentBytes,
    swapL,
    swapR,
    ws: wsBytes(p, now, wsWindowMs),
    flt: p.faults,
    hitPct: total === 0 ? 100 : round1((100 * p.hits) / total),
    bytesIn: p.bytesIn,
    bytesOut: p.bytesOut,
    lastInMs: p.lastPageInMs,
    command: p.label,
    accounted: accountedOf(p),
    softLimit: p.softLimit,
    overSoftLimit: p.overSoftLimit,
    suspended: !p.resident && p.admitted,
  };
}

/** `pmap` page row (§3.17.3); `-x` adds gen, the full SHA-256, pin reasons and the swap key. */
export interface PmapRow {
  page: number;
  kind: PageKind;
  label: string;
  size: number;
  location: Loc;
  /** COPIES: L valid local copy, S acknowledged server copy, s upload pending, B backed, - none. */
  copies: string;
  /** FLAGS: D dirty, P pinned, X speculative, W I/O in progress, - none. */
  flags: string;
  ageMs: number;
  sha256Short: string;
  gen: number;
  sha256: string;
  pinReasons: PinReason[];
  swapKey: string;
}

export interface PmapReport {
  pid: number;
  uid: number;
  command: string;
  softLimit: number;
  suspended: boolean;
  rows: PmapRow[];
  declared: Array<{ label: string; bytes: number }>;
  totals: {
    pages: number;
    bytes: number;
    resident: number;
    localCopies: number;
    remoteCopies: number;
    declared: number;
    faults: number;
    hitPct: number;
    bytesIn: number;
    bytesOut: number;
  };
}

export function copiesOf(pte: PTE): string {
  const l = pte.local === 'valid' ? 'L' : '-';
  const s =
    pte.remote === 'acked'
      ? 'S'
      : pte.remote === 'pending'
        ? 's'
        : pte.backing !== undefined
          ? 'B'
          : '-';
  return `${l} ${s}`;
}

export function flagsOf(pte: PTE): string {
  let f = '';
  if (pte.dirty) f += 'D';
  if (pte.pins > 0) f += 'P';
  if (pte.speculative) f += 'X';
  if (pte.busy) f += 'W';
  return f === '' ? '-' : f;
}

export function pmapReport(p: ProcMem, now: number): PmapReport {
  const rows: PmapRow[] = [];
  let bytes = 0;
  let resident = 0;
  let localCopies = 0;
  let remoteCopies = 0;
  const ids = [...p.pageTable.keys()].sort((a, b) => a - b);
  for (const id of ids) {
    const pte = p.pageTable.get(id);
    if (!pte) continue;
    bytes += pte.size;
    if (pte.loc === 'RESIDENT') resident += pte.size;
    if (pte.local === 'valid') localCopies += pte.size;
    if (pte.remote === 'acked') remoteCopies += pte.size;
    const origin = pte.origin ?? { osSessionId: p.osSession, pid: p.pid };
    rows.push({
      page: pte.pageId,
      kind: pte.kind,
      label: pte.label,
      size: pte.size,
      location: pte.loc,
      copies: copiesOf(pte),
      flags: flagsOf(pte),
      ageMs: Math.max(0, now - pte.lastAccess),
      sha256Short: pte.sha256.slice(0, 8),
      gen: pte.gen,
      sha256: pte.sha256,
      pinReasons: [...pte.pinReasons],
      swapKey: `u${p.uid}/${origin.osSessionId}/${origin.pid}/p${pte.pageId}-g${pte.gen}`,
    });
  }
  const total = p.hits + p.faults;
  return {
    pid: p.pid,
    uid: p.uid,
    command: p.label,
    softLimit: p.softLimit,
    suspended: !p.resident && p.admitted,
    rows,
    declared: [...p.declared.entries()].map(([label, b]) => ({ label, bytes: b })),
    totals: {
      pages: rows.length,
      bytes,
      resident,
      localCopies,
      remoteCopies,
      declared: p.declaredBytes,
      faults: p.faults,
      hitPct: total === 0 ? 100 : round1((100 * p.hits) / total),
      bytesIn: p.bytesIn,
      bytesOut: p.bytesOut,
    },
  };
}
