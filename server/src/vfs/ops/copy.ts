/**
 * `copy` (cp, cp -r) on the server (database.md §4.11.7, §4.11.9; virtual-file-system.md §3.12.3;
 * offline-and-sync.md §3.3.2; DB-02, VFS-10).
 *
 * The client applies a copy optimistically and sends ONE `copy` op; the server must create the SAME
 * inodes, so the traversal below mirrors vfs/src/ops/copy.ts `planCopy` step for step:
 *   - entries are visited depth-first in code-point order of their names;
 *   - a new inode's id is `deriveIno(opId, srcIno)`; a second name of the same source inode chains
 *     from the previous id (`deriveIno(opId, previous)`), so hard links become separate files;
 *   - at an existing target: directory into directory MERGES; a regular file onto a regular file is
 *     overwritten IN PLACE (the target keeps its ino, takes the source's blob); a symlink on either
 *     side replaces the entry (unlink, then a fresh copy); file onto directory is EISDIR, directory
 *     onto file ENOTDIR, for the whole op;
 *   - a directory copied into itself or below itself is EINVAL;
 *   - owner and group are the caller's (with `preserve` and uid 0: the source's); mode is
 *     `mode & 0o777 & ~umask` (symlinks 0o777; with `preserve` the source mode), where umask is the
 *     default 0o022 because the wire op carries none; mtime is the commit time (source mtime with
 *     `preserve`);
 *   - permissions: w+x on every directory an entry is created in (checkCreate, including a new
 *     directory created by this copy), r on files and r+x on directories of the source
 *     (checkCopySource), x on every ancestor of both ends; an overwrite needs w on the target, a
 *     replacement the sticky-aware remove right; synthesised inodes are EPERM;
 *   - at most BULK_MAX_NODES new names (EINVAL too-large).
 *
 *   plan     lock-free: source subtree and, for a merge, the target subtree
 *   locks    L1 the caller, the destination owners and the owners of overwritten or replaced
 *            files; L3 the destination parent, every source directory and every merged target
 *            directory; L4 every source non-directory and every existing target non-directory
 *            (source rows FOR UPDATE too, §4.11.7); re-planned under the locks
 *   recheck  the traversal above against the locked rows; leases on overwritten or replaced files
 *            (EBUSY); the base (versions of a file, or the subtree digest of a directory) was
 *            checked by withBaseCheck before this runs
 *   body     set-based: replaced entries removed, every new inode in one INSERT and every new name
 *            in one INSERT (pre-order, so fault nodes 1..N are the copied names), overwrites in one
 *            UPDATE, then quota and blob refcounts, then each changed directory, the destination
 *            parent last
 */
import { sql } from 'kysely';

import { deriveIno, type Change, type OpSubmit } from '@plotinium/protocol';
import {
  checkCopySource,
  checkCreate,
  checkOpen,
  checkRemove,
  DEFAULT_UMASK,
  type Cred,
  type PermSubject,
} from '@plotinium/vfs/perm';

import { checkWriteLeases } from '../../engine/locks/fencing.ts';
import type { Versioned } from '../../engine/sync/base-check.ts';
import { kyselyContentSql } from '../../engine/sync/kysely-content.ts';
import type { StoredResult } from '../../engine/sync/outcome.ts';
import type { OpHandler } from '../tx.ts';
import {
  VfsError,
  type BodyResult,
  type Ino,
  type LockPlan,
  type Locked,
  type OpContext,
  type Uid,
} from '../types.ts';
import {
  addUsage,
  checkTraverse,
  credOf,
  entryOf,
  fullRows,
  isWellKnown,
  lockedRow,
  parentOf,
  touchDir,
  uids,
  upsertOf,
  versionOf,
  type Tx,
} from './common.ts';

type CopyOp = Extract<OpSubmit['op'], { kind: 'copy' }>;
type NodeType = 'f' | 'd' | 'l';

/** vfs/src/limits.ts BULK_MAX_NODES. TODO(boundary): import it once server may use vfs/limits. */
export const COPY_MAX_NODES = 50_000;

/**
 * vfs/src/names.ts compareCodePoints (the client's entry order). TODO(boundary): import it once
 * `@plotinium/vfs/names` is allowed in SERVER_IMPORTS (w2-server-sync-locks request 6a).
 */
