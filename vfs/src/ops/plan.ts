/**
 * The plan of one user-visible mutation (virtual-file-system.md §3.11 phase 1, PVFS-03).
 *
 * A planner reads the tree through `PlanBuilder.view` (an overlay, so its own earlier writes are
 * visible) and mutates it only through the builder, which records, in order, the exact store writes
 * of phase 2 together with everything the single transaction needs: parent-version guards, quota
 * deltas per owner, tmpfs deltas, blob reference changes and chunks, the undo pre-images, the wire op
 * for the outbox, and the event drafts published after `oncomplete`. Nothing here is asynchronous
 * and nothing touches the store.
 */
import { INO } from '@plotinium/protocol';
import type { Base, MemberOp } from '@plotinium/protocol';

import type { Content } from '../content.ts';
import { blobRecordOf } from '../content.ts';
import type { VfsEventDraft } from '../events.ts';
import { fail } from '../errors.ts';
import type { Cred } from '../perm.ts';
import { DeltaSet } from '../quota/quota.ts';
import type { QuotaDelta } from '../quota/quota.ts';
import { tmpfsCharge } from '../quota/quota.ts';
import type {
  BlobRec,
  ChunkRec,
  DentryRec,
  FsId,
  InodeRec,
  OpKind,
  Sha256Hex,
  TmpfsUsage,
  Uuid,
} from '../store/records.ts';
import type { FsView } from '../view.ts';
import { OverlayView } from './overlay.ts';

/** Who is calling and with what process state (credentials from the PCB, never from args: C3). */
export interface OpCtx {
  readonly cred: Cred;
  /** The process's working directory. */
  readonly cwd: Uuid;
  readonly umask: number;
  /** Kernel clock (epoch ms) for times written by this op. */
  readonly now: number;
  /** The op's id (UUIDv7): outbox idempotency key and seed of derived ids (offline-and-sync §3.3.2). */
  readonly opId: Uuid;
  readonly newIno: () => Uuid;
  /** User names for conflicted-copy names (§3.15.3). */
  readonly username: (uid: number) => string;
  /** `YYYY-MM-DD` in the OS time zone, for conflicted-copy names. */
  readonly date: string;
  /** Another session or process holds a lease or lock on `ino` (§3.16.3): EBUSY. */
  readonly busy?: (ino: Uuid) => boolean;
  /** Recovery mode: the VFS is mounted read-only (EPERM `ro-mount`, §3.21). */
  readonly readOnly?: boolean;
  /** Whether a gid exists (chown); unknown gids are EINVAL. Absent: every gid is accepted. */
  readonly groupExists?: (gid: number) => boolean;
}

export type StoreWrite =
  | { readonly store: 'inodes'; readonly op: 'add' | 'put'; readonly value: InodeRec }
  | { readonly store: 'inodes'; readonly op: 'del'; readonly key: Uuid }
  | { readonly store: 'dentries'; readonly op: 'add'; readonly value: DentryRec }
  | { readonly store: 'dentries'; readonly op: 'del'; readonly value: DentryRec };

/** A refcount change of one blob; `record` creates the blob when the store does not have it. */
export interface BlobUse {
  readonly sha: Sha256Hex;
  readonly delta: number;
  readonly record: BlobRec | undefined;
}

export interface WireOp {
  readonly op: MemberOp | { kind: 'batch'; ops: MemberOp[]; fingerprint?: string };
  readonly base: Base;
  readonly blobs: readonly Sha256Hex[];
}

/** What a dry run reports (§3.12.7): paths as they were resolved. */
export interface PlanNotes {
  readonly creates: string[];
  readonly deletes: string[];
  readonly overwrites: string[];
  readonly chmods: { path: string; from: number; to: number }[];
  readonly chowns: { path: string; uid: number; gid: number }[];
  readonly moves: { from: string; to: string }[];
}

