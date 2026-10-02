import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { nodeOps } from '../fault-injection/matrix.ts';
import { toRows } from '../fixtures/trees.ts';
import { sameState, subtreeChecksum, takeSnapshot, type StoreRows } from '../support/oracle.ts';

import { faultCaseArb, fixtureTreeArb, namedFaultCaseArb } from './arbitraries.ts';
import { fcParams, regressionsFor } from './profile.ts';

type Corruption = 'drop-dentry' | 'nlink' | 'refcount' | 'quota' | 'mode' | 'orphan-inode';

function corrupt(rows: StoreRows, kind: Corruption, pick: number): StoreRows | undefined {
  const files = rows.inodes.filter((i) => i.type === 'f');
  const victim = files[pick % Math.max(1, files.length)];
  switch (kind) {
    case 'drop-dentry':
      return victim === undefined
        ? undefined
        : { ...rows, dentries: rows.dentries.filter((d) => d.ino !== victim.ino) };
    case 'nlink':
      return victim === undefined
        ? undefined
        : {
            ...rows,
            inodes: rows.inodes.map((i) => (i === victim ? { ...i, nlink: i.nlink + 1 } : i)),
          };
    case 'mode':
      return victim === undefined
        ? undefined
        : {
            ...rows,
            inodes: rows.inodes.map((i) => (i === victim ? { ...i, mode: i.mode ^ 0o100 } : i)),
          };
    case 'refcount': {
      const b = rows.blobs[pick % Math.max(1, rows.blobs.length)];
      return b === undefined
        ? undefined
        : {
            ...rows,
            blobs: rows.blobs.map((x) => (x === b ? { ...x, refcount: x.refcount + 1 } : x)),
          };
    }
    case 'quota':
      return { ...rows, quota: rows.quota.map((q) => ({ ...q, usedInodes: q.usedInodes + 1 })) };
    case 'orphan-inode':
      return {
        ...rows,
        inodes: [
          ...rows.inodes,
          {
            ino: 'stray',
            type: 'f',
            mode: 0o644,
            uid: 1000,
            gid: 100,
            size: 0,
            nlink: 1,
            version: 1,
            blob: null,
          },
        ],
      };
  }
}

const TITLE_DETECT =
  'TST-09 any single planted corruption of a sound random tree is detected by the oracle';

describe('TST-09 oracle properties', () => {
  it('TST-09 every generated fixture tree is sound under the oracle', () => {
    fc.assert(
      fc.property(fixtureTreeArb, (tree) => {
        const s = takeSnapshot(toRows(tree));
        return (
          s.orphans.length +
            s.parentless.length +
            s.refcountMismatches.length +
            s.nlinkMismatches.length ===
          0
        );
      }),
      fcParams(),
    );
  });

  it('TST-09 any single planted corruption of a sound random tree is detected by the oracle', () => {
    const kinds: Corruption[] = [
      'drop-dentry',
      'nlink',
      'refcount',
      'quota',
      'mode',
      'orphan-inode',
    ];
    const prop = fc.property(
      fixtureTreeArb,
      fc.constantFrom(...kinds),
      fc.nat(),
      (tree, kind, pick) => {
        const rows = toRows(tree);
        const broken = corrupt(rows, kind, pick);
        fc.pre(broken !== undefined);
        return !sameState(takeSnapshot(rows), takeSnapshot(broken)).ok;
      },
    );
    fc.assert(prop, fcParams());
    for (const replay of regressionsFor(TITLE_DETECT)) fc.assert(prop, replay);
  });

  it('TST-09 the subtree checksum does not depend on the order rows are read in', () => {
    fc.assert(
      fc.property(fixtureTreeArb, fc.nat(), (tree, seed) => {
        const rows = toRows(tree);
        const rot = (n: number, len: number): number => (len === 0 ? 0 : n % len);
        const shuffled: StoreRows = {
          ...rows,
          inodes: [
            ...rows.inodes.slice(rot(seed, rows.inodes.length)),
            ...rows.inodes.slice(0, rot(seed, rows.inodes.length)),
          ],
          dentries: [...rows.dentries].reverse(),
        };
        return subtreeChecksum(shuffled) === subtreeChecksum(rows);
      }),
      fcParams(),
    );
  });
});

describe('DB-02 fault-point generation', () => {
  it("DB-02 generated fault points always fall inside the op's node operations", () => {
    fc.assert(
      fc.property(faultCaseArb, ({ row, failAt }) => failAt >= 1 && failAt <= nodeOps(row)),
      fcParams(),
    );
    fc.assert(
      fc.property(namedFaultCaseArb, ({ row, failAt }) => failAt >= 1 && failAt <= nodeOps(row)),
      fcParams(),
    );
    expect(nodeOps({ op: 'rm-r', tree: 'tree1000' })).toBe(1001);
  });
});
