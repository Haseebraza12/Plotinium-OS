/**
 * S4: DAG with Kahn's topological sort, levels and cycle path (specs/08-dsa/data-structures.md
 * §3.5 S4, §4.4, §5 S4).
 *
 * Owner: R5 QA/DevOps · non-owner reviewer: R2 · must be IMPLEMENTED by v0.2.0 (P2, target W3).
 * Mandatory location (Spec §10.1 DAG row): service dependencies and boot order (§6.4, BOOT-03,
 * BOOT-04) and application start-up dependencies (`sys.spawn` app closure).
 *
 * Nodes are indexed 0..V−1 in input order (`names: string[]`, `index: Map<string, number>`).
 * Edges point from a dependency to its dependent ("A → B: B requires A", spec Figure 6.3) and are
 * stored twice in compressed sparse row form: `outStart`/`outTo` (dependents) and
 * `inStart`/`inFrom` (requirements), plus `indeg` and `level` per node.
 *
 * | Operation                              | Complexity                    |
 * |----------------------------------------|-------------------------------|
 * | buildDag (index + CSR + Kahn + levels) | O(V + E)                      |
 * | cycle path extraction                  | O(V + E)                      |
 * | levelOf, name, indexOf, requires, …    | O(1)                          |
 * | topoOrder, levels                      | O(V) on first call, then O(1) |
 * | cursor().complete(v)                   | O(outdeg v)                   |
 * | ancestors(targets)                     | O(V + E)                      |
 * | reversed()                             | O(V + E)                      |
 *
 * Determinism (§3.4): `requires(v)` lists v's requirements in the order of its `requires` array;
 * `dependents(u)` lists dependents by increasing index; `topoOrder` is Kahn with a FIFO queue seeded
 * with the sources in input order; each level lists its nodes by increasing index; the reported
 * cycle starts at the smallest name (UTF-16 code-unit order) and is closed (first === last).
 *
 * Invariants checked by `checkInvariants()` (§5 S4), each failure message names its id:
 * D1 names and index are a bijection; D2 Σ out-degree = Σ in-degree = edges and both CSR halves
 * describe the same edge set; D3 level[v] ≥ level[u] + 1 on every edge u→v, with equality for at
 * least one predecessor, and sources are level 0; D4 topoOrder respects every edge.
 *
 * Implementation notes (R5, written from first principles; README.md has the proofs):
 *
 * - CSR ("compressed sparse row"). Row v of a half is `adj[start[v] .. start[v + 1])`. One Int32Array
 *   of V + 1 row starts and one of E entries hold a whole adjacency list, so the graph costs
 *   8 bytes per node and 8 bytes per edge for both halves, with no per-node objects.
 * - The out half is the transpose of the in half, built by a counting pass (`transpose`). Because the
 *   counting pass visits nodes in increasing index, every dependents row comes out sorted, which
 *   also makes a repeated requirement show up as two equal neighbours in one row (`firstRepeat`).
 * - One `Map` operation per name: `Map.set` on a present key leaves `size` unchanged, which is the
 *   duplicate-name test. Resolving the E requirement strings costs one `Map.get` each; that string
 *   hashing, not Kahn, dominates the build time (README.md, benchmark).
 * - Kahn's FIFO queue IS the topological order: every node is appended exactly once, when its
 *   in-degree reaches 0, and the head only moves forward. So `order` needs no second array.
 * - Levels are computed inside Kahn: when w is appended, all its predecessors have been popped, so
 *   `level[w]` already equals 1 + the maximum level of its predecessors (the longest path).
 * - Typed-array reads use `!`: every index is in range by construction, which
 *   noUncheckedIndexedAccess cannot see. No walk recurses; stacks and queues are explicit arrays.
 */
import { DsaError } from '../_shared/errors.ts';
import type { DsaStats } from '../_shared/errors.ts';

export const IMPLEMENTED = true;

/** A service manifest or app manifest reduced to what the graph needs. */
export interface DagNode {
  readonly name: string;
  readonly requires: readonly string[];
}

/**
 * A dependency cycle (BOOT-04). `path` is in dependency direction (each element is required by the
 * next), rotated to start at its smallest name and closed: `['a', 'b', 'a']`. A self-loop is
 * `['a', 'a']`. The message joins the path with ' → '.
 */
export class CycleError extends DsaError {
  readonly path: readonly string[];

