/**
 * VFS events on the kernel bus (virtual-file-system.md §3.18, §3.19; syscall-abi.md §3.8, §4.6;
 * PVFS-07, ABI-07, SYS-03).
 *
 * - Planners emit drafts; `FsEvents.publish` stamps them (per-boot `vseq`, time, origin, actor, op)
 *   and is called only after the transaction's `oncomplete`, in commit order. An aborted
 *   transaction publishes nothing.
 * - Kernel-internal consumers (the dcache, the `complete` trie, the indexer) `listen` and receive
 *   the rich item events, `vfs.load` included, unfiltered (the trie filters at query time, §3.19).
 * - Directory watchers (the File Explorer, `watch`) receive the events of one directory, filtered
 *   by the watcher's credentials on the current tree (§3.18 delivery filter).
 * - Process subscribers receive the per-item ABI payloads (`toBusEvents`) through the kernel
 *   `EventBus`; the visibility hook installed here delivers a `vfs.*` event only to subscribers
 *   with r on the parent directory and x on every ancestor (for `vfs.rename`: either side).
 * - `permEpoch` counts `chmod`, `chown`, `rename`, `link` and `unlink` events (RAG caches).
 */
import type { EventData, KEvent, Topic } from '@plotinium/protocol';
import type { BusEvent, FsView, Uuid, VfsEvent, VfsEventDraft, VfsOrigin } from '@plotinium/vfs';
import { EventStamper, R, X, filterEvent, may, toBusEvents } from '@plotinium/vfs';
import type { Cred } from '@plotinium/vfs';

import type { SubscriberCred, VisibilityHook } from '../events/bus.ts';

/** The part of the kernel `EventBus` the file system uses. */
export interface FsBus {
  publish<T extends Topic>(topic: T, data: EventData[T]): unknown;
  addVisibilityHook(hook: VisibilityHook): () => void;
}

export type VfsListener = (ev: VfsEvent) => void;

export interface PublishMeta {
  readonly t: number;
  readonly origin: VfsOrigin;
  readonly actorUid: number;
  readonly opId?: Uuid;
}

const PERM_TOPICS: ReadonlySet<string> = new Set([
  'vfs.chmod',
  'vfs.chown',
  'vfs.rename',
  'vfs.link',
  'vfs.unlink',
]);

/** Publish one ABI event; `T` is inferred per union member, so no cast is needed. */
function publishOne<T extends Topic>(bus: FsBus, e: { topic: T; data: EventData[T] }): void {
  bus.publish(e.topic, e.data);
}

/** The directories an event item concerns (for watchers). */
function dirsOf(ev: VfsEvent): Uuid[] {
  switch (ev.topic) {
    case 'vfs.create':
    case 'vfs.write':
    case 'vfs.unlink':
    case 'vfs.link':
      return ev.data.items.map((i) => i.parent);
    case 'vfs.rename':
      return ev.data.items
        .flatMap((i) => [i.from?.parent, i.to?.parent])
        .filter((d) => d !== undefined);
    case 'vfs.chmod':
    case 'vfs.chown':
      return [ev.data.rootParent, ev.data.root];
    case 'vfs.conflict':
      return [ev.data.parent, ev.data.keptAs.parent];
    case 'vfs.load':
      return [ev.data.dir];
    case 'vfs.utimes':
    case 'vfs.revert':
      return [];
  }
}

export class FsEvents {
  private readonly bus: FsBus;
  private readonly view: () => FsView | null;
  private readonly onError: (msg: string) => void;
  private readonly stamper = new EventStamper();
  private readonly listeners = new Set<VfsListener>();
  private epoch = 0;
  private uninstall: (() => void) | null = null;

  constructor(bus: FsBus, view: () => FsView | null, onError: (msg: string) => void = () => {}) {
    this.bus = bus;
    this.view = view;
    this.onError = onError;
  }

  /** Changes on every chmod, chown, rename, link and unlink (§3.18 `permEpoch`). */
  get permEpoch(): number {
    return this.epoch;
  }