export interface Plan {
  readonly label: string;
  readonly call: OpKind;
  /** False when only tmpfs rows change: no undo, no outbox op, relaxed durability (§3.3.4). */
  readonly synced: boolean;
  readonly writes: readonly StoreWrite[];
  /** Directory versions the transaction re-checks before writing (§3.11 phase 2 step 2). */
  readonly guards: readonly { ino: Uuid; version: number }[];
  readonly quota: readonly QuotaDelta[];
  readonly tmpfs: TmpfsUsage;
  readonly blobs: readonly BlobUse[];
  readonly chunks: readonly ChunkRec[];
  /** Blob references moved from deleted inodes to the undo record (§3.12.1). */
  readonly pins: readonly Sha256Hex[];
  readonly pre: { readonly inodes: readonly InodeRec[]; readonly dentries: readonly DentryRec[] };
  readonly created: {
    readonly inodes: readonly Uuid[];
    readonly dentries: readonly [Uuid, string][];
  };
  readonly touches: readonly Uuid[];
  /** Committed versions of every pre-existing inode the plan changes (the batch fingerprint input). */
  readonly baseVersions: ReadonlyMap<Uuid, number>;
  readonly events: readonly VfsEventDraft[];
  readonly wire: WireOp | null;
  readonly notes: PlanNotes;
  /** Inode-row writes: the fault hook's unit (§3.20). */
  readonly nodeOps: number;
}

const dkey = (parent: Uuid, name: string): string => `${parent}\u0000${name}`;

/** The file system a new entry of `parent` belongs to: children of /tmp and below are tmpfs. */
export function childFs(parent: InodeRec, tmpIno: Uuid): FsId {
  return parent.fs === 'tmp' || parent.ino === tmpIno ? 'tmp' : 'root';
}

export class PlanBuilder {
  readonly ctx: OpCtx;
  readonly view: OverlayView;
  readonly notes: PlanNotes = {
    creates: [],
    deletes: [],
    overwrites: [],
    chmods: [],
    chowns: [],
    moves: [],
  };
  readonly quota = new DeltaSet();
  private readonly writes: StoreWrite[] = [];
  private readonly lastInodeWrite = new Map<Uuid, number>();
  private readonly guards = new Map<Uuid, number>();
  private readonly bumped = new Set<Uuid>();
  private readonly blobs = new Map<Sha256Hex, { delta: number; record: BlobRec | undefined }>();
  private readonly chunks = new Map<Sha256Hex, ChunkRec>();
  private readonly pins: Sha256Hex[] = [];
  private readonly preInodes = new Map<Uuid, InodeRec>();
  private readonly preDentries = new Map<string, DentryRec>();
  private readonly createdInodes = new Set<Uuid>();
  private readonly createdDentries = new Map<string, [Uuid, string]>();
  private readonly touches = new Set<Uuid>();
  private readonly baseVersions = new Map<Uuid, number>();
  private readonly events: VfsEventDraft[] = [];
  private readonly wireOps: MemberOp[] = [];
  private readonly wireBlobs = new Set<Sha256Hex>();
  private wireBase: Base | null = null;
  private tmp = { bytes: 0, inodes: 0 };
  private synced = false;
  private batchMode = false;
  private fingerprint: string | undefined;

  private readonly tmpIno: Uuid;

  constructor(base: FsView, ctx: OpCtx, tmpIno: Uuid = INO.TMP) {
    this.ctx = ctx;
    this.view = new OverlayView(base);
    this.tmpIno = tmpIno;
  }

  /** The committed tree (the overlay's base). */
  get base(): FsView {
    return this.view.base;
  }

  // -- rows ----------------------------------------------------------------------------------

  addInode(rec: InodeRec): void {
    this.markFs(rec.fs);
    this.createdInodes.add(rec.ino);
    this.bumped.add(rec.ino); // a new inode is version 1 at commit, whatever else the op does
    this.touches.add(rec.ino);
    this.view.setInode(rec, true);
    this.lastInodeWrite.set(rec.ino, this.writes.length);
    this.writes.push({ store: 'inodes', op: 'add', value: rec });
  }

  putInode(rec: InodeRec, localOnly = false): void {
    if (!localOnly) this.markFs(rec.fs);
    this.capturePre(rec.ino);
    this.touches.add(rec.ino);
    this.view.setInode(rec, false);
    const i = this.lastInodeWrite.get(rec.ino);
    const prev = i === undefined ? undefined : this.writes[i];
    if (i !== undefined && prev !== undefined && prev.store === 'inodes' && prev.op !== 'del') {
      this.writes[i] = { store: 'inodes', op: prev.op, value: rec };
      return;
    }
    this.lastInodeWrite.set(rec.ino, this.writes.length);
    this.writes.push({ store: 'inodes', op: 'put', value: rec });
  }

