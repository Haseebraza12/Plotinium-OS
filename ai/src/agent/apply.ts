/**
 * Validation checks 4–8 and the dry run, applied op by op to the overlay (agentic-shell.md §3.11,
 * §3.12): path resolution, capability roots, permissions, quota projection and overwrite
 * detection. The first failure rejects the whole plan (AGT-02); nothing here ever mutates the
 * real tree.
 *
 * Plotinium design (§3.12): an agent `unlink` becomes a rename into `$HOME/.trash/<txnId>/<n>-<name>`
 * (`.trash` created with mode 700 in the same batch), and an overwritten target is moved there
 * first, so deletions and overwrites stay recoverable for `ai undo`.
 */
import { type BatchOp, type ModeChange, applyModeChange } from '@plotinium/protocol';

import { utf8Length } from '../util/bytes.ts';
import type { Cred, PermOracle } from '../util/cred.ts';
import { type Result, fail, ok } from '../util/errors.ts';
import { type OvNode, type Overlay, isUnder, joinPath, normalizePath } from './fsview.ts';

/** Quota of one owner (protocol `Quota`); null limits mean exempt (root). */
export interface QuotaInfo {
  usedBytes: number;
  quotaBytes: number | null;
  usedInodes: number;
  quotaInodes: number | null;
}

export interface QuotaOracle {
  quota(uid: number): QuotaInfo;
}

/** A foreign lease held on an inode makes the plan EBUSY. */
export type LeaseOracle = (ino: string) => boolean;

export type OpKind = 'create' | 'modify' | 'delete';
export type MutatingCall =
  'mkdir' | 'write' | 'rename' | 'copy' | 'unlink' | 'symlink' | 'chmod' | 'chown' | 'utimes';

/** One logical, resolved operation of the dry run (agentic-shell.md §4.1 `ResolvedOp`). */
export interface ResolvedOp {
  seq: number;
  step: string;
  call: MutatingCall;
  path: string;
  /** Second operand for display and grading: the destination, the mode or the owner. */
  arg?: string;
  kind: OpKind;
  /** The existing inode acted on (absent for creations). */
  ino?: string;
  /** The inode this op replaces. */
  overwrites?: string;
  recoverable: boolean;
  /** Inodes whose dentry, content, mode or owner this op changes. */
  inodes: number;
}

/** Inverse actions recorded at dry-run time; `undo.ts` turns them into batch ops. */
export type InverseAction =
  | { kind: 'rename'; from: string; to: string }
  | { kind: 'trash'; path: string }
  | { kind: 'chmod'; path: string; mode: number }
  | { kind: 'chown'; path: string; uid: number; gid: number }
  | { kind: 'utimes'; path: string; mtime: number };

export const TRASH_DIR = '.trash';
const SYSTEM_ROOTS = ['/system', '/bin'];
export const PLAN_INODES_MAX = 10_000;

export interface ApplyContext {
  overlay: Overlay;
  /** The agent's own credentials (never uid 0). */
  cred: Cred;
  oracle: PermOracle;
  quota: QuotaOracle;
  leases: LeaseOracle | undefined;
  cwd: string;
  home: string;
  umask: number;
  now: number;
  txnId: string;
  trash: boolean;
  /** A per-plan elevation grant is attached (§3.19): ops run as uid 0. */
  elevated: boolean;
}

const ROOT_CRED: Cred = { uid: 0, gid: 0, groups: [] };

/** Mutable dry-run accumulator shared by every op of one plan. */
export class DryRunState {
  readonly ops: ResolvedOp[] = [];
  readonly batch: BatchOp[] = [];
  readonly inverse: InverseAction[] = [];
  readonly affected = new Set<string>();
  readonly expected = new Map<string, number>();
  readonly digests = new Map<string, string[]>();
  readonly grant = new Set<string>();
  readonly quotaDelta = new Map<number, { bytes: number; inodes: number }>();
  readonly overwriteSteps = new Set<string>();
  bytes = 0;
  deletions = 0;
  overwrites = 0;
  systemPath = false;
  undoAvailable = true;
  private trashDir: OvNode | undefined;
  private trashSeq = 0;
  private readonly ctx: ApplyContext;

