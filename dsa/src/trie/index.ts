/**
 * S2: struct-of-arrays radix trie with namespaces (specs/08-dsa/data-structures.md §3.5 S2, §4.2,
 * §5 S2).
 *
 * Owner: R3 Shell/WM · non-owner reviewer: R4 · must be IMPLEMENTED by v0.2.0 (P2, target W5).
 * Mandatory location (Spec §10.1 trie row): terminal autocomplete over commands, paths and history
 * (§9.6, SYS-03: p95 prefix lookup ≤ 1 ms over ≥ 10,000 entries, updated incrementally). It runs
 * inside the `complete` process and is updated from VFS events with one O(L) insert or remove each.
 *
 * Radix (PATRICIA-style): every chain of single-child, non-terminal nodes is contracted into one
 * edge labelled by a string, so there are at most 2n nodes for n keys. Layout per instance (node 0
 * is the root with an empty label): `lblStart: Int32Array`, `lblLen: Uint16Array`,
 * `first: Uint16Array` (first code unit of the label), `child`/`next: Int32Array`
 * (left-child/right-sibling, −1 = none; `next` is also the free-list link), `term: Uint8Array`,
 * `meta: Int32Array` (index into `metas: Completion[]`, −1 = none) and a shared label
 * `pool: Uint16Array` with `poolLen` used and `poolGarbage` dead code units: 21 bytes per node
 * plus 2 bytes per label code unit. Siblings are kept sorted by `first`, so `complete` returns
 * lexicographic (UTF-16 code-unit) order without a sort step. Labels longer than 65,535 code units
 * are split. Compaction runs automatically when poolGarbage > poolLen / 2.
 *
 * Contract: a Completion's `text` is always the key (the namespaced wrappers strip their prefix):
 * `insert(word, meta)` stores `{ ...meta, text: word }` and without `meta` stores `{ text: word }`;
 * re-inserting replaces the meta. `limit` must be
 * an integer ≥ 0 (RANGE otherwise). `stats().nodes` counts live nodes, the root included.
 *
 * | Operation      | Complexity                                   |
 * |----------------|----------------------------------------------|
 * | insert, remove | O(L) (plus O(σ) sibling scans per level)     |
 * | has            | O(L)                                         |
 * | complete       | O(P + k) (O(σ·P + k + D), independent of n)  |
 * | removePrefix   | O(P + m) for m removed nodes                 |
 * | compact        | O(live label units); amortised O(1)          |
 *
 * Invariants checked by `checkInvariants()` (§5 S2), each failure message names its id:
 * R1 every non-root node is terminal or has ≥ 2 children; R2 every non-root node has lblLen ≥ 1
 * and first[n] === pool[lblStart[n]]; R3 siblings have strictly increasing `first`; R4 every leaf
 * is terminal; R5 size equals the number of terminal nodes; R7 free-list nodes are unreachable and
 * reachable + free = allocated; R8 poolLen − poolGarbage equals the sum of reachable label
 * lengths. (R6, the key set, is checked by the property test against its model.)
 *
 * Implementation (C16, IMPLEMENTED = true): `radix-trie.ts` holds RadixTrie (the struct-of-arrays
 * trie) and `namespaced.ts` holds NamespacedRadixTrie (the four namespaces). Both are written from
 * first principles for this project: no package, no pilot code. This file keeps the normative
 * interface and re-exports the two classes.
 */
import type { DsaStats } from '../_shared/errors.ts';

export const IMPLEMENTED = true;

/** §10.3 Completion. */
export interface Completion {
  /** Always the key (namespaced wrappers strip the prefix). */
  text: string;
  kind?: 'cmd' | 'builtin' | 'file' | 'dir' | 'link' | 'flag' | 'hist';
  /** For example a flag's description from the man page. */
  detail?: string;
}

export interface TrieStats extends DsaStats {
  /** Live nodes, the root included. */
  nodes: number;
  /** poolLen: label code units stored, dead ones included. */
  poolUnits: number;
  /** Dead label code units awaiting compaction. */
  poolGarbage: number;
}

/** §10.3 Trie: insert, remove, complete. */
export interface Trie {
  /** O(L); re-insert replaces meta. The stored completion is `{ ...meta, text: word }`. */
  insert(word: string, meta?: Completion): void;
  /** O(L); prunes and merges; false if absent. */
  remove(word: string): boolean;
  /** O(L). */
  has(word: string): boolean;
  /** O(P + k); lexicographic by UTF-16 code unit; a key comes before its extensions. */
  complete(prefix: string, limit: number): Completion[];
  /** O(P + m); returns the number of keys removed. */
  removePrefix(prefix: string): number;
  /** O(live label units); also automatic when garbage exceeds half the pool. */
  compact(): void;
  /** Number of keys. */
  readonly size: number;
  stats(): TrieStats;
  checkInvariants(): void;
}

/**
 * Deliberate corruptions for the checkInvariants tests only (never called by product code):
 * - 'unsorted-siblings': swap the first two children of the first node (in pre-order) that has at
 *   least two children (breaks R3 only);
 * - 'unary-node': clear `term` (and decrement size) on the first non-root terminal node (in
 *   pre-order) that has exactly one child, so it becomes a non-terminal unary node (breaks R1 only;
 *   the root is skipped because R1 does not apply to it).
 */
export type TrieCorruption = 'unsorted-siblings' | 'unary-node';

export { RadixTrie } from './radix-trie.ts';

export type Namespace = 'cmd' | 'path' | 'flag' | 'hist';

/**
 * The four completion namespaces (§3.5 S2, DSA-TRIE-02). Keys: `cmd` the command name; `path`
 * `${dirIno}/${basename}` (dirIno = the 36-char UUIDv7 of the containing directory, so renaming or
 * moving a directory is one remove plus one insert); `flag` `${cmd}\u0000${flag}`; `hist`
 * `${uid}\u0000${line}`. Completions returned by the helpers carry the stripped text (basename,
 * flag or line). `addPath` is exactly one `path.insert` and `removePath` one `path.remove` (the
 * incremental VFS update of §5 S2: a rename is one remove plus one insert).
 */
export interface NamespacedTrie {
  readonly cmd: Trie;
  readonly path: Trie;
  readonly flag: Trie;
  readonly hist: Trie;
  /** Key `${dirIno}/${basename}`, kind 'file' | 'dir' | 'link'. */
  addPath(dirIno: string, basename: string, kind: 'file' | 'dir' | 'link'): void;
  removePath(dirIno: string, basename: string): boolean;
  /** Returns basenames. */
  completePath(dirIno: string, prefix: string, limit: number): Completion[];
  /** Key `${cmd}\u0000${flag}`, kind 'flag'. */
  addFlag(cmd: string, flag: string, detail?: string): void;
  completeFlag(cmd: string, prefix: string, limit: number): Completion[];
  /** Key `${uid}\u0000${line}`, kind 'hist'. */
  addHistory(uid: number, line: string): void;
  completeHistory(uid: number, prefix: string, limit: number): Completion[];
  /** `history -c`: removePrefix(`${uid}\u0000`); returns keys removed. */
  clearHistory(uid: number): number;
}

export { NamespacedRadixTrie } from './namespaced.ts';
