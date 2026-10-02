/**
 * `vfs.*` events (virtual-file-system.md §3.18, §4.5; PVFS-07).
 *
 * Planners emit drafts; the kernel stamps them (`vseq`, time, origin) and publishes them only after
 * the transaction's `oncomplete`, never for an aborted one. Kernel-internal consumers (dcache, the
 * `complete` trie, the indexer) receive these rich item arrays; processes subscribed through
 * `sys.subscribe` receive the per-item payloads of protocol/src/events.ts (syscall-abi.md §4.6),
 * produced by `toBusEvents`.
 */
import type { Errno, EventData } from '@plotinium/protocol';

import { EVENT_ITEMS_MAX } from './limits.ts';
import type { InodeType, Sha256Hex, Uuid } from './store/records.ts';

export type VfsOrigin = 'local' | 'remote' | 'revert' | 'mkfs' | 'fsck';

export interface EntryRef {
  readonly parent: Uuid;
  readonly name: string;
}

export interface VfsEventData {
  'vfs.create': {
    items: {
      ino: Uuid;
      parent: Uuid;
      name: string;
      type: InodeType;
      mode: number;
      uid: number;
      gid: number;
      size: number;
      version: number;
    }[];
    truncated?: true;
  };
  /** `parent` is the entry the writer used (projection to syscall-abi.md `vfs.write`). */
  'vfs.write': {
    items: { ino: Uuid; parent: Uuid; version: number; size: number; blob: Sha256Hex }[];
    truncated?: true;
  };
  'vfs.rename': {
    items: {
      ino: Uuid;
      type: InodeType;
      from: EntryRef | null;
      to: EntryRef | null;
      replaced?: Uuid;
    }[];
    truncated?: true;
  };
  'vfs.unlink': {
    items: {
      parent: Uuid;
      name: string;
      ino: Uuid;
      type: InodeType;
      inos: Uuid[];
      count: number;
    }[];
    truncated?: true;
  };
  'vfs.link': { items: { ino: Uuid; parent: Uuid; name: string; nlink: number }[] };
  /** `root`/`recursive` describe the call (projection to syscall-abi.md `vfs.chmod`). */
  'vfs.chmod': {
    root: Uuid;
    rootParent: Uuid;
    recursive: boolean;
    items: { ino: Uuid; mode: number; version: number }[];
    truncated?: true;
  };
  'vfs.chown': {
    root: Uuid;
    rootParent: Uuid;
    recursive: boolean;
    items: { ino: Uuid; uid: number; gid: number; version: number }[];
    truncated?: true;
  };
  'vfs.utimes': { items: { ino: Uuid; mtime: number }[] };
  'vfs.conflict': {
    ino: Uuid;
    parent: Uuid;
    path: string;
    keptAs: { ino: Uuid; path: string; parent: Uuid };
    by: string;
    source: 'local' | 'server';
  };
  'vfs.load': { dir: Uuid; entries: { name: string; ino: Uuid; type: InodeType }[] };
  'vfs.revert': { opId: Uuid; errno: Errno; detail?: string };
}

export type VfsTopic = keyof VfsEventData;

export type VfsEventDraft = { [T in VfsTopic]: { topic: T; data: VfsEventData[T] } }[VfsTopic];

export type VfsEvent = VfsEventDraft & {
  readonly vseq: number;
  readonly t: number;
  readonly origin: VfsOrigin;
  readonly opId?: Uuid;
  readonly actorUid: number;
};

/** Items beyond EVENT_ITEMS_MAX are cut and `truncated` is set; consumers then reconcile (§3.18). */
export function capItems(draft: VfsEventDraft): VfsEventDraft {
  if (!('items' in draft.data) || draft.data.items.length <= EVENT_ITEMS_MAX) return draft;
  const data = {
    ...draft.data,
    items: draft.data.items.slice(0, EVENT_ITEMS_MAX),
    truncated: true,
  };
  return { topic: draft.topic, data } as VfsEventDraft;
}

/** Per-boot monotonic stamping, in commit order. */
export class EventStamper {
  private vseq = 0;

  stamp(
    drafts: readonly VfsEventDraft[],
    meta: { t: number; origin: VfsOrigin; actorUid: number; opId?: Uuid },
  ): VfsEvent[] {
    return drafts.map((d) => ({ ...capItems(d), vseq: ++this.vseq, ...meta }));
  }
}

/**
 * Delivery filter (§3.18, SYS-01, RAG-03): an item reaches a subscriber only if `canSee(parent)` (r
 * on the parent, x on every ancestor, on the current tree). A rename is delivered when either side
 * is visible, with the invisible side replaced by null. Returns null when nothing is left.
 */
