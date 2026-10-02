/**
 * S2 RadixTrie: a struct-of-arrays radix (PATRICIA-style) trie
 * (specs/08-dsa/data-structures.md §3.5 S2 layout, §4.2 interface, §5 S2 algorithms and proofs).
 *
 * THE SHAPE. Every chain of single-child, non-terminal nodes is contracted into one edge labelled
 * by a string, so every non-root node is terminal or has ≥ 2 children (R1). A rooted tree with
 * that property and n terminal nodes has at most 2n − 1 non-root nodes: ≤ 2n nodes with the root.
 *
 * THE LAYOUT. A node is an index into seven parallel typed arrays (struct of arrays, no object per
 * node). Node 0 is the root and has an empty label.
 *
 *   lblStart Int32Array   where the node's edge label starts in `pool`
 *   lblLen   Uint16Array  label length in UTF-16 code units (so a label holds ≤ 65,535 units)
 *   first    Uint16Array  the label's first code unit (lets a sibling scan skip `pool`)
 *   child    Int32Array   first child, −1 = none        (left-child/right-sibling tree)
 *   next     Int32Array   next sibling, −1 = none; for a free node, the next free node
 *   term     Uint8Array   1 when a key ends at this node
 *   meta     Int32Array   slot in `metas` (kind/detail of the key), −1 = none
 *
 * That is 4 + 2 + 2 + 4 + 4 + 1 + 4 = 21 bytes per node, plus 2 bytes per label code unit in the
 * shared `pool: Uint16Array`. Siblings are kept sorted by `first`; siblings of a radix trie have
 * distinct first code units, so sibling order IS lexicographic (code-unit) order and `complete`
 * returns sorted results with no sort step.
 *
 * THE POOL. Labels are ranges of one Uint16Array. `poolLen` units are handed out; `poolGarbage` of
 * them belong to no live node (a freed leaf, or a label copied elsewhere by a merge). The ranges of
 * live nodes never overlap, so poolLen − poolGarbage = Σ live label lengths (R8). A split never
 * copies (the two halves keep the same storage); a merge copies only when the two labels are not
 * adjacent in the pool. When garbage exceeds half the pool, `compact()` copies the live labels into
 * a fresh pool: O(live units), amortised O(1) per unit of garbage.
 *
 * Long labels. A label longer than 65,535 units cannot be stored in one node, so a new key suffix
 * that long becomes a chain of full-length nodes. Such a chain node is unary and non-terminal, the
 * one shape R1 otherwise forbids, so R1 exempts exactly the unary nodes that cannot be merged with
 * their only child: lblLen[n] + lblLen[child] > 65,535. Keys in Plotinium are ≤ 4,096 + 37 units,
 * so this never happens in practice; the code handles it so no input can break the structure.
 *
 * No recursion anywhere: walks use explicit stacks, so a 4,096-unit key cannot overflow the stack.
 */
import { DsaError } from '../_shared/errors.ts';
import type { Completion, Trie, TrieCorruption, TrieStats } from './index.ts';

// Reads from typed arrays carry `!` because the repository compiles with noUncheckedIndexedAccess.
// Every index used is a live node id below `allocated` or an offset below `poolLen`;
// checkInvariants() verifies exactly that (R2, R7).

/** The root node id; its label is empty and it has no siblings. */
const ROOT = 0;
/** "No node" in child/next/meta. */
const NONE = -1;
/** lblLen is a Uint16Array, so one label holds at most 65,535 code units. */
const MAX_LABEL = 0xffff;
/** Bytes per node over the seven parallel arrays: 4 + 2 + 2 + 4 + 4 + 1 + 4. */
const NODE_BYTES = 21;
/** Bytes per scratch slot: pathNode, pathPrev, walkNode, walkBase (Int32) and buf (Uint16). */
const SCRATCH_BYTES = 4 * 4 + 2;
/** Code units converted per String.fromCharCode call, to keep the argument list short. */
const STRING_CHUNK = 4_096;
/** Keys the scratch arrays hold before the first longer key grows them (64 slots). */
const INITIAL_SCRATCH_KEY_UNITS = 62;

/** What is stored per key: the Completion without `text`, because the path spells the key. */
type KeyMeta = Omit<Completion, 'text'>;

/** A copy of `meta` without `text`, or undefined when nothing else is left to store. */
function metaWithoutText(meta: Completion): KeyMeta | undefined {
  const { text: _text, ...rest } = meta;
  return Object.keys(rest).length === 0 ? undefined : rest;
}

