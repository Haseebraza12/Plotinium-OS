/**
 * The kernel file system (virtual-file-system.md §3.3.6, §3.5, §3.11, §5.8; PVFS-03).
 *
 * `KernelFs` owns, for one kernel:
 * - the store adapter (`FsStore`: IndexedDB, or memory);
 * - the in-memory inode tree, a vfs `VfsTree` over the team's `dsa/tree` n-ary tree (C16), loaded
 *   lazily per directory by a vfs `DirLoader` (chunked read-only scans);
 * - the users and groups mirror, the tmpfs counters, the fencing epoch;
 * - the open-file table (fds.ts), the content cache, the VFS events, the client fault hook.
 *
 * `mount` is the `vfs` service's start: fencing epoch, first-boot `mkfs` (idempotent, one strict
 * transaction, no outbox op), tmpfs clearing, mirrors, the root directory.
 *
 * Every mutation follows §3.11:
 *   phase 1  plan against the tree (planner from vfs/ops; permission checks with vfs/perm), loading
 *            any directory the planner reaches that is not in memory, then plan again; quota fast
 *            fail;
 *   phase 2  ONE readwrite transaction through the store adapter (`applyCommit`): fencing epoch,
 *            parent-version guards, users (EDQUOT), rows, blobs, undo, outbox, hooks;
 *   phase 3  after `oncomplete` only: apply the writes to the tree, update the mirrors, publish the
 *            events, kick syncd.
 * Mutations are serialised by one kernel-wide lock (the intent locks of §5.7 reduced to a single
 * lock: plans are always made against a stable tree); reads never take it.
 */
import type { NaryTree } from '@plotinium/dsa/tree';
import { createTree } from '@plotinium/dsa/tree';
import type { ProcClass, SyncState } from '@plotinium/protocol';
import { INO, SYNTH_FILES, uuidv7 } from '@plotinium/protocol';
import type {
  ChangeSet,
  ChunkRec,
  Cred as VfsCred,
  GroupRec,
  InodeRec,
  MetaRec,
  OpCtx,
  OpKind,
  Plan,
  Resolution,
  ResolveOpts,
  SeedEntry,
  TmpfsUsage,
  UserRec,
  Uuid,
  VfsTxnHook,
} from '@plotinium/vfs';
import {
  DirLoader,
  FaultHook,
  PlanBuilder,
  TMPFS_MAX_BYTES,
  VfsTree,
  applyCommit,
  applyDelta,
  applyMkfs,
  attempt,
  clearTmpfs,
  contentOf,
  cwdNode,
  isBulk,
  mkfsPlan,
  prepareCommit,
  quotaCheck,
  resolve,
  tmpfsExceeds,
  toVfsError,
  viewSource,
} from '@plotinium/vfs';

import { KernelError } from '../errors.ts';
import type { BuildIdentity } from '../host.ts';
import type { PCB } from '../proc/pcb.ts';
import type { BlobFetch } from './content.ts';
import { ContentCache } from './content.ts';
import type { ErrCtx } from './errno.ts';
import { fromVfsError, fsError, toKernelError } from './errno.ts';
import type { FsBus } from './events.ts';
import { FsEvents } from './events.ts';
import type { Closed } from './fds.ts';
import { FileDescriptors } from './fds.ts';
import type { FsStore } from './store.ts';

/** Builds the n-ary tree the VFS hierarchy lives in (default: `dsa/tree`'s `createTree`). */
export type TreeFactory = (rootId: Uuid, root: InodeRec) => NaryTree<InodeRec>;

export type FsLogLevel = 'info' | 'warn' | 'fail';
export type FsLog = (level: FsLogLevel, msg: string) => void;

/** The kernel clock as the file system reads it (inode times are epoch milliseconds). */
export interface FsClock {
  epochMs(): number;
  timeZone(): { tz: string; offsetMin: number };
}

/** Who performs an operation: from a PCB (never from syscall arguments, C3). */
export interface FsActor {
  readonly pid: number;
  readonly cred: VfsCred;
  readonly cls: ProcClass;
  readonly cwdIno: Uuid;
  readonly cwdPath: string;
  readonly umask: number;
}

