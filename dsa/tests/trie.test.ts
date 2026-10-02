/**
 * S2 radix trie: edge cases (specs/08-dsa/data-structures.md §8.3). Gated on IMPLEMENTED (C16).
 */
import { describe, expect, it, vi } from 'vitest';

import { IMPLEMENTED, NamespacedRadixTrie, RadixTrie } from '../src/trie/index.ts';
import type { Completion } from '../src/trie/index.ts';
import { expectDsaError } from './helpers.ts';

const texts = (cs: readonly Completion[]): string[] => cs.map((c) => c.text);

function trieOf(keys: readonly string[]): RadixTrie {
  const trie = new RadixTrie();
  for (const k of keys) trie.insert(k);
  return trie;
}

/** A 36-character inode id in the well-known UUIDv7 shape. */
const ino = (n: number): string => `00000000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;

describe.runIf(IMPLEMENTED)('dsa/trie (S2)', () => {
  it('DSA-TRIE-01 an empty trie completes nothing, has size 0 and remove returns false', () => {
    const trie = new RadixTrie();
    expect(trie.complete('', 10)).toEqual([]);
    expect(trie.complete('a', 10)).toEqual([]);
    expect(trie.size).toBe(0);
    expect(trie.has('')).toBe(false);
    expect(trie.remove('a')).toBe(false);
    expect(trie.remove('')).toBe(false);
    expect(trie.stats().nodes).toBe(1);
    trie.checkInvariants();
  });

  it("DSA-TRIE-01 the empty string can be inserted, completed first for prefix '' and removed", () => {
    const trie = trieOf(['b', '', 'a']);
    expect(trie.size).toBe(3);
    expect(trie.has('')).toBe(true);
    expect(texts(trie.complete('', 10))).toEqual(['', 'a', 'b']);
    expect(trie.remove('')).toBe(true);
    expect(trie.has('')).toBe(false);
    expect(texts(trie.complete('', 10))).toEqual(['a', 'b']);
    expect(trie.size).toBe(2);
    trie.checkInvariants();
  });

  it('DSA-TRIE-01 one key completes for every prefix of it and not for a longer prefix', () => {
    const trie = trieOf(['hello']);
    for (let i = 0; i <= 5; i++)
      expect(trie.complete('hello'.slice(0, i), 10)).toEqual([{ text: 'hello' }]);
    expect(trie.complete('hellos', 10)).toEqual([]);
    expect(trie.complete('help', 10)).toEqual([]);
    expect(trie.complete('x', 10)).toEqual([]);
    expect(trie.has('hell')).toBe(false);
    expect(trie.stats().nodes).toBe(2);
    trie.checkInvariants();
  });

  it('DSA-TRIE-01 inserting a key twice keeps size 1 and replaces its meta', () => {
    const trie = new RadixTrie();
    trie.insert('ls', { text: 'ls', kind: 'cmd' });
    trie.insert('ls', { text: 'ls', kind: 'builtin', detail: 'list directory contents' });
    expect(trie.size).toBe(1);
    expect(trie.complete('l', 5)).toEqual([
      { text: 'ls', kind: 'builtin', detail: 'list directory contents' },
    ]);
    trie.insert('ls');
    expect(trie.complete('l', 5)).toEqual([{ text: 'ls' }]);
    // text is always the key, whatever the meta says.
    trie.insert('cat', { text: 'something else', kind: 'cmd' });
    expect(trie.complete('c', 5)).toEqual([{ text: 'cat', kind: 'cmd' }]);
    trie.checkInvariants();
  });

  it('DSA-TRIE-01 a key that is a prefix of another is returned before it (ls before lsof)', () => {
    const trie = trieOf(['lsof', 'ls', 'less', 'cd', 'cat']);
    expect(texts(trie.complete('l', 20))).toEqual(['less', 'ls', 'lsof']);
    expect(texts(trie.complete('ls', 20))).toEqual(['ls', 'lsof']);
    // The radix example of §3.5 S2: 8 nodes, root included, against 12 with one character per edge.
    expect(trie.stats().nodes).toBe(8);
    trie.checkInvariants();
  });

  it('DSA-TRIE-01 removing the shorter of two keys merges nodes and keeps the longer one', () => {
    const trie = trieOf(['ls', 'lsof']);
    expect(trie.stats().nodes).toBe(3);
    expect(trie.remove('ls')).toBe(true);
    expect(trie.stats().nodes).toBe(2); // 'ls' + 'of' merged into one 'lsof' edge
    expect(trie.has('lsof')).toBe(true);
    expect(trie.has('ls')).toBe(false);
    expect(texts(trie.complete('l', 10))).toEqual(['lsof']);
    expect(texts(trie.complete('lso', 10))).toEqual(['lsof']);
    trie.checkInvariants();
  });

  it('DSA-TRIE-01 inserting keys that diverge at every offset of a long label splits correctly', () => {
    const base = 'abcdefghij';
    const variants = Array.from({ length: base.length }, (_, j) => `${base.slice(0, j)}X`);
    for (const keys of [[base, ...variants], [...variants].reverse().concat(base)]) {
      const trie = trieOf(keys);
      expect(trie.size).toBe(keys.length);
      expect(texts(trie.complete('', 100))).toEqual([...keys].sort());
      for (const k of keys) expect(trie.has(k)).toBe(true);
      for (let j = 0; j < base.length; j++)
        expect(trie.has(base.slice(0, j + 1))).toBe(j + 1 === base.length);
      expect(trie.stats().nodes).toBeLessThanOrEqual(2 * keys.length + 1);
      trie.checkInvariants();
    }
  });

  it('DSA-TRIE-01 removing the only key returns the trie to a single root node and compaction empties the pool', () => {
    const trie = trieOf(['hello']);
    expect(trie.remove('hello')).toBe(true);
    expect(trie.size).toBe(0);
    expect(trie.stats().nodes).toBe(1);
    trie.compact();
    expect(trie.stats().poolUnits).toBe(0);
    expect(trie.stats().poolGarbage).toBe(0);
    trie.insert('again');
    expect(texts(trie.complete('', 5))).toEqual(['again']);
    trie.checkInvariants();
  });

  it("DSA-TRIE-01 removing the key under the root's first child keeps its siblings reachable", () => {
    const trie = trieOf(['apple', 'banana', 'cherry']);
    expect(trie.remove('apple')).toBe(true);
    expect(texts(trie.complete('', 10))).toEqual(['banana', 'cherry']);
    trie.checkInvariants();
    expect(trie.remove('cherry')).toBe(true);
    expect(texts(trie.complete('', 10))).toEqual(['banana']);

    // The first child is an inner node: removing 'ab' merges 'a' with its last child 'c'.
    const inner = trieOf(['ab', 'ac', 'b']);
    expect(inner.remove('ab')).toBe(true);
    expect(texts(inner.complete('', 10))).toEqual(['ac', 'b']);
    expect(inner.stats().nodes).toBe(3);
    inner.checkInvariants();
  });

  it('DSA-TRIE-01 a prefix ending inside an edge label completes the keys under that edge', () => {
    const trie = trieOf(['download', 'downtown', 'dig']);
    expect(texts(trie.complete('dow', 10))).toEqual(['download', 'downtown']);
    expect(texts(trie.complete('downl', 10))).toEqual(['download']);
    expect(texts(trie.complete('downt', 10))).toEqual(['downtown']);
    expect(trie.complete('dowx', 10)).toEqual([]);
    expect(trie.complete('downtownx', 10)).toEqual([]);
  });

  it('DSA-TRIE-01 limit 0 returns nothing and a limit above the match count returns all matches', () => {
    const trie = trieOf(['a1', 'a2', 'a3', 'b']);
    expect(trie.complete('a', 0)).toEqual([]);
    expect(texts(trie.complete('a', 100))).toEqual(['a1', 'a2', 'a3']);
    expect(texts(trie.complete('a', 2))).toEqual(['a1', 'a2']);
  });

  it('DSA-TRIE-01 a negative or non-integer limit throws RANGE', () => {
    const trie = trieOf(['a']);
    for (const limit of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expectDsaError(() => trie.complete('a', limit), 'RANGE');
    }
  });

  it('DSA-TRIE-01 completions are in UTF-16 code-unit order, including upper before lower case', () => {
    const trie = trieOf(['b', 'B', 'a', 'A', '_', 'Z', 'ab', 'aB']);
    expect(texts(trie.complete('', 20))).toEqual(['A', 'B', 'Z', '_', 'a', 'aB', 'ab', 'b']);
  });

  it('DSA-TRIE-01 keys with surrogate pairs and combining marks round-trip', () => {
    const keys = ['\u{1F600}', '\u{1F601}', 'é', 'é', 'e', '\u{1F600}x'];
    const trie = trieOf(keys);
    expect(texts(trie.complete('', 20))).toEqual([...keys].sort());
    expect(trie.has('é')).toBe(true);
    expect(trie.has('é')).toBe(true);
    // Code-unit based: a lone high surrogate is a prefix of both emoji.
    expect(texts(trie.complete('\uD83D', 20))).toEqual(['\u{1F600}', '\u{1F600}x', '\u{1F601}']);
    expect(trie.remove('\u{1F600}')).toBe(true);
    expect(texts(trie.complete('\uD83D', 20))).toEqual(['\u{1F600}x', '\u{1F601}']);
    trie.checkInvariants();
  });

  it('DSA-TRIE-01 a 4,136-code-unit key inserts, completes and removes', () => {
    const key = `${ino(7)}/${'x'.repeat(4_099)}`;
    expect(key).toHaveLength(4_136);
    const trie = trieOf([key, `${ino(7)}/y`]);
    expect(trie.has(key)).toBe(true);
    expect(texts(trie.complete(key.slice(0, 40), 5))).toEqual([key]);
    expect(texts(trie.complete(key, 5))).toEqual([key]);
    expect(trie.remove(key)).toBe(true);
    expect(trie.size).toBe(1);
    trie.checkInvariants();
  });

  it('DSA-TRIE-01 growth across node and pool doubling boundaries up to 2^17 keys keeps every key', () => {
    const n = 2 ** 17;
    const trie = new RadixTrie(1, 1);
    const keys = Array.from({ length: n }, (_, i) => `k${i.toString(36)}`);
    for (const k of keys) trie.insert(k);
    expect(trie.size).toBe(n);
    for (const k of keys) expect(trie.has(k)).toBe(true);
    expect(texts(trie.complete('k', 5))).toEqual([...keys].sort().slice(0, 5));
    expect(trie.stats().nodes).toBeLessThanOrEqual(2 * n + 1);
    trie.checkInvariants();
  });

  it('DSA-TRIE-01 insert-remove churn reuses free nodes and the node count stays bounded', () => {
    const trie = new RadixTrie(1, 1);
    let capacityAfterFirstRound = 0;
    for (let round = 0; round < 10; round++) {
      // Same shape every round: only the first character differs.
      const keys = Array.from(
        { length: 1_000 },
        (_, i) => `${String.fromCharCode(97 + round)}${i.toString(36).padStart(3, '0')}`,
      );
      for (const k of keys) trie.insert(k);
      expect(trie.stats().nodes).toBeLessThanOrEqual(2 * keys.length + 1);
      for (const k of keys) expect(trie.remove(k)).toBe(true);
      expect(trie.stats().nodes).toBe(1);
      if (round === 0) capacityAfterFirstRound = trie.stats().capacity;
      trie.checkInvariants();
    }
    expect(trie.stats().capacity).toBe(capacityAfterFirstRound);
  });

  it("DSA-TRIE-01 removePrefix of an absent prefix returns 0 and removePrefix('') clears everything", () => {
    const trie = trieOf(['apple', 'apricot', 'application', 'banana']);
    expect(trie.removePrefix('zzz')).toBe(0);
    expect(trie.removePrefix('applez')).toBe(0);
    expect(trie.size).toBe(4);
    expect(trie.removePrefix('appl')).toBe(2); // ends inside a label
    expect(texts(trie.complete('', 10))).toEqual(['apricot', 'banana']);
    trie.checkInvariants();
    expect(trie.removePrefix('')).toBe(2);
    expect(trie.size).toBe(0);
    expect(trie.complete('', 10)).toEqual([]);
    expect(trie.stats().nodes).toBe(1);
    trie.checkInvariants();
  });

  it('DSA-TRIE-02 path completions in one directory never return entries of another directory', () => {
    const ns = new NamespacedRadixTrie();
    ns.addPath(ino(1), 'readme.md', 'file');
    ns.addPath(ino(1), 'src', 'dir');
    ns.addPath(ino(2), 'report.txt', 'file');
    ns.addPath(ino(10), 'rogue', 'link'); // fixed-length inos plus '/' keep directories apart
    expect(ns.completePath(ino(1), 're', 10)).toEqual([{ text: 'readme.md', kind: 'file' }]);
    expect(ns.completePath(ino(1), '', 10)).toEqual([
      { text: 'readme.md', kind: 'file' },
      { text: 'src', kind: 'dir' },
    ]);
    expect(texts(ns.completePath(ino(2), '', 10))).toEqual(['report.txt']);
    expect(ns.completePath(ino(3), '', 10)).toEqual([]);
    expect(ns.removePath(ino(1), 'src')).toBe(true);
    expect(ns.removePath(ino(1), 'src')).toBe(false);
    expect(ns.path.size).toBe(3);
  });

  it('DSA-TRIE-02 renaming a directory with 10^4 entries costs exactly one remove and one insert', () => {
    const ns = new NamespacedRadixTrie();
    const parent = ino(1);
    const dir = ino(2);
    ns.addPath(parent, 'src', 'dir');
    for (let i = 0; i < 10_000; i++) ns.addPath(dir, `file${i}`, 'file');
    const size = ns.path.size;
    const insert = vi.spyOn(ns.path, 'insert');
    const remove = vi.spyOn(ns.path, 'remove');
    // mv src lib: the directory's own entries are keyed by its ino, which does not change.
    expect(ns.removePath(parent, 'src')).toBe(true);
    ns.addPath(parent, 'lib', 'dir');
    expect(insert).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(ns.path.size).toBe(size);
    expect(ns.completePath(parent, '', 10)).toEqual([{ text: 'lib', kind: 'dir' }]);
    expect(texts(ns.completePath(dir, 'file999', 20))).toEqual([
      'file999',
      ...Array.from({ length: 10 }, (_, i) => `file999${i}`),
    ]);
    insert.mockRestore();
    remove.mockRestore();
  });

  it("DSA-TRIE-02 history -c removes only that uid's history keys", () => {
    const ns = new NamespacedRadixTrie();
    ns.addHistory(1000, 'ls -la');
    ns.addHistory(1000, 'cat notes.md');
    ns.addHistory(1001, 'ls /tmp');
    ns.addHistory(10, 'echo ten');
    ns.addHistory(100, 'echo hundred');
    expect(ns.completeHistory(1000, 'ls', 10)).toEqual([{ text: 'ls -la', kind: 'hist' }]);
    expect(ns.clearHistory(1000)).toBe(2);
    expect(ns.completeHistory(1000, '', 10)).toEqual([]);
    expect(ns.completeHistory(1001, 'ls', 10)).toEqual([{ text: 'ls /tmp', kind: 'hist' }]);
    expect(ns.clearHistory(10)).toBe(1); // uid 10 is not a prefix match for uid 100
    expect(texts(ns.completeHistory(100, '', 10))).toEqual(['echo hundred']);
    expect(ns.clearHistory(4242)).toBe(0);
  });

  it("DSA-TRIE-02 flag completions for ls come only from ls's man-page front matter", () => {
    const ns = new NamespacedRadixTrie();
    ns.addFlag('ls', '-l', 'use a long listing format');
    ns.addFlag('ls', '-a', 'do not ignore entries starting with .');
    ns.addFlag('ls', '--all', 'same as -a');
    ns.addFlag('lsof', '-i', 'list IP sockets');
    expect(ns.completeFlag('ls', '-', 10)).toEqual([
      { text: '--all', kind: 'flag', detail: 'same as -a' },
      { text: '-a', kind: 'flag', detail: 'do not ignore entries starting with .' },
      { text: '-l', kind: 'flag', detail: 'use a long listing format' },
    ]);
    expect(texts(ns.completeFlag('lsof', '-', 10))).toEqual(['-i']);
    expect(ns.completeFlag('l', '-', 10)).toEqual([]);
    expect(ns.completeFlag('cat', '', 10)).toEqual([]);
  });

  it('DSA-TRIE-02 the cmd namespace completes command names with their kind', () => {
    const ns = new NamespacedRadixTrie();
    ns.cmd.insert('ls', { text: 'ls', kind: 'cmd' });
    ns.cmd.insert('cd', { text: 'cd', kind: 'builtin' });
    expect(ns.cmd.complete('', 10)).toEqual([
      { text: 'cd', kind: 'builtin' },
      { text: 'ls', kind: 'cmd' },
    ]);
    expect(ns.hist.size).toBe(0);
    expect(ns.flag.size).toBe(0);
  });

  it('DSA-TRIE-03 checkInvariants detects an unsorted sibling list and a non-terminal unary node', () => {
    const unsorted = trieOf(['ab', 'ac']);
    unsorted.checkInvariants();
    unsorted.debugCorrupt('unsorted-siblings');
    expect(() => unsorted.checkInvariants()).toThrow(/R3/);

    const unary = trieOf(['ls', 'lsof']);
    unary.checkInvariants();
    unary.debugCorrupt('unary-node');
    expect(() => unary.checkInvariants()).toThrow(/R1/);
  });
});
