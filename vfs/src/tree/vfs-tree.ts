/**
 * The kernel's in-memory inode tree (virtual-file-system.md §3.2 "In-memory node", §5.8), built on
 * the team's n-ary tree (`dsa/tree`, C16; injected, so tests use a double). Directory nodes hold a
 * hash map name → child (O(1) lookup, O(depth) resolution: VFS-01); file and symlink nodes are
 * leaves shared by every directory that links them. The payload of each node is its inode record.
 *
 * The tree implements `FsView` for the planners and changes only through `apply(writes)` after a
 * transaction's `oncomplete` (§3.11 phase 3) and through `load` when a directory is read (§5.8).
 */
import type { DirNode, NaryTree, TreeNode } from '@plotinium/dsa/tree';
import { INO, SYNTH_FILES } from '@plotinium/protocol';

import type { StoreWrite } from '../ops/plan.ts';
import type { DentryRec, InodeRec, UserRec, Uuid } from '../store/records.ts';
import type { ChildLookup, EntryList, FsView } from '../view.ts';

export type VNode = TreeNode<InodeRec>;
export type VDir = DirNode<InodeRec>;

const linkKey = (parent: Uuid, name: string): string => `${parent}\u0000${name}`;

/** The stat-able record of a synthesised file (§3.3.5): never stored, root:root, version 1. */
export function synthRecord(ino: Uuid, mode: number, now = 0): InodeRec {
  return {
    ino,
    fs: 'root',
    type: 'f',
    mode,
    uid: 0,
    gid: 0,
    size: 0,
    nlink: 1,
    version: 1,
    atime: now,
    mtime: now,
    ctime: now,
    btime: now,
    blob: null,
    target: null,
  };
}

export class VfsTree implements FsView {
  readonly tree: NaryTree<InodeRec>;
  /** Every loaded node by ino (files once, however many links). */
  private readonly nodes = new Map<Uuid, VNode>();
  /** Loaded links of non-directories: ino → key → dentry. */
  private readonly linkIndex = new Map<Uuid, Map<string, DentryRec>>();
  readonly users = new Map<number, UserRec>();
  /** syncd LIVE: a miss in an unmirrored directory is a real miss, not EAGAIN (§3.17.2). */
  online = false;

  constructor(tree: NaryTree<InodeRec>) {
    this.tree = tree;
    this.nodes.set(tree.root.id, tree.root);
    // `createTree` starts with an empty loaded root; `/` is loaded from the store like any directory.
    if (tree.root.children?.size === 0) tree.unload(tree.root);
  }

  get rootIno(): Uuid {
    return this.tree.root.id;
  }

  node(ino: Uuid): VNode | undefined {
    return this.nodes.get(ino);
  }

  inode(ino: Uuid): InodeRec | undefined {
    return this.nodes.get(ino)?.payload;
  }

  private dir(ino: Uuid): VDir | undefined {
    const n = this.nodes.get(ino);
    return n !== undefined && this.tree.isDir(n) ? n : undefined;
  }

  isLoaded(dir: Uuid): boolean {
    return this.dir(dir)?.children != null;
  }

  child(dir: Uuid, name: string): ChildLookup {
    const d = this.dir(dir);
    if (d === undefined) return null;
    if (d.children === null) return 'NOT_LOADED';
    const c = this.tree.lookup(d, name);
    if (c !== undefined) return c.payload;
    return d.payload.mir === 0 && !this.online ? 'EAGAIN' : null;
  }

  entries(dir: Uuid): EntryList {
    const d = this.dir(dir);
    if (d === undefined) return [];
    if (d.children === null) return 'NOT_LOADED';
    if (d.payload.mir === 0 && !this.online) return 'EAGAIN';
    const out: DentryRec[] = [];
    for (const [name, c] of d.children)
      out.push({ parent: dir, name, ino: c.id, dtype: c.payload.type });
    return out;
  }

  dirEntry(dir: Uuid): DentryRec | undefined {
    const d = this.dir(dir);
    if (d?.parent == null) return undefined;
    return { parent: d.parent.id, name: d.name, ino: dir, dtype: 'd' };
  }

  links(ino: Uuid): readonly DentryRec[] {
    const d = this.dirEntry(ino);
    if (d !== undefined) return [d];
    return [...(this.linkIndex.get(ino)?.values() ?? [])];
  }

  user(uid: number): UserRec | undefined {
    return this.users.get(uid);
  }

