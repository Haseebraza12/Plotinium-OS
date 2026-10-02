/**
 * S1 — n-ary tree of the VFS hierarchy (specs/08-dsa/data-structures.md §3.5 S1, §4.1, §5 S1).
 *
 * Owner: R2 VFS/DB · non-owner reviewer: R1 · must be IMPLEMENTED by v0.2.0 (P2, target W5).
 * Mandatory location (Spec §10.1 tree row): the VFS directory hierarchy (§9.3, VFS-01).
 *
 * Directory nodes carry `parent`, `name` and `children: Map<string, TreeNode>` (built-in Map is the
 * allowed hashing primitive, §10.2). File and symlink nodes are leaves without a parent pointer,
 * because a hard-linked file is referenced from several directories. `children === null` means
 * "not loaded" (lazy loading). No node stores its path or depth, which is what makes `move` O(1)
 * plus the O(depth) cycle check (DSA-TREE-02). No operation recurses (DSA-TREE-03).
 *
 * | Operation            | Complexity                   |
 * |----------------------|------------------------------|
 * | lookup/attach/detach | O(1) average                 |
 * | resolve              | O(d) for d components        |
 * | isAncestor, depthOf  | O(depth)                     |
 * | move                 | O(1) + O(depth(dst))         |
 * | pathOf               | O(depth + |path|)            |
 * | walk                 | O(k) for k loaded nodes      |
 * | setLoaded            | O(k) entries; unload O(1)    |
 *
 * Invariants checked by `checkInvariants()` (§5 S1): T1 root has no parent and name ''; T2 every
 * directory child's parent/name match its map entry; T3 every non-root directory is in exactly one
 * parent map; T4 parent chains reach the root within `size` steps; T5 every key is a valid name;
 * T6 `size` equals the number of distinct loaded nodes.
 *
 * Implementation notes (R2, first principles; README.md has the proofs):
 *
 * - The node objects belong to the VFS. Besides them the tree keeps one registry, a Map from node
 *   to its number of live links: 1 for a loaded directory (the root included), 1 or more for a
 *   loaded file or symlink (hard links). `size` is a counter of the nodes whose count is positive,
 *   so it costs O(1) to read (T6), and a file linked from two directories counts once.
 * - Lazy deletion: a node whose count drops to 0 stays in the registry as a tombstone (count 0)
 *   instead of being deleted, and the registry is rebuilt without tombstones once they outnumber
 *   the live nodes. V8's Map keeps a deleted entry on its bucket chain until the next rehash, so
 *   deleting and re-inserting one key over and over (a detach and re-attach of the same node, which
 *   is how the VFS applies a rename) would make each operation on that key O(n); an update in place
 *   does not. The rebuild is O(n) but amortised O(1): each tombstone it removes was created by one
 *   unlink since the previous rebuild, and there are more tombstones than live entries.
 * - Mutations (attach, detach, move, setLoaded, unload) only accept directories that are live in
 *   the registry, an O(1) lookup. That one check keeps the accounting exact: nothing can be added
 *   below a detached or evicted directory behind the tree's back. Queries (lookup, resolve, walk,
 *   isAncestor, depthOf, pathOf) accept any directory and change nothing.
 * - A directory can be attached only if it is not live. The root and every linked directory are,
 *   so this single check forbids directory hard links (T3) and attaching an ancestor under its
 *   descendant (a cycle, T4).
 * - Dropping links (detach of a non-empty directory, unload) visits what it drops, so its actual
 *   cost is the number of links removed; each of them was paid for by the O(1) attach or the
 *   setLoaded that added it, so the amortised cost is O(1) (README.md, "Amortised bounds"). The
 *   VFS only detaches files and empty directories (rm -r plans run in post-order) and only evicts
 *   leaf directories (VFS spec §3.17.3), so in practice nothing below them is visited.
 */
import { DsaError } from '../_shared/errors.ts';
import type { DsaStats } from '../_shared/errors.ts';

export const IMPLEMENTED = true;

/** A node of the tree; `id` is the inode UUIDv7. */
export interface TreeNode<P> {
  readonly id: string;
  payload: P;
}