export function filterEvent(
  ev: VfsEvent,
  canSee: (dir: Uuid) => boolean,
  isWriterOrRoot = false,
): VfsEvent | null {
  const keep = <I>(items: readonly I[], parentOf: (i: I) => Uuid): I[] =>
    items.filter((i) => canSee(parentOf(i)));
  switch (ev.topic) {
    case 'vfs.create':
    case 'vfs.write':
    case 'vfs.unlink':
    case 'vfs.link': {
      const items = keep<{ parent: Uuid }>(ev.data.items, (i) => i.parent);
      return items.length === 0 ? null : ({ ...ev, data: { ...ev.data, items } } as VfsEvent);
    }
    case 'vfs.rename': {
      const items = ev.data.items
        .map((i) => ({
          ...i,
          from: i.from !== null && canSee(i.from.parent) ? i.from : null,
          to: i.to !== null && canSee(i.to.parent) ? i.to : null,
        }))
        .filter((i) => i.from !== null || i.to !== null);
      return items.length === 0 ? null : { ...ev, data: { ...ev.data, items } };
    }
    case 'vfs.chmod':
    case 'vfs.chown':
      return canSee(ev.data.rootParent) ? ev : null;
    case 'vfs.utimes':
      return ev;
    case 'vfs.load':
      return canSee(ev.data.dir) ? ev : null;
    case 'vfs.conflict':
      return isWriterOrRoot || canSee(ev.data.parent) ? ev : null;
    case 'vfs.revert':
      return isWriterOrRoot ? ev : null;
  }
}

export type BusEvent = {
  [T in keyof EventData]: { topic: T; data: EventData[T] };
}[keyof EventData];

const INOS_MAX = 1000;

/**
 * Projection to the ABI payloads of syscall-abi.md §4.6. Topics the ABI does not register yet
 * (`vfs.link`, `vfs.utimes`, `vfs.load`, `vfs.revert`; cross-spec request X-ABI-2) have no
 * projection. `revert`, `mkfs` and `fsck` origins are local changes on the wire.
 */
export function toBusEvents(ev: VfsEvent): BusEvent[] {
  const origin = ev.origin === 'remote' ? 'remote' : 'local';
  const op = ev.opId === undefined ? {} : { opId: ev.opId };
  switch (ev.topic) {
    case 'vfs.create':
      return ev.data.items.map((i) => ({
        topic: 'vfs.create',
        data: {
          ino: i.ino,
          parent: i.parent,
          name: i.name,
          type: i.type,
          uid: i.uid,
          version: i.version,
          origin,
          ...op,
        },
      }));
    case 'vfs.write':
      return ev.data.items.map((i) => ({
        topic: 'vfs.write',
        data: { ino: i.ino, parent: i.parent, version: i.version, size: i.size, origin, ...op },
      }));
    case 'vfs.rename':
      return ev.data.items.flatMap((i) =>
        i.from === null || i.to === null
          ? []
          : [
              {
                topic: 'vfs.rename' as const,
                data: {
                  ino: i.ino,
                  fromParent: i.from.parent,
                  fromName: i.from.name,
                  toParent: i.to.parent,
                  toName: i.to.name,
                  origin,
                  ...op,
                },
              },
            ],
      );
    case 'vfs.unlink':
      return ev.data.items.map((i) => ({
        topic: 'vfs.unlink',
        data: {
          inos: i.inos.slice(0, INOS_MAX),
          ...(i.inos.length > INOS_MAX || ev.data.truncated === true ? { truncated: true } : {}),
          parent: i.parent,
          name: i.name,
          origin,
          ...op,
        },
      }));
    case 'vfs.chmod':
    case 'vfs.chown': {
      const first = ev.data.items[0];
      if (first === undefined) return [];
      const inos = ev.data.items.map((i) => i.ino);
      const attrs =
        ev.topic === 'vfs.chmod' ? sameMode(ev.data.items) : chownAttrs(ev.data.items[0]);
      return [
        {
          topic: ev.topic,
          data: {
            root: ev.data.root,
            inos: inos.slice(0, INOS_MAX),
            ...(inos.length > INOS_MAX || ev.data.truncated === true ? { truncated: true } : {}),
            ...attrs,
            recursive: ev.data.recursive,
            origin,
          },
        },
      ];
    }
    case 'vfs.conflict':
      return [
        {
          topic: 'vfs.conflict',
          data: {
            ino: ev.data.ino,
            keptAs: { ino: ev.data.keptAs.ino, path: ev.data.keptAs.path },
            by: ev.data.by,
          },
        },
      ];
    case 'vfs.link':
    case 'vfs.utimes':
    case 'vfs.load':
    case 'vfs.revert':
      return [];
  }
}

/** `mode` only when every changed inode got the same one (a symbolic `chmod -R` may differ per inode). */
function sameMode(items: readonly { mode: number }[]): { mode?: number } {
  const modes = new Set(items.map((i) => i.mode));
  const [only] = modes;
  return modes.size === 1 && only !== undefined ? { mode: only } : {};
}

function chownAttrs(i: { uid: number; gid: number } | undefined): { uid?: number; gid?: number } {
  return i === undefined ? {} : { uid: i.uid, gid: i.gid };
}
