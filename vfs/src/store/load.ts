/**
 * Lazy directory loading (virtual-file-system.md §5.8, PVFS-14, PVFS-18). A directory's entries are
 * read with chunked read-only scans of its `dentries` key range, then its children's inodes with a
 * chunked `getMany`. Concurrent callers share ONE in-flight promise per directory, so two loads can
 * never create two nodes for one inode.
 */
import type { VfsEventDraft } from '../events.ts';
import type { DentryRec, InodeRec, Uuid } from './records.ts';
import type { ReadStore } from './store.ts';
import { dirBounds } from './store.ts';
import type { VfsTree } from '../tree/vfs-tree.ts';

export interface LoaderHooks {
  /** Online and `mir = 0`: fetch the listing from the server first (§3.17.2, syncd). */
  readonly ensureMirrored?: (dir: Uuid) => Promise<void>;
  /** Publish `vfs.load` (feeds the trie, §3.19). */
  readonly onLoaded?: (event: VfsEventDraft) => void;
  readonly now?: () => number;
}

export class DirLoader {
  private readonly store: ReadStore;
  private readonly tree: VfsTree;
  private readonly hooks: LoaderHooks;
  private readonly inflight = new Map<Uuid, Promise<void>>();

  constructor(store: ReadStore, tree: VfsTree, hooks: LoaderHooks = {}) {
    this.store = store;
    this.tree = tree;
    this.hooks = hooks;
  }

  ensureLoaded(dir: Uuid): Promise<void> {
    if (this.tree.isLoaded(dir) || this.tree.inode(dir)?.type !== 'd') return Promise.resolve();
    const running = this.inflight.get(dir);
    if (running !== undefined) return running;
    const p = this.load(dir).finally(() => this.inflight.delete(dir));
    this.inflight.set(dir, p);
    return p;
  }

  /** Breadth-first by level; each level's directories load concurrently (§5.8). */
  async ensureLoadedSubtree(root: Uuid): Promise<void> {
    let level = [root];
    while (level.length > 0) {
      await Promise.all(level.map((d) => this.ensureLoaded(d)));
      const next: Uuid[] = [];
      for (const d of level) {
        const entries = this.tree.entries(d);
        if (typeof entries === 'string') continue;
        for (const e of entries) if (e.dtype === 'd') next.push(e.ino);
      }
      level = next;
    }
  }

  private async load(dir: Uuid): Promise<void> {
    const rec = this.tree.inode(dir);
    if (rec?.mir === 0 && this.tree.online && this.hooks.ensureMirrored !== undefined) {
      await this.hooks.ensureMirrored(dir);
    }
    const dentries: DentryRec[] = [];
    await this.store.scan<DentryRec>('dentries', dirBounds(dir), (d) => dentries.push(d));
    const inodes = await this.store.getMany<InodeRec>(
      'inodes',
      dentries.map((d) => d.ino),
    );
    if (this.tree.isLoaded(dir)) return;
    this.tree.load(dir, dentries, inodes, this.hooks.now?.() ?? 0);
    this.hooks.onLoaded?.({
      topic: 'vfs.load',
      data: { dir, entries: dentries.map((d) => ({ name: d.name, ino: d.ino, type: d.dtype })) },
    });
  }
}