/**
 * units[from, to) as a string; lone surrogates are kept as they are (TextDecoder would replace
 * them). `apply` accepts any array-like (ECMA-262 CreateListFromArrayLike); the cast only tells
 * TypeScript so. It is about 6x faster than spreading the typed array.
 */
function unitsToString(units: Uint16Array, from: number, to: number): string {
  if (to - from <= STRING_CHUNK) {
    return String.fromCharCode.apply(null, units.subarray(from, to) as unknown as number[]);
  }
  let out = '';
  for (let a = from; a < to; a += STRING_CHUNK) {
    const chunk = units.subarray(a, Math.min(to, a + STRING_CHUNK));
    out += String.fromCharCode.apply(null, chunk as unknown as number[]);
  }
  return out;
}

function growInt32(old: Int32Array, capacity: number): Int32Array {
  const out = new Int32Array(capacity);
  out.set(old);
  return out;
}

function growUint16(old: Uint16Array, capacity: number): Uint16Array {
  const out = new Uint16Array(capacity);
  out.set(old);
  return out;
}

function growUint8(old: Uint8Array, capacity: number): Uint8Array {
  const out = new Uint8Array(capacity);
  out.set(old);
  return out;
}

export class RadixTrie implements Trie {
  // ---- Node arrays (struct of arrays), indexed by node id. ----
  private lblStart: Int32Array;
  private lblLen: Uint16Array;
  private first: Uint16Array;
  private child: Int32Array;
  private next: Int32Array;
  private term: Uint8Array;
  private meta: Int32Array;

  // ---- Label pool. ----
  private pool: Uint16Array;
  /** Code units handed out (live and dead). */
  private poolLen = 0;
  /** Dead code units among the first `poolLen`. */
  private poolGarbage = 0;
  /** The constructor's pool capacity: compaction never shrinks the pool below it. */
  private readonly minPoolUnits: number;

  // ---- Key metadata side table: `meta[n]` is a slot here; freed slots are reused. ----
  private readonly metas: (KeyMeta | undefined)[] = [];
  private readonly freeMetas: number[] = [];

  // ---- Node bookkeeping. ----
  /** High-water mark: node ids [0, allocated) have been handed out at least once. */
  private allocated = 1;
  /** Reachable nodes, the root included. */
  private liveNodes = 1;
  /** Head of the free list of node ids, linked through `next`. */
  private freeHead = NONE;
  /** Number of keys (terminal nodes). */
  private keyCount = 0;

  // ---- Scratch arrays, reused by every call (never shrink). ----
  /**
   * The longest key ever inserted. A node at depth d spells ≥ d code units of some key (labels are
   * non-empty and every subtree holds a key), so every path, walk stack and spelled string below
   * fits in `maxKeyLen + 2` slots. insert() grows the scratch arrays; nothing else needs to.
   */
  private maxKeyLen = 0;
  private scratchCap = 0;
  /** descend(): the node at each depth of the path, and its previous sibling (−1 if first). */
  private pathNode: Int32Array;
  private pathPrev: Int32Array;
  /** complete(): per depth, the next node to visit and the spelled length before its label. */
  private walkNode: Int32Array;
  private walkBase: Int32Array;
  /** complete(): the code units spelled from the root to the visited node. */
  private buf: Uint16Array;

  /** Initial node and pool capacities; both grow by doubling. */
  constructor(initialNodes = 64, initialPoolUnits = 512) {
    if (!Number.isInteger(initialNodes) || initialNodes < 0) {
      throw new DsaError(
        'RANGE',
        `trie: initialNodes must be an integer >= 0, got ${String(initialNodes)}`,
      );
    }
    if (!Number.isInteger(initialPoolUnits) || initialPoolUnits < 0) {
      throw new DsaError(
        'RANGE',
        `trie: initialPoolUnits must be an integer >= 0, got ${String(initialPoolUnits)}`,
      );
    }
    const nodes = Math.max(1, initialNodes); // room for the root at least
    this.lblStart = new Int32Array(nodes);
    this.lblLen = new Uint16Array(nodes);
    this.first = new Uint16Array(nodes);
    this.child = new Int32Array(nodes);
    this.next = new Int32Array(nodes);
    this.term = new Uint8Array(nodes);
    this.meta = new Int32Array(nodes);
    this.pool = new Uint16Array(initialPoolUnits);
    this.minPoolUnits = initialPoolUnits;
    // The root: empty label, no children, not a key.
    this.child[ROOT] = NONE;
    this.next[ROOT] = NONE;
    this.meta[ROOT] = NONE;
    this.pathNode = new Int32Array(0);
    this.pathPrev = new Int32Array(0);
    this.walkNode = new Int32Array(0);
    this.walkBase = new Int32Array(0);
    this.buf = new Uint16Array(0);
    this.reserveScratch(INITIAL_SCRATCH_KEY_UNITS);
  }