export function actorOf(
  pcb: Pick<PCB, 'pid' | 'cred' | 'cls' | 'cwdIno' | 'cwdPath' | 'umask'>,
): FsActor {
  const { uid, gid, groups } = pcb.cred;
  return {
    pid: pcb.pid,
    cred: { uid, gid, groups: groups.includes(gid) ? [...groups] : [gid, ...groups] },
    cls: pcb.cls,
    cwdIno: pcb.cwdIno,
    cwdPath: pcb.cwdPath,
    umask: pcb.umask,
  };
}

export interface KernelFsDeps {
  readonly store: FsStore;
  readonly bus: FsBus;
  readonly clock: FsClock;
  /** The process manager's kill-path hook (closes every fd of a terminated process). */
  readonly procs?: { onTerminate(hook: (pcb: PCB) => void): () => void };
  readonly log?: FsLog;
  /** The OS session id outbox and undo records carry. */
  readonly osSessionId?: () => string;
  /** The build identity: mkfs times (so every device agrees) and `/system/release`. */
  readonly identity?: BuildIdentity;
  readonly treeFactory?: TreeFactory;
  /** Content of a kernel-synthesised file (§3.3.5), generated on open and stat. */
  readonly synth?: (ino: Uuid) => Uint8Array | null;
  /**
   * A lease or lock held by another session or process (lockd, §3.16.3): EBUSY. `pid` is the
   * process that wants to change `ino`: a process never gets EBUSY from its own X lease (UI-002).
   */
  readonly busy?: (ino: Uuid, pid?: number) => boolean;
  /** Transaction hooks: the audit mirror, `ai_*` stores (§4.6). */
  readonly hooks?: readonly VfsTxnHook[];
  /** Called after each committed op: `syncd.kick()` (§3.11 phase 3 step 4). */
  readonly onCommit?: (info: {
    readonly opId: Uuid;
    readonly synced: boolean;
    readonly bulk: boolean;
  }) => void;
  /** Swap usage for `statfs` (the memory manager's tiers). */
  readonly swapBytes?: () => { local: number; remote: number };
  /** Content that arrived by sync as a hash only is fetched from the server on first read. */
  readonly fetchBlob?: BlobFetch;
  readonly newIno?: () => Uuid;
}

export interface MountOptions {
  /**
   * No server: the local store is authoritative, so a miss in a directory that was never mirrored
   * (`/home` after mkfs) is a real miss, not EAGAIN (§3.17.2). Tests and the offline demo.
   */
  readonly standalone?: boolean;
  /** The kernel's fencing epoch (written by the `storage` service); absent: adopt or create one. */
  readonly epoch?: number;
  readonly deviceId?: Uuid;
  /** The build's seed manifest (§3.3.3) for first-boot mkfs. */
  readonly seed?: {
    readonly entries: readonly SeedEntry[];
    readonly chunks?: readonly ChunkRec[];
    readonly hash?: string;
  };
  /** Clear tmpfs (§3.3.4); default true. */
  readonly clearTmp?: boolean;
  /** Recovery mode: every mutation is EPERM `ro-mount` (§3.21). */
  readonly readOnly?: boolean;
}

export interface MountReport {
  readonly mkfs: boolean;
  readonly tmpCleared: number;
  readonly epoch: number;
  readonly users: number;
}

export interface Mutated<T> {
  readonly value: T;
  readonly opId: Uuid;
  readonly sync: SyncState;
  /** Null when the plan changed nothing (no transaction ran). */
  readonly plan: Plan | null;
}

export interface MutateOpts {
  readonly opId?: Uuid;
  /** Load what the plan will need first (a recursive op's subtree). */
  readonly prefetch?: () => Promise<void>;
  /** Agent batches keep their undo record after the ack (AGT-10). */
  readonly keepAfterAck?: boolean;
  readonly err?: ErrCtx;
}

/** Directory loads one resolution or plan may trigger before EIO (a corrupt store). */
const MAX_LOADS = 4096;

const numberMeta = (v: MetaRec | undefined): number | undefined =>
  typeof v?.v === 'number' ? v.v : undefined;

/** A FIFO lock: `run` calls start after every earlier call settled. */
class Mutex {
  private tail: Promise<void> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const r = this.tail.then(fn);
    this.tail = r.then(
      () => undefined,
      () => undefined,
    );
    return r;
  }
}

function buildTimeOf(identity: BuildIdentity | undefined): number {
  const t = identity === undefined ? Number.NaN : Date.parse(identity.buildDate);
  return Number.isFinite(t) && t >= 0 ? t : 0;
}