export function compareCodePoints(a: string, b: string): number {
  const ia = a[Symbol.iterator]();
  const ib = b[Symbol.iterator]();
  for (;;) {
    const x = ia.next();
    const y = ib.next();
    if (x.done === true) return y.done === true ? 0 : -1;
    if (y.done === true) return 1;
    const cx = x.value.codePointAt(0) ?? 0;
    const cy = y.value.codePointAt(0) ?? 0;
    if (cx !== cy) return cx - cy;
  }
}

/** Every attribute of an inode the copy reads. */
export interface CopyNode extends PermSubject {
  readonly ino: Ino;
  readonly type: NodeType;
  readonly version: number;
  readonly size: number;
  readonly nlink: number;
  readonly blobId: number | null;
  readonly symlinkTarget: string | null;
  readonly mtimeMs: number;
}

export interface CopyEntry {
  readonly name: string;
  readonly ino: Ino;
}

export interface CopyInput {
  readonly opId: string;
  readonly cred: Cred;
  readonly op: Pick<CopyOp, 'srcIno' | 'toParentIno' | 'toName' | 'recursive' | 'preserve'>;
  /** Rows of the source subtree, the destination parent and the existing target subtree. */
  readonly node: (ino: Ino) => CopyNode | undefined;
  /** Entries of a source directory or an existing target directory. */
  readonly children: (dirIno: Ino) => readonly CopyEntry[];
  /** True when `ino` is the source or inside the source subtree (the EINVAL check). */
  readonly inSource: (ino: Ino) => boolean;
  readonly umask?: number;
  readonly maxNodes?: number;
}

export interface NewNode {
  readonly ino: Ino;
  readonly srcIno: Ino;
  readonly parentIno: Ino;
  readonly name: string;
  readonly type: NodeType;
  readonly mode: number;
  readonly uid: Uid;
  readonly gid: number;
  readonly size: number;
  readonly blobId: number | null;
  readonly symlinkTarget: string | null;
  /** null: the commit time. */
  readonly mtimeMs: number | null;
  /** 2 + the directories created inside it (directories), 1 otherwise. */
  nlink: number;
}

export interface Overwrite {
  readonly ino: Ino;
  readonly parentIno: Ino;
  readonly name: string;
  readonly uid: Uid;
  readonly oldSize: number;
  readonly oldBlobId: number | null;
  readonly size: number;
  readonly blobId: number | null;
}

export interface Replace {
  readonly parentIno: Ino;
  readonly name: string;
  readonly node: CopyNode;
}

export interface CopyActions {
  /** In creation order (pre-order, code-point order). */
  readonly creates: readonly NewNode[];
  readonly overwrites: readonly Overwrite[];
  readonly replaces: readonly Replace[];
  /** Existing directories whose entries change, with the change of their nlink. */
  readonly dirDeltas: ReadonlyMap<Ino, number>;
}

const fail = (
  errno: ConstructorParameters<typeof VfsError>[0],
  detail: Record<string, unknown> = {},
): never => {
  throw new VfsError(errno, detail);
};

/**
 * The client's planCopy traversal over server rows: pure, so it can be tested without a database.
 * Throws the same errno the client would for the whole op.
 */