  get size(): number {
    return this.keyCount;
  }

  // ===================================================================================== insert

  /**
   * O(L) code-unit comparisons plus an O(σ) sibling scan per level (§5 S2 "Insert"). Three cases:
   * (a) the word ends exactly at a node: mark it terminal; (b) the word leaves or ends inside an
   * edge label: split the edge; (c) no edge starts with the next code unit: add a leaf.
   */
  insert(word: string, meta?: Completion): void {
    const len = word.length;
    if (len > this.maxKeyLen) {
      this.maxKeyLen = len;
      this.reserveScratch(len);
    }
    let node = ROOT;
    let i = 0; // code units of `word` spelled by the path root → node
    for (;;) {
      // (a) The whole word is spelled by the path to `node`.
      if (i === len) {
        this.markKey(node, meta);
        return;
      }
      const cu = word.charCodeAt(i);
      // Find the child whose label starts with cu. Siblings are sorted by `first`, so the scan
      // stops at the first larger one; `prev` ends as the sibling after which cu belongs.
      let prev = NONE;
      let c = this.child[node]!;
      while (c !== NONE && this.first[c]! < cu) {
        prev = c;
        c = this.next[c]!;
      }
      if (c === NONE || this.first[c] !== cu) {
        // (c) No edge starts with cu: the rest of the word becomes a new leaf, linked between
        // `prev` and `c` so the sibling list stays sorted.
        const leaf = this.newLeaf(word, i, meta);
        this.next[leaf] = c;
        if (prev === NONE) this.child[node] = leaf;
        else this.next[prev] = leaf;
        return;
      }
      // Compare c's label with the word; the first unit already matched.
      const start = this.lblStart[c]!;
      const labelLen = this.lblLen[c]!;
      const max = Math.min(labelLen, len - i);
      const pool = this.pool;
      let j = 1;
      while (j < max && pool[start + j] === word.charCodeAt(i + j)) j++;
      if (j === labelLen) {
        // The whole label matched: continue below c.
        node = c;
        i += labelLen;
        continue;
      }
      // (b) Split c's edge after j units. `mid` takes the first j units (the same pool storage,
      // no copy), replaces c in the sibling list, and c (keeping its subtree) becomes mid's child.
      const mid = this.allocNode();
      this.lblStart[mid] = start;
      this.lblLen[mid] = j;
      this.first[mid] = this.first[c]!;
      this.next[mid] = this.next[c]!;
      this.child[mid] = c;
      if (prev === NONE) this.child[node] = mid;
      else this.next[prev] = mid;
      this.lblStart[c] = start + j;
      this.lblLen[c] = labelLen - j;
      this.first[c] = this.pool[start + j]!;
      this.next[c] = NONE;
      if (i + j === len) {
        // The word ended inside the label: mid itself is the key.
        this.markKey(mid, meta);
      } else {
        // Mismatch at j: the rest of the word hangs under mid next to c, in first-unit order.
        const leaf = this.newLeaf(word, i + j, meta);
        if (this.first[leaf]! < this.first[c]!) {
          this.child[mid] = leaf;
          this.next[leaf] = c;
        } else {
          this.next[c] = leaf;
        }
      }
      // Only a long-label chain node (see the file header) can need a merge after a split: c's
      // label got shorter, and node's only child changed from c to the shorter mid.
      this.mergeIfUnary(c);
      this.mergeIfUnary(node);
      this.maybeCompact();
      return;
    }
  }

  // ===================================================================================== remove

  /** O(L): descend with the path recorded, clear the key, prune empty branches and merge. */
  remove(word: string): boolean {
    const depth = this.descend(word, false);
    if (depth < 0) return false;
    const node = this.pathNode[depth]!;
    if (this.term[node] === 0) return false;
    this.term[node] = 0;
    this.dropMeta(node);
    this.keyCount--;
    this.pruneFrom(depth);
    this.maybeCompact();
    return true;
  }