/**
 * A directory node. Nodes are plain objects (the VFS builds them): a node is a directory exactly
 * when it has a `children` property (a Map, or null while not loaded); `isDir` tests that.
 */
export interface DirNode<P> extends TreeNode<P> {
  /** null only for the root. */
  parent: DirNode<P> | null;
  /** '' for the root. */
  name: string;
  /** null = not loaded. */
  children: Map<string, TreeNode<P>> | null;
}

/**
 * Result of `resolve` (contract fixed here so the tests are exact):
 * - success: `node` is the last node, `parent` the directory it was found in (`start.parent` when
 *   there are no components) and `depth` the number of components consumed;
 * - failure: `at` is the index of the component that could not be looked up and `dir` the
 *   directory in which it was being looked up. NOT_FOUND: no such name in `dir`; NOT_LOADED:
 *   `dir.children` is null; NOT_DIR: the node reached by component `at - 1` is not a directory
 *   (`dir` is the directory that contains it).
 */
export type ResolveResult<P> =
  | { ok: true; node: TreeNode<P>; parent: DirNode<P> | null; depth: number }
  | { ok: false; code: 'NOT_FOUND' | 'NOT_DIR' | 'NOT_LOADED'; at: number; dir: DirNode<P> };

/**
 * One step of `walk`. The start node comes first in pre-order (last in post-order) with `dir` null,
 * its own name and depth 0. Siblings are visited in the children map's iteration order (insertion
 * order); a directory whose children are null is yielded but not descended into. A hard-linked
 * file is yielded once per link.
 */
export interface WalkEntry<P> {
  node: TreeNode<P>;
  /** The directory the node was reached from (null for the start node). */
  dir: DirNode<P> | null;
  name: string;
  /** Depth relative to the start node. */
  depth: number;
}

/**
 * Children are addressed by `(directory, name)`. The root has no parent, so the only pair that
 * addresses it is `(root, '')` (its own empty name): `detach` and `move` given that pair throw
 * INVALID. `size` counts distinct loaded nodes (T6), so a file linked from two directories counts
 * once and leaves the count only when its last link is detached.
 *
 * Errors shared by every mutation: INVALID when a directory argument is not a loaded node of this
 * tree (detached, or dropped by `unload` of an ancestor) or a new name breaks T5; NOT_LOADED when
 * the directory's children are not loaded. A refused call changes nothing.
 */
export interface NaryTree<P> {
  readonly root: DirNode<P>;
  /** Distinct loaded nodes, the root included. */
  readonly size: number;
  isDir(n: TreeNode<P>): n is DirNode<P>;
  /** O(1) avg; throws NOT_LOADED if `dir.children` is null. */
  lookup(dir: DirNode<P>, name: string): TreeNode<P> | undefined;
  /**
   * O(1) avg; throws DUPLICATE if the name exists; sets parent and name on directory children.
   * Throws INVALID for a directory already in the tree (the root, or linked elsewhere: T3).
   * Grafting a detached directory that still holds loaded content costs O(k) for its k links.
   */
  attach(dir: DirNode<P>, name: string, node: TreeNode<P>): void;
  /**
   * O(1) avg; undefined if absent; throws INVALID for the root. A detached directory keeps its
   * subtree, gets `parent = null` and can be attached again; its loaded content leaves `size`.
   */
  detach(dir: DirNode<P>, name: string): TreeNode<P> | undefined;
  /**
   * O(1) + O(depth(dst)); throws INVALID on a cycle or for the root, DUPLICATE on an existing name,
   * NOT_FOUND if `src` has no entry `name`. The same parent and name is a no-op.
   */
  move(src: DirNode<P>, name: string, dst: DirNode<P>, newName: string): void;
  /** O(depth(b)); true if a === b. */
  isAncestor(a: DirNode<P>, b: DirNode<P>): boolean;
  depthOf(n: DirNode<P>): number;
  /** '/' for the root. */
  pathOf(n: DirNode<P>): string;
  /** O(d); plain names only (vfs/path.ts handles '.', '..', symlinks and permissions). */
  resolve(start: DirNode<P>, components: readonly string[]): ResolveResult<P>;
  /** O(k), iterative; pre-order by default. */
  walk(from: DirNode<P>, order?: 'pre' | 'post'): Generator<WalkEntry<P>>;
  /**
   * O(k): installs the children map of a directory that was not loaded. Throws INVALID if `dir`
   * is already loaded, DUPLICATE for a repeated name; all checks run before anything changes.
   */
  setLoaded(dir: DirNode<P>, entries: Iterable<[string, TreeNode<P>]>): void;
  /** O(1) amortised: children := null (the dcache evicts a directory). A no-op if not loaded. */
  unload(dir: DirNode<P>): void;
  stats(): DsaStats;
  checkInvariants(): void;
}