  constructor(ctx: ApplyContext) {
    this.ctx = ctx;
  }

  get context(): ApplyContext {
    return this.ctx;
  }

  /** The credentials the ops are checked with: uid 0 under an elevation grant. */
  get effective(): Cred {
    return this.ctx.elevated ? ROOT_CRED : this.ctx.cred;
  }

  read(node: OvNode): void {
    const v = this.ctx.overlay.baseVersion(node.ino);
    if (v !== undefined) this.expected.set(node.ino, v);
  }

  charge(uid: number, bytes: number, inodes: number): void {
    const d = this.quotaDelta.get(uid) ?? { bytes: 0, inodes: 0 };
    d.bytes += bytes;
    d.inodes += inodes;
    this.quotaDelta.set(uid, d);
  }

  grantOp(op: BatchOp['op'], ino: string): void {
    this.grant.add(`${op}\u0000${ino}`);
  }

  emit(op: BatchOp, grantIno: string): void {
    this.batch.push(op);
    this.grantOp(op.op, grantIno);
  }

  /** `$HOME/.trash/<txnId>`, created on first use with mode 700. */
  trashTarget(name: string): Result<{ dir: OvNode; path: string; name: string }> {
    const { overlay, home, txnId } = this.ctx;
    if (this.trashDir === undefined) {
      const eff = this.effective;
      const h = overlay.resolve(home, eff, this.ctx.oracle, true);
      if (!h.ok) return h;
      const trash = h.value.node.children?.get(TRASH_DIR);
      let trashNode = trash === undefined ? undefined : overlay.node(trash);
      if (trashNode === undefined) {
        trashNode = overlay.create({
          type: 'd',
          uid: eff.uid,
          gid: eff.gid,
          mode: 0o700,
          size: 0,
          mtime: this.ctx.now,
        });
        overlay.link(h.value.node, TRASH_DIR, trashNode.ino);
        this.emit(
          { op: 'mkdir', path: joinPath(home, TRASH_DIR), mode: 0o700, parents: true },
          h.value.node.ino,
        );
        this.charge(eff.uid, 0, 1);
      } else if (trashNode.type !== 'd') return fail('ENOTDIR', 'trash');
      const txnDir = overlay.create({
        type: 'd',
        uid: eff.uid,
        gid: eff.gid,
        mode: 0o700,
        size: 0,
        mtime: this.ctx.now,
      });
      overlay.link(trashNode, txnId, txnDir.ino);
      this.emit(
        { op: 'mkdir', path: joinPath(joinPath(home, TRASH_DIR), txnId), mode: 0o700 },
        trashNode.ino,
      );
      this.charge(eff.uid, 0, 1);
      this.trashDir = txnDir;
    }
    let base = `${++this.trashSeq}-${name}`;
    while (utf8Length(base) > 255) base = base.slice(0, -1);
    return ok({
      dir: this.trashDir,
      path: joinPath(joinPath(joinPath(home, TRASH_DIR), txnId), base),
      name: base,
    });
  }

  /** Move an entry into the trash (a delete or the old side of an overwrite). */
  toTrash(parent: OvNode, name: string, node: OvNode, path: string): Result<string> {
    const t = this.trashTarget(name);
    if (!t.ok) return t;
    this.ctx.overlay.unlinkEntry(parent, name);
    this.ctx.overlay.link(t.value.dir, t.value.name, node.ino);
    this.emit({ op: 'rename', from: path, to: t.value.path }, node.ino);
    this.inverse.push({ kind: 'rename', from: t.value.path, to: path });
    return ok(t.value.path);
  }

