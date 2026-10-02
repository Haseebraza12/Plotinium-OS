/**
 * The readable set R over the dense file table (rag-semantic-search.md §3.5 step 3, §5.2; RAG-03).
 *
 * R is computed from the CURRENT tree at query time, through an injected permission oracle (the
 * kernel passes `vfs/perm.ts`; ai/ may not import it), and BEFORE any row is ranked (I-A1). A file
 * is readable when the caller has `r` on it and at least one of its links sits in a directory the
 * caller can traverse (`x` on it and on every ancestor, POSIX semantics for hard links). A deleted
 * inode is absent from the tree and therefore never readable (I-A9). No permission bit is ever
 * copied into the index (I-A2).
 *
 * `traversable` is memoised per directory and computed iteratively (no input-depth recursion).
 */
import { INO } from '@plotinium/protocol';

import type { Cred, PermOracle, PermSubject } from '../util/cred.ts';
import { type Bitset, bitsetFor, setBit } from './bits.ts';

export type { Cred, PermOracle } from '../util/cred.ts';

/** One inode of the live tree as the kernel sees it now. */
export interface LiveNode extends PermSubject {
  readonly ino: string;
  readonly version: number;
  /** Directories holding a link to this node; one entry for a directory, empty for the root. */
  readonly parents: readonly string[];
}

export interface LiveTree {
  readonly rootIno: string;
  node(ino: string): LiveNode | undefined;
}

/** One slot of the kernel's dense file table (`fileIdx → {ino, inodeVersion}`). */
export interface FileSlot {
  readonly ino: string;
  readonly inodeVersion: number;
}

class Traversal {
  private readonly memo = new Map<string, boolean>();
  private readonly inScope = new Map<string, boolean>();

  private readonly cred: Cred;
  private readonly tree: LiveTree;
  private readonly oracle: PermOracle;
  private readonly scopeIno: string | undefined;

  constructor(cred: Cred, tree: LiveTree, oracle: PermOracle, scopeIno: string | undefined) {
    this.cred = cred;
    this.tree = tree;
    this.oracle = oracle;
    this.scopeIno = scopeIno;
  }

  /** x on `dir` and on every ancestor up to the root. */
  traversable(dirIno: string): boolean {
    // Walk up until a memoised answer, a directory without x, or the root. Every directory on the
    // chain except possibly the last had x, so they all share one answer.
    const chain: string[] = [];
    const seen = new Set<string>();
    let cur: string | undefined = dirIno;
    let result = false;
    while (cur !== undefined && !seen.has(cur)) {
      const known = this.memo.get(cur);
      if (known !== undefined) {
        result = known;
        break;
      }
      seen.add(cur);
      chain.push(cur);
      const node = this.tree.node(cur);
      if (node?.type !== 'd' || !this.oracle.may(this.cred, node, 'x')) break;
      if (cur === this.tree.rootIno) {
        result = true;
        break;
      }
      cur = node.parents[0];
    }
    for (const ino of chain) this.memo.set(ino, result);
    return result;
  }

  /** Whether `dirIno` is `scope` or lies below it. */
  underScope(dirIno: string): boolean {
    if (this.scopeIno === undefined) return true;
    const chain: string[] = [];
    let cur: string | undefined = dirIno;
    let found = false;
    const seen = new Set<string>();
    while (cur !== undefined && !seen.has(cur)) {
      const known = this.inScope.get(cur);
      if (known !== undefined) {
        found = known;
        break;
      }
      seen.add(cur);
      chain.push(cur);
      if (cur === this.scopeIno) {
        found = true;
        break;
      }
      cur = this.tree.node(cur)?.parents[0];
    }
    for (const ino of chain) this.inScope.set(ino, found);
    return found;
  }
}

/** Whether the caller may read file `node` through at least one traversable link (in scope). */
function readableNode(t: Traversal, cred: Cred, node: LiveNode, oracle: PermOracle): boolean {
  if (node.type !== 'f' || !oracle.may(cred, node, 'r')) return false;
  return node.parents.some((p) => t.traversable(p) && t.underScope(p));
}

export interface ReadableInput {
  cred: Cred;
  fileTable: readonly (FileSlot | undefined)[];
  tree: LiveTree;
  oracle: PermOracle;
  /** The resolved `scope` directory (semsearch --dir); resolution errors are the caller's. */
  scopeIno?: string;
}

/** R[fileIdx] for the caller, O(F + D) with memoised ancestors (§5.2). */
export function readableSet(input: ReadableInput): Bitset {
  const bits = bitsetFor(input.fileTable.length);
  const t = new Traversal(input.cred, input.tree, input.oracle, input.scopeIno);
  input.fileTable.forEach((slot, fileIdx) => {
    if (slot === undefined) return;
    const node = input.tree.node(slot.ino);
    if (node !== undefined && readableNode(t, input.cred, node, input.oracle))
      setBit(bits, fileIdx);
  });
  return bits;
}

/** The well-known system directories that never make a result foreign (§3.5 step 7). */
const SHARED_DIRS: ReadonlySet<string> = new Set([INO.ROOT, INO.HOME, INO.TMP, INO.MNT]);

/**
 * A result is foreign when the file's owner is not the caller, or a directory on its path (other
 * than `/`, `/home`, `/tmp`, `/mnt`) is owned by someone else. uid 0 has no foreign results.
 * `ancestors` are the directory inodes of the resolved path, root first.
 */
export function isForeign(cred: Cred, file: LiveNode, ancestors: readonly LiveNode[]): boolean {
  if (cred.uid === 0) return false;
  if (file.uid !== cred.uid) return true;
  return ancestors.some((d) => !SHARED_DIRS.has(d.ino) && d.uid !== cred.uid);
}

/**
 * Cache of readable sets keyed by `(uid, groupsHash, permEpoch, fileTableGeneration, scope)`. The
 * kernel bumps `permEpoch` on every chmod, chown, rename, unlink or group change, so a stale set is
 * never reused. At most `max` entries, oldest dropped first.
 */
export class ReadableCache {
  private readonly entries = new Map<string, Bitset>();
  private readonly max: number;

  constructor(max = 16) {
    this.max = max;
  }

  static key(cred: Cred, permEpoch: number, generation: number, scopeIno?: string): string {
    const groups = [...cred.groups].sort((a, b) => a - b).join(',');
    return `${cred.uid}|${cred.gid}|${groups}|${permEpoch}|${generation}|${scopeIno ?? ''}`;
  }

  getOrCompute(key: string, compute: () => Bitset): Bitset {
    const hit = this.entries.get(key);
    if (hit !== undefined) return hit;
    const bits = compute();
    this.entries.set(key, bits);
    if (this.entries.size > this.max) {
      const oldest = this.entries.keys().next();
      if (oldest.done !== true) this.entries.delete(oldest.value);
    }
    return bits;
  }

  get size(): number {
    return this.entries.size;
  }
}