// -------------------------------------------------------------------------------------------------
// Names (T5)
// -------------------------------------------------------------------------------------------------

/** Longest valid name in UTF-8 bytes (T5; the VFS's NAME_MAX). */
const NAME_MAX_BYTES = 255;

/**
 * T5: 1–255 UTF-8 bytes, no '/', no U+0000, not '.' or '..'. O(|name|), at most 255 steps.
 *
 * The UTF-8 length is counted from the UTF-16 code units without allocating an encoder buffer:
 * a unit below U+0080 is 1 byte, below U+0800 is 2, a surrogate pair (one astral code point) is 4,
 * and every other unit is 3 (a lone surrogate is encoded as U+FFFD, also 3 bytes). Every code unit
 * costs at least one byte, so more than 255 units can be rejected before counting.
 */
function isValidName(name: string): boolean {
  const n = name.length;
  if (n === 0 || n > NAME_MAX_BYTES || name === '.' || name === '..') return false;
  let bytes = 0;
  for (let i = 0; i < n; i++) {
    const unit = name.charCodeAt(i);
    if (unit === 0x2f || unit === 0) return false; // '/' or U+0000
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < n) {
      const low = name.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        bytes += 4;
        i++; // the low surrogate belongs to this code point
      } else {
        bytes += 3;
      }
    } else bytes += 3;
  }
  return bytes <= NAME_MAX_BYTES;
}

// -------------------------------------------------------------------------------------------------
// Errors
// -------------------------------------------------------------------------------------------------

function invalid(message: string): DsaError {
  return new DsaError('INVALID', `dsa/tree: ${message}`);
}

function invalidName(name: string): DsaError {
  return invalid(
    `${JSON.stringify(name)} is not a valid name (T5: 1–255 UTF-8 bytes, no '/', no NUL, not '.' or '..')`,
  );
}

function notLoaded(dir: DirNode<unknown>): DsaError {
  return new DsaError('NOT_LOADED', `dsa/tree: the children of directory ${dir.id} are not loaded`);
}

function duplicate(dir: DirNode<unknown>, name: string): DsaError {
  return new DsaError(
    'DUPLICATE',
    `dsa/tree: directory ${dir.id} already has an entry ${JSON.stringify(name)}`,
  );
}

/** A checkInvariants failure; the message starts with the invariant id (T1–T6). */
function corrupt(id: string, message: string): DsaError {
  return new DsaError('INVALID', `${id} violated (dsa/tree): ${message}`);
}

// -------------------------------------------------------------------------------------------------
// Memory accounting
// -------------------------------------------------------------------------------------------------

/**
 * stats() estimates the bytes the tree itself owns (§3.4 "Accounting"): one children-Map entry per
 * link plus one registry entry per registered node. A V8 Map entry holds key, value and chain link,
 * 8 bytes each (Node's V8 has no pointer compression). Bucket arrays, Map headers and the node
 * objects (built and owned by the VFS) are not counted; the benchmark's measured bytes/node
 * includes all of them.
 */
const MAP_ENTRY_BYTES = 3 * 8;

// -------------------------------------------------------------------------------------------------
// The tree
// -------------------------------------------------------------------------------------------------

/** A node is a directory exactly when it has a `children` property (DirNode's doc comment). */
function isDirNode<P>(n: TreeNode<P>): n is DirNode<P> {
  return 'children' in n;
}

/** True when `d` holds loaded entries, i.e. there is something below it to visit. */
function hasContent<P>(d: DirNode<P>): boolean {
  return d.children !== null && d.children.size > 0;
}