export function planCopyActions(input: CopyInput): CopyActions {
  const { cred, op } = input;
  const umask = input.umask ?? DEFAULT_UMASK;
  const maxNodes = input.maxNodes ?? COPY_MAX_NODES;
  const node = (ino: Ino): CopyNode => input.node(ino) ?? fail('ENOENT', { ino });
  const orFail = (errno: ReturnType<typeof checkCreate>, ino: Ino): void => {
    if (errno !== null) fail(errno, { ino });
  };
  const creates: NewNode[] = [];
  const overwrites: Overwrite[] = [];
  const replaces: Replace[] = [];
  const dirDeltas = new Map<Ino, number>();
  /** New directories by ino: their children are all new. */
  const created = new Map<Ino, NewNode>();
  const derived = new Map<Ino, Ino>();
  const preserve = op.preserve === true;

  const src = node(op.srcIno);
  if (src.type === 'd' && !op.recursive) fail('EISDIR', { ino: src.ino });
  const toParent = node(op.toParentIno);
  if (toParent.type !== 'd') fail('ENOTDIR', { ino: toParent.ino });
  if (src.type === 'd' && input.inSource(toParent.ino)) fail('EINVAL', { reason: 'into-itself' });

  const newIno = (s: CopyNode): Ino => {
    const ino = deriveIno(input.opId, derived.get(s.ino) ?? s.ino);
    derived.set(s.ino, ino);
    return ino;
  };
  const modeOf = (s: CopyNode): number => {
    if (s.type === 'l') return 0o777;
    return preserve ? s.mode : s.mode & 0o777 & ~umask;
  };
  const sorted = (dirIno: Ino): CopyEntry[] =>
    [...input.children(dirIno)].sort((x, y) => compareCodePoints(x.name, y.name));
  const changed = (dirIno: Ino, delta: number): void => {
    const n = created.get(dirIno);
    if (n !== undefined) {
      if (delta !== 0) n.nlink += delta;
      return;
    }
    dirDeltas.set(dirIno, (dirDeltas.get(dirIno) ?? 0) + delta);
  };
  /** The directory an entry is created in, as a permission subject. */
  const dirSubject = (dirIno: Ino): PermSubject => created.get(dirIno) ?? node(dirIno);
  /** The existing entry of a directory, or null (a new directory is always empty). */
  const childOf = (dirIno: Ino, name: string): CopyNode | null => {
    if (created.has(dirIno)) return null;
    const e = input.children(dirIno).find((c) => c.name === name);
    return e === undefined ? null : node(e.ino);
  };

  const createCopy = (s: CopyNode, parentIno: Ino, name: string): void => {
    orFail(checkCreate(cred, dirSubject(parentIno)), parentIno);
    orFail(checkCopySource(cred, s), s.ino);
    if (creates.length + 1 > maxNodes) fail('EINVAL', { reason: 'too-large' });
    const owner =
      preserve && cred.uid === 0 ? { uid: s.uid, gid: s.gid } : { uid: cred.uid, gid: cred.gid };
    const n: NewNode = {
      ino: newIno(s),
      srcIno: s.ino,
      parentIno,
      name,
      type: s.type,
      mode: modeOf(s),
      ...owner,
      size: s.type === 'd' ? 0 : s.size,
      blobId: s.type === 'f' ? s.blobId : null,
      symlinkTarget: s.type === 'l' ? s.symlinkTarget : null,
      mtimeMs: preserve ? s.mtimeMs : null,
      nlink: s.type === 'd' ? 2 : 1,
    };
    creates.push(n);
    changed(parentIno, n.type === 'd' ? 1 : 0);
    if (n.type === 'd') {
      created.set(n.ino, n);
      for (const e of sorted(s.ino)) copyInto(node(e.ino), n.ino, e.name);
    }
  };

  const copyInto = (s: CopyNode, parentIno: Ino, name: string): void => {
    const dst = childOf(parentIno, name);
    if (dst === null) {
      createCopy(s, parentIno, name);
      return;
    }
    if (s.type === 'd') {
      if (dst.type !== 'd') fail('ENOTDIR', { ino: dst.ino });
      orFail(checkCopySource(cred, s), s.ino);
      orFail(checkCreate(cred, dst), dst.ino);
      for (const e of sorted(s.ino)) copyInto(node(e.ino), dst.ino, e.name);
      return;
    }
    if (dst.type === 'd') fail('EISDIR', { ino: dst.ino });
    orFail(checkCopySource(cred, s), s.ino);
    if (isWellKnown(dst.ino)) fail('EPERM', { reason: 'synthesised', ino: dst.ino });
    if (s.type === 'f' && dst.type === 'f') {
      orFail(checkOpen(cred, dst, false, true), dst.ino);
      overwrites.push({
        ino: dst.ino,
        parentIno,
        name,
        uid: dst.uid,
        oldSize: dst.size,
        oldBlobId: dst.blobId,
        size: s.size,
        blobId: s.blobId,
      });
      return;
    }
    // A symlink on either side: the entry is replaced (unlink, then a fresh copy under the name).
    orFail(checkRemove(cred, dirSubject(parentIno), dst), dst.ino);
    replaces.push({ parentIno, name, node: dst });
    changed(parentIno, 0);
    createCopy(s, parentIno, name);
  };

  copyInto(src, toParent.ino, op.toName);
  return { creates, overwrites, replaces, dirDeltas };
}

