/**
 * S6 open-addressing hash table: edge cases (specs/08-dsa/data-structures.md §8.7). Gated on
 * IMPLEMENTED (C16).
 *
 * The hash function and probing are normative (§3.5 S6), so the collision tests use keys whose
 * home slots are known: at capacity 8, h(k) = Math.imul(k, 0x9E3779B1) >>> 29 gives home 2 for
 * 7, 15 and 20; home 3 for 4; home 7 for 8, 16 and 21; and home 0 for 5.
 */
import { describe, expect, it } from 'vitest';

import { IMPLEMENTED, OpenAddressingTable } from '../src/hashtable/index.ts';
import type { PidTable, WindowRegistry } from '../src/hashtable/index.ts';
import { expectDsaError } from './helpers.ts';

/** Spec §3.5 S6 hash, used here only to document and check the chosen test keys. */
const home = (key: number, capacity: number): number =>
  Math.imul(key, 0x9e3779b1) >>> (32 - Math.log2(capacity));

/** Keys in slot order (forEach visits slots 0..capacity−1). */
function slotOrder(table: OpenAddressingTable<string>): number[] {
  const keys: number[] = [];
  table.forEach((_value, key) => keys.push(key));
  return keys;
}

function table(keys: readonly number[]): OpenAddressingTable<string> {
  const t = new OpenAddressingTable<string>();
  for (const k of keys) t.set(k, `v${k}`);
  return t;
}

function expectReachable(t: OpenAddressingTable<string>, keys: readonly number[]): void {
  for (const k of keys) expect(t.get(k)).toBe(`v${k}`);
  expect(t.size).toBe(keys.length);
  t.checkInvariants();
}