export class KernelFs {
  readonly store: FsStore;
  readonly events: FsEvents;
  readonly fds = new FileDescriptors();
  readonly faults = new FaultHook();
  readonly content: ContentCache;
  private readonly deps: KernelFsDeps;
  private readonly lock = new Mutex();
  private vtree: VfsTree | null = null;
  private dirLoader: DirLoader | null = null;
  private epoch = 0;
  private tmpfs: TmpfsUsage = { bytes: 0, inodes: 0 };
  /** gid → name, from the `groups` store (group names for `id` and `proc.cred`, UI-012). */
  private readonly groups = new Map<number, string>();
  private inodeCount: number | null = null;
  private ro = false;
  private unhook: (() => void) | null = null;

  constructor(deps: KernelFsDeps) {
    this.deps = deps;
    this.store = deps.store;
    this.content = new ContentCache(deps.store, undefined, deps.fetchBlob);
    this.events = new FsEvents(
      deps.bus,
      () => this.vtree,
      (msg) => this.log('warn', msg),
    );
  }

  // -- state ---------------------------------------------------------------------------------

  get mounted(): boolean {
    return this.vtree !== null;
  }

  /** The in-memory tree (EBUSY `starting` before mount). */
  get tree(): VfsTree {
    return this.vtree ?? fsFail('EBUSY', 'starting');
  }

  get loader(): DirLoader {
    return this.dirLoader ?? fsFail('EBUSY', 'starting');
  }

  get tmpfsUsage(): TmpfsUsage {
    return this.tmpfs;
  }

  get fencingEpoch(): number {
    return this.epoch;
  }

  get readOnly(): boolean {
    return this.ro;
  }

  hasGroup(gid: number): boolean {
    return this.groups.has(gid);
  }

  /** The name of group `gid` in the local groups mirror, if it has one. */
  groupName(gid: number): string | undefined {
    return this.groups.get(gid);
  }

  /**
   * A lease or lock on `ino` held by another session or process (§3.16.3). `pid` is the process
   * that wants to change it; its own X lease never makes it busy (UI-002).
   */
  isBusy(ino: Uuid, pid?: number): boolean {
    return this.deps.busy?.(ino, pid) ?? false;
  }

  log(level: FsLogLevel, msg: string): void {
    this.deps.log?.(level, msg);
  }

  now(): number {
    return Math.max(0, Math.floor(this.deps.clock.epochMs()));
  }

  userName(uid: number): string {
    return this.vtree?.user(uid)?.username ?? (uid === 0 ? 'root' : `u${String(uid)}`);
  }

  /** `YYYY-MM-DD` in the OS time zone (conflicted-copy names, §3.15.3). */
  private date(): string {
    const ms = this.deps.clock.epochMs() + this.deps.clock.timeZone().offsetMin * 60_000;
    return new Date(ms).toISOString().slice(0, 10);
  }

  // -- mount ---------------------------------------------------------------------------------