  delInode(ino: Uuid): void {
    const cur = this.view.inode(ino);
    if (cur !== undefined) this.markFs(cur.fs);
    this.capturePre(ino);
    this.touches.add(ino);
    this.view.deleteInode(ino);
    this.lastInodeWrite.delete(ino);
    this.writes.push({ store: 'inodes', op: 'del', key: ino });
  }

  addDentry(d: DentryRec): void {
    const k = dkey(d.parent, d.name);
    const base = this.base.child(d.parent, d.name);
    if (!this.preDentries.has(k) && !this.createdDentries.has(k)) {
      if (typeof base === 'object' && base !== null) {
        this.preDentries.set(k, { ...d, ino: base.ino, dtype: base.type });
      } else {
        this.createdDentries.set(k, [d.parent, d.name]);
      }
    }
    this.touches.add(d.parent);
    this.view.addDentry(d);
    this.writes.push({ store: 'dentries', op: 'add', value: d });
  }

  delDentry(d: DentryRec): void {
    const k = dkey(d.parent, d.name);
    if (!this.preDentries.has(k) && !this.createdDentries.has(k)) {
      const base = this.base.child(d.parent, d.name);
      if (typeof base === 'object' && base !== null) {
        this.preDentries.set(k, {
          parent: d.parent,
          name: d.name,
          ino: base.ino,
          dtype: base.type,
        });
      }
    }
    this.touches.add(d.parent);
    this.view.deleteDentry(d);
    this.writes.push({ store: 'dentries', op: 'del', value: d });
  }

  // -- derived row updates -------------------------------------------------------------------

  /**
   * A directory's entry set changed: version once per op, mtime, ctime, nlink by `dNlink` (§3.2).
   * The `/tmp` inode is synced but its entries are tmpfs: its row changes locally only, without a
   * version bump, so the server's `/tmp` never diverges (§3.3.4).
   */
  dirChanged(dir: Uuid, dNlink: number): InodeRec {
    const cur = this.view.inode(dir) ?? fail('ENOENT');
    this.guard(dir);
    const local = dir === this.tmpIno;
    const version = local ? cur.version : this.bump(cur);
    const next = {
      ...cur,
      version,
      nlink: cur.nlink + dNlink,
      mtime: this.ctx.now,
      ctime: this.ctx.now,
    };
    this.putInode(next, local);
    return next;
  }

  /** The version an op leaves on `n`: +1 the first time it changes versioned state (§3.2). */
  bump(n: InodeRec): number {
    if (this.bumped.has(n.ino)) return n.version;
    this.bumped.add(n.ino);
    return n.version + 1;
  }

  /** Re-check `ino`'s committed version inside the transaction. */
  guard(ino: Uuid): void {
    if (this.guards.has(ino) || this.createdInodes.has(ino)) return;
    const b = this.base.inode(ino);
    if (b !== undefined) this.guards.set(ino, b.version);
  }

  /** Charge (+1) or release (−1) an inode on its owner's quota or on the tmpfs counters. */
  charge(n: InodeRec, sign: 1 | -1): void {
    this.quota.charge(n, sign);
    const t = tmpfsCharge(n);
    this.tmp = {
      bytes: this.tmp.bytes + sign * t.bytes,
      inodes: this.tmp.inodes + sign * t.inodes,
    };
  }

  /** A new inode reference to `content`'s blob, creating the blob (and storing chunks) if needed. */
  refContent(content: Content): void {
    this.refBlob(content.sha, 1, blobRecordOf(content));
    for (const c of content.chunks) this.chunks.set(c.sha, c);
  }

  refBlob(sha: Sha256Hex, delta: number, record?: BlobRec): void {
    const cur = this.blobs.get(sha);
    this.blobs.set(sha, { delta: (cur?.delta ?? 0) + delta, record: cur?.record ?? record });
  }

  /**
   * An inode drops its reference to `sha`. On the synced fs the reference moves to an undo pin (net
   * refcount 0) so a revert can restore the content; on tmpfs it is simply released.
   */
  unrefBlob(sha: Sha256Hex, fs: FsId): void {
    if (fs === 'root') this.pins.push(sha);
    else this.refBlob(sha, -1);
  }

