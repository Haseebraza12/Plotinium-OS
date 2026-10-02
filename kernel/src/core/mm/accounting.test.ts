/**
 * Accounting model, calibration arithmetic and the reclaim policy (memory-and-paging.md §3.2,
 * §3.6; MEM-01, KMM-01, KMM-02, KMM-05).
 */
import { describe, expect, it } from 'vitest';

import {
  accountedOf,
  DEFAULT_CALIBRATION,
  dropLocation,
  errorReport,
  isClean,
  loadCalibration,
  kernelLine,
  modelError,
  modelEstimate,
  newProcMem,
  recountResident,
  wsBytes,
} from './accounting.ts';
import calibration from './calibration.json';
import { DEFAULT_PARAMS, localSwapCap, MiB, resolveParams, tier2Pressure } from './params.ts';
import {
  hintSkips,
  reclaimNeed,
  segmentFor,
  shouldStartBackground,
  victimAction,
  watermarks,
} from './reclaim.ts';
import type { PTE } from './types.ts';

function pte(over: Partial<PTE> = {}): PTE {
  return {
    pageId: 1,
    kind: 'logical',
    label: 'doc',
    size: 100,
    loc: 'RESIDENT',
    dirty: false,
    lastAccess: 0,
    sha256: 'a'.repeat(64),
    gen: 1,
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
    ...over,
  };
}

describe('accounting model (§3.2.1)', () => {
  it('MEM-01 accounted = resident pages (state included) + declared assets + OVERHEAD_PROC', () => {
    const p = newProcMem({ pid: 5, uid: 1000, app: 'editor', osSession: 's', softLimit: 64 * MiB });
    expect(p.label).toBe('editor');
    expect(p.checkpointable).toBe(true);
    p.pageTable.set(0, pte({ pageId: 0, kind: 'state', size: 18_000 }));
    p.pageTable.set(1, pte({ pageId: 1, size: 1_200_000 }));
    p.pageTable.set(2, pte({ pageId: 2, size: 256 * 1024, loc: 'LOCAL_SWAP' }));
    p.residentBytes = recountResident(p);
    p.declaredBytes = 3_100_000;
    p.overheadCharged = DEFAULT_PARAMS.overheadProc;
    expect(p.residentBytes).toBe(1_218_000);
    expect(accountedOf(p)).toBe(1_218_000 + 3_100_000 + 64 * 1024);
  });

  it('MEM-01 the kernel line is reported by free and never charged to the budget', () => {
    const k = kernelLine(
      [
        { name: 'tree', entries: 10_000, bytesPerEntry: 310.2 },
        { name: 'trie', entries: 20_000, bytesPerEntry: 95 },
      ],
      2 * MiB,
    );
    expect(k.parts).toEqual([
      { name: 'tree', bytes: 3_102_000 },
      { name: 'trie', bytes: 1_900_000 },
      { name: 'io', bytes: 2 * MiB },
    ]);
    expect(k.bytes).toBe(3_102_000 + 1_900_000 + 2 * MiB);
    expect(kernelLine([], 0)).toEqual({ bytes: 0, parts: [] });
  });

  it('MEM-01 calibration: the model and its error report follow §3.2.3 (target < 25 %)', () => {
    const c = {
      ...DEFAULT_CALIBRATION,
      kappa: 1.2,
      bMain: 40 * MiB,
      bExec: 8 * MiB,
      bSpecial: 20 * MiB,
    };
    const m = modelEstimate(c, {
      committed: 100 * MiB,
      kernelBytes: 10 * MiB,
      executors: 2,
      specialWorkers: 1,
    });
    expect(m).toBe(100 * MiB + 12 * MiB + 40 * MiB + 16 * MiB + 20 * MiB);
    expect(modelError(120, 100)).toBeCloseTo(0.2);
    expect(() => modelError(1, 0)).toThrow(RangeError);
    expect(
      errorReport([
        { model: 110, measured: 100 },
        { model: 70, measured: 100 },
      ]),
    ).toEqual({ max: 0.3, mean: 0.2, ok: false });
    expect(errorReport([{ model: 90, measured: 100 }]).ok).toBe(true);
    expect(errorReport([])).toEqual({ max: 0, mean: 0, ok: true });
  });

  it('MEM-01 calibration.json loads when well formed and falls back to the defaults otherwise', () => {
    expect(loadCalibration(calibration)).toEqual({
      constants: { overheadProc: 65_536, kappa: 1, bMain: 0, bExec: 0, bSpecial: 0 },
      ok: true,
    });
    const withError = loadCalibration({
      ...calibration,
      lastError: { max: 0.18, mean: 0.09, date: '2026-10-01' },
    });
    expect(withError.constants.lastError).toEqual({ max: 0.18, mean: 0.09, date: '2026-10-01' });
    expect(
      loadCalibration({ ...calibration, lastError: { max: 'x' } }).constants.lastError,
    ).toBeUndefined();
    expect(loadCalibration({ ...calibration, kappa: -1 })).toEqual({
      constants: DEFAULT_CALIBRATION,
      ok: false,
    });
    expect(loadCalibration(null).ok).toBe(false);
    expect(loadCalibration('x').ok).toBe(false);
  });

  it('MEM-03 a page is clean only without the dirty bit and with a valid copy, and drops to that copy', () => {
    expect(isClean(pte({ dirty: true, local: 'valid' }))).toBe(false);
    expect(isClean(pte({ local: 'valid' }))).toBe(true);
    expect(isClean(pte({ remote: 'acked' }))).toBe(true);
    expect(isClean(pte({ backing: { store: 'vec', ref: 's1' } }))).toBe(true);
    expect(isClean(pte({ local: 'stale', remote: 'pending' }))).toBe(false);
    expect(dropLocation(pte({ local: 'valid', remote: 'acked' }))).toBe('LOCAL_SWAP');
    expect(dropLocation(pte({ remote: 'acked' }))).toBe('REMOTE_SWAP');
    expect(dropLocation(pte({ backing: { store: 'model', ref: 'x' } }))).toBe('BACKED');
  });

  it('MEM-07 the working set counts distinct pages touched within Δ = 5 s', () => {
    const p = newProcMem({ pid: 1, uid: 1, app: 'a', osSession: 's', softLimit: 1 });
    p.pageTable.set(1, pte({ pageId: 1, size: 10, lastAccess: 9_000 }));
    p.pageTable.set(2, pte({ pageId: 2, size: 20, lastAccess: 2_000 }));
    p.pageTable.set(3, pte({ pageId: 3, size: 40, lastAccess: 5_000 }));
    expect(wsBytes(p, 10_000, 5_000)).toBe(50);
  });
});