describe.runIf(IMPLEMENTED)('dsa/hashtable (S6)', () => {
  it('PROC-01 get and delete on an empty table return undefined and false', () => {
    const t = new OpenAddressingTable<string>();
    expect(t.get(1)).toBeUndefined();
    expect(t.has(1)).toBe(false);
    expect(t.delete(1)).toBe(false);
    expect(t.size).toBe(0);
    expect(t.capacity).toBe(8);
    expect([...t.keys()]).toEqual([]);
    expect(t.probeStats()).toEqual({ maxProbe: 0, meanProbe: 0, loadFactor: 0 });
    t.checkInvariants();
  });

  it('PROC-01 one key can be set, read and deleted', () => {
    const t = new OpenAddressingTable<string>();
    t.set(42, 'pcb');
    expect(t.get(42)).toBe('pcb');
    expect(t.has(42)).toBe(true);
    expect(t.size).toBe(1);
    expect(t.delete(42)).toBe(true);
    expect(t.get(42)).toBeUndefined();
    expect(t.size).toBe(0);
    t.checkInvariants();
  });

  it('PROC-01 setting an existing key replaces the value without changing size', () => {
    const t = table([1, 2]);
    t.set(1, 'new');
    expect(t.get(1)).toBe('new');
    expect(t.size).toBe(2);
    t.checkInvariants();
  });

  it('PROC-01 delete then re-insert of the same key works', () => {
    const t = table([7, 15, 20]);
    expect(t.delete(15)).toBe(true);
    expect(t.has(15)).toBe(false);
    t.set(15, 'v15');
    expectReachable(t, [7, 15, 20]);
  });

  it('DSA-HASH-01 deleting the head, middle and tail of a colliding cluster keeps every other key reachable', () => {
    expect([7, 15, 20].map((k) => home(k, 8))).toEqual([2, 2, 2]);
    expect(home(4, 8)).toBe(3);
    const t = table([7, 15, 20, 4]); // slots 2, 3, 4 and 5 (4's home 3 is taken)
    expect(slotOrder(t)).toEqual([7, 15, 20, 4]);

    expect(t.delete(7)).toBe(true); // head: 15, 20 and 4 shift back
    expect(slotOrder(t)).toEqual([15, 20, 4]);
    expectReachable(t, [15, 20, 4]);

    t.set(7, 'v7'); // probes 2, 3, 4 and lands in 5
    expect(t.delete(20)).toBe(true); // middle
    expect(slotOrder(t)).toEqual([15, 4, 7]);
    expectReachable(t, [15, 4, 7]);

    expect(t.delete(7)).toBe(true); // tail
    expect(slotOrder(t)).toEqual([15, 4]);
    expectReachable(t, [15, 4]);
  });

  it('DSA-HASH-01 a cluster that wraps from the last slot to slot 0 survives deletions', () => {
    expect([8, 16, 21].map((k) => home(k, 8))).toEqual([7, 7, 7]);
    expect(home(5, 8)).toBe(0);
    const t = table([8, 16, 21, 5]); // slots 7, 0, 1 and 2
    expect(slotOrder(t)).toEqual([16, 21, 5, 8]);
    expect(t.probeStats().maxProbe).toBe(3);

    expect(t.delete(8)).toBe(true); // the head in slot 7: the run shifts back across the wrap
    expect(slotOrder(t)).toEqual([21, 5, 16]);
    expectReachable(t, [16, 21, 5]);

    expect(t.delete(21)).toBe(true);
    expect(slotOrder(t)).toEqual([5, 16]);
    expectReachable(t, [16, 5]);
  });

  it('DSA-HASH-01 keys 0 and 2^31 − 1 work and negative or non-integer keys throw RANGE', () => {
    const t = new OpenAddressingTable<string>();
    t.set(0, 'zero');
    t.set(2 ** 31 - 1, 'max');
    expect(t.get(0)).toBe('zero');
    expect(t.get(2 ** 31 - 1)).toBe('max');
    for (const bad of [-1, 1.5, 2 ** 31, Number.NaN]) {
      expectDsaError(() => t.set(bad, 'x'), 'RANGE');
      expectDsaError(() => t.get(bad), 'RANGE');
      expectDsaError(() => t.has(bad), 'RANGE');
      expectDsaError(() => t.delete(bad), 'RANGE');
    }
    expect(t.size).toBe(2);
    t.checkInvariants();
  });

  it('DSA-HASH-01 inserting past load 0.5 doubles capacity and keeps every key', () => {
    const t = new OpenAddressingTable<string>();
    const keys = [1, 2, 3, 4];
    for (const k of keys) t.set(k, `v${k}`);
    expect(t.capacity).toBe(8);
    expect(t.probeStats().loadFactor).toBe(0.5);
    t.set(5, 'v5');
    expect(t.capacity).toBe(16);
    expectReachable(t, [...keys, 5]);
    for (let k = 6; k <= 100; k++) {
      t.set(k, `v${k}`);
      expect(t.probeStats().loadFactor).toBeLessThanOrEqual(0.5);
    }
    expect(t.capacity).toBe(256);
    expectReachable(
      t,
      Array.from({ length: 100 }, (_, i) => i + 1),
    );
  });

  it('DSA-HASH-01 deleting below load 1/8 halves capacity with hysteresis', () => {
    const t = new OpenAddressingTable<string>();
    const keys = Array.from({ length: 32 }, (_, i) => i * 7 + 3);
    for (const k of keys) t.set(k, `v${k}`);
    expect(t.capacity).toBe(64);
    for (const k of keys.slice(0, 24)) t.delete(k);
    expect(t.size).toBe(8);
    expect(t.capacity).toBe(64); // 8 is not below 64 / 8
    t.delete(keys[24] ?? -1);
    expect(t.capacity).toBe(32);
    t.set(keys[24] ?? -1, `v${keys[24] ?? -1}`);
    expect(t.capacity).toBe(32); // no grow straight back: hysteresis between 1/8 and 1/2
    expectReachable(t, keys.slice(24));
  });

  it('DSA-HASH-01 minimum capacity is 8 so the shift never reaches 32', () => {
    expect(new OpenAddressingTable<string>(0).capacity).toBe(8);
    expect(new OpenAddressingTable<string>(1).capacity).toBe(8);
    expect(new OpenAddressingTable<string>(8).capacity).toBe(8);
    expect(new OpenAddressingTable<string>(9).capacity).toBe(16);
    const t = table([1, 2, 3]);
    for (const k of [1, 2, 3]) t.delete(k);
    expect(t.capacity).toBe(8);
    t.set(3, 'v3');
    expectReachable(t, [3]);
  });

  it('PROC-01 sequential pids 1..32,768 and reuse after wrap-around stay O(1) with max probe reported', () => {
    const pids: PidTable<{ pid: number }> = new OpenAddressingTable();
    const n = 32_768;
    for (let pid = 1; pid <= n; pid++) pids.set(pid, { pid });
    expect(pids.size).toBe(n);
    expect(pids.capacity).toBe(65_536);
    const first = pids.probeStats();
    expect(first.loadFactor).toBe(0.5);
    expect(first.maxProbe).toBeLessThanOrEqual(2);
    expect(first.meanProbe).toBeLessThanOrEqual(1.1);
    // PID_MAX is 32,767, so allocation wraps: free the low half and reuse it.
    for (let pid = 1; pid <= n / 2; pid++) expect(pids.delete(pid)).toBe(true);
    for (let pid = 1; pid <= n / 2; pid++) pids.set(pid, { pid });
    for (let pid = 1; pid <= n; pid++) expect(pids.get(pid)?.pid).toBe(pid);
    expect(pids.probeStats().maxProbe).toBeLessThanOrEqual(2);
    pids.checkInvariants();
  });

  it('WM-01 the window registry stores and finds window records by wid', () => {
    const registry: WindowRegistry<{ wid: number; title: string }> = new OpenAddressingTable();
    registry.set(1, { wid: 1, title: 'Terminal' });
    registry.set(2, { wid: 2, title: 'Files' });
    expect(registry.get(2)?.title).toBe('Files');
    expect(registry.delete(1)).toBe(true);
    expect(registry.get(1)).toBeUndefined();
    expect([...registry.keys()]).toEqual([2]);
  });

  it('DSA-HASH-01 clear empties the table and forEach visits every key once', () => {
    const t = new OpenAddressingTable<string>();
    const keys = Array.from({ length: 50 }, (_, i) => i * 13);
    for (const k of keys) t.set(k, `v${k}`);
    const visited: number[] = [];
    t.forEach((value, key) => {
      expect(value).toBe(`v${key}`);
      visited.push(key);
    });
    expect([...visited].sort((a, b) => a - b)).toEqual(keys);
    expect([...t.keys()]).toEqual(visited);
    t.clear();
    expect(t.size).toBe(0);
    expect(t.get(13)).toBeUndefined();
    let calls = 0;
    t.forEach(() => calls++);
    expect(calls).toBe(0);
    t.checkInvariants();
  });

  it('DSA-HASH-01 inserting or deleting during forEach or keys() throws INVALID but replacing a value does not', () => {
    const t = table([1, 2, 3]);
    t.forEach((_value, key) => t.set(key, 'replaced')); // same key: not a structural change
    expect([...t.keys()].map((k) => t.get(k))).toEqual(['replaced', 'replaced', 'replaced']);
    // A backward shift or a resize could skip or repeat keys, so the walk fails fast instead.
    expectDsaError(() => t.forEach((_value, key) => t.delete(key)), 'INVALID');
    expectDsaError(() => {
      for (const k of t.keys()) t.set(k + 100, 'new');
    }, 'INVALID');
    expect(t.size).toBe(3); // one delete and one insert happened before each walk stopped
    t.checkInvariants();
  });

  it('DSA-HASH-01 an undefined value and an unbounded initial capacity are rejected', () => {
    const t = new OpenAddressingTable<string | undefined>();
    expectDsaError(() => t.set(1, undefined), 'INVALID'); // undefined marks an empty slot (HT5)
    expect(t.size).toBe(0);
    for (const bad of [2 ** 31, Number.POSITIVE_INFINITY, Number.NaN]) {
      expectDsaError(() => new OpenAddressingTable<string>(bad), 'RANGE');
    }
  });

  it('DSA-GEN-09 stats reports 12 bytes per slot and capacity/2 entries before growth', () => {
    const t = table([1, 2, 3]);
    expect(t.stats()).toEqual({ size: 3, capacity: 4, bytesAllocated: 8 * 12, bytesUsed: 3 * 12 });
  });

  it('DSA-HASH-01 checkInvariants detects an EMPTY slot inside a probe path', () => {
    const t = table([7, 15, 20]);
    t.checkInvariants();
    t.debugCorrupt('probe-hole');
    expect(() => t.checkInvariants()).toThrow(/HT1/);
  });
});