  /** Record every node of a subtree as read, with its `subtreeDigest` input. */
  subtree(root: OvNode): OvNode[] {
    const nodes = this.ctx.overlay.subtree(root);
    const pairs: string[] = [];
    for (const n of nodes) {
      this.read(n);
      const v = this.ctx.overlay.baseVersion(n.ino);
      if (v !== undefined) pairs.push(`${n.ino}:${v}`);
    }
    if (!root.created) this.digests.set(root.ino, pairs.sort());
    return nodes;
  }
}

type StepResult = Result<undefined>;
const done: StepResult = ok(undefined);

function err<T = undefined>(
  errno: Parameters<typeof fail>[0],
  step: string,
  reason?: string,
): Result<T> {
  return fail(errno, reason, step);
}

/** Checks 4 and 5 on a path the plan mutates: normalisation, capability roots, system paths. */
export function mutatedPath(st: DryRunState, raw: string, step: string): Result<string> {
  const { cwd, home, elevated } = st.context;
  const p = normalizePath(raw, cwd, home);
  if (p === undefined) return err('EINVAL', step);
  if (SYSTEM_ROOTS.some((r) => isUnder(p, r))) {
    if (!elevated) return err('EPERM', step, 'system-path');
    st.systemPath = true;
    return ok(p);
  }
  if (!isUnder(p, cwd) && !isUnder(p, home)) return err('EPERM', step, 'scope');
  return ok(p);
}

function canWriteDir(st: DryRunState, dir: OvNode): boolean {
  const o = st.context.oracle;
  const c = st.effective;
  return o.may(c, dir, 'w') && o.may(c, dir, 'x');
}

/** The sticky-directory rule: only the entry's owner, the directory's owner or root may remove. */
function stickyAllows(st: DryRunState, dir: OvNode, entry: OvNode): boolean {
  const uid = st.effective.uid;
  return (dir.mode & 0o1000) === 0 || uid === 0 || uid === entry.uid || uid === dir.uid;
}

function leased(st: DryRunState, nodes: readonly OvNode[]): boolean {
  const l = st.context.leases;
  return l !== undefined && nodes.some((n) => !n.created && l(n.ino));
}

function newMode(st: DryRunState, base: number): number {
  return base & ~st.context.umask & 0o7777;
}

function push(st: DryRunState, op: Omit<ResolvedOp, 'seq'>): void {
  st.ops.push({ seq: st.ops.length + 1, ...op });
}

/**
 * Check 8 for a name about to be replaced: a type mismatch or a non-empty directory is rejected;
 * anything else is an OVERWRITE (confirmable), moved to the trash first.
 */
function replaceExisting(
  st: DryRunState,
  step: string,
  dir: OvNode,
  name: string,
  path: string,
  existing: OvNode,
  incoming: 'f' | 'd' | 'l',
): Result<string | undefined> {
  if (existing.type === 'd' && incoming !== 'd') return err('EISDIR', step);
  if (existing.type !== 'd' && incoming === 'd') return err('ENOTDIR', step);
  if (existing.type === 'd' && (existing.children?.size ?? 0) > 0) return err('ENOTEMPTY', step);
  if (!stickyAllows(st, dir, existing)) return err('EPERM', step, 'sticky');
  if (leased(st, [existing])) return err('EBUSY', step, 'lease');
  st.read(existing);
  st.overwriteSteps.add(step);
  st.overwrites++;
  st.affected.add(existing.ino);
  if (!st.context.trash) {
    st.context.overlay.unlinkEntry(dir, name);
    st.undoAvailable = false;
    return ok(existing.ino);
  }
  const moved = st.toTrash(dir, name, existing, path);
  return moved.ok ? ok(existing.ino) : moved;
}