  constructor(path: readonly string[]) {
    super('CYCLE', path.join(' → '));
    this.name = 'CycleError';
    this.path = path;
  }
}

/** `node` requires `missing`, which is not a node of the graph. */
export class UnknownNodeError extends DsaError {
  readonly node: string;
  readonly missing: string;

  constructor(node: string, missing: string) {
    super('NOT_FOUND', `${node} requires unknown ${missing}`);
    this.name = 'UnknownNodeError';
    this.node = node;
    this.missing = missing;
  }
}

export interface Dag {
  /** V. */
  readonly size: number;
  /** E. */
  readonly edges: number;
  /** RANGE if v is not a node index. */
  name(v: number): string;
  indexOf(name: string): number | undefined;
  /** Predecessors (requirements) of v, as a subarray view. */
  requires(v: number): Int32Array;
  /** Successors (dependents) of v, as a subarray view. */
  dependents(v: number): Int32Array;
  /** Kahn order; ties by input index. */
  topoOrder(): readonly number[];
  /** levels[L] = nodes whose longest path from a source is L. */
  levels(): readonly (readonly number[])[];
  levelOf(v: number): number;
  /** Membership mask of every node the targets depend on, targets included; O(V + E). */
  ancestors(targets: readonly number[]): Uint8Array;
  /** The same nodes with every edge reversed (shutdown order). */
  reversed(): Dag;
  /** Completion-driven execution (svcmgr boot, BOOT-03). */
  cursor(): KahnCursor;
  checkInvariants(): void;
  /** §3.4 "Accounting": the typed arrays of this graph (exactly sized, so allocated = used). */
  stats(): DsaStats;
}

export interface KahnCursor {
  /** Nodes with in-degree 0, by increasing index. */
  initial(): number[];
  /**
   * Mark v done; return the nodes that just became ready, by increasing index. O(outdeg v).
   * INVALID if v was already completed or is not ready yet.
   */
  complete(v: number): number[];
  /** Nodes not yet completed. */
  readonly remaining: number;
}

// ------------------------------------------------------------------------------------------------
// Internal building blocks
// ------------------------------------------------------------------------------------------------

/** One CSR half: row v is `adj[start[v] .. start[v + 1])`. */
interface Csr {
  readonly start: Int32Array;
  readonly adj: Int32Array;
}

/** RANGE unless v is an integer node index in 0..size−1. */
function checkNode(v: number, size: number, op: string): void {
  if (!Number.isInteger(v) || v < 0 || v >= size) {
    throw new DsaError('RANGE', `dag.${op}: ${String(v)} is not a node index in 0..${size - 1}`);
  }
}

/** A DsaError INVALID whose message starts with the invariant id (§3.4). */
function broken(id: 'D1' | 'D2' | 'D3' | 'D4', detail: string): DsaError {
  return new DsaError('INVALID', `${id} ${detail}`);
}

/**
 * Transpose one CSR half into the other with two counting passes. Input: for every node v, the row
 * of its neighbours u. Output: for every u, the row of every v whose input row contains u. Because
 * v is visited in increasing order, each output row lists its nodes by increasing index. O(V + E).
 */
function transpose(size: number, start: Int32Array, adj: Int32Array): Csr {
  const tStart = new Int32Array(size + 1);
  // Pass 1: count each output row's length into tStart[u + 1] ...
  for (let e = 0; e < adj.length; e++) {
    const u = adj[e]!;
    tStart[u + 1] = tStart[u + 1]! + 1;
  }
  // ... and prefix-sum the counts into row starts: tStart[u] = Σ lengths of rows 0..u−1.
  for (let u = 0; u < size; u++) tStart[u + 1] = tStart[u + 1]! + tStart[u]!;
  // Pass 2: drop every v into the rows of its neighbours. fill[u] is row u's next free slot.
  const fill = tStart.slice(0, size);
  const tAdj = new Int32Array(adj.length);
  for (let v = 0; v < size; v++) {
    const end = start[v + 1]!;
    for (let e = start[v]!; e < end; e++) {
      const u = adj[e]!;
      tAdj[fill[u]!] = v;
      fill[u] = fill[u]! + 1;
    }
  }
  return { start: tStart, adj: tAdj };
}