  /** O(L): one descent. */
  has(word: string): boolean {
    const depth = this.descend(word, false);
    return depth >= 0 && this.term[this.pathNode[depth]!] === 1;
  }

  /**
   * O(P + m) for m removed nodes: find the locus of `prefix` (it may end inside a label), unlink
   * its subtree, free it with an explicit stack, then prune and merge above it like remove().
   */
  removePrefix(prefix: string): number {
    const depth = this.descend(prefix, true);
    if (depth < 0) return 0;
    let removed = 0;
    if (depth === 0) {
      // prefix '' matches every key: free every subtree of the root; the root itself stays.
      if (this.term[ROOT] === 1) {
        this.term[ROOT] = 0;
        this.dropMeta(ROOT);
        removed++;
      }
      let c = this.child[ROOT]!;
      this.child[ROOT] = NONE;
      while (c !== NONE) {
        const sibling = this.next[c]!; // read before c is freed (next becomes the free-list link)
        removed += this.freeSubtree(c);
        c = sibling;
      }
    } else {
      const locus = this.pathNode[depth]!;
      this.unlink(this.pathNode[depth - 1]!, this.pathPrev[depth]!, locus);
      removed = this.freeSubtree(locus);
      this.pruneFrom(depth - 1);
    }
    this.keyCount -= removed;
    this.maybeCompact();
    return removed;
  }

  // =================================================================================== complete

  /**
   * O(σ·P + k + D) node visits (§5 S2), independent of n. (1) Find the locus of the prefix: the
   * highest node whose spelled string starts with it. (2) Pre-order DFS below it in sibling order,
   * which is lexicographic order, emitting at terminal nodes and stopping after `limit`.
   */
  complete(prefix: string, limit: number): Completion[] {
    if (!Number.isInteger(limit) || limit < 0) {
      throw new DsaError(
        'RANGE',
        `trie.complete: limit must be an integer >= 0, got ${String(limit)}`,
      );
    }
    const out: Completion[] = [];
    if (limit === 0) return out;
    const lblStart = this.lblStart;
    const lblLen = this.lblLen;
    const first = this.first;
    const child = this.child;
    const next = this.next;
    const term = this.term;
    const pool = this.pool;
    const buf = this.buf;

    // (1) Locate. `start` is where the locus label begins in the spelled string, `i` where it ends.
    const plen = prefix.length;
    let node = ROOT;
    let start = 0;
    let i = 0;
    while (i < plen) {
      const cu = prefix.charCodeAt(i);
      let c = child[node]!;
      while (c !== NONE && first[c]! < cu) c = next[c]!;
      if (c === NONE || first[c] !== cu) return out;
      const s = lblStart[c]!;
      const m = Math.min(lblLen[c]!, plen - i);
      for (let j = 1; j < m; j++) if (pool[s + j] !== prefix.charCodeAt(i + j)) return out;
      node = c;
      start = i;
      i += lblLen[c]!; // may pass plen: the prefix ends inside this label (a partial locus)
    }
    // Every result starts with `prefix`, so a result's text is `prefix` + buf[plen, end): only
    // the units after the prefix are ever converted, and buf[0, plen) is never read. Copy the
    // locus label to buf[start, i); for a partial locus its tail is what extends the prefix.
    const ls = lblStart[node]!;
    for (let j = start; j < i; j++) buf[j] = pool[ls + j - start]!;
    if (term[node] === 1) {
      out.push(this.emit(node, prefix, i));
      if (out.length === limit) return out;
    }

    // (2) Pre-order DFS over the left-child/right-sibling tree. One stack entry per depth:
    // walkNode[d] is the next node to visit at depth d, walkBase[d] the spelled length before its
    // label. Visiting n replaces n by its next sibling, then descends into n's first child.
    const walkNode = this.walkNode;
    const walkBase = this.walkBase;
    let top = 0;
    walkNode[0] = child[node]!;
    walkBase[0] = i;
    while (top >= 0) {
      const n = walkNode[top]!;
      if (n === NONE) {
        top--; // this sibling list is exhausted
        continue;
      }
      walkNode[top] = next[n]!;
      const base = walkBase[top]!;
      const s = lblStart[n]!;
      const end = base + lblLen[n]!;
      for (let j = base; j < end; j++) buf[j] = pool[s + j - base]!; // labels are short: no subarray
      if (term[n] === 1) {
        out.push(this.emit(n, prefix, end));
        if (out.length === limit) break;
      }
      const c = child[n]!;
      if (c !== NONE) {
        top++;
        walkNode[top] = c;
        walkBase[top] = end;
      }
    }
    return out;
  }

