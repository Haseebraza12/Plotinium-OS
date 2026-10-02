import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { comparePaths, credOf, readableTopDown, verifyUpward } from './reference.ts';
import {
  GIDS,
  GraphBuilder,
  ROOT,
  USERS,
  bruteForceReadable,
  buildTree,
  randomTree,
} from './tests/graph.ts';

const alice = { uid: 1001, gids: [100, 500] };
const bob = { uid: 1002, gids: [100, 500] };
const carol = { uid: 1003, gids: [100] };
const root = { uid: 0, gids: [0] };

/** /home (0755) with alice's 0700 home, a 0750 team dir, a 0711 drop box and a hard link. */
function fixture() {
  const g = new GraphBuilder();
  const home = g.dir(ROOT, 'home', 0o755, 0, 0);
  const ah = g.dir(home, 'alice', 0o700, 1001, 100);
  const secret = g.file(ah, 'diary.md', 0o644, 1001, 100);
  const team = g.dir(home, 'team', 0o750, 1001, 500);
  const plan = g.file(team, 'plan.md', 0o640, 1001, 500);
  const drop = g.dir(home, 'drop', 0o711, 1001, 100);
  const blind = g.file(drop, 'blind.md', 0o644, 1001, 100);
  const pub = g.dir(ROOT, 'pub', 0o755, 0, 0);
  g.link(pub, 'diary-link.md', secret); // the same inode under a traversable directory
  const noX = g.file(pub, 'script.sh', 0o644, 1001, 100);
  return { g, home, ah, secret, team, plan, drop, blind, pub, noX };
}

describe('RAG-03 the readable set on a fake permission graph (backend-api.md §3.12; rag-semantic-search.md §5.2)', () => {
  it('RAG-03 a 0700 home hides every file from other users, and group bits admit team members only', () => {
    const f = fixture();
    const forCarol = readableTopDown(f.g.graph(), carol);
    expect(forCarol.has(f.plan)).toBe(false); // carol is not in group 500
    expect(forCarol.get(f.secret)).toBe('/pub/diary-link.md'); // readable through the hard link only
    expect(forCarol.get(f.blind)).toBe('/home/drop/blind.md'); // 0711: traversable without r on the dir
    const forBob = readableTopDown(f.g.graph(), bob);
    expect(forBob.get(f.plan)).toBe('/home/team/plan.md');
    const forAlice = readableTopDown(f.g.graph(), alice);
    expect(forAlice.get(f.secret)).toBe('/home/alice/diary.md'); // the byte-wise smallest readable path
  });

  it('RAG-03 hard link and symlink cases follow POSIX readability of at least one traversable link', () => {
    const f = fixture();
    const up = verifyUpward(f.g.graph(), carol, [f.secret, f.plan]);
    expect(up.get(f.secret)).toEqual({ readable: true, path: '/pub/diary-link.md' });
    expect(up.get(f.plan)).toEqual({ readable: false });
    f.g.chmod(f.pub, 0o754); // the only traversable link is closed: others lose x on /pub
    expect(verifyUpward(f.g.graph(), carol, [f.secret]).get(f.secret)).toEqual({ readable: false });
    expect(readableTopDown(f.g.graph(), carol).has(f.secret)).toBe(false);
  });

  it('RAG-03 server verify returns readable=false for a file chmodded after indexing', () => {
    const f = fixture();
    expect(verifyUpward(f.g.graph(), bob, [f.plan]).get(f.plan)?.readable).toBe(true);
    f.g.chmod(f.plan, 0o600);
    expect(verifyUpward(f.g.graph(), bob, [f.plan]).get(f.plan)).toEqual({ readable: false });
    expect(readableTopDown(f.g.graph(), bob).has(f.plan)).toBe(false);
  });

  it('RAG-03 removing x from an ancestor directory hides every file below it', () => {
    const f = fixture();
    expect(readableTopDown(f.g.graph(), bob).has(f.plan)).toBe(true);
    f.g.chmod(f.home, 0o744);
    const r = readableTopDown(f.g.graph(), bob);
    expect([r.has(f.plan), r.has(f.blind)]).toEqual([false, false]);
    expect(verifyUpward(f.g.graph(), bob, [f.plan, f.blind]).get(f.blind)?.readable).toBe(false);
    f.g.chmod(ROOT, 0o700); // even / itself: nothing is readable for others
    expect(readableTopDown(f.g.graph(), alice).size).toBe(0);
  });

  it('RAG-03 root reads everything reachable, but a deleted inode, a directory or a missing ino is never readable', () => {
    const f = fixture();
    const all = readableTopDown(f.g.graph(), root);
    expect(all.size).toBe(4); // diary (two links), plan, blind, script
    const up = verifyUpward(f.g.graph(), root, [
      f.team,
      'deadbeef-0000-7000-8000-000000000000',
      f.noX,
    ]);
    expect(up.get(f.team)).toEqual({ readable: false });
    expect(up.get('deadbeef-0000-7000-8000-000000000000')).toEqual({ readable: false });
    expect(up.get(f.noX)).toEqual({ readable: true, path: '/pub/script.sh' });
    const g2 = f.g.graph();
    const unlinked = { ...g2, dentries: g2.dentries.filter((d) => d.ino !== f.noX) };
    expect(verifyUpward(unlinked, root, [f.noX]).get(f.noX)).toEqual({ readable: false });
  });

  it('RAG-03 a scope limits results to one subtree that must still be reached with x from /', () => {
    const f = fixture();
    expect([...readableTopDown(f.g.graph(), bob, f.team).keys()]).toEqual([f.plan]);
    expect(readableTopDown(f.g.graph(), carol, f.ah).size).toBe(0);
    expect(readableTopDown(f.g.graph(), alice, ROOT).size).toBe(4);
  });

  it('RAG-03 an orphaned directory chain that does not reach / is never readable', () => {
    const g = new GraphBuilder();
    const lost = '0192f2a0-0000-7000-8000-00000000ffff';
    g.inodes.set(lost, { ino: lost, type: 'd', mode: 0o777, uid: 0, gid: 0 });
    const f = g.file(lost, 'x', 0o644, 0, 0);
    expect(verifyUpward(g.graph(), alice, [f]).get(f)).toEqual({ readable: false });
    expect(readableTopDown(g.graph(), alice).has(f)).toBe(false);
  });

  it('RAG-03 top-down, upward and the brute-force definition agree on random permission graphs', () => {
    fc.assert(
      fc.property(randomTree, (t) => {
        const { g, files } = buildTree(t);
        const graph = g.graph();
        for (const uid of USERS) {
          const req = { uid, gids: GIDS[uid] ?? [] };
          const expected = bruteForceReadable(graph, credOf(req));
          const top = readableTopDown(graph, req);
          expect(new Set(top.keys())).toEqual(expected);
          const up = verifyUpward(graph, req, files);
          for (const ino of files) {
            expect(up.get(ino)?.readable).toBe(expected.has(ino));
            if (expected.has(ino)) expect(up.get(ino)?.path).toBe(top.get(ino));
          }
        }
      }),
      { numRuns: 300, seed: 94 },
    );
  });

  it('RAG-03 paths compare in UTF-8 byte order, the order of COLLATE "C"', () => {
    expect(comparePaths('/a', '/b')).toBeLessThan(0);
    expect(comparePaths('/Ａ', '/\u{1F600}')).toBeLessThan(0); // U+FF21 < U+1F600 in code points
    expect('/Ａ' < '/\u{1F600}').toBe(false); // ... but not in UTF-16 units
  });
});
