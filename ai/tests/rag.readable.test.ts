import { INO } from '@plotinium/protocol';
import { describe, expect, it } from 'vitest';

import { buildTree, type FixtureEntry } from '../eval/fixtures/tree.ts';
import { hasBit } from '../src/search/bits.ts';
import { ReadableCache, type FileSlot, isForeign, readableSet } from '../src/search/readable.ts';
import { assembleResults, type AssembleInput, type Candidate } from '../src/search/results.ts';
import {
  displayPath,
  escapeForTty,
  formatCitation,
  formatPathsOnly,
  makeSnippet,
  pickSnippet,
} from '../src/search/citations.ts';
import { NOTICE_VERIFY_FAILED } from '../src/search/hybrid.ts';
import { cred, posixOracle } from './doubles.ts';

const ALICE = 1001;
const BOB = 1002;
const CAROL = 1003;
const TEAM = 2000;
const USERS: Array<[string, number]> = [
  ['alice', ALICE],
  ['bob', BOB],
  ['carol', CAROL],
];
const credOf = (uid: number) => cred(uid, 100, uid === CAROL ? [100] : [100, TEAM]);

function leakTree(): { entries: FixtureEntry[]; files: string[] } {
  const entries: FixtureEntry[] = [
    { path: '/home', type: 'd', uid: 0, gid: 0, mode: 0o755 },
    { path: '/home/alice', type: 'd', uid: ALICE, gid: 100, mode: 0o755 },
  ];
  const files: string[] = [];
  for (const dmode of [0o700, 0o711, 0o755]) {
    const dir = `/home/alice/d${dmode.toString(8)}`;
    entries.push({ path: dir, type: 'd', uid: ALICE, gid: TEAM, mode: dmode });
    for (const fmode of [0o600, 0o640, 0o644]) {
      const path = `${dir}/f${fmode.toString(8)}.md`;
      entries.push({ path, type: 'f', uid: ALICE, gid: TEAM, mode: fmode });
      files.push(path);
    }
  }
  return { entries, files };
}

/** Reference: POSIX readability through the single parent chain. */
function reference(uid: number, dirMode: number, fileMode: number): boolean {
  if (uid === ALICE) return true;
  const inGroup = uid !== CAROL;
  const dirX = inGroup ? (dirMode >> 3) & 1 : dirMode & 1;
  const fileR = inGroup ? (fileMode >> 3) & 4 : fileMode & 4;
  return dirX !== 0 && fileR !== 0;
}