  // ==================================================================================== compact

  /**
   * O(live label units): copy every reachable label into a fresh pool by an iterative pre-order
   * DFS (so labels end up in walk order, which also helps `complete`). The new pool holds twice
   * the live units (never less than the constructor's capacity, never more than the old pool).
   */
  compact(): void {
    const live = this.poolLen - this.poolGarbage;
    const capacity = Math.min(this.pool.length, Math.max(this.minPoolUnits, 2 * live));
    const pool = new Uint16Array(capacity);
    let used = 0;
    const stack: number[] = [];
    if (this.child[ROOT] !== NONE) stack.push(this.child[ROOT]!);
    while (stack.length > 0) {
      const n = stack.pop()!;
      const s = this.lblStart[n]!;
      const len = this.lblLen[n]!;
      pool.set(this.pool.subarray(s, s + len), used);
      this.lblStart[n] = used;
      used += len;
      // Push the sibling first so the child is visited first (pre-order).
      if (this.next[n] !== NONE) stack.push(this.next[n]!);
      if (this.child[n] !== NONE) stack.push(this.child[n]!);
    }
    this.pool = pool;
    this.poolLen = used;
    this.poolGarbage = 0;
  }

  // ====================================================================== stats and invariants

  stats(): TrieStats {
    const nodeCapacity = this.child.length;
    return {
      size: this.keyCount,
      // Node slots: a key needs at most two (the 2n bound), so this bounds growth-free inserts.
      capacity: nodeCapacity,
      // Typed arrays only; the `metas` side table holds JS objects (the measured bytes cover it).
      bytesAllocated:
        nodeCapacity * NODE_BYTES + this.pool.length * 2 + this.scratchCap * SCRATCH_BYTES,
      bytesUsed: this.liveNodes * NODE_BYTES + this.poolLen * 2,
      nodes: this.liveNodes,
      poolUnits: this.poolLen,
      poolGarbage: this.poolGarbage,
    };
  }

  /** O(allocated nodes): checks R1–R5, R7 and R8 of §5 S2 (R6 is the property test's job). */
  checkInvariants(): void {
    const fail = (id: string, message: string): never => {
      throw new DsaError('INVALID', `dsa/trie ${id}: ${message}`);
    };
    const allocated = this.allocated;
    const seen = new Uint8Array(allocated);
    seen[ROOT] = 1;
    if (this.lblLen[ROOT] !== 0) fail('R2', 'the root label must be empty');
    if (this.next[ROOT] !== NONE) fail('R7', 'the root must have no siblings');
    let reachable = 1;
    let terminals = this.term[ROOT] === 1 ? 1 : 0;
    let labelUnits = 0;
    const stack: number[] = [ROOT];
    while (stack.length > 0) {
      const n = stack.pop()!;
      let children = 0;
      let previousFirst = -1;
      for (let c = this.child[n]!; c !== NONE; c = this.next[c]!) {
        if (c < 0 || c >= allocated) fail('R7', `node ${n} links to node ${c}, never allocated`);
        if (seen[c] === 1) fail('R7', `node ${c} is reachable twice (a cycle or a shared child)`);
        seen[c] = 1;
        reachable++;
        children++;
        const s = this.lblStart[c]!;
        const len = this.lblLen[c]!;
        if (len < 1) fail('R2', `node ${c} has an empty label`);
        if (s < 0 || s + len > this.poolLen)
          fail('R2', `node ${c} label [${s}, ${s + len}) lies outside the pool`);
        if (this.first[c] !== this.pool[s]) {
          fail('R2', `node ${c}: first ${this.first[c]!} != pool[lblStart] ${this.pool[s]!}`);
        }
        if (this.first[c]! <= previousFirst) {
          fail('R3', `children of node ${n} are not in strictly increasing first-unit order`);
        }
        previousFirst = this.first[c]!;
        labelUnits += len;
        if (this.term[c] === 1) terminals++;
        stack.push(c);
      }
      const slot = this.meta[n]!;
      if (slot !== NONE && (this.term[n] === 0 || this.metas[slot] === undefined)) {
        fail('R5', `node ${n} carries meta slot ${slot} but is not a key`);
      }
      if (n === ROOT) continue;
      if (children === 0 && this.term[n] === 0) fail('R4', `leaf ${n} is not terminal`);
      if (children === 1 && this.term[n] === 0) {
        const only = this.child[n]!;
        // Unary non-terminal nodes are allowed only where a merge would overflow a label (long keys).
        if (this.lblLen[n]! + this.lblLen[only]! <= MAX_LABEL) {
          fail('R1', `node ${n} is non-terminal with a single child (it should have been merged)`);
        }
      }
    }
    if (terminals !== this.keyCount)
      fail('R5', `size is ${this.keyCount} but ${terminals} nodes are terminal`);
    if (reachable !== this.liveNodes)
      fail('R7', `${reachable} nodes are reachable but ${this.liveNodes} are live`);
    let free = 0;
    for (let f = this.freeHead; f !== NONE; f = this.next[f]!) {
      if (f < 0 || f >= allocated) fail('R7', `free list holds node ${f}, never allocated`);
      if (seen[f] === 1)
        fail('R7', `node ${f} is on the free list but reachable (or listed twice)`);
      seen[f] = 1;
      free++;
    }
    if (reachable + free !== allocated) {
      fail('R7', `reachable ${reachable} + free ${free} != allocated ${allocated}`);
    }
    if (this.poolGarbage < 0 || this.poolLen > this.pool.length)
      fail('R8', 'pool counters out of range');
    if (this.poolLen - this.poolGarbage !== labelUnits) {
      fail(
        'R8',
        `poolLen ${this.poolLen} - poolGarbage ${this.poolGarbage} != live label units ${labelUnits}`,
      );
    }
  }

