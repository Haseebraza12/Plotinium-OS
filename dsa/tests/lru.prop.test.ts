/**
 * S5 LRU: model-based property test (specs/08-dsa/data-structures.md §8.6). The model keeps the
 * evictable keys in an array (MRU first), the values, the pin counts and the speculative set, and
 * applies the semantics documented in src/lru/index.ts. Gated on IMPLEMENTED (C16).
 */
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { DsaError } from '../src/_shared/errors.ts';
import { IMPLEMENTED, LruCache } from '../src/lru/index.ts';
import { PROP } from './helpers.ts';

type LruOp =
  | { kind: 'get' | 'touch' | 'moveToLru' | 'delete' | 'pin' | 'unpin'; key: number }
  | { kind: 'put' | 'putAtLru'; key: number; value: number }
  | { kind: 'evict' };

const key = fc.nat(11);
const KEYS = Array.from({ length: 12 }, (_, k) => k);
const lruOp: fc.Arbitrary<LruOp> = fc.oneof(
  fc.record({
    kind: fc.constantFrom(
      'get' as const,
      'touch' as const,
      'moveToLru' as const,
      'delete' as const,
    ),
    key,
  }),
  fc.record({ kind: fc.constantFrom('pin' as const, 'unpin' as const), key }),
  fc.record({
    kind: fc.constantFrom('put' as const, 'putAtLru' as const),
    key,
    value: fc.integer(),
  }),
  fc.record({ kind: fc.constant('evict' as const) }),
);

class Model {
  list: number[] = []; // evictable keys, MRU first
  readonly values = new Map<number, number>();
  readonly pins = new Map<number, number>();
  readonly speculative = new Set<number>();
  readonly capacity: number | undefined;

  constructor(capacity: number | undefined) {
    this.capacity = capacity;
  }

  private unlink(k: number): void {
    this.list = this.list.filter((x) => x !== k);
  }
  pinned(k: number): boolean {
    return (this.pins.get(k) ?? 0) > 0;
  }
  hit(k: number): void {
    if (!this.pinned(k)) {
      this.unlink(k);
      this.list.unshift(k);
    }
    this.speculative.delete(k);
  }
  evict(): [number, number] | undefined {
    const k = this.list.pop();
    if (k === undefined) return undefined;
    const v = this.values.get(k) as number;
    this.remove(k);
    return [k, v];
  }
  snapshot(): unknown {
    return {
      list: this.list,
      size: this.values.size,
      evictable: this.list.length,
      lru: this.list[this.list.length - 1],
      keys: KEYS.map((k) => [this.values.get(k), this.pinned(k), this.speculative.has(k)]),
    };
  }
  remove(k: number): void {
    this.unlink(k);
    this.values.delete(k);
    this.pins.delete(k);
    this.speculative.delete(k);
  }
  /** put / putAtLru; throws 'FULL' when bounded, full and nothing is evictable. */
  insert(k: number, v: number, atLru: boolean): [number, number] | undefined {
    let evicted: [number, number] | undefined;
    if (!this.values.has(k) && this.capacity !== undefined && this.values.size >= this.capacity) {
      if (this.list.length === 0) throw new Error('FULL');
      evicted = this.evict();
    }
    this.values.set(k, v);
    if (!this.pinned(k)) {
      this.unlink(k);
      if (atLru) this.list.push(k);
      else this.list.unshift(k);
    }
    if (atLru) this.speculative.add(k);
    else this.speculative.delete(k);
    return evicted;
  }
}

/** Everything observable about the cache, compared with the model once per step. */
function snapshot(cache: LruCache<number, number>): unknown {
  return {
    list: [...cache.keysMruToLru()],
    size: cache.size,
    evictable: cache.evictableSize,
    lru: cache.peekLru(),
    keys: KEYS.map((k) => [cache.peek(k), cache.isPinned(k), cache.isSpeculative(k)]),
  };
}

/** The DsaError code thrown by `fn`, or undefined. */
function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    if (error instanceof DsaError) return error.code;
    throw error;
  }
}