// -------------------------------------------------------------------------------------------------
// SQL helpers
// -------------------------------------------------------------------------------------------------

interface TreeEntry {
  readonly parentIno: Ino;
  readonly name: string;
  readonly ino: Ino;
  readonly dType: NodeType;
  readonly ownerUid: Uid;
}

/** Every entry below `root` (root excluded), lock-free or under the locks. */
async function entriesUnder(tx: Tx, root: Ino): Promise<readonly TreeEntry[]> {
  const r = await sql<{
    parent_ino: string;
    name: string;
    ino: string;
    d_type: NodeType;
    owner_uid: number;
  }>`
    WITH RECURSIVE sub(parent_ino, name, ino, d_type, owner_uid, depth) AS (
      SELECT d.parent_ino, d.name, d.ino, d.d_type, d.owner_uid, 1 FROM dentries d WHERE d.parent_ino = ${root}::uuid
      UNION ALL
      SELECT c.parent_ino, c.name, c.ino, c.d_type, c.owner_uid, s.depth + 1
      FROM sub s JOIN dentries c ON c.parent_ino = s.ino
      WHERE s.d_type = 'd' AND s.depth < 4096)
    SELECT parent_ino, name, ino, d_type, owner_uid FROM sub`.execute(tx);
  return r.rows.map((x) => ({
    parentIno: x.parent_ino,
    name: x.name,
    ino: x.ino,
    dType: x.d_type,
    ownerUid: x.owner_uid,
  }));
}

type Time = Date | string;
const msOf = (t: Time): number => (t instanceof Date ? t : new Date(t)).getTime();

async function copyNodes(tx: Tx, inos: readonly Ino[]): Promise<Map<Ino, CopyNode>> {
  const out = new Map<Ino, CopyNode>();
  if (inos.length === 0) return out;
  const r = await sql<{
    ino: string;
    type: NodeType;
    mode: number;
    uid: number;
    gid: number;
    version: number | string;
    size: number | string;
    nlink: number;
    blob_id: number | string | null;
    symlink_target: string | null;
    modified_at: Time;
  }>`
    SELECT ino, type, mode, uid, gid, version, size, nlink, blob_id, symlink_target, modified_at
    FROM inodes WHERE ino = ANY(${[...new Set(inos)]}::uuid[])`.execute(tx);
  for (const x of r.rows) {
    out.set(x.ino, {
      ino: x.ino,
      type: x.type,
      mode: x.mode,
      uid: x.uid,
      gid: x.gid,
      version: Number(x.version),
      size: Number(x.size),
      nlink: x.nlink,
      blobId: x.blob_id === null ? null : Number(x.blob_id),
      symlinkTarget: x.symlink_target,
      mtimeMs: msOf(x.modified_at),
    });
  }
  return out;
}

// -------------------------------------------------------------------------------------------------
// The handler
// -------------------------------------------------------------------------------------------------

interface Trees {
  readonly src: { readonly ino: Ino; readonly type: NodeType; readonly uid: Uid };
  readonly srcEntries: readonly TreeEntry[];
  /** The existing entry at (toParentIno, toName), when there is one. */
  readonly target: { readonly ino: Ino; readonly dType: NodeType; readonly ownerUid: Uid } | null;
  readonly targetEntries: readonly TreeEntry[];
}

export class CopyHandler implements OpHandler<Tx, StoredResult> {
  readonly #op: CopyOp;
  readonly #submit: OpSubmit;
  #toParentOwner: Uid = 0;
  #trees: Trees | null = null;
  #actions: CopyActions | null = null;
  #nodes = new Map<Ino, CopyNode>();

  constructor(submit: OpSubmit, op: CopyOp) {
    this.#submit = submit;
    this.#op = op;
  }