/**
 * A performance measure for `walk` with no effect on its result (memory-level parallelism). On a
 * tree larger than the CPU caches each node the walk reaches costs a cache miss, and between two
 * yields the CPU waits for them one at a time. This tight loop reads, for every child of the
 * directory the walk is entering, what the walk will need from it later: its shape (the directory
 * test) and, for a loaded subdirectory, its Map's size. The loads do not depend on each other, so
 * the CPU overlaps their misses and the walk then finds the data in cache. The sum is returned only
 * so the loads have a use. O(entries), so the walk stays O(k).
 */
function prefetchChildren<P>(children: Map<string, TreeNode<P>>): number {
  let below = 0;
  for (const c of children.values()) {
    if (isDirNode(c) && c.children !== null) below += c.children.size;
  }
  return below;
}

class LinkedNaryTree<P> implements NaryTree<P> {
  readonly root: DirNode<P>;

  /**
   * node → number of live links: 1 for a loaded directory, the hard-link count for a loaded file,
   * 0 for a tombstone (a node that was loaded and is not any more; see the header comment).
   */
  #registry = new Map<TreeNode<P>, number>();
  /** Registered nodes with a positive count: exactly `size` (T6). */
  #live = 0;
  /** Registered nodes with count 0. Kept at most #live by #compact(). */
  #tombstones = 0;
  /** Entries over the children maps of all loaded directories, i.e. live links (for stats()). */
  #links = 0;

  constructor(rootId: string, rootPayload: P) {
    this.root = { id: rootId, payload: rootPayload, parent: null, name: '', children: new Map() };
    this.#addLink(this.root); // the root is live from the start and is never unlinked
  }

  /** T6: the number of distinct loaded nodes, kept as a counter. O(1). */
  get size(): number {
    return this.#live;
  }

  isDir(n: TreeNode<P>): n is DirNode<P> {
    return isDirNode(n);
  }

  // --- queries ----------------------------------------------------------------------------------

  lookup(dir: DirNode<P>, name: string): TreeNode<P> | undefined {
    const children = dir.children;
    if (children === null) throw notLoaded(dir);
    return children.get(name); // one hash-map probe: O(1) average
  }

  isAncestor(a: DirNode<P>, b: DirNode<P>): boolean {
    // Follow parent pointers from b towards the root: at most depth(b) + 1 steps.
    for (let d: DirNode<P> | null = b; d !== null; d = d.parent) {
      if (d === a) return true;
    }
    return false;
  }

  depthOf(n: DirNode<P>): number {
    let depth = 0;
    for (let d = n.parent; d !== null; d = d.parent) depth++;
    return depth;
  }

  pathOf(n: DirNode<P>): string {
    // Collect the names bottom-up (O(depth)), then one join (O(|path|)).
    const names: string[] = [];
    let d = n;
    while (d.parent !== null) {
      names.push(d.name);
      d = d.parent;
    }
    if (names.length === 0) return '/';
    names.reverse();
    return `/${names.join('/')}`;
  }

  resolve(start: DirNode<P>, components: readonly string[]): ResolveResult<P> {
    const d = components.length;
    let dir = start; // the directory in which component i is looked up
    let node: TreeNode<P> = start;
    let parent = start.parent;
    // One lookup per component, so O(d) whatever the size of the tree.
    for (let i = 0; i < d; i++) {
      const children = dir.children;
      if (children === null) return { ok: false, code: 'NOT_LOADED', at: i, dir };
      const next = children.get(components[i] as string);
      if (next === undefined) return { ok: false, code: 'NOT_FOUND', at: i, dir };
      parent = dir;
      node = next;
      if (i + 1 < d) {
        // Another component follows, so `next` must be a directory to look it up in.
        if (!isDirNode(next)) return { ok: false, code: 'NOT_DIR', at: i + 1, dir };
        dir = next;
      }
    }
    return { ok: true, node, parent, depth: d };
  }

