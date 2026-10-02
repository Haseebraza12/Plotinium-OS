/**
 * S2 radix trie: model-based property tests (specs/08-dsa/data-structures.md §8.3). The model is
 * a Set of keys; `complete` is filter(startsWith) + sort (UTF-16 code units) + slice. A 3-letter
 * alphabet makes splits, merges and shared prefixes frequent. Gated on IMPLEMENTED (C16).
 */
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { IMPLEMENTED, RadixTrie } from '../src/trie/index.ts';
import { PROP } from './helpers.ts';

type TrieOp =
  | { kind: 'insert' | 'remove' | 'removePrefix'; key: string }
  | { kind: 'complete'; key: string; limit: number };

const word = fc.string({ unit: fc.constantFrom('a', 'b', 'c'), maxLength: 6 });
const trieOp: fc.Arbitrary<TrieOp> = fc.oneof(
  { weight: 4, arbitrary: fc.record({ kind: fc.constant('insert' as const), key: word }) },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant('remove' as const), key: word }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('removePrefix' as const), key: word }) },
  {
    weight: 2,
    arbitrary: fc.record({ kind: fc.constant('complete' as const), key: word, limit: fc.nat(12) }),
  },
);

function modelComplete(model: ReadonlySet<string>, prefix: string, limit: number): string[] {
  return [...model]
    .filter((k) => k.startsWith(prefix))
    .sort()
    .slice(0, limit);
}

describe.runIf(IMPLEMENTED)('dsa/trie properties (S2)', () => {
  it('DSA-TRIE-01 random insert, remove, removePrefix and complete over a 3-letter alphabet match a Set model (filter, sort, slice) and keep invariants R1–R8', () => {
    fc.assert(
      fc.property(fc.array(trieOp, { size: 'max', maxLength: 150 }), (ops) => {
        const trie = new RadixTrie(1, 1);
        const model = new Set<string>();
        for (const op of ops) {
          switch (op.kind) {
            case 'insert':
              trie.insert(op.key);
              model.add(op.key);
              break;
            case 'remove':
              expect(trie.remove(op.key)).toBe(model.delete(op.key));
              break;
            case 'removePrefix': {
              const doomed = [...model].filter((k) => k.startsWith(op.key));
              expect(trie.removePrefix(op.key)).toBe(doomed.length);
              for (const k of doomed) model.delete(k);
              break;
            }
            case 'complete':
              expect(trie.complete(op.key, op.limit).map((c) => c.text)).toEqual(
                modelComplete(model, op.key, op.limit),
              );
              break;
          }
          trie.checkInvariants();
          expect(trie.size).toBe(model.size);
          // R6: the spelled key set equals the model.
          expect(trie.complete('', model.size + 1).map((c) => c.text)).toEqual(
            modelComplete(model, '', model.size + 1),
          );
          expect(trie.stats().nodes).toBeLessThanOrEqual(2 * model.size + 1);
        }
      }),
      PROP,
    );
  });

  it('DSA-TRIE-01 after removing every key only the root remains', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(word, { size: 'max', maxLength: 60 }),
        fc.boolean(),
        (keys, compact) => {
          const trie = new RadixTrie(1, 1);
          for (const k of keys) trie.insert(k);
          for (const k of [...keys].reverse()) expect(trie.remove(k)).toBe(true);
          expect(trie.size).toBe(0);
          expect(trie.stats().nodes).toBe(1);
          if (compact) {
            trie.compact();
            expect(trie.stats().poolUnits).toBe(0);
          }
          trie.checkInvariants();
        },
      ),
      PROP,
    );
  });
});
