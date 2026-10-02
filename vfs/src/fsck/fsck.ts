/**
 * `fsck` (virtual-file-system.md §3.21, VFS-11, PVFS-15): check the invariants, optionally repair
 * locally, and compute the tree checksum of §5.6 (the DB-02 proof). Exit codes: 0 clean, 1 problems
 * remain, 2 something was repaired. The repairs become a diff applied in one local transaction that
 * also sets `meta.fsckDirty`, so the next online session re-validates against a snapshot.
 */
import { INO } from '@plotinium/protocol';

import { treeChecksum } from '../digest.ts';
import type {
  BlobRec,
  DentryRec,
  InodeRec,
  MetaRec,
  OutboxRec,
  UserRec,
  Uuid,
} from '../store/records.ts';
import type { Store, TxHandle } from '../store/store.ts';
import { checkAll, isClean } from './check.ts';
import type { InvariantId, InvariantResult } from './check.ts';
import { repairAll } from './repair.ts';
import { FsState } from './state.ts';
import type { FsckInput } from './state.ts';

export interface FsckOptions {
  readonly repair?: boolean;
  /** Server semantics for I4/I6 (every row is local). */
  readonly complete?: boolean;
  readonly now?: number;
  readonly scope?: string;
}

export interface FsckReport {
  readonly scope: string;
  readonly checked: { readonly inodes: number; readonly dentries: number; readonly blobs: number };
  readonly invariants: readonly InvariantResult[];
  readonly repaired?: readonly { id: InvariantId; count: number }[];
  readonly exitCode: 0 | 1 | 2;
}

export interface RepairDiff {
  readonly inodesPut: readonly InodeRec[];
  readonly inodesDel: readonly Uuid[];
  readonly dentriesPut: readonly DentryRec[];
  readonly dentriesDel: readonly (readonly [Uuid, string])[];
  readonly users: readonly UserRec[];
  readonly blobs: readonly BlobRec[];
  readonly outbox: readonly OutboxRec[];
  readonly undoDel: readonly Uuid[];
  readonly meta: readonly MetaRec[];
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

function diffOf(before: FsState, after: FsState): RepairDiff {
  const inodesPut = [...after.inodes.values()].filter((n) => !same(before.inodes.get(n.ino), n));
  const inodesDel = [...before.inodes.keys()].filter((k) => !after.inodes.has(k));
  const dentriesPut = [...after.dentries.entries()]
    .filter(([k, d]) => !same(before.dentries.get(k), d))
    .map(([, d]) => d);
  const dentriesDel = [...before.dentries.entries()]
    .filter(([k]) => !after.dentries.has(k))
    .map(([, d]) => [d.parent, d.name] as const);
  const users = [...after.users.values()].filter((u) => !same(before.users.get(u.uid), u));
  const blobs = [...after.blobs.values()].filter((b) => !same(before.blobs.get(b.sha), b));
  const outbox = after.outbox.filter((o, i) => !same(before.outbox[i], o));
  const undoDel = [...before.undo.keys()].filter((k) => !after.undo.has(k));
  const meta: MetaRec[] = [{ k: 'fsckDirty', v: true }];
  if (after.tmpfsUsage !== undefined && !same(before.tmpfsUsage, after.tmpfsUsage))
    meta.push({ k: 'tmpfsUsage', v: after.tmpfsUsage });
  return { inodesPut, inodesDel, dentriesPut, dentriesDel, users, blobs, outbox, undoDel, meta };
}

export function fsck(
  input: FsckInput,
  opts: FsckOptions = {},
): { report: FsckReport; diff: RepairDiff | null; repairedState: FsState | null } {
  const checked = {
    inodes: input.inodes.length,
    dentries: input.dentries.length,
    blobs: input.blobs?.length ?? 0,
  };
  const scope = opts.scope ?? '/';
  const state = new FsState(input);
  const first = checkAll(state, opts);
  if (opts.repair !== true || isClean(first)) {
    return {
      report: { scope, checked, invariants: first, exitCode: isClean(first) ? 0 : 1 },
      diff: null,
      repairedState: null,
    };
  }
  const fixed = new FsState(input);
  const counts = repairAll(fixed, {
    now: opts.now ?? 0,
    ...(opts.complete === undefined ? {} : { complete: opts.complete }),
  });
  const after = checkAll(fixed, opts);
  const repaired = [...counts].map(([id, count]) => ({ id, count }));
  return {
    report: {
      scope,
      checked,
      invariants: after,
      repaired,
      exitCode: counts.size > 0 ? 2 : isClean(after) ? 0 : 1,
    },
    diff: diffOf(new FsState(input), fixed),
    repairedState: fixed,
  };
}

/**
 * `fsck --checksum [path]` (§5.6): one line per dentry of the subtree of `root` plus the root's own
 * line (for `/`, parent and name are empty), over the rows given.
 */
export function checksumOf(
  input: Pick<FsckInput, 'inodes' | 'dentries'>,
  root: Uuid = INO.ROOT,
): string {
  const inodes = new Map(input.inodes.map((n) => [n.ino, n]));
  const children = new Map<Uuid, DentryRec[]>();
  let rootEntry: DentryRec | undefined;
  for (const d of input.dentries) {
    if (d.ino === root && d.dtype === 'd') rootEntry = d;
    const list = children.get(d.parent);
    if (list === undefined) children.set(d.parent, [d]);
    else list.push(d);
  }
  const rootInode = inodes.get(root);
  if (rootInode === undefined) throw new Error(`checksum: no inode ${root}`);
  const entries: { dentry: DentryRec; inode: InodeRec }[] = [];
  const seen = new Set<string>();
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined || seen.has(dir)) continue;
    seen.add(dir);
    for (const d of children.get(dir) ?? []) {
      const inode = inodes.get(d.ino);
      if (inode === undefined || inode.fs === 'tmp') continue;
      entries.push({ dentry: d, inode });
      if (inode.type === 'd') stack.push(d.ino);
    }
  }
  const top =
    root === INO.ROOT || rootEntry === undefined
      ? { parent: '', name: '' }
      : { parent: rootEntry.parent, name: rootEntry.name };
  return treeChecksum({ ...top, inode: rootInode }, entries);
}

/** The synchronous builder of a repair transaction (local-only: no outbox, no undo). */
export function repairBuilder(diff: RepairDiff): (t: TxHandle) => void {
  return (t) => {
    for (const [p, n] of diff.dentriesDel) t.del('dentries', [p, n]);
    for (const ino of diff.inodesDel) t.del('inodes', ino);
    for (const n of diff.inodesPut) t.put('inodes', n);
    for (const d of diff.dentriesPut) t.put('dentries', d);
    for (const u of diff.users) t.put('users', u);
    for (const b of diff.blobs) t.put('blobs', b);
    for (const o of diff.outbox) t.put('outbox', o);
    for (const k of diff.undoDel) t.del('undo', k);
    for (const m of diff.meta) t.put('meta', m);
  };
}

export async function applyRepair(store: Store, diff: RepairDiff): Promise<void> {
  await store.tx(
    ['inodes', 'dentries', 'users', 'blobs', 'outbox', 'undo', 'meta'],
    'strict',
    repairBuilder(diff),
    { label: 'fsck --repair' },
  );
}
