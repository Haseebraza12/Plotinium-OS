/**
 * S9 z-order list: edge cases (specs/08-dsa/data-structures.md §8.10). Gated on IMPLEMENTED (C16).
 */
import { describe, expect, it } from 'vitest';

import { mulberry32 } from '../src/_shared/prng.ts';
import { IMPLEMENTED, LinkedZOrder } from '../src/zorder/index.ts';
import { expectDsaError } from './helpers.ts';

function stack(...wids: number[]): LinkedZOrder {
  const z = new LinkedZOrder();
  for (const wid of wids) z.insertTop(wid);
  return z;
}

/** z of every window, bottom to top. */
const zs = (list: LinkedZOrder): number[] => list.bottomToTop().map((wid) => list.zOf(wid) ?? -1);

describe.runIf(IMPLEMENTED)('dsa/zorder (S9)', () => {
  it('WM-02 an empty list has no top and no bottom', () => {
    const z = new LinkedZOrder();
    expect(z.top()).toBeUndefined();
    expect(z.bottom()).toBeUndefined();
    expect(z.size).toBe(0);
    expect(z.bottomToTop()).toEqual([]);
    expect(z.topWhere(() => true)).toBeUndefined();
    z.checkInvariants();
  });

  it('WM-02 raising the only window returns no changes', () => {
    const z = stack(1);
    expect(z.zOf(1)).toBe(1);
    expect(z.raise(1)).toEqual([]);
    expect(z.lower(1)).toEqual([]);
    expect(z.top()).toBe(1);
    expect(z.bottom()).toBe(1);
  });

  it('WM-02 raising the top window returns no changes', () => {
    const z = stack(1, 2, 3);
    expect(z.raise(3)).toEqual([]);
    expect(z.bottomToTop()).toEqual([1, 2, 3]);
  });

  it('WM-02 raising the bottom of three renumbers all three to 1..3', () => {
    const z = stack(10, 20, 30);
    expect(z.raise(10)).toEqual([
      { wid: 20, z: 1 },
      { wid: 30, z: 2 },
      { wid: 10, z: 3 },
    ]);
    expect(z.bottomToTop()).toEqual([20, 30, 10]);
    expect(zs(z)).toEqual([1, 2, 3]);
    expect(z.top()).toBe(10);
    // Raising a middle window renumbers only the windows from its old position up.
    expect(z.raise(30)).toEqual([
      { wid: 10, z: 2 },
      { wid: 30, z: 3 },
    ]);
    expect(z.lower(30)).toEqual([
      { wid: 30, z: 1 },
      { wid: 20, z: 2 },
      { wid: 10, z: 3 },
    ]);
    z.checkInvariants();
  });

  it('WM-02 removing the top, the bottom and a middle window renumbers the rest to 1..n', () => {
    const z = stack(1, 2, 3, 4, 5);
    expect(z.remove(5)).toEqual([]); // top: nothing above it
    expect(zs(z)).toEqual([1, 2, 3, 4]);
    expect(z.remove(1)).toEqual([
      { wid: 2, z: 1 },
      { wid: 3, z: 2 },
      { wid: 4, z: 3 },
    ]);
    expect(z.remove(3)).toEqual([{ wid: 4, z: 2 }]);
    expect(z.bottomToTop()).toEqual([2, 4]);
    expect(zs(z)).toEqual([1, 2]);
    expect(z.zOf(3)).toBeUndefined();
    expect(z.size).toBe(2);
    z.checkInvariants();
  });

  it('DSA-ZORD-01 inserting a wid twice throws DUPLICATE', () => {
    const z = stack(1, 2);
    expectDsaError(() => z.insertTop(1), 'DUPLICATE');
    expect(z.bottomToTop()).toEqual([1, 2]);
    expect(z.insertTop(3)).toEqual([{ wid: 3, z: 3 }]);
    expectDsaError(() => z.insertTop(-1), 'RANGE');
    z.checkInvariants();
  });

  it('DSA-ZORD-01 operating on a missing wid returns no changes', () => {
    const z = stack(1, 2);
    expect(z.raise(9)).toEqual([]);
    expect(z.lower(9)).toEqual([]);
    expect(z.remove(9)).toEqual([]);
    expect(z.zOf(9)).toBeUndefined();
    expect(z.bottomToTop()).toEqual([1, 2]);
  });

  it('WM-02 a million raises keep every z at most n', () => {
    const n = 8;
    const z = stack(...Array.from({ length: n }, (_, i) => i + 1));
    const rand = mulberry32(42);
    let maxZ = 0;
    for (let i = 0; i < 1_000_000; i++) {
      for (const change of z.raise(1 + Math.floor(rand() * n))) maxZ = Math.max(maxZ, change.z);
    }
    expect(maxZ).toBeLessThanOrEqual(n);
    expect(zs(z)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    z.checkInvariants();
  });

  it('DSA-ZORD-01 topWhere with no match returns undefined', () => {
    const z = stack(1, 2, 3, 4);
    expect(z.topWhere((wid) => wid > 10)).toBeUndefined();
    expect(z.topWhere((wid) => wid % 2 === 1)).toBe(3); // searched from the top
    const visited: number[] = [];
    z.topWhere((wid) => {
      visited.push(wid);
      return wid === 2;
    });
    expect(visited).toEqual([4, 3, 2]);
  });
});