describe('readable set (RAG-03)', () => {
  it('RAG-03 rag-leak matrix: 3 users × file modes 600/640/644 × directory modes 700/711/755 give exactly POSIX readability', () => {
    const { entries, files } = leakTree();
    const tree = buildTree(entries);
    const table: FileSlot[] = files.map((p) => ({ ino: tree.inoOf(p) ?? '', inodeVersion: 1 }));
    for (const [, uid] of USERS) {
      const bits = readableSet({
        cred: credOf(uid),
        fileTable: table,
        tree: tree.live,
        oracle: posixOracle,
      });
      files.forEach((p, i) => {
        const m = /d(\d+)\/f(\d+)/.exec(p);
        const want = reference(
          uid,
          Number.parseInt(m?.[1] ?? '0', 8),
          Number.parseInt(m?.[2] ?? '0', 8),
        );
        expect(hasBit(bits, i), `${uid} ${p}`).toBe(want);
      });
    }
  });

  it('RAG-03 removing x from an ancestor directory hides every file below it', () => {
    const entries: FixtureEntry[] = [
      { path: '/home/alice', type: 'd', uid: ALICE, gid: 100, mode: 0o700 },
      { path: '/home/alice/a/b', type: 'd', uid: ALICE, gid: 100, mode: 0o755 },
      { path: '/home/alice/a/b/deep.md', type: 'f', uid: ALICE, gid: 100, mode: 0o644 },
    ];
    const tree = buildTree(entries);
    const table = [{ ino: tree.inoOf('/home/alice/a/b/deep.md') ?? '', inodeVersion: 1 }];
    expect(
      hasBit(
        readableSet({ cred: credOf(BOB), fileTable: table, tree: tree.live, oracle: posixOracle }),
        0,
      ),
    ).toBe(false);
    expect(
      hasBit(
        readableSet({
          cred: credOf(ALICE),
          fileTable: table,
          tree: tree.live,
          oracle: posixOracle,
        }),
        0,
      ),
    ).toBe(true);
    expect(
      hasBit(
        readableSet({ cred: cred(0, 0), fileTable: table, tree: tree.live, oracle: posixOracle }),
        0,
      ),
    ).toBe(true);
  });

  it('RAG-03 hard link and symlink cases follow POSIX readability of at least one traversable link', () => {
    const entries: FixtureEntry[] = [
      { path: '/home/alice', type: 'd', uid: ALICE, gid: 100, mode: 0o755 },
      { path: '/home/alice/private', type: 'd', uid: ALICE, gid: 100, mode: 0o700 },
      { path: '/home/alice/public', type: 'd', uid: ALICE, gid: 100, mode: 0o755 },
      {
        path: '/home/alice/private/both.md',
        type: 'f',
        uid: ALICE,
        gid: 100,
        mode: 0o644,
        links: ['/home/alice/public/both.md'],
      },
      { path: '/home/alice/private/only.md', type: 'f', uid: ALICE, gid: 100, mode: 0o644 },
      {
        path: '/home/alice/public/link.md',
        type: 'l',
        uid: ALICE,
        gid: 100,
        mode: 0o777,
        target: '/home/alice/private/only.md',
      },
    ];
    const tree = buildTree(entries);
    const table = [
      '/home/alice/private/both.md',
      '/home/alice/private/only.md',
      '/home/alice/public/link.md',
    ].map((p) => ({ ino: tree.inoOf(p) ?? '', inodeVersion: 1 }));
    const bits = readableSet({
      cred: credOf(BOB),
      fileTable: table,
      tree: tree.live,
      oracle: posixOracle,
    });
    expect([hasBit(bits, 0), hasBit(bits, 1), hasBit(bits, 2)]).toEqual([true, false, false]);
  });

  it('RAG-03 a deleted inode or an empty slot is never readable, even before ai.index.drop runs', () => {
    const tree = buildTree([
      { path: '/home/alice/x.md', type: 'f', uid: ALICE, gid: 100, mode: 0o644 },
    ]);
    const table: Array<FileSlot | undefined> = [
      { ino: '0192f0c1-0000-7000-8000-00000000dead', inodeVersion: 1 },
      undefined,
    ];
    const bits = readableSet({
      cred: credOf(ALICE),
      fileTable: table,
      tree: tree.live,
      oracle: posixOracle,
    });
    expect(hasBit(bits, 0)).toBe(false);
    expect(hasBit(bits, 1)).toBe(false);
  });

  it('RAG-03 scope restricts the readable set to the subtree and a chmod epoch invalidates the cache', () => {
    const tree = buildTree([
      { path: '/home/alice/a/x.md', type: 'f', uid: ALICE, gid: 100, mode: 0o644 },
      { path: '/home/alice/b/y.md', type: 'f', uid: ALICE, gid: 100, mode: 0o644 },
    ]);
    const table = ['/home/alice/a/x.md', '/home/alice/b/y.md'].map((p) => ({
      ino: tree.inoOf(p) ?? '',
      inodeVersion: 1,
    }));
    const scoped = readableSet({
      cred: credOf(ALICE),
      fileTable: table,
      tree: tree.live,
      oracle: posixOracle,
      scopeIno: tree.inoOf('/home/alice/a') ?? '',
    });
    expect([hasBit(scoped, 0), hasBit(scoped, 1)]).toEqual([true, false]);
    const cache = new ReadableCache(2);
    let computed = 0;
    const compute = () => {
      computed++;
      return scoped;
    };
    const c = credOf(ALICE);
    cache.getOrCompute(ReadableCache.key(c, 1, 1), compute);
    cache.getOrCompute(ReadableCache.key(c, 1, 1), compute);
    cache.getOrCompute(ReadableCache.key(c, 2, 1), compute);
    cache.getOrCompute(ReadableCache.key(c, 3, 1, 'scope'), compute);
    expect(computed).toBe(3);
    expect(cache.size).toBe(2);
  });

  it('RAG-03 a result is foreign when the owner or a non-system ancestor belongs to someone else; root has none', () => {
    const tree = buildTree([
      { path: '/home/alice', type: 'd', uid: ALICE, gid: 100, mode: 0o755 },
      { path: '/home/alice/x.md', type: 'f', uid: ALICE, gid: 100, mode: 0o644 },
      { path: '/home/team', type: 'd', uid: 0, gid: TEAM, mode: 0o775 },
      { path: '/home/team/bob.md', type: 'f', uid: BOB, gid: TEAM, mode: 0o664 },
    ]);
    const n = (p: string) => tree.live.node(tree.inoOf(p) ?? '');
    const file = n('/home/alice/x.md');
    const anc = ['/', '/home', '/home/alice'].map(n).filter((x) => x !== undefined);
    if (file === undefined) throw new Error('fixture');
    expect(isForeign(credOf(ALICE), file, anc)).toBe(false);
    expect(isForeign(credOf(BOB), file, anc)).toBe(true);
    expect(isForeign(cred(0, 0), file, anc)).toBe(false);
    const own = n('/home/team/bob.md');
    const teamAnc = ['/', '/home', '/home/team'].map(n).filter((x) => x !== undefined);
    if (own === undefined) throw new Error('fixture');
    expect(isForeign(credOf(BOB), own, teamAnc)).toBe(true);
    expect(INO.HOME).toBe(tree.inoOf('/home'));
  });
});