export function applyMkdir(
  st: DryRunState,
  step: string,
  rawPath: string,
  parents: boolean,
): StepResult {
  const p = mutatedPath(st, rawPath, step);
  if (!p.ok) return p;
  const { overlay, oracle } = st.context;
  const eff = st.effective;
  const parts = p.value.split('/').filter((s) => s !== '');
  const missing: string[] = [];
  // With `parents`, walk down and create every missing component; without, only the last.
  let prefix = '/';
  for (let i = 0; i < parts.length; i++) {
    const name = parts[i] ?? '';
    const path = joinPath(prefix, name);
    const last = i === parts.length - 1;
    const r = overlay.resolveParent(path, eff, oracle);
    if (!r.ok) return fail(r.error.errno, r.error.reason, step);
    if (r.value.existing !== undefined) {
      if (last && !parents) return err('EEXIST', step);
      // An existing component must be (or link to) a directory.
      const res = overlay.resolve(path, eff, oracle, true);
      if (!res.ok || res.value.node.type !== 'd') return err(last ? 'EEXIST' : 'ENOTDIR', step);
      prefix = res.value.path;
      continue;
    }
    if (!last && !parents) return err('ENOENT', step);
    if (!canWriteDir(st, r.value.dir)) return err('EACCES', step);
    st.read(r.value.dir);
    const node = overlay.create({
      type: 'd',
      uid: eff.uid,
      gid: eff.gid,
      mode: newMode(st, 0o777),
      size: 0,
      mtime: st.context.now,
    });
    overlay.link(r.value.dir, name, node.ino);
    st.affected.add(node.ino);
    st.charge(eff.uid, 0, 1);
    st.grantOp('mkdir', r.value.dir.ino);
    missing.push(path);
    prefix = path;
  }
  if (missing.length === 0) return done;
  st.batch.push(
    parents ? { op: 'mkdir', path: p.value, parents: true } : { op: 'mkdir', path: p.value },
  );
  for (const m of missing) st.inverse.push({ kind: 'trash', path: m });
  push(st, {
    step,
    call: 'mkdir',
    path: p.value,
    kind: 'create',
    recoverable: true,
    inodes: missing.length,
  });
  return done;
}

export function applyWrite(
  st: DryRunState,
  step: string,
  rawPath: string,
  text: string,
): StepResult {
  const p = mutatedPath(st, rawPath, step);
  if (!p.ok) return p;
  const { overlay, oracle } = st.context;
  const eff = st.effective;
  const r = overlay.resolveParent(p.value, eff, oracle);
  if (!r.ok) return fail(r.error.errno, r.error.reason, step);
  if (!canWriteDir(st, r.value.dir)) return err('EACCES', step);
  st.read(r.value.dir);
  let replaced: string | undefined;
  if (r.value.existing !== undefined) {
    const rep = replaceExisting(
      st,
      step,
      r.value.dir,
      r.value.name,
      r.value.path,
      r.value.existing,
      'f',
    );
    if (!rep.ok) return fail(rep.error.errno, rep.error.reason, step);
    replaced = rep.value;
  }
  const bytes = utf8Length(text);
  const node = overlay.create({
    type: 'f',
    uid: eff.uid,
    gid: eff.gid,
    mode: newMode(st, 0o666),
    size: bytes,
    mtime: st.context.now,
  });
  overlay.link(r.value.dir, r.value.name, node.ino);
  st.affected.add(node.ino);
  st.charge(eff.uid, bytes, 1);
  st.bytes += bytes;
  st.emit({ op: 'write', path: r.value.path, text }, r.value.dir.ino);
  st.inverse.push({ kind: 'trash', path: r.value.path });
  const op: Omit<ResolvedOp, 'seq'> = {
    step,
    call: 'write',
    path: r.value.path,
    kind: 'create',
    recoverable: true,
    inodes: 1,
  };
  if (replaced !== undefined) op.overwrites = replaced;
  push(st, op);
  return done;
}