  // -- outbox, events, notes -----------------------------------------------------------------

  /** Queue a member op for the outbox; tmpfs changes never produce one (§3.3.4). */
  wire(op: MemberOp, fs: FsId, blobs: readonly Sha256Hex[] = []): void {
    if (fs === 'tmp') return;
    this.wireOps.push(op);
    for (const sha of blobs) {
      // The outbox pins each blob it must upload until the op is acknowledged (§3.13.4).
      if (!this.wireBlobs.has(sha)) this.refBlob(sha, 1);
      this.wireBlobs.add(sha);
    }
  }

  setBase(base: Base): void {
    if (!this.batchMode) this.wireBase = base;
  }

  /** `batch`: one outbox op of kind `batch` whatever the member count, based on its fingerprint. */
  setBatch(fingerprint: string | undefined): void {
    this.batchMode = true;
    this.fingerprint = fingerprint;
  }

  emit(e: VfsEventDraft): void {
    this.events.push(e);
  }

  // -- build ---------------------------------------------------------------------------------

  build(label: string, call: OpKind): Plan {
    for (const ino of this.touches) {
      const b = this.base.inode(ino);
      if (b !== undefined) this.baseVersions.set(ino, b.version);
    }
    const blobs: BlobUse[] = [];
    for (const [sha, u] of this.blobs)
      if (u.delta !== 0) blobs.push({ sha, delta: u.delta, record: u.record });
    return {
      label,
      call,
      synced: this.synced,
      writes: [...this.writes],
      guards: [...this.guards].map(([ino, version]) => ({ ino, version })),
      quota: this.quota.list(),
      tmpfs: { ...this.tmp },
      blobs,
      chunks: [...this.chunks.values()],
      pins: [...this.pins],
      pre: { inodes: [...this.preInodes.values()], dentries: [...this.preDentries.values()] },
      created: { inodes: [...this.createdInodes], dentries: [...this.createdDentries.values()] },
      touches: [...this.touches],
      baseVersions: new Map(this.baseVersions),
      events: mergeEvents(this.events),
      wire: this.buildWire(),
      notes: this.notes,
      nodeOps: this.writes.filter((w) => w.store === 'inodes').length,
    };
  }

  private buildWire(): WireOp | null {
    if (!this.synced || this.wireOps.length === 0) return null;
    const blobs = [...this.wireBlobs];
    const [only] = this.wireOps;
    if (!this.batchMode && this.wireOps.length === 1 && only !== undefined) {
      return { op: only, base: this.wireBase ?? { kind: 'versions', entries: [] }, blobs };
    }
    const op = {
      kind: 'batch' as const,
      ops: [...this.wireOps],
      ...(this.fingerprint === undefined ? {} : { fingerprint: this.fingerprint }),
    };
    return { op, base: this.wireBase ?? { kind: 'versions', entries: [] }, blobs };
  }

  private markFs(fs: FsId): void {
    if (fs === 'root') this.synced = true;
  }

  private capturePre(ino: Uuid): void {
    if (this.preInodes.has(ino) || this.createdInodes.has(ino)) return;
    const b = this.base.inode(ino);
    if (b !== undefined) this.preInodes.set(ino, b);
  }
}

const MERGEABLE = new Set([
  'vfs.create',
  'vfs.write',
  'vfs.unlink',
  'vfs.link',
  'vfs.utimes',
  'vfs.rename',
]);

/** Consecutive drafts of one item topic become one event (one batch per commit for subscribers). */
function mergeEvents(drafts: readonly VfsEventDraft[]): VfsEventDraft[] {
  const out: VfsEventDraft[] = [];
  for (const d of drafts) {
    const last = out[out.length - 1];
    if (
      last !== undefined &&
      last.topic === d.topic &&
      MERGEABLE.has(d.topic) &&
      'items' in last.data &&
      'items' in d.data
    ) {
      const items = [...last.data.items, ...d.data.items];
      out[out.length - 1] = { topic: d.topic, data: { ...last.data, items } } as VfsEventDraft;
    } else {
      out.push(d);
    }
  }
  return out;
}