  /**
   * Depth-first walk with an explicit stack (DSA-TREE-03: no recursion, so a 10^4-level chain
   * cannot overflow the call stack). Stack slot i holds the directory at depth i (as the entry
   * that reached it) and the iterator over its entries. Every link is produced by exactly one
   * iterator step and every loaded directory is pushed and popped once, so the walk is O(k) for
   * the k links below `from`. Pre-order yields an entry when it is reached; post-order yields a
   * leaf when it is reached and a directory when its frame is popped, i.e. after its children.
   *
   * Entering a directory costs one extra pass over its entries (prefetchChildren), still O(k) in
   * total. The iterators are live Map iterators: an entry added to a directory that is still being
   * visited while the walk is paused is visited, and one deleted before it is reached is skipped.
   */
  *walk(from: DirNode<P>, order: 'pre' | 'post' = 'pre'): Generator<WalkEntry<P>> {
    const post = order === 'post';
    const start: WalkEntry<P> = { node: from, dir: null, name: from.name, depth: 0 };
    // Read the children map before any yield, so the consumer cannot change what we descend into.
    const children = from.children;
    if (children === null) {
      yield start; // an unloaded start directory: the walk is just itself, in either order
      return;
    }
    if (!post) yield start;
    prefetchChildren(children);
    const frames: WalkEntry<P>[] = [start];
    const iterators: Iterator<[string, TreeNode<P>]>[] = [children.entries()];
    while (iterators.length > 0) {
      const top = iterators.length - 1;
      const step = (iterators[top] as Iterator<[string, TreeNode<P>]>).next();
      if (step.done === true) {
        // Every child of this directory has been visited: pop its frame (the start frame last).
        iterators.pop();
        const done = frames.pop() as WalkEntry<P>;
        if (post) yield done;
        continue;
      }
      const [name, node] = step.value;
      const entry: WalkEntry<P> = {
        node,
        dir: (frames[top] as WalkEntry<P>).node as DirNode<P>,
        name,
        depth: top + 1,
      };
      // Read the children map before yielding, so the consumer cannot change what we descend into.
      const below = isDirNode(node) ? node.children : null;
      if (below === null) {
        yield entry; // a file, a symlink or an unloaded directory: nothing below it
      } else {
        if (!post) yield entry;
        prefetchChildren(below);
        frames.push(entry);
        iterators.push(below.entries());
      }
    }
  }

  // --- mutations --------------------------------------------------------------------------------

