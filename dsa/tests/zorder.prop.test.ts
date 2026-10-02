/**
 * S9 z-order list: model-based property test (specs/08-dsa/data-structures.md §8.10). The model is
 * an array of wids, bottom to top. Gated on IMPLEMENTED (C16).
 */
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { DsaError } from '../src/_shared/errors.ts';
import { IMPLEMENTED, LinkedZOrder } from '../src/zorder/index.ts';
import type { ZChange } from '../src/zorder/index.ts';
import { PROP } from './helpers.ts';

type ZOp = { kind: 'insertTop' | 'remove' | 'raise' | 'lower'; wid: number };

const zOp: fc.Arbitrary<ZOp> = fc.record({
  kind: fc.constantFrom(
    'insertTop' as const,
    'remove' as const,
    'raise' as const,
    'lower' as const,
  ),
  wid: fc.nat(15),
});

/** z of each wid in a bottom-to-top array (1-based). */
function zMap(order: readonly number[]): Map<number, number> {
  return new Map(order.map((wid, i) => [wid, i + 1]));
}

/** Windows present before and after whose z changed, with the new z, bottom to top. */
function diff(before: readonly number[], after: readonly number[]): ZChange[] {
  const old = zMap(before);
  return after.flatMap((wid, i) => (old.get(wid) === i + 1 ? [] : [{ wid, z: i + 1 }]));
}

describe.runIf(IMPLEMENTED)('dsa/zorder properties (S9)', () => {
  it('WM-02 random insert, remove, raise and lower match an array model, z values are exactly 1..n in list order, and the returned changes equal the before/after diff', () => {
    fc.assert(
      fc.property(fc.array(zOp, { size: 'max', maxLength: 200 }), (ops) => {
        const list = new LinkedZOrder(1);
        let model: number[] = [];
        for (const op of ops) {
          const before = model;
          const present = model.includes(op.wid);
          let changes: ZChange[];
          switch (op.kind) {
            case 'insertTop':
              if (present) {
                expect(() => list.insertTop(op.wid)).toThrow(DsaError);
                continue;
              }
              changes = list.insertTop(op.wid);
              model = [...model, op.wid];
              break;
            case 'remove':
              changes = list.remove(op.wid);
              model = model.filter((w) => w !== op.wid);
              break;
            case 'raise':
              changes = list.raise(op.wid);
              if (present) model = [...model.filter((w) => w !== op.wid), op.wid];
              break;
            case 'lower':
              changes = list.lower(op.wid);
              if (present) model = [op.wid, ...model.filter((w) => w !== op.wid)];
              break;
          }
          list.checkInvariants();
          expect({
            order: list.bottomToTop(),
            size: list.size,
            z: model.map((wid) => list.zOf(wid)),
            changes,
            top: list.top(),
            bottom: list.bottom(),
          }).toEqual({
            order: model,
            size: model.length,
            z: model.map((_, i) => i + 1),
            changes: diff(before, model),
            top: model[model.length - 1],
            bottom: model[0],
          });
        }
      }),
      PROP,
    );
  });
});
