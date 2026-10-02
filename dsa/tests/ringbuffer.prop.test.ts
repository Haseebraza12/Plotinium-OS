/**
 * S7 ring buffers: model-based property tests (specs/08-dsa/data-structures.md §8.8). Gated on
 * IMPLEMENTED (C16).
 */
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { DsaError } from '../src/_shared/errors.ts';
import { ByteRingBuffer, Float64Ring, IMPLEMENTED, RingBuffer } from '../src/ringbuffer/index.ts';
import type { RingMode } from '../src/ringbuffer/index.ts';
import { PROP } from './helpers.ts';

type RingOp =
  { kind: 'push'; x: number } | { kind: 'shift' } | { kind: 'at'; i: number } | { kind: 'clear' };

const ringOp: fc.Arbitrary<RingOp> = fc.oneof(
  { weight: 4, arbitrary: fc.record({ kind: fc.constant('push' as const), x: fc.integer() }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('shift' as const) }) },
  {
    weight: 2,
    arbitrary: fc.record({ kind: fc.constant('at' as const), i: fc.integer({ min: -2, max: 20 }) }),
  },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('clear' as const) }) },
);

type ByteOp = { kind: 'write'; data: Uint8Array } | { kind: 'read'; n: number };

const byteOp: fc.Arbitrary<ByteOp> = fc.oneof(
  fc.record({
    kind: fc.constant('write' as const),
    data: fc.uint8Array({ size: 'max', maxLength: 40 }),
  }),
  fc.record({ kind: fc.constant('read' as const), n: fc.nat(40) }),
);

/**
 * Time budget of each property below, scaled with the run count: Vitest's 5 s default is too short
 * for the nightly PLT_PROP_RUNS=10000 (about 25 s here, almost all of it fast-check generation and
 * deep `toEqual`, not the ring) and tight for 1,000 runs under coverage instrumentation (4.6 s).
 */
const PROP_TIMEOUT_MS = 10_000 + 30 * PROP.numRuns;