  /** Start the file system (the `vfs` service, boot-and-services.md). */
  async mount(opts: MountOptions = {}): Promise<MountReport> {
    if (this.vtree !== null)
      throw new KernelError('EBUSY', undefined, 'file system already mounted');
    const store = this.store;
    // Fencing epoch (§3.13.3): the storage service writes it; adopt it, or create it on a fresh device.
    const stored = numberMeta(await store.get<MetaRec>('meta', 'fencingEpoch'));
    const epoch = opts.epoch ?? stored ?? 1;
    if (stored === undefined) {
      await store.tx(['meta'], 'strict', (t) => t.put('meta', { k: 'fencingEpoch', v: epoch }), {
        label: 'fencing epoch',
      });
    }
    this.epoch = epoch;

    // First-boot mkfs (§3.3.6): idempotent, one strict transaction, no outbox op.
    const plan = mkfsPlan({
      buildTime: buildTimeOf(this.deps.identity),
      deviceId: opts.deviceId ?? uuidv7(),
      ...(opts.seed === undefined
        ? {}
        : {
            seed: opts.seed.entries,
            ...(opts.seed.chunks === undefined ? {} : { chunks: opts.seed.chunks }),
            ...(opts.seed.hash === undefined ? {} : { seedHash: opts.seed.hash }),
          }),
    });
    const mkfs = await applyMkfs(store, plan);
    if (mkfs)
      this.log('info', `mkfs: standard hierarchy created (${String(plan.inodes.length)} inodes)`);

    const tmpCleared = opts.clearTmp === false ? 0 : await clearTmpfs(store, this.now());
    const usage = (await store.get<MetaRec>('meta', 'tmpfsUsage'))?.v;
    this.tmpfs = isUsage(usage) ? usage : { bytes: 0, inodes: 0 };

    const root = await store.get<InodeRec>('inodes', INO.ROOT);
    if (root === undefined) throw new KernelError('EIO', { reason: 'storage' }, 'no root inode');
    const factory: TreeFactory =
      this.deps.treeFactory ?? ((rootId, rec) => createTree<InodeRec>(rootId, rec));
    const tree = new VfsTree(factory(INO.ROOT, root));
    tree.online = opts.standalone === true;
    await store.scan<UserRec>('users', null, (u) => tree.users.set(u.uid, u));
    this.groups.clear();
    await store.scan<GroupRec>('groups', null, (g) => this.groups.set(g.gid, g.name));
    this.ro = opts.readOnly === true;

    this.vtree = tree;
    this.dirLoader = new DirLoader(store, tree, {
      now: () => this.now(),
      onLoaded: (draft) => {
        this.events.publish([draft], { t: this.now(), origin: 'local', actorUid: 0 });
      },
    });
    await this.dirLoader.ensureLoaded(INO.ROOT);
    this.events.install();
    this.unhook = this.deps.procs?.onTerminate((pcb) => this.onProcessExit(pcb)) ?? null;
    this.log(
      'info',
      `vfs mounted on ${store.kind} · epoch ${String(epoch)} · ${String(tree.users.size)} users` +
        (tmpCleared > 0 ? ` · tmpfs cleared (${String(tmpCleared)})` : ''),
    );
    return { mkfs, tmpCleared, epoch, users: tree.users.size };
  }

  /** Stop: drop the tree and the hooks (tests; shutdown). */
  unmount(): void {
    this.unhook?.();
    this.unhook = null;
    this.events.dispose();
    this.vtree = null;
    this.dirLoader = null;
  }

  // -- resolution and reads ------------------------------------------------------------------

  /** The path a resolution starts from: relative paths join the cwd path when its ino is unknown. */
  abs(actor: FsActor, path: string): string {
    if (path.startsWith('/') || actor.cwdIno !== '' || actor.cwdPath === '/') return path;
    return `${actor.cwdPath}/${path}`;
  }

  cwdOf(actor: FsActor): Uuid {
    return actor.cwdIno === '' ? INO.ROOT : actor.cwdIno;
  }

  /** Synchronous resolution on the current tree ('load' when a directory is not in memory). */
  resolveNow(actor: FsActor, path: string, opts: ResolveOpts): Resolution<InodeRec> {
    const tree = this.tree;
    return resolve(
      viewSource(tree),
      actor.cred,
      cwdNode(tree, this.cwdOf(actor)),
      this.abs(actor, path),
      opts,
    );
  }

  /** Resolve, loading directories on demand; resolution errors become KernelErrors. */
  async resolvePath(
    actor: FsActor,
    path: string,
    opts: ResolveOpts,
    err: ErrCtx = {},
  ): Promise<Extract<Resolution<InodeRec>, { kind: 'ok' }>> {
    for (let i = 0; i <= MAX_LOADS; i++) {
      const r = this.resolveNow(actor, path, opts);
      if (r.kind === 'ok') return r;
      if (r.kind === 'err') throw fsError(r.errno, r.detail, { ...err, path });
      await this.loader.ensureLoaded(r.dir.ino);
    }
    throw fsError('EIO', 'storage', err);
  }

  /**
   * Run a read-only function against the tree; a `NotLoaded` loads the directory and runs it again.
   * Synchronous when everything is in memory (the F-call fast path), else a promise.
   */
  read<T>(fn: () => T, err: ErrCtx = {}): T | Promise<T> {
    const o = attempt(fn);
    if (o.ok === true) return o.value;
    if (o.ok === false) throw fsError(o.errno, o.detail, err, o.index);
    return this.readAsync(fn, o.dir, err);
  }

  private async readAsync<T>(fn: () => T, first: Uuid, err: ErrCtx): Promise<T> {
    let dir = first;
    for (let i = 0; i < MAX_LOADS; i++) {
      await this.loader.ensureLoaded(dir);
      const o = attempt(fn);
      if (o.ok === true) return o.value;
      if (o.ok === false) throw fsError(o.errno, o.detail, err, o.index);
      dir = o.dir;
    }
    throw fsError('EIO', 'storage', err);
  }

