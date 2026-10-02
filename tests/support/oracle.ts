/**
 * The fault-injection oracle (spec §3.6.5, §4.3, §5.5; TST-09).
 *
 * A pure function over snapshots of the tree rows. The client side builds the rows through
 * syscalls in test builds, the server side reads them with SQL (tests/fault-injection/server.ts);
 * both then go through `takeSnapshot` so the two sides are judged by the same code.
 */
import { createHash } from 'node:crypto';

export type InodeType = 'f' | 'd' | 'l';

export interface InodeRow {
  ino: string;
  type: InodeType;
  mode: number;
  uid: number;
  gid: number;
  size: number;
  nlink: number;
  version: number;
  blob: string | null;
}

export interface DentryRow {
  parent: string;
  name: string;
  ino: string;
  dType: InodeType;
}

export interface BlobRow {
  blob: string;
  refcount: number;
}

export interface QuotaRow {
  uid: number;
  usedBytes: number;
  usedInodes: number;
}

export interface StoreRows {
  /** The inode the checksum starts from (a subtree root, or `/`). */
  subtreeRoot: string;
  /** The file-system root, which legitimately has no dentry. */
  fsRoot: string;
  inodes: readonly InodeRow[];
  dentries: readonly DentryRow[];
  blobs: readonly BlobRow[];
  quota: readonly QuotaRow[];
  outboxLen: number;
  undoLen: number;
  fsckClean: boolean;
}

/** Shape fixed by spec §4.3 (shared with kernel/test/fault.ts and server/src/vfs/fault.ts). */
export interface OracleSnapshot {
  checksum: string;
  orphans: string[];
  parentless: string[];
  quota: Record<number, { usedBytes: number; usedInodes: number }>;
  refcountMismatches: string[];
  nlinkMismatches: string[];
  outboxLen: number;
  undoLen: number;
  fsckClean: boolean;
}

function countBy<T>(items: readonly T[], key: (item: T) => string | null): Map<string, number> {
  const out = new Map<string, number>();
  for (const item of items) {
    const k = key(item);
    if (k !== null) out.set(k, (out.get(k) ?? 0) + 1);
  }
  return out;
}

/** Rows of the subtree under `root` as `(ino, parent, name)` triples, root first. */
function subtree(rows: StoreRows): Array<{ ino: string; parent: string; name: string }> {
  const children = new Map<string, DentryRow[]>();
  for (const d of rows.dentries) {
    const list = children.get(d.parent);
    if (list === undefined) children.set(d.parent, [d]);
    else list.push(d);
  }
  const out = [{ ino: rows.subtreeRoot, parent: '-', name: '' }];
  const stack = [rows.subtreeRoot];
  const seen = new Set(stack);
  for (let ino = stack.pop(); ino !== undefined; ino = stack.pop()) {
    for (const d of children.get(ino) ?? []) {
      out.push({ ino: d.ino, parent: d.parent, name: d.name });
      // A hard link appears once per name but is descended only once; a cycle cannot loop.
      if (d.dType === 'd' && !seen.has(d.ino)) {
        seen.add(d.ino);
        stack.push(d.ino);
      }
    }
  }
  return out;
}

/** SHA-256 over `(ino, parent, name, type, mode, uid, gid, size, version, blob)` ordered by ino. */
export function subtreeChecksum(rows: StoreRows): string {
  const byIno = new Map(rows.inodes.map((i) => [i.ino, i]));
  const lines = subtree(rows).map(({ ino, parent, name }) => {
    const i = byIno.get(ino);
    const cols =
      i === undefined
        ? ['missing']
        : [i.type, i.mode, i.uid, i.gid, i.size, i.version, i.blob ?? '-'].map(String);
    return [ino, parent, Buffer.from(name, 'utf8').toString('hex'), ...cols].join('|');
  });
  lines.sort();
  return createHash('sha256').update(lines.join('\n'), 'utf8').digest('hex');
}

export function takeSnapshot(rows: StoreRows): OracleSnapshot {
  const inodeIds = new Set(rows.inodes.map((i) => i.ino));
  const named = new Set(rows.dentries.map((d) => d.ino));
  const orphans = rows.inodes
    .filter((i) => i.ino !== rows.fsRoot && !named.has(i.ino))
    .map((i) => i.ino);
  const parentless = rows.dentries
    .filter((d) => !inodeIds.has(d.parent))
    .map((d) => `${d.parent}/${d.name}`);

  const refs = countBy(rows.inodes, (i) => i.blob);
  const refcountMismatches = rows.blobs
    .filter((b) => (refs.get(b.blob) ?? 0) !== b.refcount)
    .map((b) => b.blob);

  // Same rule as db/probes P4: files and symlinks = number of names; directories = 2 + subdirs.
  const names = countBy(rows.dentries, (d) => d.ino);
  const subdirs = countBy(rows.dentries, (d) => (d.dType === 'd' ? d.parent : null));
  const nlinkMismatches = rows.inodes
    .filter((i) => {
      const expected = i.type === 'd' ? 2 + (subdirs.get(i.ino) ?? 0) : (names.get(i.ino) ?? 0);
      return i.nlink !== expected;
    })
    .map((i) => i.ino);

  const quota: OracleSnapshot['quota'] = {};
  for (const q of rows.quota) quota[q.uid] = { usedBytes: q.usedBytes, usedInodes: q.usedInodes };

  return {
    checksum: subtreeChecksum(rows),
    orphans,
    parentless,
    quota,
    refcountMismatches,
    nlinkMismatches,
    outboxLen: rows.outboxLen,
    undoLen: rows.undoLen,
    fsckClean: rows.fsckClean,
  };
}

/** Spec §5.5: equal checksum, empty probe sets after, equal quota per uid, equal queues. */
export function sameState(
  before: OracleSnapshot,
  after: OracleSnapshot,
): { ok: boolean; diffs: string[] } {
  const diffs: string[] = [];
  if (before.checksum !== after.checksum) diffs.push('checksum changed');
  const sets = ['orphans', 'parentless', 'refcountMismatches', 'nlinkMismatches'] as const;
  for (const key of sets) {
    if (after[key].length > 0) diffs.push(`${key}: ${after[key].join(', ')}`);
  }
  const uids = new Set([...Object.keys(before.quota), ...Object.keys(after.quota)].map(Number));
  for (const uid of uids) {
    const b = before.quota[uid];
    const a = after.quota[uid];
    if (b?.usedBytes !== a?.usedBytes || b?.usedInodes !== a?.usedInodes) {
      diffs.push(`quota of uid ${uid} changed`);
    }
  }
  if (before.outboxLen !== after.outboxLen) diffs.push('outbox length changed');
  if (before.undoLen !== after.undoLen) diffs.push('undo length changed');
  if (!after.fsckClean) diffs.push('fsck not clean');
  return { ok: diffs.length === 0, diffs };
}
