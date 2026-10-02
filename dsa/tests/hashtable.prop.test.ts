/**
 * S6 open-addressing hash table: differential tests against the built-in Map
 * (specs/08-dsa/data-structures.md §8.7). Gated on IMPLEMENTED (C16).
 */
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { mulberry32 } from '../src/_shared/prng.ts';
import { IMPLEMENTED, OpenAddressingTable } from '../src/hashtable/index.ts';
import { PROP } from './helpers.ts';

type TableOp =
  { kind: 'set'; key: number; value: number } | { kind: 'get' | 'delete' | 'has'; key: number };

// Keys from a small range collide, cluster and wrap at small capacities; a few large keys too.
const key = fc.oneof(fc.nat(63), fc.integer({ min: 2 ** 31 - 64, max: 2 ** 31 - 1 }));
const tableOp: fc.Arbitrary<TableOp> = fc.oneof(
  {
    weight: 2,
    arbitrary: fc.record({ kind: fc.constant('set' as const), key, value: fc.integer() }),
  },
  {
    weight: 1,
    arbitrary: fc.record({ kind: fc.constantFrom('get' as const, 'has' as const), key }),
  },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('delete' as const), key }) },
);

/** Apply one operation to both; returns a description of the mismatch, or undefined. */
function apply(
  table: OpenAddressingTable<number>,
  model: Map<number, number>,
  op: TableOp,
): string | undefined {
  let actual: unknown;
  let expected: unknown;
  switch (op.kind) {
    case 'set':
      table.set(op.key, op.value);
      model.set(op.key, op.value);
      return undefined;
    case 'get':
      [actual, expected] = [table.get(op.key), model.get(op.key)];
      break;
    case 'has':
      [actual, expected] = [table.has(op.key), model.has(op.key)];
      break;
    case 'delete':
      [actual, expected] = [table.delete(op.key), model.delete(op.key)];
      break;
  }
  return Object.is(actual, expected)
    ? undefined
    : `${op.kind}(${op.key}) returned ${String(actual)}, Map ${String(expected)}`;
}

describe.runIf(IMPLEMENTED)('dsa/hashtable properties (S6)', () => {
  it('DSA-HASH-01 200,000 random set, get, delete and has operations match Map after every step and keep invariants HT1–HT5', () => {
    // 1,000 runs × up to 200 operations on pull requests (PLT_PROP_RUNS=10000 nightly).
    fc.assert(
      fc.property(fc.array(tableOp, { size: 'max', maxLength: 200 }), (ops) => {
        const table = new OpenAddressingTable<number>();
        const model = new Map<number, number>();
        for (const op of ops) {
          const mismatch = apply(table, model, op);
          if (mismatch !== undefined) expect.unreachable(mismatch);
          table.checkInvariants();
          if (table.size !== model.size || table.probeStats().loadFactor > 0.5) {
            expect.unreachable(
              `size ${table.size} (Map ${model.size}), load ${table.probeStats().loadFactor}`,
            );
          }
        }
        const keys: number[] = [];
        table.forEach((value, k) => {
          expect(model.get(k)).toBe(value);
          keys.push(k);
        });
        expect(keys.length).toBe(model.size);
      }),
      PROP,
    );
  });

  it('DSA-HASH-01 a seeded 200,000-operation run over sequential and random keys matches Map', () => {
    const rand = mulberry32(42);
    const table = new OpenAddressingTable<number>();
    const model = new Map<number, number>();
    let nextPid = 1;
    for (let step = 1; step <= 200_000; step++) {
      const r = rand();
      // 50% get / 25% set / 25% delete (§7.1 S6), half sequential PID-like keys, half random.
      const k = rand() < 0.5 ? (nextPid++ % 32_768) + 1 : Math.floor(rand() * 2 ** 31);
      const op: TableOp =
        r < 0.5
          ? { kind: 'get', key: k }
          : r < 0.75
            ? { kind: 'set', key: k, value: step }
            : { kind: 'delete', key: k };
      const mismatch = apply(table, model, op);
      if (mismatch !== undefined) expect.unreachable(`step ${step}: ${mismatch}`);
      if (step % 10_000 === 0) {
        table.checkInvariants();
        expect(table.size).toBe(model.size);
      }
    }
    expect([...model].filter(([k, v]) => table.get(k) !== v)).toEqual([]);
  });
});