  attach(dir: DirNode<P>, name: string, node: TreeNode<P>): void {
    const children = this.#mutable(dir);
    if (!isValidName(name)) throw invalidName(name);
    if (children.has(name)) throw duplicate(dir, name);
    if (isDirNode(node)) {
      // T3 and cycle safety in one O(1) check: the root and every linked directory are live.
      if (this.#isLive(node))
        throw invalid(
          `directory ${node.id} is already in the tree (directories cannot be hard-linked)`,
        );
      if (hasContent(node)) this.#checkGraft(node, new Set([node]));
    }
    // Every check has passed and nothing below throws, so a refused attach changed nothing.
    children.set(name, node);
    this.#links++;
    if (isDirNode(node)) this.#adopt(dir, name, node);
    else this.#addLink(node);
  }

  detach(dir: DirNode<P>, name: string): TreeNode<P> | undefined {
    if (dir === this.root && name === '') throw invalid('the root cannot be detached');
    const children = this.#mutable(dir);
    const node = children.get(name);
    if (node === undefined) return undefined;
    children.delete(name);
    this.#links--;
    this.#removeLink(node);
    if (isDirNode(node)) {
      this.#dropBelow(node); // nothing to do for an empty or unloaded directory
      node.parent = null; // now the top of a free subtree, which may be attached again
    }
    return node;
  }

  move(src: DirNode<P>, name: string, dst: DirNode<P>, newName: string): void {
    if (src === this.root && name === '') throw invalid('the root cannot be moved');
    const from = this.#mutable(src);
    const to = this.#mutable(dst);
    const node = from.get(name);
    if (node === undefined)
      throw new DsaError(
        'NOT_FOUND',
        `dsa/tree: directory ${src.id} has no entry ${JSON.stringify(name)}`,
      );
    if (src === dst && name === newName) return; // same parent and name: nothing changes
    if (!isValidName(newName)) throw invalidName(newName);
    // DSA-TREE-02 cycle check, O(depth(dst)): a directory may not move into itself or below itself,
    // and dst is below node exactly when node is on dst's parent chain.
    if (isDirNode(node) && this.isAncestor(node, dst)) {
      throw invalid(`cannot move directory ${node.id} into its own subtree (${dst.id})`);
    }
    if (to.has(newName)) throw duplicate(dst, newName);
    // The re-link: one delete, one set and, for a directory, two field writes. No descendant is
    // touched because no node stores its path or depth, so the cost is independent of the subtree.
    // The registry does not change: the node stays loaded with the same number of links.
    from.delete(name);
    to.set(newName, node);
    if (isDirNode(node)) {
      node.parent = dst;
      node.name = newName;
    }
  }

  setLoaded(dir: DirNode<P>, entries: Iterable<[string, TreeNode<P>]>): void {
    this.#requireLive(dir);
    if (dir.children !== null) throw invalid(`directory ${dir.id} is already loaded`);
    // Phase 1, validation (O(k)): build the map aside and check every entry, so a refused call
    // leaves the tree unchanged. `pending` holds the directories this call would add, so one
    // directory cannot arrive twice (under two names, or inside two grafted subtrees).
    const map = new Map<string, TreeNode<P>>();
    let pending: Set<DirNode<P>> | null = null;
    for (const [name, node] of entries) {
      if (!isValidName(name)) throw invalidName(name);
      if (map.has(name))
        throw new DsaError('DUPLICATE', `dsa/tree: entry ${JSON.stringify(name)} appears twice`);
      if (isDirNode(node)) {
        pending ??= new Set();
        if (this.#isLive(node) || pending.has(node)) {
          throw invalid(
            `directory ${node.id} is already in the tree (directories cannot be hard-linked)`,
          );
        }
        pending.add(node);
        if (hasContent(node)) this.#checkGraft(node, pending);
      }
      map.set(name, node);
    }
    // Phase 2, install (O(k)).
    dir.children = map;
    for (const [name, node] of map) {
      this.#links++;
      if (isDirNode(node)) this.#adopt(dir, name, node);
      else this.#addLink(node);
    }
  }

  unload(dir: DirNode<P>): void {
    this.#requireLive(dir);
    if (dir.children === null) return;
    // The dropped entries leave the loaded set, so they leave `size` (T6). The VFS evicts only
    // leaf directories, so this visits only the directory's own entries.
    this.#dropBelow(dir);
    dir.children = null;
  }

  // --- the registry -----------------------------------------------------------------------------

  #isLive(node: TreeNode<P>): boolean {
    return (this.#registry.get(node) ?? 0) > 0;
  }

  /** INVALID unless `dir` is a loaded node of this tree. O(1) average. */
  #requireLive(dir: DirNode<P>): void {
    if (!this.#isLive(dir)) throw invalid(`directory ${dir.id} is not a loaded node of this tree`);
  }

  /** The children map of a directory about to be mutated: live, and its children loaded. */
  #mutable(dir: DirNode<P>): Map<string, TreeNode<P>> {
    this.#requireLive(dir);
    const children = dir.children;
    if (children === null) throw notLoaded(dir);
    return children;
  }