  private makeNode(rec: InodeRec): VNode {
    const known = this.nodes.get(rec.ino);
    if (known !== undefined) {
      known.payload = rec;
      return known;
    }
    const n: VNode | VDir =
      rec.type === 'd'
        ? ({ id: rec.ino, payload: rec, parent: null, name: '', children: null } satisfies VDir)
        : { id: rec.ino, payload: rec };
    this.nodes.set(rec.ino, n);
    return n;
  }

  private indexLink(d: DentryRec, add: boolean): void {
    if (d.dtype === 'd') return;
    let m = this.linkIndex.get(d.ino);
    if (m === undefined) {
      if (!add) return;
      m = new Map();
      this.linkIndex.set(d.ino, m);
    }
    if (add) m.set(linkKey(d.parent, d.name), d);
    else {
      m.delete(linkKey(d.parent, d.name));
      if (m.size === 0) this.linkIndex.delete(d.ino);
    }
  }

  /**
   * Install a directory's children read from the store (§5.8), plus its synthesised files (§3.3.5).
   * Nodes already in memory (a hard-linked file seen through another directory) are reused, so one
   * inode is one node.
   */
  load(
    dir: Uuid,
    dentries: readonly DentryRec[],
    inodes: readonly (InodeRec | undefined)[],
    now = 0,
  ): void {
    const d = this.dir(dir);
    if (d === undefined || d.children !== null) return;
    const pairs: [string, VNode][] = [];
    dentries.forEach((e, i) => {
      const rec = inodes[i];
      if (rec === undefined) return;
      const n = this.makeNode(rec);
      if (this.tree.isDir(n)) {
        n.parent = d;
        n.name = e.name;
      }
      this.indexLink(e, true);
      pairs.push([e.name, n]);
    });
    for (const s of SYNTH_FILES) {
      if (INO[s.parent] !== dir) continue;
      const name = s.path.slice(s.path.lastIndexOf('/') + 1);
      if (pairs.some(([n]) => n === name)) continue; // I12: fsck reports the stored collision
      pairs.push([name, this.makeNode(synthRecord(s.ino, s.mode, now))]);
    }
    this.tree.setLoaded(d, pairs);
  }

  /** Drop a directory's children map (dcache eviction, §3.17.3); nodes of other links stay. */
  unload(dir: Uuid): void {
    const d = this.dir(dir);
    if (d?.children == null) return;
    for (const [name, c] of d.children)
      this.indexLink({ parent: dir, name, ino: c.id, dtype: c.payload.type }, false);
    this.tree.unload(d);
  }

  /** Apply a committed plan's writes, in order (§3.11 phase 3 step 1): O(changes). */
  apply(writes: readonly StoreWrite[]): void {
    const fresh = new Set<Uuid>();
    for (const w of writes) {
      if (w.store === 'inodes') {
        if (w.op === 'del') this.nodes.delete(w.key);
        else if (this.nodes.has(w.value.ino) || w.op === 'add') this.makeNode(w.value);
        if (w.op === 'add') fresh.add(w.value.ino);
        continue;
      }
      const parent = this.dir(w.value.parent);
      if (w.op === 'del') {
        if (parent?.children != null) this.tree.detach(parent, w.value.name);
        this.indexLink(w.value, false);
        continue;
      }
      const n = this.nodes.get(w.value.ino);
      if (parent?.children == null || n === undefined) continue; // not in memory: a later load reads the store
      this.tree.attach(parent, w.value.name, n);
      this.indexLink(w.value, true);
      // A directory created by this op is empty and fully known: no store read later.
      if (fresh.has(n.id) && this.tree.isDir(n) && n.children === null) this.tree.setLoaded(n, []);
    }
  }

  /** Loaded rows (fsck `--memory`, I14; tests). Synthesised entries excluded. */
  snapshot(): { inodes: InodeRec[]; dentries: DentryRec[] } {
    const synth = new Set(SYNTH_FILES.map((s) => s.ino));
    const inodes: InodeRec[] = [];
    const dentries: DentryRec[] = [];
    for (const n of this.nodes.values()) {
      if (synth.has(n.id)) continue;
      inodes.push(n.payload);
      if (this.tree.isDir(n) && n.children !== null) {
        for (const [name, c] of n.children) {
          if (!synth.has(c.id))
            dentries.push({ parent: n.id, name, ino: c.id, dtype: c.payload.type });
        }
      }
    }
    return { inodes, dentries };
  }
}