  async #collect(tx: Tx): Promise<Trees> {
    const op = this.#op;
    const r = await sql<{ ino: string; type: NodeType; uid: number }>`
      SELECT ino, type, uid FROM inodes WHERE ino = ${op.srcIno}::uuid`.execute(tx);
    const src = r.rows[0] ?? fail('ENOENT', { ino: op.srcIno });
    const walk = src.type === 'd' && op.recursive;
    const srcEntries = walk ? await entriesUnder(tx, src.ino) : [];
    const target = await entryOf(tx, op.toParentIno, op.toName);
    const targetEntries =
      target !== null && target.dType === 'd' && walk ? await entriesUnder(tx, target.ino) : [];
    return { src, srcEntries, target, targetEntries };
  }

  #lockSets(t: Trees): { dirs: Ino[]; files: Ino[]; owners: Uid[] } {
    const dirs: Ino[] = [this.#op.toParentIno];
    const files: Ino[] = [];
    // Source owners too: a root `preserve` copy charges the new inodes to them.
    const owners: Uid[] = [this.#toParentOwner, t.src.uid];
    (t.src.type === 'd' ? dirs : files).push(t.src.ino);
    for (const e of t.srcEntries) {
      (e.dType === 'd' ? dirs : files).push(e.ino);
      owners.push(e.ownerUid);
    }
    if (t.target !== null) {
      (t.target.dType === 'd' ? dirs : files).push(t.target.ino);
      owners.push(t.target.ownerUid);
    }
    for (const e of t.targetEntries) {
      (e.dType === 'd' ? dirs : files).push(e.ino);
      owners.push(e.ownerUid);
    }
    return { dirs, files, owners };
  }

  async plan(tx: Tx, extraOwners: readonly number[]): Promise<LockPlan> {
    const parent = await sql<{ uid: number }>`
      SELECT uid FROM inodes WHERE ino = ${this.#op.toParentIno}::uuid`.execute(tx);
    const owner = parent.rows[0] ?? fail('ENOENT', { ino: this.#op.toParentIno });
    this.#toParentOwner = owner.uid;
    const trees = await this.#collect(tx);
    if (trees.src.type === 'd' && !this.#op.recursive) fail('EISDIR', { ino: trees.src.ino });
    this.#trees = trees;
    const s = this.#lockSets(trees);
    return {
      owners: [...s.owners, ...extraOwners],
      renameLock: false,
      dirs: s.dirs,
      files: s.files,
      subtreeRoots: [],
    };
  }

  /** Both subtrees re-collected under the locks until stable (new directories, new owners). */
  async replan(tx: Tx, _locked: Locked): Promise<{ dirs: readonly Ino[]; owners: readonly Uid[] }> {
    this.#trees = await this.#collect(tx);
    const s = this.#lockSets(this.#trees);
    return { dirs: s.dirs, owners: s.owners };
  }

  /** The locked source subtree for a digest base (withBaseCheck). */
  sourceRows(locked: Locked, rootIno: Ino): Versioned[] {
    const t = this.#trees;
    if (t === null || rootIno !== t.src.ino) return [];
    const out: Versioned[] = [];
    for (const ino of [t.src.ino, ...t.srcEntries.map((e) => e.ino)]) {
      const row = locked.rows.get(ino);
      if (row !== undefined) out.push({ ino, version: row.version });
    }
    return out;
  }

  async recheck(tx: Tx, op: OpContext, locked: Locked): Promise<void> {
    const t = this.#trees ?? fail('EIO', { reason: 'server' });
    lockedRow(locked, this.#op.toParentIno);
    lockedRow(locked, t.src.ino);
    const cred = await credOf(tx, op);
    await checkTraverse(tx, cred, this.#op.toParentIno);
    const up = await parentOf(tx, t.src.ino);
    if (up !== null) await checkTraverse(tx, cred, up.parentIno);

    const inos = [
      this.#op.toParentIno,
      t.src.ino,
      ...t.srcEntries.map((e) => e.ino),
      ...(t.target === null ? [] : [t.target.ino]),
      ...t.targetEntries.map((e) => e.ino),
    ];
    this.#nodes = await copyNodes(tx, inos);
    const byParent = new Map<Ino, CopyEntry[]>();
    const add = (e: TreeEntry): void => {
      const list = byParent.get(e.parentIno) ?? [];
      list.push({ name: e.name, ino: e.ino });
      byParent.set(e.parentIno, list);
    };
    t.srcEntries.forEach(add);
    t.targetEntries.forEach(add);
    if (t.target !== null) {
      const list = byParent.get(this.#op.toParentIno) ?? [];
      list.push({ name: this.#op.toName, ino: t.target.ino });
      byParent.set(this.#op.toParentIno, list);
    }
    const inSource = new Set([t.src.ino, ...t.srcEntries.map((e) => e.ino)]);
    this.#actions = planCopyActions({
      opId: op.opId,
      cred,
      op: this.#op,
      node: (ino) => this.#nodes.get(ino),
      children: (dir) => byParent.get(dir) ?? [],
      inSource: (ino) => inSource.has(ino),
    });

    const touched = [
      ...this.#actions.overwrites.map((o) => o.ino),
      ...this.#actions.replaces.map((r) => r.node.ino),
    ];
    if (touched.length > 0) {
      const targets = touched.map((ino) => ({
        ino,
        lockFence: locked.rows.get(ino)?.lock_fence ?? 0,
      }));
      const verdict = checkWriteLeases({
        osSessionId: op.osSessionId,
        fences: this.#submit.fences ?? [],
        targets,
        leases: await kyselyContentSql.leasesOn(tx, touched),
        bulk: touched.length > 1,
      });
      if (!verdict.ok) throw new VfsError('EBUSY', { reason: verdict.reason, ino: verdict.ino });
    }
  }

  async body(tx: Tx, _locked: Locked): Promise<BodyResult<StoredResult>> {
    const a = this.#actions ?? fail('EIO', { reason: 'server' });
    const usage = new Map<Uid, { bytes: number; inodes: number }>();
    const charge = (uid: Uid, bytes: number, inodes: number): void => {
      const u = usage.get(uid) ?? { bytes: 0, inodes: 0 };
      usage.set(uid, { bytes: u.bytes + bytes, inodes: u.inodes + inodes });
    };
    const blobDelta = new Map<number, number>();
    const ref = (blobId: number | null, n: number): void => {
      if (blobId !== null) blobDelta.set(blobId, (blobDelta.get(blobId) ?? 0) + n);
    };
    const changes: Change[] = [];

    // 1. Replaced entries (a symlink on either side): the single-name unlink of §4.11.8.
    for (const r of a.replaces) {
      const del = await sql<{ ino: string }>`
        DELETE FROM dentries WHERE parent_ino = ${r.parentIno}::uuid AND name = ${r.name} RETURNING ino`.execute(
        tx,
      );
      if (del.rows.length !== 1) fail('EAGAIN', { reason: 'stale-version', ino: r.node.ino });
      if (r.node.nlink <= 1) {
        await sql`DELETE FROM inodes WHERE ino = ${r.node.ino}::uuid`.execute(tx);
        charge(r.node.uid, -r.node.size, -1);
        ref(r.node.blobId, -1);
      } else {
        await sql`UPDATE inodes SET nlink = nlink - 1, changed_at = now(), version = version + 1
                  WHERE ino = ${r.node.ino}::uuid`.execute(tx);
      }
      changes.push({
        kind: 'unlink',
        ino: r.node.ino,
        version: r.node.version,
        parentIno: r.parentIno,
        name: r.name,
        type: r.node.type,
      });
    }

    // 2. Every new inode, then every new name, in pre-order (fault nodes 1..N).
    if (a.creates.length > 0) {
      const c = a.creates;
      await sql`
        INSERT INTO inodes (ino, type, mode, uid, gid, size, nlink, blob_id, symlink_target, modified_at)
        SELECT u.ino, u.type, u.mode, u.uid, u.gid, u.size, u.nlink, u.blob_id, u.target,
               coalesce(to_timestamp(u.mtime / 1000.0), now())
        FROM unnest(${c.map((n) => n.ino)}::uuid[], ${c.map((n) => n.type)}::text[],
                    ${c.map((n) => n.mode)}::int[], ${c.map((n) => n.uid)}::int[],
                    ${c.map((n) => n.gid)}::int[], ${c.map((n) => n.size)}::bigint[],
                    ${c.map((n) => n.nlink)}::int[], ${c.map((n) => n.blobId)}::bigint[],
                    ${c.map((n) => n.symlinkTarget)}::text[], ${c.map((n) => n.mtimeMs)}::double precision[])
             WITH ORDINALITY AS u(ino, type, mode, uid, gid, size, nlink, blob_id, target, mtime, ord)
        ORDER BY u.ord`.execute(tx);
      const linked = await sql<{ ino: string }>`
        INSERT INTO dentries (parent_ino, name, ino, d_type, owner_uid)
        SELECT u.parent_ino, u.name, u.ino, u.d_type, u.owner_uid
        FROM unnest(${c.map((n) => n.parentIno)}::uuid[], ${c.map((n) => n.name)}::text[],
                    ${c.map((n) => n.ino)}::uuid[], ${c.map((n) => n.type)}::text[],
                    ${c.map((n) => n.uid)}::int[])
             WITH ORDINALITY AS u(parent_ino, name, ino, d_type, owner_uid, ord)
        ORDER BY u.ord
        ON CONFLICT ON CONSTRAINT dentries_pkey DO NOTHING
        RETURNING ino`.execute(tx);
      if (linked.rows.length !== c.length) fail('EEXIST', { parentIno: this.#op.toParentIno });
      for (const n of c) {
        charge(n.uid, n.size, 1);
        ref(n.blobId, 1);
      }
    }

    // 3. Files overwritten in place: the target keeps its ino and takes the source's content.
    if (a.overwrites.length > 0) {
      const o = a.overwrites;
      await sql`
        UPDATE inodes i SET blob_id = u.blob_id, size = u.size, modified_at = now(), changed_at = now(),
                            version = i.version + 1
        FROM unnest(${o.map((x) => x.ino)}::uuid[], ${o.map((x) => x.blobId)}::bigint[],
                    ${o.map((x) => x.size)}::bigint[]) AS u(ino, blob_id, size)
        WHERE i.ino = u.ino`.execute(tx);
      for (const x of o) {
        charge(x.uid, x.size - x.oldSize, 0);
        ref(x.blobId, 1);
        ref(x.oldBlobId, -1);
      }
    }

    // 4. Quota (the users CHECK raises EDQUOT, root exempt) and blob refcounts.
    for (const uid of uids(usage.keys())) {
      const u = usage.get(uid);
      if (u !== undefined) await addUsage(tx, uid, u.bytes, u.inodes);
    }
    const blobs = [...blobDelta].filter(([, n]) => n !== 0);
    if (blobs.length > 0) {
      await sql`
        UPDATE blobs b SET refcount = b.refcount + r.n,
                           zero_since = CASE WHEN b.refcount + r.n = 0 THEN now() END,
                           first_ref_at = CASE WHEN r.n > 0 THEN coalesce(b.first_ref_at, now()) ELSE b.first_ref_at END
        FROM unnest(${blobs.map(([id]) => id)}::bigint[], ${blobs.map(([, n]) => n)}::int[]) AS r(blob_id, n)
        WHERE b.blob_id = r.blob_id`.execute(tx);
    }

    // 5. Every existing directory whose entries changed, the destination parent last.
    const dirs = [...a.dirDeltas.keys()].sort((x, y) =>
      x === this.#op.toParentIno ? 1 : y === this.#op.toParentIno ? -1 : x < y ? -1 : 1,
    );
    for (const d of dirs) await touchDir(tx, d, a.dirDeltas.get(d) ?? 0);

    const rows = await fullRows(tx, [
      ...a.creates.map((n) => n.ino),
      ...a.overwrites.map((x) => x.ino),
      ...dirs,
    ]);
    const versions = [];
    for (const d of [...dirs].reverse()) {
      const row = rows.get(d);
      if (row !== undefined) versions.push(versionOf(row));
    }
    for (const n of a.creates) {
      const row = rows.get(n.ino);
      if (row === undefined) continue;
      changes.push(upsertOf(row, { parentIno: n.parentIno, name: n.name }));
      versions.push(versionOf(row));
    }
    for (const x of a.overwrites) {
      const row = rows.get(x.ino);
      if (row === undefined) continue;
      changes.push(upsertOf(row));
      versions.push(versionOf(row));
    }
    const owners: Uid[] = [...usage.keys()];
    for (const d of dirs) {
      const row = rows.get(d);
      if (row === undefined) continue;
      changes.push(upsertOf(row));
      owners.push(row.uid);
    }
    for (const r of a.replaces) owners.push(r.node.uid);
    return {
      status: 'applied',
      result: { versions },
      effects: { changes, dirs },
      owners: uids(owners),
    };
  }
}