export function applyRename(
  st: DryRunState,
  step: string,
  rawFrom: string,
  rawTo: string,
  noReplace: boolean | undefined,
): StepResult {
  const f = mutatedPath(st, rawFrom, step);
  if (!f.ok) return f;
  const t = mutatedPath(st, rawTo, step);
  if (!t.ok) return t;
  if (f.value === t.value) return done;
  const { overlay, oracle } = st.context;
  const eff = st.effective;
  const src = overlay.resolveParent(f.value, eff, oracle);
  if (!src.ok) return fail(src.error.errno, src.error.reason, step);
  const node = src.value.existing;
  if (node === undefined) return err('ENOENT', step);
  if (node.type === 'd' && isUnder(t.value, f.value)) return err('EINVAL', step, 'into-itself');
  const dst = overlay.resolveParent(t.value, eff, oracle);
  if (!dst.ok) return fail(dst.error.errno, dst.error.reason, step);
  if (!canWriteDir(st, src.value.dir) || !canWriteDir(st, dst.value.dir))
    return err('EACCES', step);
  if (!stickyAllows(st, src.value.dir, node)) return err('EPERM', step, 'sticky');
  if (leased(st, [node])) return err('EBUSY', step, 'lease');
  st.read(src.value.dir);
  st.read(dst.value.dir);
  st.read(node);
  let replaced: string | undefined;
  const existing = dst.value.existing;
  if (existing !== undefined && existing.ino !== node.ino) {
    if (noReplace === true) return err('EEXIST', step);
    const rep = replaceExisting(
      st,
      step,
      dst.value.dir,
      dst.value.name,
      dst.value.path,
      existing,
      node.type,
    );
    if (!rep.ok) return fail(rep.error.errno, rep.error.reason, step);
    replaced = rep.value;
  }
  overlay.unlinkEntry(src.value.dir, src.value.name);
  overlay.link(dst.value.dir, dst.value.name, node.ino);
  st.affected.add(node.ino);
  const op: BatchOp =
    noReplace === true
      ? { op: 'rename', from: src.value.path, to: dst.value.path, noReplace: true }
      : { op: 'rename', from: src.value.path, to: dst.value.path };
  st.emit(op, node.ino);
  st.inverse.push({ kind: 'rename', from: dst.value.path, to: src.value.path });
  const r: Omit<ResolvedOp, 'seq'> = {
    step,
    call: 'rename',
    path: src.value.path,
    arg: dst.value.path,
    kind: 'modify',
    ino: node.ino,
    recoverable: true,
    inodes: 1,
  };
  if (replaced !== undefined) r.overwrites = replaced;
  push(st, r);
  return done;
}

