import { describe, expect, it } from 'vitest';

import { mulberry32, pick } from './rng.ts';
import {
  TREE_SIZES,
  contentOf,
  maxDepth,
  toRows,
  tree1000,
  treeById,
  type TreeId,
} from './trees.ts';
import { SHARED_PLAN, allSeedUsers, seedUser } from './users.ts';

describe('TST-22 seeded fixtures', () => {
  it('TST-22 tree1000 has exactly 1,000 nodes, depth at least 6 and unique paths', () => {
    const t = tree1000();
    expect(t.nodes).toHaveLength(1000);
    expect(maxDepth(t)).toBeGreaterThanOrEqual(6);
    expect(new Set(t.nodes.map((n) => n.path)).size).toBe(1000);
  });

  it('TST-22 every parent directory precedes its children', () => {
    const seen = new Set<string>();
    for (const n of tree1000().nodes) {
      const cut = n.path.lastIndexOf('/');
      if (cut >= 0) expect(seen.has(n.path.slice(0, cut))).toBe(true);
      if (n.type === 'd') seen.add(n.path);
    }
  });

  it('TST-22 two runs of the generator produce identical trees', () => {
    expect(tree1000()).toEqual(tree1000());
    expect(tree1000(7)).not.toEqual(tree1000());
  });

  it('TST-22 every tree id matches its declared size', () => {
    for (const id of Object.keys(TREE_SIZES) as TreeId[]) {
      expect(treeById(id).nodes).toHaveLength(TREE_SIZES[id]);
    }
  });

  it('TST-22 toRows yields a sound tree with quota equal to the fixture size', () => {
    const rows = toRows(treeById('files20'));
    expect(rows.inodes).toHaveLength(22);
    expect(rows.quota[0]?.usedInodes).toBe(21);
    expect(rows.blobs).toHaveLength(20);
  });

  it('TST-22 contentOf returns exactly size bytes and is deterministic', () => {
    expect(contentOf('a/b.txt', 20)).toHaveLength(20);
    expect(contentOf('a/b.txt', 0)).toBe('');
    expect(contentOf('x', 5)).toBe(contentOf('x', 5));
  });

  it('TST-22 mulberry32 is reproducible and pick rejects an empty list', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
    expect(() => pick(a, [])).toThrow(RangeError);
  });

  it('TST-22 seed users follow the db/seed uids and read passwords from the environment', () => {
    expect(seedUser('root').uid).toBe(0);
    expect(seedUser('guest').password).toBeUndefined();
    expect(seedUser('alice', { PLT_TEST_ALICE_PASSWORD: 'x' }).password).toBe('x');
    expect(allSeedUsers().map((u) => u.username)).toEqual([
      'root',
      'alice',
      'bob',
      'demo',
      'guest',
    ]);
    expect(() => seedUser('mallory' as 'root')).toThrow(RangeError);
    expect(SHARED_PLAN.startsWith('/home/shared/')).toBe(true);
  });
});
