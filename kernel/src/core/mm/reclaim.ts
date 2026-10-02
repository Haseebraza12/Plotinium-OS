/**
 * Reclaim policy (specs/03-kernel/memory-and-paging.md §3.6, KMM-05; victim order §3.5.3).
 *
 * - Background reclaim starts when committed > HIGH_WM · budget (85 %) and stops when
 *   committed ≤ LOW_WM · budget (75 %).
 * - Direct reclaim starts whenever a reservation is blocked, frees at least that reservation's
 *   deficit, then continues as background reclaim.
 * - Victim handling for v = evict(): a state page suspends the whole process; a clean page (valid
 *   local copy, acknowledged remote copy, or BACKED) is dropped WITHOUT a write (Spec §9.2); a dirty
 *   page is paged out.
 * - Victim order: SPEC, then COLD (minimised or over the soft limit), then HOT, each in LRU order;
 *   the residency hint skips a hinted app's victim once per pass.
 *
 * These are the pure decisions; the memory manager (./mm.ts) runs the I/O.
 */
import { isClean } from './accounting.ts';
import type { ProcMem } from './accounting.ts';
import type { MmParams } from './params.ts';
import type { LruSeg, PTE } from './types.ts';

export type VictimAction = 'suspend' | 'drop' | 'pageout';

/** What reclaim does with an evicted page (§3.6 victim handling). */
export function victimAction(pte: PTE): VictimAction {
  if (pte.kind === 'state') return 'suspend';
  if (pte.kind === 'worker' || isClean(pte)) return 'drop';
  return 'pageout';
}

export function watermarks(
  budget: number,
  p: Pick<MmParams, 'highWm' | 'lowWm'>,
): { high: number; low: number } {
  return { high: Math.floor(p.highWm * budget), low: Math.floor(p.lowWm * budget) };
}

/** Whether background reclaim must start now. */
export function shouldStartBackground(
  committed: number,
  budget: number,
  p: Pick<MmParams, 'highWm' | 'lowWm'>,
): boolean {
  return committed > watermarks(budget, p).high;
}

/**
 * Bytes reclaim still has to free, beyond what in-flight page-outs and drops will free:
 * the background target (down to LOW_WM) while background reclaim is on, and the head waiter's
 * deficit (direct reclaim).
 */
export function reclaimNeed(s: {
  committed: number;
  budget: number;
  background: boolean;
  headDeficit: number;
  freeing: number;
  params: Pick<MmParams, 'highWm' | 'lowWm'>;
}): number {
  const bg = s.background ? s.committed - watermarks(s.budget, s.params).low : 0;
  return Math.max(bg, s.headDeficit) - s.freeing;
}

/** The LRU segment a resident page belongs to (§3.5.1). */
export function segmentFor(pte: PTE, p: ProcMem): LruSeg {
  if (pte.speculative) return 'SPEC';
  return p.minimised || p.overSoftLimit ? 'COLD' : 'HOT';
}

/** Residency hint (§3.5.3): skip a victim of the hinted app once per reclaim pass. */
export function hintSkips(
  hint: { app: string; until: number } | null,
  app: string,
  now: number,
  alreadySkipped: boolean,
): boolean {
  return hint !== null && hint.app === app && now < hint.until && !alreadySkipped;
}