  /** Install the `vfs.*` visibility hook on the bus (idempotent). */
  install(): void {
    this.uninstall ??= this.bus.addVisibilityHook((cred, event) => this.visible(cred, event));
  }

  dispose(): void {
    this.uninstall?.();
    this.uninstall = null;
    this.listeners.clear();
  }

  /** Kernel-internal consumers: every event, unfiltered. Returns the unsubscribe function. */
  listen(listener: VfsListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Watch one directory as `cred`: events whose items concern `dir`, filtered by what `cred` may
   * see on the current tree at publish time.
   */
  watch(cred: Cred, dir: Uuid, listener: VfsListener): () => void {
    return this.listen((ev) => {
      if (!dirsOf(ev).includes(dir)) return;
      const seen = filterEvent(
        ev,
        (d) => this.canSee(cred, d),
        cred.uid === 0 || cred.uid === ev.actorUid,
      );
      if (seen !== null) listener(seen);
    });
  }

  /** Stamp and publish committed drafts (call only after `oncomplete`). */
  publish(drafts: readonly VfsEventDraft[], meta: PublishMeta): VfsEvent[] {
    if (drafts.length === 0) return [];
    const events = this.stamper.stamp(drafts, meta);
    for (const ev of events) {
      if (PERM_TOPICS.has(ev.topic)) this.epoch++;
      for (const l of this.listeners) {
        try {
          l(ev);
        } catch (e) {
          this.onError(
            `vfs event listener failed on ${ev.topic}: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
      for (const be of toBusEvents(ev)) this.publishBus(be);
    }
    return events;
  }

  private publishBus(e: BusEvent): void {
    try {
      publishOne(this.bus, e);
    } catch (err) {
      this.onError(
        `bus publish failed on ${e.topic}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Whether `cred` has r on directory `dir` and x on every ancestor of it, on the current tree.
   * Unknown or unloaded directories are not visible (fail closed).
   */
  canSee(cred: SubscriberCred, dir: Uuid): boolean {
    if (cred.uid === 0) return true;
    const view = this.view();
    if (view === null) return false;
    const node = view.inode(dir);
    if (node?.type !== 'd' || !may(cred, node, R)) return false;
    let cur = dir;
    for (let i = 0; i < 4096 && cur !== view.rootIno; i++) {
      const d = view.dirEntry(cur);
      if (d === undefined) return false;
      const parent = view.inode(d.parent);
      if (parent === undefined || !may(cred, parent, X)) return false;
      cur = d.parent;
    }
    return cur === view.rootIno;
  }

  /** The directory holding `ino` (a directory's parent, or a file's first link). */
  private parentOf(ino: Uuid): Uuid | undefined {
    const view = this.view();
    if (view === null) return undefined;
    if (ino === view.rootIno) return ino;
    return view.dirEntry(ino)?.parent ?? view.links(ino)[0]?.parent;
  }

  /** The bus visibility hook for `vfs.*` topics (undefined: not ours, use the bus default). */
  visible(cred: SubscriberCred, event: KEvent): boolean | undefined {
    if (
      event.topic === 'vfs.create' ||
      event.topic === 'vfs.write' ||
      event.topic === 'vfs.unlink'
    ) {
      return this.canSee(cred, event.data.parent);
    }
    if (event.topic === 'vfs.rename') {
      return this.canSee(cred, event.data.fromParent) || this.canSee(cred, event.data.toParent);
    }
    if (event.topic === 'vfs.chmod' || event.topic === 'vfs.chown') {
      const p = this.parentOf(event.data.root);
      return p !== undefined && this.canSee(cred, p);
    }
    if (event.topic === 'vfs.conflict') {
      if (cred.uid === 0) return true;
      const p = this.parentOf(event.data.keptAs.ino);
      return p !== undefined && this.canSee(cred, p);
    }
    // `vfs.rejected` belongs to syncd (originating uid only); other groups keep the bus default.
    return undefined;
  }
}