export function applyCopy(
  st: DryRunState,
  step: string,
  rawFrom: string,
  rawTo: string,
  recursive: boolean,
): StepResult {
  const { overlay, oracle, cwd, home } = st.context;
  const eff = st.effective;
  const from = normalizePath(rawFrom, cwd, home);
  if (from === undefined) return err('EINVAL', step);
  const t = mutatedPath(st, rawTo, step);
  if (!t.ok) return t;
  const src = overlay.resolve(from, eff, oracle, true);
  if (!src.ok) return fail(src.error.errno, src.error.reason, step);
  if (src.value.node.type === 'd' && !recursive) return err('EISDIR', step);
  if (src.value.node.type === 'd' && isUnder(t.value, src.value.path))
    return err('EINVAL', step, 'into-itself');
  const dst = overlay.resolveParent(t.value, eff, oracle);
  if (!dst.ok) return fail(dst.error.errno, dst.error.reason, step);
  if (!canWriteDir(st, dst.value.dir)) return err('EACCES', step);
  const nodes = src.value.node.type === 'd' ? st.subtree(src.value.node) : [src.value.node];
  if (src.value.node.type !== 'd') st.read(src.value.node);
  for (const n of nodes) {
    if (!oracle.may(eff, n, 'r') || (n.type === 'd' && !oracle.may(eff, n, 'x')))
      return err('EACCES', step);
  }
  st.read(dst.value.dir);
  let replaced: string | undefined;
  if (dst.value.existing !== undefined) {
    const rep = replaceExisting(
      st,
      step,
      dst.value.dir,
      dst.value.name,
      dst.value.path,
      dst.value.existing,
      src.value.node.type,
    );
    if (!rep.ok) return fail(rep.error.errno, rep.error.reason, step);
    replaced = rep.value;
  }
  // Copy the subtree into the overlay: new inodes owned by the caller, modes masked by umask.
  let bytes = 0;
  const clones = new Map<string, OvNode>();
  for (const n of nodes) {
    const c = overlay.create({
      type: n.type,
      uid: eff.uid,
      gid: eff.gid,
      mode: n.mode & ~st.context.umask & 0o777,
      size: n.size,
      mtime: st.context.now,
    });
    if (n.target !== undefined) c.target = n.target;
    clones.set(n.ino, c);
    if (n.type === 'f') bytes += n.size;
  }
  for (const n of nodes) {
    const c = clones.get(n.ino);
    if (c === undefined || n.children === undefined) continue;
    for (const [name, kid] of n.children) {
      const kc = clones.get(kid);
      if (kc !== undefined) overlay.link(c, name, kc.ino);
    }
  }
  const top = clones.get(src.value.node.ino);
  if (top === undefined) return err('EIO', step);
  overlay.link(dst.value.dir, dst.value.name, top.ino);
  for (const c of clones.values()) st.affected.add(c.ino);
  st.charge(eff.uid, bytes, clones.size);
  st.bytes += bytes;
  st.emit({ op: 'copy', from: src.value.path, to: dst.value.path, recursive }, src.value.node.ino);
  st.grantOp('copy', dst.value.dir.ino);
  st.inverse.push({ kind: 'trash', path: dst.value.path });
  const r: Omit<ResolvedOp, 'seq'> = {
    step,
    call: 'copy',
    path: src.value.path,
    arg: dst.value.path,
    kind: 'create',
    ino: src.value.node.ino,
    recoverable: true,
    inodes: clones.size,
  };
  if (replaced !== undefined) r.overwrites = replaced;
  push(st, r);
  return done;
}

export function applyUnlink(
  st: DryRunState,
  step: string,
  rawPath: string,
  recursive: boolean,
): StepResult {
  const p = mutatedPath(st, rawPath, step);
  if (!p.ok) return p;
  const { overlay, oracle } = st.context;
  const eff = st.effective;
  const r = overlay.resolveParent(p.value, eff, oracle);
  if (!r.ok) return fail(r.error.errno, r.error.reason, step);
  const node = r.value.existing;
  if (node === undefined) return err('ENOENT', step);
  if (node.type === 'd' && !recursive && (node.children?.size ?? 0) > 0) return err('EISDIR', step);
  if (!canWriteDir(st, r.value.dir)) return err('EACCES', step);
  if (!stickyAllows(st, r.value.dir, node)) return err('EPERM', step, 'sticky');
  const nodes = node.type === 'd' ? st.subtree(node) : [node];
  // Removing a subtree needs w+x on every directory in it (§3.11 check 6).
  for (const n of nodes) if (n.type === 'd' && !canWriteDir(st, n)) return err('EACCES', step);
  if (leased(st, nodes)) return err('EBUSY', step, 'lease');
  st.read(r.value.dir);
  st.read(node);
  for (const n of nodes) st.affected.add(n.ino);
  st.deletions++;
  if (st.context.trash) {
    const moved = st.toTrash(r.value.dir, r.value.name, node, r.value.path);
    if (!moved.ok) return fail(moved.error.errno, moved.error.reason, step);
  } else {
    overlay.unlinkEntry(r.value.dir, r.value.name);
    st.emit({ op: 'unlink', path: r.value.path, recursive }, node.ino);
    st.undoAvailable = false;
  }
  push(st, {
    step,
    call: 'unlink',
    path: r.value.path,
    kind: 'delete',
    ino: node.ino,
    recoverable: st.context.trash,
    inodes: nodes.length,
  });
  return done;
}