/** What one Kahn run leaves behind. */
interface KahnRun {
  /** The FIFO queue; its first `count` entries are the topological order. */
  readonly order: Int32Array;
  /** How many nodes were output; `count < V` means the graph has a cycle. */
  readonly count: number;
  /** The sources are `order[0 .. sources)`, by increasing index. */
  readonly sources: number;
  /** Longest path from a source, final for every output node. */
  readonly level: Int32Array;
  /** The largest level of an output node; −1 when nothing was output. */
  readonly maxLevel: number;
  /** In-degree left over: 0 for output nodes, ≥ 1 (remaining predecessors) for the others. */
  readonly pending: Int32Array;
}

/**
 * Kahn's algorithm with levels (§5 S4). Each node is appended to the queue once (when its pending
 * in-degree reaches 0) and popped once; each edge is decremented once when its tail is popped. So
 * the run is O(V + E) whether or not the graph is acyclic.
 */
function kahn(size: number, indeg: Int32Array, outStart: Int32Array, outTo: Int32Array): KahnRun {
  const pending = indeg.slice();
  const level = new Int32Array(size); // sources stay at level 0
  const order = new Int32Array(size);
  let tail = 0;
  // Step 1: the queue starts as the sources in input order (ties by input index).
  for (let v = 0; v < size; v++) if (pending[v] === 0) order[tail++] = v;
  const sources = tail;
  let maxLevel = sources > 0 ? 0 : -1;
  // Step 2: pop u, relax the level of each dependent w and append w when its last requirement pops.
  for (let head = 0; head < tail; head++) {
    const u = order[head]!;
    const next = level[u]! + 1;
    const end = outStart[u + 1]!;
    for (let e = outStart[u]!; e < end; e++) {
      const w = outTo[e]!;
      if (level[w]! < next) level[w] = next;
      const left = pending[w]! - 1;
      pending[w] = left;
      if (left === 0) {
        // Step 3: every predecessor of w has been popped, so level[w] is final here.
        order[tail++] = w;
        if (level[w]! > maxLevel) maxLevel = level[w]!;
      }
    }
  }
  return { order, count: tail, sources, level, maxLevel, pending };
}

/**
 * The deterministic cycle of a graph on which Kahn stopped early (DSA-DAG-02, §5 S4). O(V + E).
 *
 * 1. Every node Kahn did not output has pending ≥ 1, and pending counts exactly its predecessors
 *    that were not output either (output nodes decremented their edges). So every remaining node
 *    has a remaining predecessor.
 * 2. Start at the remaining node with the smallest name and keep stepping to the smallest-named
 *    remaining predecessor. The walk stays inside a finite set, so a node repeats (pigeonhole); the
 *    stretch from its first visit to the end of the walk is a cycle, and a tail leading into the
 *    cycle is cut off. Each node is visited at most once before the repeat, so each predecessor
 *    list is scanned at most once.
 * 3. The walk runs against the edges (v → a requirement of v), so reverse the cycle into dependency
 *    direction, rotate it to its smallest name and close it by repeating that name.
 */
function cyclePath(
  names: readonly string[],
  inStart: Int32Array,
  inFrom: Int32Array,
  pending: Int32Array,
): string[] {
  const size = names.length;
  let start = -1;
  for (let v = 0; v < size; v++) {
    if (pending[v]! > 0 && (start < 0 || names[v]! < names[start]!)) start = v;
  }
  const stepOf = new Int32Array(size).fill(-1); // position of v in the walk, or −1 if not visited
  const walk: number[] = [];
  let v = start;
  while (stepOf[v] === -1) {
    stepOf[v] = walk.length;
    walk.push(v);
    let best = -1;
    const end = inStart[v + 1]!;
    for (let e = inStart[v]!; e < end; e++) {
      const u = inFrom[e]!;
      if (pending[u]! > 0 && (best < 0 || names[u]! < names[best]!)) best = u;
    }
    // Step 1 guarantees a remaining predecessor; reaching this would mean Kahn itself is wrong.
    if (best < 0)
      throw new DsaError(
        'INVALID',
        `dag: remaining node ${names[v]!} has no remaining predecessor`,
      );
    v = best;
  }
  // walk[i] requires walk[i + 1], and the last node requires v = walk[stepOf[v]]. Reversed, each
  // element is required by the next one (dependency direction), cyclically.
  const cycle = walk.slice(stepOf[v]).reverse();
  let first = 0;
  for (let i = 1; i < cycle.length; i++) if (names[cycle[i]!]! < names[cycle[first]!]!) first = i;
  const path: string[] = [];
  for (let k = 0; k <= cycle.length; k++) path.push(names[cycle[(first + k) % cycle.length]!]!);
  return path; // k = cycle.length wraps to `first` again, which closes the path
}