  /** Test-only: see TrieCorruption. Never called by product code. */
  debugCorrupt(kind: TrieCorruption): void {
    const stack: number[] = [ROOT];
    while (stack.length > 0) {
      const n = stack.pop()!;
      const c1 = this.child[n]!;
      const hasOneChild = c1 !== NONE && this.next[c1] === NONE;
      if (kind === 'unsorted-siblings' && c1 !== NONE && !hasOneChild) {
        // Swap the first two children: c2 now comes before c1 (breaks R3 only).
        const c2 = this.next[c1]!;
        this.next[c1] = this.next[c2]!;
        this.next[c2] = c1;
        this.child[n] = c2;
        return;
      }
      // The root is skipped: R1 does not apply to it, so clearing it would break nothing.
      if (kind === 'unary-node' && n !== ROOT && this.term[n] === 1 && hasOneChild) {
        this.term[n] = 0;
        this.dropMeta(n);
        this.keyCount--;
        return;
      }
      // Push the children in reverse so they are popped in sibling order (pre-order).
      const children: number[] = [];
      for (let c = c1; c !== NONE; c = this.next[c]!) children.push(c);
      for (let k = children.length - 1; k >= 0; k--) stack.push(children[k]!);
    }
    throw new DsaError('NOT_FOUND', `dsa/trie: no node qualifies for the '${kind}' corruption`);
  }

  // ============================================================================ private helpers

  /**
   * Walk down from the root along `key`, recording pathNode[d] (the node at depth d) and
   * pathPrev[d] (its previous sibling). Returns the depth of the node that spells `key`, or −1.
   * With `partial`, the key may also end inside the last label (the prefix locus).
   */
  private descend(key: string, partial: boolean): number {
    const len = key.length;
    const lblStart = this.lblStart;
    const lblLen = this.lblLen;
    const first = this.first;
    const child = this.child;
    const next = this.next;
    const pool = this.pool;
    const pathNode = this.pathNode;
    const pathPrev = this.pathPrev;
    pathNode[0] = ROOT;
    pathPrev[0] = NONE;
    let depth = 0;
    let node = ROOT;
    let i = 0;
    while (i < len) {
      const cu = key.charCodeAt(i);
      let prev = NONE;
      let c = child[node]!;
      while (c !== NONE && first[c]! < cu) {
        prev = c;
        c = next[c]!;
      }
      if (c === NONE || first[c] !== cu) return -1;
      const s = lblStart[c]!;
      const labelLen = lblLen[c]!;
      const rest = len - i;
      if (rest < labelLen && !partial) return -1; // the key ends inside a label: not a node
      const m = Math.min(labelLen, rest);
      for (let j = 1; j < m; j++) if (pool[s + j] !== key.charCodeAt(i + j)) return -1;
      // depth ≤ maxKeyLen (see `maxKeyLen`), so the scratch arrays always have room.
      depth++;
      pathNode[depth] = c;
      pathPrev[depth] = prev;
      node = c;
      i += labelLen;
    }
    return depth;
  }

