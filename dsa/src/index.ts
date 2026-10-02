/**
 * @plotinium/dsa: the team-written data structures (specs/08-dsa/data-structures.md; C16).
 *
 * Each structure is also importable on its own as `@plotinium/dsa/<name>`, which is how consumers
 * gate their tests on its flag: `import { IMPLEMENTED as HEAP_READY } from '@plotinium/dsa/heap'`.
 * Here every module's flag is re-exported under a distinct name, and STRUCTURES lists them with
 * their owners and the release tag at which the flag must be true (§3.2, §3.3).
 *
 * Every structure is written by its owner from first principles (Spec §10.2): no npm package and
 * no pilot code may stand in for one, even temporarily (§3.1).
 */
import type { OwnerRole } from './_shared/errors.ts';
import { IMPLEMENTED as BLOOM_IMPLEMENTED } from './bloom/index.ts';
import { IMPLEMENTED as DAG_IMPLEMENTED } from './dag/index.ts';
import { IMPLEMENTED as HASHTABLE_IMPLEMENTED } from './hashtable/index.ts';
import { IMPLEMENTED as HEAP_IMPLEMENTED } from './heap/index.ts';
import { IMPLEMENTED as LRU_IMPLEMENTED } from './lru/index.ts';
import { IMPLEMENTED as RINGBUFFER_IMPLEMENTED } from './ringbuffer/index.ts';
import { IMPLEMENTED as TREE_IMPLEMENTED } from './tree/index.ts';
import { IMPLEMENTED as TRIE_IMPLEMENTED } from './trie/index.ts';
import { IMPLEMENTED as ZORDER_IMPLEMENTED } from './zorder/index.ts';

export const PACKAGE_NAME = '@plotinium/dsa';

export { DsaError, NotImplementedError } from './_shared/errors.ts';
export type { DsaErrorCode, DsaStats, OwnerRole } from './_shared/errors.ts';
export { mulberry32, randomInt } from './_shared/prng.ts';
export { percentile, sampleOps } from './_shared/sampler.ts';
export type { SampleOptions, SampleResult } from './_shared/sampler.ts';

// S1 tree (R2)
export { createTree } from './tree/index.ts';
export type { DirNode, NaryTree, ResolveResult, TreeNode, WalkEntry } from './tree/index.ts';
// S2 trie (R3)
export { NamespacedRadixTrie, RadixTrie } from './trie/index.ts';
export type {
  Completion,
  Namespace,
  NamespacedTrie,
  Trie,
  TrieCorruption,
  TrieStats,
} from './trie/index.ts';
// S3 heap (R1)
export { BinaryHeap, BoundedTopKHeap, HeapPriorityQueue } from './heap/index.ts';
export type { BoundedTopK, HeapCorruption, IndexedMinHeap, PriorityQueue } from './heap/index.ts';
// S4 DAG (R5)
export { buildDag, CycleError, topoLevels, UnknownNodeError } from './dag/index.ts';
export type { Dag, DagNode, KahnCursor } from './dag/index.ts';
// S5 LRU (R1)
export { LruCache } from './lru/index.ts';
export type { LRU, LruCorruption, LruOptions } from './lru/index.ts';
// S6 hash table (R1)
export { OpenAddressingTable } from './hashtable/index.ts';
export type {
  HashCorruption,
  IntHashTable,
  PidTable,
  ProbeStats,
  WindowRegistry,
} from './hashtable/index.ts';
// S7 ring buffer (R5)
export { ByteRingBuffer, Float64Ring, RingBuffer } from './ringbuffer/index.ts';
export type { ByteRing, Ring, RingMode } from './ringbuffer/index.ts';
// S8 Bloom filter (R4)
export { DoubleHashBloom } from './bloom/index.ts';
export type { BloomFilter, BloomOptions } from './bloom/index.ts';
// S9 z-order list (R3)
export { LinkedZOrder } from './zorder/index.ts';
export type { ZChange, ZOrderList } from './zorder/index.ts';

export {
  BLOOM_IMPLEMENTED,
  DAG_IMPLEMENTED,
  HASHTABLE_IMPLEMENTED,
  HEAP_IMPLEMENTED,
  LRU_IMPLEMENTED,
  RINGBUFFER_IMPLEMENTED,
  TREE_IMPLEMENTED,
  TRIE_IMPLEMENTED,
  ZORDER_IMPLEMENTED,
};

export interface StructureInfo {
  /** Structure number of the spec (§3.3). */
  readonly id: `S${number}`;
  /** Module folder under src/, and the `@plotinium/dsa/<name>` subpath. */
  readonly name: string;
  readonly owner: OwnerRole;
  readonly reviewer: OwnerRole;
  readonly implemented: boolean;
  /** Release tag at which the flag must be true (§3.2 gate check). */
  readonly dueTag: 'v0.2.0' | 'v0.3.0' | 'v0.4.0';
}

/** The nine structures of §3.3 in spec order, with their flags (§3.2). */
export const STRUCTURES: readonly StructureInfo[] = [
  {
    id: 'S1',
    name: 'tree',
    owner: 'R2',
    reviewer: 'R1',
    implemented: TREE_IMPLEMENTED,
    dueTag: 'v0.2.0',
  },
  {
    id: 'S2',
    name: 'trie',
    owner: 'R3',
    reviewer: 'R4',
    implemented: TRIE_IMPLEMENTED,
    dueTag: 'v0.2.0',
  },
  {
    id: 'S3',
    name: 'heap',
    owner: 'R1',
    reviewer: 'R3',
    implemented: HEAP_IMPLEMENTED,
    dueTag: 'v0.2.0',
  },
  {
    id: 'S4',
    name: 'dag',
    owner: 'R5',
    reviewer: 'R2',
    implemented: DAG_IMPLEMENTED,
    dueTag: 'v0.2.0',
  },
  {
    id: 'S5',
    name: 'lru',
    owner: 'R1',
    reviewer: 'R5',
    implemented: LRU_IMPLEMENTED,
    dueTag: 'v0.3.0',
  },
  {
    id: 'S6',
    name: 'hashtable',
    owner: 'R1',
    reviewer: 'R3',
    implemented: HASHTABLE_IMPLEMENTED,
    dueTag: 'v0.2.0',
  },
  {
    id: 'S7',
    name: 'ringbuffer',
    owner: 'R5',
    reviewer: 'R1',
    implemented: RINGBUFFER_IMPLEMENTED,
    dueTag: 'v0.2.0',
  },
  {
    id: 'S8',
    name: 'bloom',
    owner: 'R4',
    reviewer: 'R2',
    implemented: BLOOM_IMPLEMENTED,
    dueTag: 'v0.4.0',
  },
  {
    id: 'S9',
    name: 'zorder',
    owner: 'R3',
    reviewer: 'R5',
    implemented: ZORDER_IMPLEMENTED,
    dueTag: 'v0.2.0',
  },
];