  /** One more live link to `node`. O(1) average; never deletes from the Map. */
  #addLink(node: TreeNode<P>): void {
    const count = this.#registry.get(node);
    this.#registry.set(node, (count ?? 0) + 1); // an update in place when the key is present
    if (count === undefined || count === 0) {
      this.#live++; // 0 → 1: the node becomes loaded
      if (count === 0) this.#tombstones--; // a tombstone revived
    }
  }

  /** One live link to `node` fewer. O(1) amortised: see #compact. */
  #removeLink(node: TreeNode<P>): void {
    const count = this.#registry.get(node) ?? 0; // ≥ 1: only linked nodes are unlinked
    this.#registry.set(node, count - 1);
    if (count === 1) {
      this.#live--; // 1 → 0: the node leaves the loaded set and becomes a tombstone
      this.#tombstones++;
      if (this.#tombstones > this.#live) this.#compact();
    }
  }

  /**
   * Rebuild the registry without its tombstones (a fresh Map, so no deleted entries linger in V8's
   * bucket chains). O(live + tombstones) = O(tombstones), since it runs when tombstones > live.
   * Every tombstone removed here became one by a distinct #removeLink since the previous rebuild
   * (which removed all older ones), so the rebuild costs O(1) amortised per unlink. After every
   * operation tombstones ≤ live, so the registry holds at most 2·size entries.
   */
  #compact(): void {
    const kept = new Map<TreeNode<P>, number>();
    for (const [node, count] of this.#registry) {
      if (count > 0) kept.set(node, count);
    }
    this.#registry = kept;
    this.#tombstones = 0;
  }

  /**
   * Validation half of a graft: `top` is a detached directory that still holds loaded content.
   * Throws INVALID if a directory below it is already in the tree or is reached twice (it would
   * then be linked twice, T3, or close a cycle, T4) or if a key is not a valid name (T5).
   * `pending` must already contain `top`. O(k) for the k links below `top`; iterative.
   *
   * Termination: every directory pushed is first added to `pending`, and a directory already in
   * `pending` is refused, so each directory is expanded at most once.
   */
  #checkGraft(top: DirNode<P>, pending: Set<DirNode<P>>): void {
    const stack: DirNode<P>[] = [top];
    for (let d = stack.pop(); d !== undefined; d = stack.pop()) {
      if (d.children === null) continue;
      for (const [key, c] of d.children) {
        if (!isValidName(key)) throw invalidName(key);
        if (!isDirNode(c)) continue;
        if (this.#isLive(c) || pending.has(c)) {
          throw invalid(
            `directory ${c.id} below ${top.id} is already in the tree or appears twice`,
          );
        }
        pending.add(c);
        stack.push(c);
      }
    }
  }

  /**
   * Install half of attach/setLoaded for a directory `top` now linked as `parent/name`: set its
   * parent and name (T2), register it, and register everything loaded below it (a graft that
   * #checkGraft has validated). O(1) when `top` is empty or unloaded, O(k) for k links otherwise.
   */
  #adopt(parent: DirNode<P>, name: string, top: DirNode<P>): void {
    top.parent = parent;
    top.name = name;
    this.#addLink(top);
    if (!hasContent(top)) return;
    const stack: DirNode<P>[] = [top];
    for (let d = stack.pop(); d !== undefined; d = stack.pop()) {
      if (d.children === null) continue;
      for (const [key, c] of d.children) {
        this.#links++;
        this.#addLink(c);
        if (isDirNode(c)) {
          c.parent = d; // T2 holds for grafted directories too
          c.name = key;
          stack.push(c);
        }
      }
    }
  }

  /**
   * Remove every link below `top` from the accounting (`top` itself is the caller's business).
   * The maps below `top` are left intact, so a detached subtree can be attached again. O(k) for the
   * k links below `top`, O(1) amortised because each of them was counted in by an O(1) step.
   */
  #dropBelow(top: DirNode<P>): void {
    if (!hasContent(top)) return;
    const stack: DirNode<P>[] = [top];
    for (let d = stack.pop(); d !== undefined; d = stack.pop()) {
      if (d.children === null) continue;
      for (const c of d.children.values()) {
        this.#links--;
        this.#removeLink(c);
        if (isDirNode(c)) stack.push(c);
      }
    }
  }

  // --- accounting and checking ------------------------------------------------------------------

  stats(): DsaStats {
    const registered = this.#live + this.#tombstones;
    return {
      size: this.#live,
      // Registry slots in use, tombstones included (they are reclaimed by the next rebuild).
      capacity: registered,
      bytesAllocated: (this.#links + registered) * MAP_ENTRY_BYTES,
      bytesUsed: (this.#links + this.#live) * MAP_ENTRY_BYTES,
    };
  }

  /**
   * Recomputes everything from the node objects alone, with one iterative walk from the root, and
   * compares it with the registry. O(n) time and memory; for tests and __DEV__ builds only. The
   * walk cannot loop on a corrupted tree: a directory reached a second time fails T3 first.
   */
  checkInvariants(): void {
    const root = this.root;
    if (root.parent !== null || root.name !== '') {
      throw corrupt(
        'T1',
        `the root has parent ${root.parent?.id ?? 'null'} and name ${JSON.stringify(root.name)}`,
      );
    }

    // One walk collects the loaded directories, each file's link count and the number of links.
    const dirs = new Set<DirNode<P>>([root]);
    const files = new Map<TreeNode<P>, number>();
    let links = 0;
    const stack: DirNode<P>[] = [root];
    for (let d = stack.pop(); d !== undefined; d = stack.pop()) {
      if (d.children === null) continue;
      for (const [key, c] of d.children) {
        links++;
        if (!isValidName(key))
          throw corrupt('T5', `directory ${d.id} has an invalid key ${JSON.stringify(key)}`);
        if (!isDirNode(c)) {
          files.set(c, (files.get(c) ?? 0) + 1);
          continue;
        }
        // T3 first: a directory reached twice is linked from two maps (or is the root). Checking it
        // before expanding also guarantees that the walk ends on a corrupted, cyclic structure.
        if (dirs.has(c)) throw corrupt('T3', `directory ${c.id} is linked from more than one map`);
        if (c.parent !== d || c.name !== key) {
          throw corrupt(
            'T2',
            `directory ${c.id} is entry ${JSON.stringify(key)} of ${d.id} but has parent ` +
              `${c.parent?.id ?? 'null'} and name ${JSON.stringify(c.name)}`,
          );
        }
        dirs.add(c);
        stack.push(c);
      }
    }

    // T4: every loaded directory reaches the root by parent pointers within `size` steps. `dirs`
    // lists directories in discovery order, each after the directory it was found in, so it is
    // enough to check, in that order, that each one's parent is a directory already known to reach
    // the root: by induction every chain then reaches it, one step per level, and a chain has at
    // most |dirs| ≤ size steps. (Given T2 this cannot fail; it is checked directly as §5 lists it.)
    const reaches = new Set<DirNode<P>>([root]);
    for (const d of dirs) {
      if (d === root) continue;
      if (d.parent === null || !reaches.has(d.parent)) {
        throw corrupt(
          'T4',
          `the parent chain of ${d.id} does not reach the root (parent ${d.parent?.id ?? 'null'})`,
        );
      }
      reaches.add(d);
    }

    // T6: `size` counts exactly the distinct loaded nodes found by the walk, and the registry
    // holds exactly their link counts (directories 1, files one per link) plus tombstones.
    const distinct = dirs.size + files.size;
    if (this.size !== distinct)
      throw corrupt('T6', `size is ${this.size} but ${distinct} distinct nodes are loaded`);
    for (const d of dirs) {
      const count = this.#registry.get(d);
      if (count !== 1)
        throw corrupt(
          'T6',
          `loaded directory ${d.id} has registry count ${count ?? 'none'}, not 1`,
        );
    }
    for (const [f, n] of files) {
      const count = this.#registry.get(f);
      if (count !== n)
        throw corrupt('T6', `file ${f.id} has ${n} links but registry count ${count ?? 'none'}`);
    }
    let live = 0;
    let tombstones = 0;
    for (const count of this.#registry.values()) {
      if (count > 0) live++;
      else if (count === 0) tombstones++;
      else throw corrupt('T6', `a registry count is negative (${count})`);
    }
    if (live !== this.#live || tombstones !== this.#tombstones) {
      throw corrupt(
        'T6',
        `registry holds ${live} live and ${tombstones} dead nodes, counters say ${this.#live} and ${this.#tombstones}`,
      );
    }
    if (this.#tombstones > this.#live)
      throw corrupt('T6', `${this.#tombstones} tombstones outnumber ${this.#live} live nodes`);
    if (this.#links !== links)
      throw corrupt('T6', `${links} links are loaded but ${this.#links} are counted`);
  }
}

/** A tree whose root directory has id `rootId` and an empty loaded children map. */
export function createTree<P>(rootId: string, rootPayload: P): NaryTree<P> {
  return new LinkedNaryTree(rootId, rootPayload);
}