/**
 * Up to 200 steps per run, each with a deep snapshot comparison, cost about 4 ms per run on a dev
 * machine (the cache itself is under 10% of that). Vitest's 5 s default would fail the nightly
 * 10,000-run setting (§8) and leaves little headroom at 1,000 runs, so the limit scales with
 * numRuns (20 ms per run, at least 30 s).
 */
const PROP_TIMEOUT_MS = Math.max(30_000, PROP.numRuns * 20);

describe.runIf(IMPLEMENTED)('dsa/lru properties (S5)', () => {
  it(
    'MEM-02 random get, put, putAtLru, touch, moveToLru, evict, delete, pin and unpin match an ordered-list model and keep invariants L1–L5',
    () => {
      fc.assert(
        fc.property(
          fc.option(fc.integer({ min: 1, max: 8 }), { nil: undefined }),
          fc.array(lruOp, { size: 'max', maxLength: 200 }),
          (capacity, ops) => {
            const cache = new LruCache<number, number>(
              capacity === undefined ? { initialSlots: 1 } : { capacity, initialSlots: 1 },
            );
            const model = new Model(capacity);
            for (const op of ops) {
              switch (op.kind) {
                case 'get': {
                  const present = model.values.has(op.key);
                  const expected = model.values.get(op.key);
                  if (present) model.hit(op.key);
                  expect(cache.get(op.key)).toBe(expected);
                  break;
                }
                case 'touch':
                  expect(cache.touch(op.key)).toBe(model.values.has(op.key));
                  if (model.values.has(op.key)) model.hit(op.key);
                  break;
                case 'moveToLru': {
                  const present = model.values.has(op.key);
                  expect(cache.moveToLru(op.key)).toBe(present);
                  if (present && !model.pinned(op.key)) {
                    model.list = model.list.filter((x) => x !== op.key);
                    model.list.push(op.key);
                  }
                  break;
                }
                case 'delete':
                  expect(cache.delete(op.key)).toBe(model.values.has(op.key));
                  model.remove(op.key);
                  break;
                case 'pin':
                  if (!model.values.has(op.key)) {
                    expect(codeOf(() => cache.pin(op.key))).toBe('NOT_FOUND');
                  } else {
                    cache.pin(op.key);
                    const count = model.pins.get(op.key) ?? 0;
                    model.pins.set(op.key, count + 1);
                    if (count === 0) model.list = model.list.filter((x) => x !== op.key);
                  }
                  break;
                case 'unpin':
                  if (!model.values.has(op.key)) {
                    expect(codeOf(() => cache.unpin(op.key))).toBe('NOT_FOUND');
                  } else if (!model.pinned(op.key)) {
                    expect(codeOf(() => cache.unpin(op.key))).toBe('INVALID');
                  } else {
                    cache.unpin(op.key);
                    const count = (model.pins.get(op.key) ?? 0) - 1;
                    model.pins.set(op.key, count);
                    if (count === 0) model.list.unshift(op.key);
                  }
                  break;
                case 'put':
                case 'putAtLru': {
                  const atLru = op.kind === 'putAtLru';
                  let expected: [number, number] | undefined;
                  let full = false;
                  try {
                    expected = model.insert(op.key, op.value, atLru);
                  } catch {
                    full = true;
                  }
                  if (full) {
                    expect(
                      codeOf(() =>
                        atLru ? cache.putAtLru(op.key, op.value) : cache.put(op.key, op.value),
                      ),
                    ).toBe('FULL');
                  } else {
                    expect(
                      atLru ? cache.putAtLru(op.key, op.value) : cache.put(op.key, op.value),
                    ).toEqual(expected);
                  }
                  break;
                }
                case 'evict':
                  expect(cache.evict()).toEqual(model.evict());
                  break;
              }
              cache.checkInvariants();
              expect(snapshot(cache)).toEqual(model.snapshot());
            }
          },
        ),
        PROP,
      );
    },
    PROP_TIMEOUT_MS,
  );
});