  /**
   * After a key or a subtree left pathNode[depth]: free every non-terminal node that is left
   * childless, walking up (only a long-label chain can make this loop run more than once), then
   * merge the first surviving ancestor with its only child if it has become unary (§5 S2 step 4).
   */
  private pruneFrom(depth: number): void {
    let d = depth;
    let node = this.pathNode[d]!;
    while (d > 0 && this.term[node] === 0 && this.child[node] === NONE) {
      const parent = this.pathNode[d - 1]!;
      this.unlink(parent, this.pathPrev[d]!, node);
      this.freeNode(node, true);
      d--;
      node = parent;
    }
    this.mergeIfUnary(node);
  }

  /**
   * Merge a non-root, non-terminal node with its only child (R1): n absorbs c's label, children,
   * terminal flag and meta, and c is freed. n keeps its place in its parent's sibling list and its
   * first unit, so nothing above it changes. No cascade: the merged n is terminal, branches, or
   * sits above a long-label chain node that still cannot merge.
   */
  private mergeIfUnary(n: number): void {
    if (n === ROOT || this.term[n] === 1) return;
    const c = this.child[n]!;
    if (c === NONE || this.next[c] !== NONE) return;
    if (this.lblLen[n]! + this.lblLen[c]! > MAX_LABEL) return; // long-label chain link: R1 exempts it
    this.concatLabels(n, c);
    this.child[n] = this.child[c]!;
    this.term[n] = this.term[c]!;
    this.meta[n] = this.meta[c]!; // the meta slot moves to n
    this.meta[c] = NONE;
    this.term[c] = 0;
    this.freeNode(c, false); // c's label units now belong to n (or were counted as garbage)
  }

  /** n's label becomes n's label followed by c's label. */
  private concatLabels(n: number, c: number): void {
    const sn = this.lblStart[n]!;
    const ln = this.lblLen[n]!;
    const sc = this.lblStart[c]!;
    const lc = this.lblLen[c]!;
    if (sn + ln === sc) {
      // Adjacent in the pool (always the case right after a split): extend in place, no copy.
    } else if (sn + ln === this.poolLen) {
      // n's label ends the pool: append c's units right after it; c's old copy is dead.
      this.reservePool(lc);
      this.pool.copyWithin(this.poolLen, sc, sc + lc);
      this.poolLen += lc;
      this.poolGarbage += lc;
    } else {
      // Append the concatenation; both old copies are dead.
      this.reservePool(ln + lc);
      const dst = this.poolLen;
      this.pool.copyWithin(dst, sn, sn + ln);
      this.pool.copyWithin(dst + ln, sc, sc + lc);
      this.poolLen = dst + ln + lc;
      this.poolGarbage += ln + lc;
      this.lblStart[n] = dst;
    }
    this.lblLen[n] = ln + lc;
  }

  /** Remove n from its parent's sibling list; `prev` is n's previous sibling or −1. O(1). */
  private unlink(parent: number, prev: number, n: number): void {
    if (prev === NONE) this.child[parent] = this.next[n]!;
    else this.next[prev] = this.next[n]!;
    this.next[n] = NONE;
  }

  /** Free `top` and every node below it (not its siblings). Returns the number of keys freed. */
  private freeSubtree(top: number): number {
    let keys = 0;
    const stack: number[] = [top];
    while (stack.length > 0) {
      const n = stack.pop()!;
      // Read the children before freeing n: freeNode reuses `next` as the free-list link.
      for (let c = this.child[n]!; c !== NONE; c = this.next[c]!) stack.push(c);
      if (this.term[n] === 1) keys++;
      this.freeNode(n, true);
    }
    return keys;
  }

  /** Take a node id from the free list, or the next never-used id (doubling the arrays if full). */
  private allocNode(): number {
    let n = this.freeHead;
    if (n !== NONE) {
      this.freeHead = this.next[n]!;
    } else {
      if (this.allocated === this.child.length) this.growNodes();
      n = this.allocated++;
    }
    this.child[n] = NONE;
    this.next[n] = NONE;
    this.term[n] = 0;
    this.meta[n] = NONE;
    this.liveNodes++;
    return n;
  }