  /** Load a directory's whole subtree before a recursive plan (§3.11 phase 1 step 4). */
  async prefetchSubtree(actor: FsActor, path: string, follow: boolean): Promise<void> {
    try {
      const r = await this.resolvePath(actor, path, { follow });
      if (r.node?.type === 'd') await this.loader.ensureLoadedSubtree(r.node.ino);
    } catch {
      // The planner reports the error in order; prefetching is only an optimisation.
    }
  }

  // -- mutations -----------------------------------------------------------------------------

  opCtx(actor: FsActor, opId: Uuid): OpCtx {
    const busy = this.deps.busy;
    const pid = actor.pid;
    return {
      cred: actor.cred,
      cwd: this.cwdOf(actor),
      umask: actor.umask,
      now: this.now(),
      opId,
      newIno: this.deps.newIno ?? uuidv7,
      username: (uid) => this.userName(uid),
      date: this.date(),
      readOnly: this.ro,
      groupExists: (gid) => this.groups.has(gid),
      ...(busy === undefined ? {} : { busy: (ino: Uuid) => busy(ino, pid) }),
    };
  }

  /** Serialise with every other mutation (the kernel-wide mutation lock). */
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    return this.lock.run(fn);
  }

  /** Plan, commit and publish one user-visible operation (§3.11). */
  mutate<T>(
    actor: FsActor,
    call: OpKind,
    label: string,
    run: (b: PlanBuilder) => T,
    opts: MutateOpts = {},
  ): Promise<Mutated<T>> {
    return this.lock.run(() => this.mutateLocked(actor, call, label, run, opts));
  }

  /** `mutate` for a caller that already holds the mutation lock (`exclusive`). */
  async mutateLocked<T>(
    actor: FsActor,
    call: OpKind,
    label: string,
    run: (b: PlanBuilder) => T,
    opts: MutateOpts = {},
  ): Promise<Mutated<T>> {
    const err = opts.err ?? {};
    const opId = opts.opId ?? uuidv7();
    await opts.prefetch?.();
    for (let attemptNo = 0; ; attemptNo++) {
      const { plan, value } = await this.plan(actor, call, label, opId, run, err);
      if (plan.writes.length === 0) return { value, opId, sync: 'applied', plan: null };
      const q = quotaCheck(plan, (uid) => this.tree.user(uid), this.tmpfs);
      if (q !== null) throw fsError(q, quotaDetail(plan, this.tmpfs), err);
      const now = this.now();
      const commit = prepareCommit(plan, {
        opId,
        osSessionId: this.deps.osSessionId?.() ?? '00000000-0000-7000-8000-000000000000',
        principal: actor.cred.uid,
        now,
        awaitSync: false,
        ...(opts.keepAfterAck === true ? { keepAfterAck: true } : {}),
      });
      const change: ChangeSet = changeSetOf(plan, call, actor, opId);
      const fault = this.faults.take(call, now);
      try {
        const res = await applyCommit(this.store, commit, {
          epoch: this.epoch,
          now,
          hooks: this.deps.hooks ?? [],
          change,
          ...(fault === undefined ? {} : { fault }),
        });
        if (res.faultNotReached && fault !== undefined) {
          this.log('warn', `fault not reached (${String(res.nodeOps)} < ${String(fault.after)})`);
        }
      } catch (e) {
        const v = toVfsError(e);
        // A parent-version guard fired: the tree changed under the plan; plan again once (§3.11).
        if (v.errno === 'EAGAIN' && v.detail === undefined && attemptNo === 0) continue;
        if (v.errno === 'EIO' && v.detail === 'fencing') {
          this.log('fail', 'fencing epoch changed: another tab owns the file system');
        }
        throw fromVfsError(v, err);
      }
      this.committed(plan, actor, opId, now);
      return { value, opId, sync: plan.wire === null ? 'applied' : 'pending', plan };
    }
  }

  /** Phase 1: run the planner, loading directories until it no longer reaches an unloaded one. */
  private async plan<T>(
    actor: FsActor,
    call: OpKind,
    label: string,
    opId: Uuid,
    run: (b: PlanBuilder) => T,
    err: ErrCtx,
  ): Promise<{ plan: Plan; value: T }> {
    for (let i = 0; i <= MAX_LOADS; i++) {
      const b = new PlanBuilder(this.tree, this.opCtx(actor, opId));
      const o = attempt(() => {
        const value = run(b);
        return { value, plan: b.build(label, call) };
      });
      if (o.ok === true) return o.value;
      if (o.ok === false) throw fsError(o.errno, o.detail, err, o.index);
      await this.loader.ensureLoaded(o.dir);
    }
    throw fsError('EIO', 'storage', err);
  }

  /** Phase 3: memory, mirrors, cache, events, syncd (only after `oncomplete`). */
  private committed(plan: Plan, actor: FsActor, opId: Uuid, now: number): void {
    const tree = this.tree;
    tree.apply(plan.writes);
    if (plan.synced) {
      for (const q of plan.quota) {
        const u = tree.users.get(q.uid);
        if (u !== undefined) tree.users.set(q.uid, applyDelta(u, q));
      }
    }
    this.tmpfs = {
      bytes: this.tmpfs.bytes + plan.tmpfs.bytes,
      inodes: this.tmpfs.inodes + plan.tmpfs.inodes,
    };
    if (this.inodeCount !== null) {
      for (const w of plan.writes) {
        if (w.store !== 'inodes') continue;
        if (w.op === 'add') this.inodeCount++;
        else if (w.op === 'del') this.inodeCount--;
      }
    }
    this.content.remember(plan);
    this.events.publish(plan.events, { t: now, origin: 'local', actorUid: actor.cred.uid, opId });
    try {
      this.deps.onCommit?.({ opId, synced: plan.wire !== null, bulk: isBulk(plan) });
    } catch (e) {
      this.log('warn', `onCommit hook failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Apply rows written outside the planners (local provisioning) to memory and publish. */
  applyExternal(
    plan: Pick<Plan, 'writes' | 'events'>,
    actorUid: number,
    users: readonly UserRec[] = [],
  ): void {
    const tree = this.tree;
    tree.apply(plan.writes);
    for (const u of users) tree.users.set(u.uid, u);
    this.events.publish(plan.events, { t: this.now(), origin: 'local', actorUid });
  }

  // -- quotas, statfs ------------------------------------------------------------------------

  /**
   * The largest size file `node` may reach before EDQUOT (§3.8 rule 8): the owner's remaining byte
   * quota plus the committed size; tmpfs: its remaining space; root (exempt) and unmirrored owners
   * are unbounded here (the transaction and the server remain authoritative).
   */
  headroom(node: InodeRec): number {
    if (node.fs === 'tmp') return Math.max(0, TMPFS_MAX_BYTES - this.tmpfs.bytes) + node.size;
    if (node.uid === 0) return Number.MAX_SAFE_INTEGER;
    const u = this.tree.user(node.uid);
    if (u === undefined) return Number.MAX_SAFE_INTEGER;
    return Math.max(0, u.quotaBytes - u.usedBytes) + node.size;
  }

  /** Inodes on this device (counted once, then maintained by every commit). */
  async inodes(): Promise<number> {
    if (this.inodeCount === null) {
      let n = 0;
      await this.store.scan<unknown>('inodes', null, () => {
        n++;
      });
      this.inodeCount ??= n;
    }
    return this.inodeCount;
  }

  swapBytes(): { local: number; remote: number } {
    return this.deps.swapBytes?.() ?? { local: 0, remote: 0 };
  }

  // -- synthesised files (§3.3.5) ------------------------------------------------------------

  /** A synthesised file's fresh snapshot, or null when `ino` is not one. */
  synthContent(ino: Uuid): Uint8Array | null {
    if (!SYNTH_FILES.some((s) => s.ino === ino)) return null;
    const custom = this.deps.synth?.(ino);
    if (custom !== undefined && custom !== null) return custom;
    if (ino === INO.SYSTEM_RELEASE)
      return new TextEncoder().encode(releaseText(this.deps.identity));
    return new Uint8Array(0);
  }

  /** `contentOf` for synthesised bytes, remembered in the content cache. */
  synthSnapshot(bytes: Uint8Array): { sha: string; size: number; parts: Uint8Array[] } {
    const c = contentOf(bytes, this.now());
    const parts = c.chunks.map((ch) => new Uint8Array(ch.bytes));
    this.content.rememberBytes(c.sha, parts, c.chunkShas);
    return { sha: c.sha, size: c.size, parts };
  }

  // -- kill path -----------------------------------------------------------------------------

  /** PROC-07 kill path step 3: close every file fd of the process and finalise its descriptions. */
  private onProcessExit(pcb: PCB): void {
    const closed = this.fds.closeAll(pcb);
    if (closed.length === 0) return;
    const actor = actorOf(pcb);
    void Promise.all(closed.map((c) => this.finalise(c, actor))).catch((e: unknown) => {
      this.log(
        'warn',
        `closing fds of pid ${String(pcb.pid)}: ${e instanceof Error ? e.message : String(e)}`,
      );
    });
  }

  /**
   * A description's last reference went (§3.9.3 rule 6): if its session was poisoned and the open
   * created the file, which nobody has written since (version 1), the file is removed, so a failed
   * `cat big > f` leaves no `f`. Writes were committed one call at a time, so nothing else is owed.
   */
  async finalise(c: Closed, actor: FsActor): Promise<void> {
    const { file } = c;
    if (file.poisoned === undefined || !file.createdByOpen || file.via === null) return;
    const node = this.vtree?.inode(file.ino);
    if (node === undefined || node.version !== 1 || node.type !== 'f') return;
    const via = file.via;
    try {
      await this.mutate(actor, 'unlink', `discard ${file.pathAtOpen}`, (b) => {
        const cur = b.view.child(via.parent, via.name);
        if (typeof cur !== 'object' || cur === null || cur.ino !== file.ino || cur.version !== 1)
          return false;
        const parent = b.view.inode(via.parent);
        if (parent === undefined) return false;
        b.delDentry({ parent: via.parent, name: via.name, ino: cur.ino, dtype: cur.type });
        b.delInode(cur.ino);
        b.charge(cur, -1);
        if (cur.blob !== null) b.unrefBlob(cur.blob, cur.fs);
        b.dirChanged(via.parent, 0);
        b.emit({
          topic: 'vfs.unlink',
          data: {
            items: [
              {
                parent: via.parent,
                name: via.name,
                ino: cur.ino,
                type: cur.type,
                inos: [cur.ino],
                count: 1,
              },
            ],
          },
        });
        b.wire(
          { kind: 'unlink', parentIno: via.parent, name: via.name, ino: cur.ino, recursive: false },
          cur.fs,
        );
        b.setBase({ kind: 'versions', entries: [{ ino: cur.ino, version: cur.version }] });
        return true;
      });
    } catch (e) {
      this.log('warn', `discarding ${file.pathAtOpen}: ${toKernelError(e).errno}`);
    }
  }
}

function fsFail(errno: 'EBUSY', reason: string): never {
  throw new KernelError(errno, { reason }, 'file system not mounted yet');
}

function isUsage(v: unknown): v is TmpfsUsage {
  return (
    typeof v === 'object' &&
    v !== null &&
    'bytes' in v &&
    'inodes' in v &&
    typeof v.bytes === 'number' &&
    typeof v.inodes === 'number'
  );
}

/** EDQUOT's VFS detail: `tmpfs-full` when the tmpfs limits bound, else none (a user quota). */
function quotaDetail(plan: Plan, usage: TmpfsUsage): string | undefined {
  return tmpfsExceeds(usage, plan.tmpfs) ? 'tmpfs-full' : undefined;
}

function changeSetOf(plan: Plan, call: OpKind, actor: FsActor, opId: Uuid): ChangeSet {
  const created = new Set(plan.created.inodes);
  const deleted: Uuid[] = [];
  const changed = new Set<Uuid>();
  for (const w of plan.writes) {
    if (w.store !== 'inodes') continue;
    if (w.op === 'del') deleted.push(w.key);
    else if (!created.has(w.value.ino)) changed.add(w.value.ino);
  }
  return {
    opId,
    kind: plan.synced ? call : 'tmp',
    pid: actor.pid,
    cred: actor.cred,
    created: [...created],
    changed: [...changed],
    deleted,
  };
}

/** `/system/release` (identity-and-branding.md §3.9): the build identity as KEY=value lines. */
function releaseText(id: BuildIdentity | undefined): string {
  if (id === undefined) return 'NAME=Plotinium\n';
  return [
    `NAME=${id.name}`,
    `VERSION=${id.version}`,
    `BUILD=${id.build}`,
    `BUILD_DATE=${id.buildDate}`,
    ...(id.codename === null ? [] : [`CODENAME=${id.codename}`]),
    `ABI=${String(id.abi)}`,
    '',
  ].join('\n');
}