describe('params (§3.1)', () => {
  it('MEM-01 the defaults are the spec constants and overrides are validated', () => {
    expect(DEFAULT_PARAMS.budget).toBe(256 * MiB);
    expect(DEFAULT_PARAMS.softLimit).toBe(64 * MiB);
    expect(DEFAULT_PARAMS.pageChunk).toBe(256 * 1024);
    expect(DEFAULT_PARAMS.highWm).toBe(0.85);
    expect(DEFAULT_PARAMS.lowWm).toBe(0.75);
    expect(resolveParams({ budget: 64 * MiB }).budget).toBe(64 * MiB);
    expect(() => resolveParams({ lowWm: 0.9 })).toThrow(RangeError);
    expect(() => resolveParams({ budget: 0 })).toThrow(RangeError);
    expect(localSwapCap(10 * 1024 * MiB)).toBe(2 * 1024 * MiB);
    expect(localSwapCap(1024 * MiB)).toBe(256 * MiB);
    expect(localSwapCap(Number.NaN)).toBe(2 * 1024 * MiB);
    expect(tier2Pressure(81, 100)).toBe(true);
    expect(tier2Pressure(80, 100)).toBe(false);
    expect(tier2Pressure(1, 0)).toBe(false);
  });
});

describe('reclaim policy (§3.6)', () => {
  it('MEM-06 background reclaim starts above 85% and stops at 75%', () => {
    const budget = 100 * MiB;
    expect(watermarks(budget, DEFAULT_PARAMS)).toEqual({ high: 85 * MiB, low: 75 * MiB });
    expect(shouldStartBackground(85 * MiB, budget, DEFAULT_PARAMS)).toBe(false);
    expect(shouldStartBackground(85 * MiB + 1, budget, DEFAULT_PARAMS)).toBe(true);
    const base = { budget, headDeficit: 0, freeing: 0, params: DEFAULT_PARAMS };
    expect(reclaimNeed({ ...base, committed: 90 * MiB, background: true })).toBe(15 * MiB);
    expect(reclaimNeed({ ...base, committed: 75 * MiB, background: true })).toBe(0);
    expect(reclaimNeed({ ...base, committed: 90 * MiB, background: false })).toBe(0);
    expect(
      reclaimNeed({ ...base, committed: 90 * MiB, background: false, headDeficit: 3 * MiB }),
    ).toBe(3 * MiB);
    expect(reclaimNeed({ ...base, committed: 90 * MiB, background: true, freeing: 5 * MiB })).toBe(
      10 * MiB,
    );
  });

  it('MEM-03 victim handling: state pages suspend, clean pages drop without a write, dirty pages page out', () => {
    expect(victimAction(pte({ kind: 'state', local: 'valid' }))).toBe('suspend');
    expect(victimAction(pte({ local: 'valid' }))).toBe('drop');
    expect(victimAction(pte({ kind: 'worker', dirty: true }))).toBe('drop');
    expect(victimAction(pte({ dirty: true, local: 'stale' }))).toBe('pageout');
    expect(victimAction(pte({ dirty: false }))).toBe('pageout');
  });

  it('WM-05 minimised or over-soft-limit processes put their pages in COLD; speculative pages in SPEC', () => {
    const p = newProcMem({ pid: 1, uid: 1, app: 'a', osSession: 's', softLimit: 1 });
    expect(segmentFor(pte(), p)).toBe('HOT');
    p.minimised = true;
    expect(segmentFor(pte(), p)).toBe('COLD');
    p.minimised = false;
    p.overSoftLimit = true;
    expect(segmentFor(pte(), p)).toBe('COLD');
    expect(segmentFor(pte({ speculative: true }), p)).toBe('SPEC');
  });

  it('KMM-13 the residency hint skips the hinted app once per pass while valid', () => {
    const hint = { app: 'editor', until: 1_000 };
    expect(hintSkips(hint, 'editor', 500, false)).toBe(true);
    expect(hintSkips(hint, 'editor', 500, true)).toBe(false);
    expect(hintSkips(hint, 'files', 500, false)).toBe(false);
    expect(hintSkips(hint, 'editor', 1_000, false)).toBe(false);
    expect(hintSkips(null, 'editor', 0, false)).toBe(false);
  });
});