  /** Put n on the free list; with `releaseLabel` its label units are returned to the pool. */
  private freeNode(n: number, releaseLabel: boolean): void {
    if (releaseLabel) {
      const s = this.lblStart[n]!;
      const len = this.lblLen[n]!;
      // A label at the end of the pool is handed back directly (typical for insert/remove
      // churn); anywhere else it becomes garbage for the next compaction.
      if (s + len === this.poolLen) this.poolLen = s;
      else this.poolGarbage += len;
    }
    this.dropMeta(n);
    this.term[n] = 0;
    this.lblLen[n] = 0;
    this.child[n] = NONE;
    this.next[n] = this.freeHead;
    this.freeHead = n;
    this.liveNodes--;
  }

  /** Doubling: amortised O(1) per allocated node. */
  private growNodes(): void {
    const capacity = this.child.length * 2;
    this.lblStart = growInt32(this.lblStart, capacity);
    this.lblLen = growUint16(this.lblLen, capacity);
    this.first = growUint16(this.first, capacity);
    this.child = growInt32(this.child, capacity);
    this.next = growInt32(this.next, capacity);
    this.term = growUint8(this.term, capacity);
    this.meta = growInt32(this.meta, capacity);
  }

  /** Make room for `extra` more pool units, doubling the pool as needed. */
  private reservePool(extra: number): void {
    const need = this.poolLen + extra;
    if (need <= this.pool.length) return;
    let capacity = Math.max(this.pool.length * 2, 16);
    while (capacity < need) capacity *= 2;
    const pool = new Uint16Array(capacity);
    pool.set(this.pool.subarray(0, this.poolLen));
    this.pool = pool;
  }

  /** Grow the scratch arrays to hold a key of `keyLen` units (depth ≤ keyLen + 1). */
  private reserveScratch(keyLen: number): void {
    const need = keyLen + 2;
    if (need <= this.scratchCap) return;
    const capacity = Math.max(need, this.scratchCap * 2);
    this.pathNode = new Int32Array(capacity);
    this.pathPrev = new Int32Array(capacity);
    this.walkNode = new Int32Array(capacity);
    this.walkBase = new Int32Array(capacity);
    this.buf = new Uint16Array(capacity);
    this.scratchCap = capacity;
  }

  /** Append word[from, word.length) as a new leaf (a chain of full labels if longer than 65,535). */
  private newLeaf(word: string, from: number, meta: Completion | undefined): number {
    const units = word.length - from;
    this.reservePool(units);
    let start = this.poolLen;
    for (let k = 0; k < units; k++) this.pool[start + k] = word.charCodeAt(from + k);
    this.poolLen += units;
    let top = NONE;
    let last = NONE;
    let remaining = units;
    while (remaining > 0) {
      const len = Math.min(remaining, MAX_LABEL);
      const n = this.allocNode();
      this.lblStart[n] = start;
      this.lblLen[n] = len;
      this.first[n] = this.pool[start]!;
      if (last === NONE) top = n;
      else this.child[last] = n;
      last = n;
      start += len;
      remaining -= len;
    }
    this.markKey(last, meta);
    return top;
  }

  /** Make n a key (counting it once) and set or clear its meta; re-inserting replaces the meta. */
  private markKey(n: number, meta: Completion | undefined): void {
    if (this.term[n] === 0) {
      this.term[n] = 1;
      this.keyCount++;
    }
    const stored = meta === undefined ? undefined : metaWithoutText(meta);
    if (stored === undefined) {
      this.dropMeta(n);
      return;
    }
    let slot = this.meta[n]!;
    if (slot === NONE) {
      slot = this.freeMetas.pop() ?? this.metas.length;
      this.meta[n] = slot;
    }
    this.metas[slot] = stored;
  }

  /** Release n's meta slot, if any. */
  private dropMeta(n: number): void {
    const slot = this.meta[n]!;
    if (slot === NONE) return;
    this.metas[slot] = undefined;
    this.freeMetas.push(slot);
    this.meta[n] = NONE;
  }

  /** The completion for key node n, spelled `prefix` + buf[prefix.length, end). A fresh object. */
  private emit(n: number, prefix: string, end: number): Completion {
    const plen = prefix.length;
    const text = end === plen ? prefix : prefix + unitsToString(this.buf, plen, end);
    const slot = this.meta[n]!;
    const stored = slot === NONE ? undefined : this.metas[slot];
    return stored === undefined ? { text } : { text, ...stored };
  }

  private maybeCompact(): void {
    if (this.poolGarbage > this.poolLen / 2) this.compact();
  }
}