describe('results, citations and snippets', () => {
  const tree = buildTree([
    { path: '/home/alice', type: 'd', uid: ALICE, gid: 100, mode: 0o755 },
    { path: '/home/alice/notes', type: 'd', uid: ALICE, gid: 100, mode: 0o755 },
    { path: '/home/alice/notes/memory.md', type: 'f', uid: ALICE, gid: 100, mode: 0o644 },
    { path: '/home/alice/notes/old.md', type: 'f', uid: ALICE, gid: 100, mode: 0o644 },
    { path: '/home/bob/shared.md', type: 'f', uid: BOB, gid: 100, mode: 0o644 },
  ]);
  const paths = ['/home/alice/notes/memory.md', '/home/alice/notes/old.md', '/home/bob/shared.md'];
  const table = paths.map((p) => ({ ino: tree.inoOf(p) ?? '', inodeVersion: 1 }));
  const base = (over: Partial<AssembleInput> = {}): AssembleInput => ({
    cred: credOf(ALICE),
    candidates: [],
    k: 5,
    chunks: false,
    fileTable: table,
    tree: tree.live,
    resolvePath: (ino) => {
      const i = table.findIndex((t) => t.ino === ino);
      const path = paths[i];
      if (path === undefined) return undefined;
      const parts = path.split('/').slice(1, -1);
      const anc = ['/', ...parts.map((_, j) => `/${parts.slice(0, j + 1).join('/')}`)]
        .map((p) => tree.live.node(tree.inoOf(p) ?? ''))
        .filter((x) => x !== undefined);
      return { path, ancestors: anc };
    },
    chunkMeta: (ino, seq) => ({
      lineStart: 41 + seq,
      lineEnd: 67 + seq,
      inodeVersion: ino === table[1]?.ino ? 7 : 1,
    }),
    ownSnippet: () => 'The LRU list keeps pages\n\nin recency order',
    online: true,
    ...over,
  });
  const cands: Candidate[] = [
    { fileIdx: 0, seq: 0, score: 0.83 },
    { fileIdx: 0, seq: 1, score: 0.8 },
    { fileIdx: 1, seq: 0, score: 0.7 },
    { fileIdx: 2, seq: 0, score: 0.6 },
  ];

  it('RAG-03 a chunk whose inodeVersion differs from the current inode is never shown', async () => {
    const r = await assembleResults(base({ candidates: cands, verify: () => Promise.resolve([]) }));
    expect(r.results.map((x) => x.path)).toEqual(['/home/alice/notes/memory.md']);
  });

  it('RAG-06 results collapse per file unless chunks are requested, with path:line citations and snippets', async () => {
    const r = await assembleResults(base({ candidates: cands.slice(0, 2), online: false }));
    expect(r.results).toHaveLength(1);
    expect(r.results[0]).toMatchObject({
      lineStart: 41,
      lineEnd: 67,
      snippet: 'The LRU list keeps pages in recency order',
      verified: 'own',
    });
    const all = await assembleResults(
      base({ candidates: cands.slice(0, 2), chunks: true, online: false }),
    );
    expect(all.results).toHaveLength(2);
    const line = formatCitation(
      {
        path: '/home/alice/notes/memory.md',
        lineStart: 41,
        lineEnd: 67,
        score: 0.83,
        snippet: 'x',
      },
      '/home/alice',
    );
    expect(line).toBe('~/notes/memory.md:41-67  0.83  x');
    expect(
      formatCitation({ path: '/home/alice/a', lineStart: 0, lineEnd: 0, score: 0.5, snippet: 's' }),
    ).toBe('/home/alice/a  0.50  s');
    expect(
      formatPathsOnly([
        { path: '/a', lineStart: 1, lineEnd: 1, score: 1, snippet: '' },
        { path: '/a', lineStart: 2, lineEnd: 2, score: 1, snippet: '' },
      ]),
    ).toEqual(['/a']);
  });

  it('RAG-03 offline, foreign results are hidden with a notice and never shown unverified', async () => {
    const r = await assembleResults(
      base({ candidates: [cands[3] ?? cands[0] ?? { fileIdx: 0, score: 0 }], online: false }),
    );
    expect(r.results).toEqual([]);
    expect(r.notices).toEqual(['1 shared result hidden while offline']);
  });

  it('RAG-03 online, only server-verified foreign results are shown, with the server snippet', async () => {
    const shared = table[2]?.ino ?? '';
    const ok = await assembleResults(
      base({
        candidates: [{ fileIdx: 2, seq: 0, score: 0.6 }],
        verify: () =>
          Promise.resolve([
            { ino: shared, seq: 0, readable: true, inodeVersion: 1, snippet: 'server text' },
          ]),
      }),
    );
    expect(ok.results[0]).toMatchObject({ verified: 'server', snippet: 'server text' });
    const denied = await assembleResults(
      base({
        candidates: [{ fileIdx: 2, seq: 0, score: 0.6 }],
        verify: () => Promise.resolve([{ ino: shared, seq: 0, readable: false }]),
      }),
    );
    expect(denied.results).toEqual([]);
    const timeout = await assembleResults(
      base({
        candidates: [{ fileIdx: 2, seq: 0, score: 0.6 }],
        verify: () => Promise.resolve(undefined),
      }),
    );
    expect(timeout.results).toEqual([]);
    expect(timeout.notices).toEqual([NOTICE_VERIFY_FAILED]);
    const noVerifier = await assembleResults(base({ candidates: [{ fileIdx: 2, score: 0.6 }] }));
    expect(noVerifier.notices).toEqual([NOTICE_VERIFY_FAILED]);
  });

  it('RAG-06 snippets are whitespace-collapsed, at most 240 characters, and TTY output escapes control characters', () => {
    const long = makeSnippet('word '.repeat(200));
    expect([...long].length).toBeLessThanOrEqual(240);
    expect(long.endsWith('…')).toBe(true);
    expect(pickSnippet({ serverSnippet: 's' })).toBe('s');
    expect(pickSnippet({ preview: 'p', serverSnippet: 's' })).toBe('p');
    expect(pickSnippet({})).toBe('');
    expect(escapeForTty('a\u001b[31mb\u202ec')).toBe('a\\u{001B}[31mb\\u{202E}c');
    expect(displayPath('/home/alice', '/home/alice')).toBe('~');
    expect(displayPath('/home/alicex', '/home/alice')).toBe('/home/alicex');
  });
});
