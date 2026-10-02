/**
 * S3 binary heap: model-based property tests (specs/08-dsa/data-structures.md §8.4; the spec
 * §15.3 SHOULD). The model is a Map from handle to key. Gated on IMPLEMENTED (C16).
 */
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { BinaryHeap, BoundedTopKHeap, IMPLEMENTED } from '../src/heap/index.ts';
import { expectDsaError, PROP } from './helpers.ts';

type HeapOp =
  | { kind: 'push'; h: number; key: number }
  | { kind: 'pop' }
  | { kind: 'change'; h: number; key: number }
  | { kind: 'remove'; h: number }
  | { kind: 'replaceTop'; h: number; key: number };

// A small handle space and key range force duplicates, equal keys and growth of the index map.
const handle = fc.nat(63);
const key = fc.integer({ min: -50, max: 50 });
const heapOp: fc.Arbitrary<HeapOp> = fc.oneof(
  fc.record({ kind: fc.constant('push' as const), h: handle, key }),
  fc.record({ kind: fc.constant('pop' as const) }),
  fc.record({ kind: fc.constant('change' as const), h: handle, key }),
  fc.record({ kind: fc.constant('remove' as const), h: handle }),
  fc.record({ kind: fc.constant('replaceTop' as const), h: handle, key }),
);

function modelMin(model: ReadonlyMap<number, number>): number | undefined {
  let min: number | undefined;
  for (const k of model.values()) if (min === undefined || k < min) min = k;
  return min;
}

/** Pop the heap and check the popped handle carries the model's minimum key. */
function popAndCheck(
  model: Map<number, number>,
  popped: number | undefined,
  min: number | undefined,
): void {
  if (min === undefined) {
    expect(popped).toBeUndefined();
    return;
  }
  expect(popped).toBeDefined();
  expect(model.get(popped as number)).toBe(min);
  model.delete(popped as number);
}

describe.runIf(IMPLEMENTED)('dsa/heap properties (S3)', () => {
  it('PROC-02 random push, pop, changePriority, remove and replaceTop sequences match a model and keep invariants H1–H4 after every step', () => {
    fc.assert(
      fc.property(fc.array(heapOp, { size: 'max', maxLength: 300 }), (ops) => {
        const heap = new BinaryHeap(2);
        const model = new Map<number, number>();
        for (const op of ops) {
          switch (op.kind) {
            case 'push':
              if (model.has(op.h)) {
                expectDsaError(() => heap.push(op.h, op.key), 'DUPLICATE');
              } else {
                heap.push(op.h, op.key);
                model.set(op.h, op.key);
              }
              break;
            case 'pop':
              popAndCheck(model, heap.pop(), modelMin(model));
              break;
            case 'change':
              expect(heap.changePriority(op.h, op.key)).toBe(model.has(op.h));
              if (model.has(op.h)) model.set(op.h, op.key);
              break;
            case 'remove':
              expect(heap.remove(op.h)).toBe(model.delete(op.h));
              break;
            case 'replaceTop':
              // With equal keys the popped handle is not determined, so only fresh handles are used.
              if (!model.has(op.h)) {
                popAndCheck(model, heap.replaceTop(op.h, op.key), modelMin(model));
                model.set(op.h, op.key);
              }
              break;
          }
          heap.checkInvariants();
          expect([
            heap.size,
            heap.peekKey(),
            ...[...model.keys()].map((h) => heap.keyOf(h)),
          ]).toEqual([model.size, modelMin(model), ...model.values()]);
        }
      }),
      PROP,
    );
  });

  it('DSA-HEAP-01 pushing a random array and popping everything yields it sorted', () => {
    const finite = fc
      .double({ noNaN: true, noDefaultInfinity: true })
      .map((x) => (x === 0 ? 0 : x));
    fc.assert(
      fc.property(fc.array(finite, { size: 'max', maxLength: 500 }), (keys) => {
        const heap = new BinaryHeap(1);
        keys.forEach((k, h) => heap.push(h, k));
        const out: number[] = [];
        for (let k = heap.peekKey(); k !== undefined; k = heap.peekKey()) {
          out.push(k);
          heap.pop();
        }
        expect(out).toEqual([...keys].sort((a, b) => a - b));
      }),
      PROP,
    );
  });

  it('DSA-HEAP-02 BoundedTopK equals sorting descending and taking k', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: -100, max: 100 }), { size: 'max', maxLength: 300 }),
        fc.nat(20),
        (scores, k) => {
          const top = new BoundedTopKHeap(k);
          scores.forEach((s, h) => top.offer(h, s));
          expect(top.size).toBe(Math.min(k, scores.length));
          const drained = top.drainDescending();
          expect(drained.map((d) => d.score)).toEqual(
            [...scores].sort((a, b) => b - a).slice(0, k),
          );
          for (const d of drained) expect(scores[d.handle]).toBe(d.score);
          expect(new Set(drained.map((d) => d.handle)).size).toBe(drained.length);
          expect(top.size).toBe(0);
        },
      ),
      PROP,
    );
  });
});