export function applySymlink(
  st: DryRunState,
  step: string,
  target: string,
  rawPath: string,
): StepResult {
  const p = mutatedPath(st, rawPath, step);
  if (!p.ok) return p;
  const { overlay, oracle } = st.context;
  const eff = st.effective;
  const r = overlay.resolveParent(p.value, eff, oracle);
  if (!r.ok) return fail(r.error.errno, r.error.reason, step);
  if (!canWriteDir(st, r.value.dir)) return err('EACCES', step);
  st.read(r.value.dir);
  let replaced: string | undefined;
  if (r.value.existing !== undefined) {
    const rep = replaceExisting(
      st,
      step,
      r.value.dir,
      r.value.name,
      r.value.path,
      r.value.existing,
      'l',
    );
    if (!rep.ok) return fail(rep.error.errno, rep.error.reason, step);
    replaced = rep.value;
  }
  const node = overlay.create({
    type: 'l',
    uid: eff.uid,
    gid: eff.gid,
    mode: 0o777,
    size: utf8Length(target),
    mtime: st.context.now,
  });
  node.target = target;
  overlay.link(r.value.dir, r.value.name, node.ino);
  st.affected.add(node.ino);
  st.charge(eff.uid, 0, 1);
  st.emit({ op: 'symlink', target, path: r.value.path }, r.value.dir.ino);
  st.inverse.push({ kind: 'trash', path: r.value.path });
  const op: Omit<ResolvedOp, 'seq'> = {
    step,
    call: 'symlink',
    path: r.value.path,
    arg: target,
    kind: 'create',
    recoverable: true,
    inodes: 1,
  };
  if (replaced !== undefined) op.overwrites = replaced;
  push(st, op);
  return done;
}

/** A subtree with the path of every node (for per-node inverse ops). */
function withPaths(
  st: DryRunState,
  root: OvNode,
  rootPath: string,
): Array<{ node: OvNode; path: string }> {
  const out: Array<{ node: OvNode; path: string }> = [];
  const stack = [{ node: root, path: rootPath }];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (cur === undefined) break;
    out.push(cur);
    if (cur.node.type !== 'd' || cur.node.children === undefined) continue;
    for (const [name, ino] of [...cur.node.children].sort((a, b) => (a[0] < b[0] ? 1 : -1))) {
      const n = st.context.overlay.node(ino);
      if (n !== undefined) stack.push({ node: n, path: joinPath(cur.path, name) });
    }
  }
  return out;
}

function targets(
  st: DryRunState,
  step: string,
  rawPath: string,
  recursive: boolean,
): Result<Array<{ node: OvNode; path: string }>> {
  const p = mutatedPath(st, rawPath, step);
  if (!p.ok) return p;
  const { overlay, oracle } = st.context;
  const eff = st.effective;
  const r = overlay.resolve(p.value, eff, oracle, true);
  if (!r.ok) return fail(r.error.errno, r.error.reason, step);
  if (!recursive || r.value.node.type !== 'd') {
    st.read(r.value.node);
    return ok([{ node: r.value.node, path: r.value.path }]);
  }
  st.subtree(r.value.node);
  const list = withPaths(st, r.value.node, r.value.path);
  for (const { node } of list) {
    if (node.type === 'd' && !(oracle.may(eff, node, 'r') && oracle.may(eff, node, 'x')))
      return err('EACCES', step);
  }
  return ok(list);
}

export function applyChmod(
  st: DryRunState,
  step: string,
  rawPath: string,
  mode: ModeChange,
  recursive: boolean,
  display: string,
): StepResult {
  const list = targets(st, step, rawPath, recursive);
  if (!list.ok) return list;
  const eff = st.effective;
  let changed = 0;
  for (const { node, path } of list.value) {
    if (node.type === 'l') continue;
    if (eff.uid !== 0 && eff.uid !== node.uid) return err('EPERM', step, 'owner');
    const next = applyModeChange(node.mode, mode) & 0o7777;
    if (next === node.mode) continue;
    st.inverse.push({ kind: 'chmod', path, mode: node.mode });
    node.mode = next;
    st.affected.add(node.ino);
    changed++;
  }
  const root = list.value[0];
  if (root === undefined) return done;
  st.emit(
    recursive
      ? { op: 'chmod', path: root.path, mode, recursive: true }
      : { op: 'chmod', path: root.path, mode },
    root.node.ino,
  );
  for (const { node } of list.value) st.grantOp('chmod', node.ino);
  push(st, {
    step,
    call: 'chmod',
    path: root.path,
    arg: display,
    kind: 'modify',
    ino: root.node.ino,
    recoverable: true,
    inodes: changed,
  });
  return done;
}