describe.runIf(IMPLEMENTED)('dsa/ringbuffer properties (S7)', () => {
  it(
    'DSA-RING-01 random push, shift and at match an array model in both modes; ByteRing matches a concatenated-bytes model',
    () => {
      fc.assert(
        fc.property(
          fc.constantFrom(1, 2, 4, 8, 16),
          fc.constantFrom<RingMode>('overwrite', 'reject'),
          fc.array(ringOp, { size: 'max', maxLength: 200 }),
          (capacity, mode, ops) => {
            const ring = new RingBuffer<number>(capacity, mode);
            let model: number[] = [];
            let dropped = 0;
            for (const op of ops) {
              switch (op.kind) {
                case 'push':
                  if (model.length < capacity) {
                    ring.push(op.x);
                    model.push(op.x);
                  } else if (mode === 'overwrite') {
                    ring.push(op.x);
                    model = [...model.slice(1), op.x];
                    dropped++;
                  } else {
                    expect(() => ring.push(op.x)).toThrow(DsaError);
                    expect(ring.tryPush(op.x)).toBe(false);
                  }
                  break;
                case 'shift':
                  expect(ring.shift()).toBe(model.shift());
                  break;
                case 'at':
                  expect(ring.at(op.i)).toBe(op.i >= 0 ? model[op.i] : undefined);
                  break;
                case 'clear':
                  ring.clear();
                  model = [];
                  break;
              }
              ring.checkInvariants();
              const head = ring.head;
              expect({
                items: ring.toArray(),
                size: ring.size,
                dropped: ring.dropped,
                oldest: ring.peekOldest(),
                newest: ring.peekNewest(),
                slots: model.map((_, i) => ring.slotOf(i)),
              }).toEqual({
                items: model,
                size: model.length,
                dropped,
                oldest: model[0],
                newest: model[model.length - 1],
                slots: model.map((_, i) => (head + i) & (capacity - 1)),
              });
            }
          },
        ),
        PROP,
      );

      fc.assert(
        fc.property(
          fc.constantFrom(1, 2, 8, 32),
          fc.array(byteOp, { size: 'max', maxLength: 100 }),
          (capacity, ops) => {
            const pipe = new ByteRingBuffer(capacity);
            let model: number[] = [];
            for (const op of ops) {
              if (op.kind === 'write') {
                const accepted = Math.min(op.data.length, capacity - model.length);
                expect(pipe.write(op.data)).toBe(accepted);
                model = [...model, ...op.data.subarray(0, accepted)];
              } else {
                const dst = new Uint8Array(op.n);
                const delivered = Math.min(op.n, model.length);
                expect(pipe.read(dst)).toBe(delivered);
                expect([...dst.subarray(0, delivered)]).toEqual(model.slice(0, delivered));
                model = model.slice(delivered);
              }
              pipe.checkInvariants();
              expect([pipe.available, pipe.free]).toEqual([model.length, capacity - model.length]);
            }
          },
        ),
        PROP,
      );
    },
    PROP_TIMEOUT_MS,
  );

  // Added with the implementation: the frame meter's Float64Ring is differential-tested against the
  // model-tested RingBuffer<number>, including -0, NaN and infinities, which a Float64Array keeps.
  it(
    'DSA-RING-01 Float64Ring matches RingBuffer<number> on random push, tryPush, shift, at and clear in both modes',
    () => {
      const floatOp: fc.Arbitrary<RingOp | { kind: 'tryPush'; x: number }> = fc.oneof(
        { weight: 3, arbitrary: fc.record({ kind: fc.constant('push' as const), x: fc.double() }) },
        {
          weight: 1,
          arbitrary: fc.record({ kind: fc.constant('tryPush' as const), x: fc.double() }),
        },
        { weight: 2, arbitrary: fc.record({ kind: fc.constant('shift' as const) }) },
        {
          weight: 2,
          arbitrary: fc.record({
            kind: fc.constant('at' as const),
            i: fc.integer({ min: -2, max: 20 }),
          }),
        },
        { weight: 1, arbitrary: fc.record({ kind: fc.constant('clear' as const) }) },
      );
      fc.assert(
        fc.property(
          fc.constantFrom(1, 2, 4, 8, 16),
          fc.constantFrom<RingMode>('overwrite', 'reject'),
          fc.array(floatOp, { size: 'max', maxLength: 100 }),
          (capacity, mode, ops) => {
            const meter = new Float64Ring(capacity, mode);
            const ring = new RingBuffer<number>(capacity, mode);
            for (const op of ops) {
              switch (op.kind) {
                case 'push': {
                  let meterError: unknown;
                  let ringError: unknown;
                  try {
                    meter.push(op.x);
                  } catch (error) {
                    meterError = error;
                  }
                  try {
                    ring.push(op.x);
                  } catch (error) {
                    ringError = error;
                  }
                  expect((meterError as DsaError | undefined)?.code).toBe(
                    (ringError as DsaError | undefined)?.code,
                  );
                  break;
                }
                case 'tryPush':
                  expect(meter.tryPush(op.x)).toBe(ring.tryPush(op.x));
                  break;
                case 'shift':
                  expect(meter.shift()).toBe(ring.shift());
                  break;
                case 'at':
                  expect(meter.at(op.i)).toBe(ring.at(op.i));
                  break;
                case 'clear':
                  meter.clear();
                  ring.clear();
                  break;
              }
              meter.checkInvariants();
              expect([
                meter.toArray(),
                meter.size,
                meter.dropped,
                meter.head,
                meter.peekOldest(),
                meter.peekNewest(),
              ]).toEqual([
                ring.toArray(),
                ring.size,
                ring.dropped,
                ring.head,
                ring.peekOldest(),
                ring.peekNewest(),
              ]);
            }
          },
        ),
        PROP,
      );
    },
    PROP_TIMEOUT_MS,
  );
});