/**
 * The first duplicate edge, as `[u, v]` (v lists u twice), or undefined. Dependents rows come out of
 * `transpose` sorted, so a repeated edge u→v puts v twice in row u as two neighbours: one sequential
 * pass finds it, with no per-node "seen" array. O(V + E).
 */
function firstRepeat(size: number, out: Csr): [number, number] | undefined {
  for (let u = 0; u < size; u++) {
    const end = out.start[u + 1]!;
    for (let e = out.start[u]! + 1; e < end; e++) {
      if (out.adj[e] === out.adj[e - 1]) return [u, out.adj[e]!];
    }
  }
  return undefined;
}

/**
 * Everything after the two CSR halves exist: derive the in-degrees, run Kahn and either throw the
 * cycle or return the graph. Shared by buildDag and reversed(). O(V + E).
 */
function finish(
  names: readonly string[],
  index: ReadonlyMap<string, number>,
  inHalf: Csr,
  outHalf: Csr,
): CsrDag {
  const size = names.length;
  const indeg = new Int32Array(size);
  for (let v = 0; v < size; v++) indeg[v] = inHalf.start[v + 1]! - inHalf.start[v]!;
  const run = kahn(size, indeg, outHalf.start, outHalf.adj);
  if (run.count < size)
    throw new CycleError(cyclePath(names, inHalf.start, inHalf.adj, run.pending));
  return new CsrDag(names, index, inHalf, outHalf, indeg, run);
}

// ------------------------------------------------------------------------------------------------
// The graph
// ------------------------------------------------------------------------------------------------

/** An immutable, acyclic, already sorted and levelled graph (built only by `finish`). */
class CsrDag implements Dag {
  readonly size: number;
  readonly edges: number;
  readonly #names: readonly string[];
  readonly #index: ReadonlyMap<string, number>;
  /** Requirements: row v lists what v requires, in the order of v's `requires` array. */
  readonly #inStart: Int32Array;
  readonly #inFrom: Int32Array;
  /** Dependents: row u lists the nodes that require u, by increasing index. */
  readonly #outStart: Int32Array;
  readonly #outTo: Int32Array;
  /** In-degree per node (the cursor copies it; it is never written). */
  readonly #indeg: Int32Array;
  /** Longest path from a source. */
  readonly #level: Int32Array;
  readonly #maxLevel: number;
  /** Kahn's queue = the topological order; the sources are its first `#sources` entries. */
  readonly #order: Int32Array;
  readonly #sources: number;
  /** Plain-array copies handed out by topoOrder() and levels(), built on first use and frozen. */
  #orderList: readonly number[] | undefined;
  #levelList: readonly (readonly number[])[] | undefined;

  constructor(
    names: readonly string[],
    index: ReadonlyMap<string, number>,
    inHalf: Csr,
    outHalf: Csr,
    indeg: Int32Array,
    run: KahnRun,
  ) {
    this.size = names.length;
    this.edges = inHalf.adj.length;
    this.#names = names;
    this.#index = index;
    this.#inStart = inHalf.start;
    this.#inFrom = inHalf.adj;
    this.#outStart = outHalf.start;
    this.#outTo = outHalf.adj;
    this.#indeg = indeg;
    this.#level = run.level;
    this.#maxLevel = run.maxLevel;
    this.#order = run.order;
    this.#sources = run.sources;
  }

  name(v: number): string {
    checkNode(v, this.size, 'name');
    return this.#names[v]!;
  }

  indexOf(name: string): number | undefined {
    return this.#index.get(name);
  }

  requires(v: number): Int32Array {
    checkNode(v, this.size, 'requires');
    return this.#inFrom.subarray(this.#inStart[v], this.#inStart[v + 1]);
  }

  dependents(v: number): Int32Array {
    checkNode(v, this.size, 'dependents');
    return this.#outTo.subarray(this.#outStart[v], this.#outStart[v + 1]);
  }

  topoOrder(): readonly number[] {
    this.#orderList ??= Object.freeze(Array.from(this.#order));
    return this.#orderList;
  }