export function applyChown(
  st: DryRunState,
  step: string,
  rawPath: string,
  uid: number | undefined,
  gid: number | undefined,
  recursive: boolean,
): StepResult {
  if (st.effective.uid !== 0) return err('EPERM', step, 'root-only');
  const list = targets(st, step, rawPath, recursive);
  if (!list.ok) return list;
  let changed = 0;
  for (const { node, path } of list.value) {
    const nu = uid ?? node.uid;
    const ng = gid ?? node.gid;
    if (nu === node.uid && ng === node.gid) continue;
    st.inverse.push({ kind: 'chown', path, uid: node.uid, gid: node.gid });
    if (nu !== node.uid) {
      // Ownership moves the charge from the old owner to the new one.
      st.charge(node.uid, -(node.type === 'f' ? node.size : 0), -1);
      st.charge(nu, node.type === 'f' ? node.size : 0, 1);
    }
    node.uid = nu;
    node.gid = ng;
    st.affected.add(node.ino);
    changed++;
  }
  const root = list.value[0];
  if (root === undefined) return done;
  const op: BatchOp = { op: 'chown', path: root.path, recursive };
  if (uid !== undefined) op.uid = uid;
  if (gid !== undefined) op.gid = gid;
  st.emit(op, root.node.ino);
  for (const { node } of list.value) st.grantOp('chown', node.ino);
  push(st, {
    step,
    call: 'chown',
    path: root.path,
    arg: `${uid ?? ''}:${gid ?? ''}`,
    kind: 'modify',
    ino: root.node.ino,
    recoverable: true,
    inodes: changed,
  });
  return done;
}

export function applyUtimes(st: DryRunState, step: string, rawPath: string): StepResult {
  const list = targets(st, step, rawPath, false);
  if (!list.ok) return list;
  const root = list.value[0];
  if (root === undefined) return done;
  const eff = st.effective;
  if (eff.uid !== 0 && eff.uid !== root.node.uid && !st.context.oracle.may(eff, root.node, 'w'))
    return err('EACCES', step);
  st.inverse.push({ kind: 'utimes', path: root.path, mtime: root.node.mtime });
  root.node.mtime = st.context.now;
  st.affected.add(root.node.ino);
  st.emit({ op: 'utimes', path: root.path, mtime: 'now' }, root.node.ino);
  push(st, {
    step,
    call: 'utimes',
    path: root.path,
    kind: 'modify',
    ino: root.node.ino,
    recoverable: true,
    inodes: 1,
  });
  return done;
}

/** Check 7: the quota projection per affected owner. */
export function quotaCheck(
  st: DryRunState,
): Array<{ uid: number; bytesAfter: number; inodesAfter: number; ok: boolean }> {
  const out: Array<{ uid: number; bytesAfter: number; inodesAfter: number; ok: boolean }> = [];
  for (const [uid, d] of [...st.quotaDelta].sort((a, b) => a[0] - b[0])) {
    const q = st.context.quota.quota(uid);
    const bytesAfter = q.usedBytes + d.bytes;
    const inodesAfter = q.usedInodes + d.inodes;
    const okBytes = q.quotaBytes === null || d.bytes <= 0 || bytesAfter <= q.quotaBytes;
    const okInodes = q.quotaInodes === null || d.inodes <= 0 || inodesAfter <= q.quotaInodes;
    out.push({ uid, bytesAfter, inodesAfter, ok: okBytes && okInodes });
  }
  return out;
}