  levels(): readonly (readonly number[])[] {
    if (this.#levelList === undefined) {
      // A counting sort by level: one bucket per level, filled in increasing index. O(V).
      const groups: number[][] = [];
      for (let l = 0; l <= this.#maxLevel; l++) groups.push([]);
      for (let v = 0; v < this.size; v++) groups[this.#level[v]!]!.push(v);
      this.#levelList = Object.freeze(groups.map((group) => Object.freeze(group)));
    }
    return this.#levelList;
  }

  levelOf(v: number): number {
    checkNode(v, this.size, 'levelOf');
    return this.#level[v]!;
  }

  /**
   * Iterative DFS over `requires` (§5 S4). A node is marked when it is pushed, so it is pushed at
   * most once: the stack never holds more than V entries and each requirement row is scanned once.
   */
  ancestors(targets: readonly number[]): Uint8Array {
    const inStart = this.#inStart;
    const inFrom = this.#inFrom;
    const mask = new Uint8Array(this.size);
    const stack = new Int32Array(this.size);
    let top = 0;
    for (const t of targets) {
      checkNode(t, this.size, 'ancestors');
      if (mask[t] === 0) {
        mask[t] = 1;
        stack[top++] = t;
      }
    }
    while (top > 0) {
      const v = stack[--top]!;
      const end = inStart[v + 1]!;
      for (let e = inStart[v]!; e < end; e++) {
        const u = inFrom[e]!;
        if (mask[u] === 0) {
          mask[u] = 1;
          stack[top++] = u;
        }
      }
    }
    return mask;
  }

  /**
   * Swap the two CSR halves (§5 S4): the new requirements are the old dependents. The new
   * dependents are rebuilt by `transpose`, so they are sorted by index like every dependents row
   * (the old requirement rows are in manifest order). Reversing every edge of a DAG leaves it
   * acyclic, so `finish` cannot throw here. The arrays are never written after construction, so
   * the two graphs share the names, the index and the old dependents half.
   */
  reversed(): Dag {
    const inHalf: Csr = { start: this.#outStart, adj: this.#outTo };
    return finish(
      this.#names,
      this.#index,
      inHalf,
      transpose(this.size, this.#outStart, this.#outTo),
    );
  }

  cursor(): KahnCursor {
    return new CsrCursor(
      this.#names,
      this.#indeg,
      this.#outStart,
      this.#outTo,
      this.#order.subarray(0, this.#sources),
    );
  }

  checkInvariants(): void {
    const size = this.size;
    const names = this.#names;
    const inStart = this.#inStart;
    const inFrom = this.#inFrom;
    const outStart = this.#outStart;
    const outTo = this.#outTo;

    // D1: names and index are a bijection between 0..V−1 and the names.
    if (names.length !== size || this.#index.size !== size) {
      throw broken(
        'D1',
        `${names.length} names and ${this.#index.size} index entries for ${size} nodes`,
      );
    }
    for (let v = 0; v < size; v++) {
      const back = this.#index.get(names[v]!);
      if (back !== v)
        throw broken('D1', `index maps ${names[v]!} to ${String(back)}, expected ${v}`);
    }

    // D2: both halves hold E edges, their rows are well formed, and they describe the same edge set.
    checkRows('requires', size, this.edges, inStart, inFrom);
    checkRows('dependents', size, this.edges, outStart, outTo);
    for (let v = 0; v < size; v++) {
      if (this.#indeg[v] !== inStart[v + 1]! - inStart[v]!) {
        throw broken(
          'D2',
          `indeg[${v}] = ${this.#indeg[v]!} but ${names[v]!} has ${inStart[v + 1]! - inStart[v]!} requirements`,
        );
      }
      for (let e = inStart[v]!; e < inStart[v + 1]!; e++) {
        if (inFrom[e] === v) throw broken('D2', `self-loop on ${names[v]!}`);
      }
      // Strictly increasing rows: sorted as documented, and no edge is stored twice.
      for (let e = outStart[v]! + 1; e < outStart[v + 1]!; e++) {
        if (outTo[e - 1]! >= outTo[e]!)
          throw broken('D2', `dependents of ${names[v]!} are not strictly increasing`);
      }
    }
    // Rows of the transposed in half are sorted by index, like the out half, so the two edge sets
    // are equal exactly when the arrays are equal element by element (a requirement listed twice
    // would appear twice in a transposed row, which the strictly increasing out half cannot match).
    const t = transpose(size, inStart, inFrom);
    for (let v = 0; v <= size; v++) {
      if (t.start[v] !== outStart[v])
        throw broken('D2', `out-degree of node ${v} disagrees with the requirement lists`);
    }
    for (let e = 0; e < this.edges; e++) {
      if (t.adj[e] !== outTo[e])
        throw broken('D2', `dependents entry ${e} is not an edge of the requirement lists`);
    }

    // D3: level[v] = 1 + max level of its requirements (≥ on every edge, = on at least one), 0 for a source.
    let maxLevel = size > 0 ? 0 : -1;
    for (let v = 0; v < size; v++) {
      const level = this.#level[v]!;
      let tight = inStart[v] === inStart[v + 1] ? 0 : -1;
      for (let e = inStart[v]!; e < inStart[v + 1]!; e++) {
        const need = this.#level[inFrom[e]!]! + 1;
        if (level < need)
          throw broken(
            'D3',
            `level of ${names[v]!} is ${level}, below ${need} required by ${names[inFrom[e]!]!}`,
          );
        if (need > tight) tight = need;
      }
      if (level !== tight)
        throw broken('D3', `level of ${names[v]!} is ${level} but its longest path is ${tight}`);
      if (level > maxLevel) maxLevel = level;
    }
    if (maxLevel !== this.#maxLevel)
      throw broken('D3', `max level is ${maxLevel}, recorded ${this.#maxLevel}`);

    // D4: topoOrder is a permutation of 0..V−1 in which every requirement comes first.
    const position = new Int32Array(size).fill(-1);
    for (let i = 0; i < size; i++) {
      const v = this.#order[i]!;
      if (v < 0 || v >= size || position[v] !== -1)
        throw broken('D4', `topoOrder is not a permutation (entry ${i} = ${v})`);
      position[v] = i;
    }
    for (let v = 0; v < size; v++) {
      for (let e = inStart[v]!; e < inStart[v + 1]!; e++) {
        const u = inFrom[e]!;
        if (position[u]! >= position[v]!)
          throw broken('D4', `${names[v]!} comes before its requirement ${names[u]!}`);
      }
    }
  }

  stats(): DsaStats {
    const bytes =
      this.#inStart.byteLength +
      this.#inFrom.byteLength +
      this.#outStart.byteLength +
      this.#outTo.byteLength +
      this.#indeg.byteLength +
      this.#level.byteLength +
      this.#order.byteLength;
    return { size: this.size, capacity: this.size, bytesAllocated: bytes, bytesUsed: bytes };
  }
}

/** D2 helper: a CSR half has V + 1 non-decreasing row starts from 0 to E and entries in 0..V−1. */
function checkRows(
  half: string,
  size: number,
  edges: number,
  start: Int32Array,
  adj: Int32Array,
): void {
  if (
    start.length !== size + 1 ||
    start[0] !== 0 ||
    start[size] !== edges ||
    adj.length !== edges
  ) {
    throw broken('D2', `${half} rows do not span exactly ${edges} edges over ${size} nodes`);
  }
  for (let v = 0; v < size; v++) {
    if (start[v]! > start[v + 1]!) throw broken('D2', `${half} row ${v} has negative length`);
  }
  for (let e = 0; e < edges; e++) {
    if (adj[e]! < 0 || adj[e]! >= size)
      throw broken('D2', `${half} entry ${e} = ${adj[e]!} is not a node`);
  }
}

// ------------------------------------------------------------------------------------------------
// Completion-driven execution
// ------------------------------------------------------------------------------------------------

/**
 * Kahn run one completion at a time (§5 S4 "Cursor"): svcmgr starts every ready service
 * asynchronously and calls complete(v) as each start finishes, so independent services overlap.
 * pending[v] counts v's requirements that are not complete yet; v is ready exactly when it is 0.
 */
class CsrCursor implements KahnCursor {
  readonly #names: readonly string[];
  readonly #outStart: Int32Array;
  readonly #outTo: Int32Array;
  readonly #sources: Int32Array;
  readonly #pending: Int32Array;
  readonly #done: Uint8Array;
  #remaining: number;

  constructor(
    names: readonly string[],
    indeg: Int32Array,
    outStart: Int32Array,
    outTo: Int32Array,
    sources: Int32Array,
  ) {
    this.#names = names;
    this.#outStart = outStart;
    this.#outTo = outTo;
    this.#sources = sources;
    this.#pending = indeg.slice();
    this.#done = new Uint8Array(names.length);
    this.#remaining = names.length;
  }

  get remaining(): number {
    return this.#remaining;
  }

  initial(): number[] {
    return Array.from(this.#sources);
  }

  complete(v: number): number[] {
    checkNode(v, this.#names.length, 'cursor.complete');
    if (this.#done[v] === 1)
      throw new DsaError(
        'INVALID',
        `dag.cursor.complete: ${this.#names[v]!} was already completed`,
      );
    const waiting = this.#pending[v]!;
    if (waiting !== 0) {
      throw new DsaError(
        'INVALID',
        `dag.cursor.complete: ${this.#names[v]!} is not ready (${waiting} requirement(s) not complete)`,
      );
    }
    this.#done[v] = 1;
    this.#remaining--;
    // Dependents rows are sorted, so the newly ready nodes come out by increasing index.
    const ready: number[] = [];
    const end = this.#outStart[v + 1]!;
    for (let e = this.#outStart[v]!; e < end; e++) {
      const w = this.#outTo[e]!;
      const left = this.#pending[w]! - 1;
      this.#pending[w] = left;
      if (left === 0) ready.push(w);
    }
    return ready;
  }
}

// ------------------------------------------------------------------------------------------------
// Public entry points
// ------------------------------------------------------------------------------------------------

/**
 * Build, sort and level the graph in O(V + E). Throws DsaError DUPLICATE for a repeated node name
 * or a repeated requirement, UnknownNodeError for a requirement that names no node, and CycleError
 * for a self-loop or a cycle.
 *
 * Checks run in this order, so the error for a given input is deterministic: a repeated name (the
 * first in input order), an unknown requirement (the first in input order), a repeated requirement,
 * a self-loop (the one with the smallest name), and finally a longer cycle (the walk of §5 S4).
 * A cycle is therefore only reported for a structurally valid input, and which cycle is reported
 * depends on the names, not on the input order.
 */
export function buildDag(nodes: readonly DagNode[]): Dag {
  const size = nodes.length;

  // Step 1: index the names and count the edges. Map.set on a key that is already present keeps
  // the size unchanged, so one hash operation per node both inserts it and detects a repeat.
  const names = new Array<string>(size);
  const index = new Map<string, number>();
  let edges = 0;
  for (let v = 0; v < size; v++) {
    const node = nodes[v]!;
    const name = node.name;
    index.set(name, v);
    if (index.size === v) throw new DsaError('DUPLICATE', `duplicate node name ${name}`);
    names[v] = name;
    edges += node.requires.length;
  }

  // Step 2: resolve every requirement into the requirements half (row v in v's `requires` order).
  const inStart = new Int32Array(size + 1);
  const inFrom = new Int32Array(edges);
  let selfLoop = -1;
  let e = 0;
  for (let v = 0; v < size; v++) {
    const requires = nodes[v]!.requires;
    for (let i = 0; i < requires.length; i++) {
      const required = requires[i]!;
      const u = index.get(required);
      if (u === undefined) throw new UnknownNodeError(names[v]!, required);
      if (u === v && (selfLoop < 0 || names[v]! < names[selfLoop]!)) selfLoop = v;
      inFrom[e++] = u;
    }
    inStart[v + 1] = e;
  }
  const inHalf: Csr = { start: inStart, adj: inFrom };

  // Step 3: the dependents half by counting passes; its sorted rows expose repeated requirements.
  const outHalf = transpose(size, inStart, inFrom);
  const repeat = firstRepeat(size, outHalf);
  if (repeat !== undefined) {
    throw new DsaError('DUPLICATE', `${names[repeat[1]]!} requires ${names[repeat[0]]!} twice`);
  }
  if (selfLoop >= 0) {
    const loop = names[selfLoop]!;
    throw new CycleError([loop, loop]);
  }

  // Step 4: Kahn and levels (or the cycle).
  return finish(names, index, inHalf, outHalf);
}

/** §10.3 signature: the input nodes grouped by level (Kahn); throws CycleError(path). */
export function topoLevels<N extends DagNode>(nodes: readonly N[]): N[][] {
  const dag = buildDag(nodes);
  // Levels hold input indices, so this maps back to the caller's own objects, not copies.
  return dag.levels().map((level) => level.map((v) => nodes[v]!));
}
