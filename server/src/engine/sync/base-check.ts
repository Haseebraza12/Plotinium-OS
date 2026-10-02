/**
 * Base versions and subtree digests for STRUCTURAL ops (Spec: MUST, §9.3, VFS-10;
 * offline-and-sync.md §3.3.1, §3.12.3; database.md §3.12 "Fingerprint and base checks").
 *
 * `unlink`, `rename`, `link`, `copy`, `chmod`, `chown`, `utimes` and `batch` never produce
 * conflicted copies: if the base does not match the rows locked at L3/L4 (someone changed the file,
 * or anything in the subtree, since the client planned the op), the op is REJECTED with EAGAIN
 * `stale-version` (`stale-plan` for a `batch`) and nothing changes. The rejection is persisted by
 * vfsTxn (deterministic, §3.10 step 6), so a resend returns the same outcome.
 *
 * The check runs after the locks, so the versions cannot change between check and write.
 * `withBaseCheck` adds it in front of any structural OpHandler's own `recheck`.
 */
import { sha256Hex, type Base } from '@plotinium/protocol';

import type { OpHandler } from '../../vfs/tx.ts';
import { VfsError, type Ino, type Locked, type OpContext } from '../../vfs/types.ts';

export interface Versioned {
  readonly ino: Ino;
  readonly version: number;
}

const ascii = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * SHA-256 over the lines `"<ino>:<version>\n"` sorted by ino (ASCII), each inode once: the same
 * formula as the isomorphic vfs/digest.ts `subtreeDigest` (virtual-file-system.md §5.6, PVFS-16).
 */
export function subtreeDigest(entries: Iterable<Versioned>): string {
  const seen = new Map<string, number>();
  for (const e of entries) seen.set(e.ino, e.version);
  const lines = [...seen.entries()]
    .sort((a, b) => ascii(a[0], b[0]))
    .map(([ino, ver]) => `${ino}:${ver}\n`);
  return sha256Hex(lines.join(''));
}

export type StructuralKind = 'structural' | 'batch';

/**
 * Throws EAGAIN `stale-version` (or `stale-plan` for a batch) when `base` does not match.
 * `current(ino)` is the locked version; `subtree(rootIno)` lists every inode of a locked subtree.
 */
export function checkBase(
  base: Base,
  current: (ino: Ino) => number | undefined,
  kind: StructuralKind,
  subtree?: (rootIno: Ino) => Iterable<Versioned>,
): void {
  const stale = (detail: Record<string, unknown>): VfsError =>
    new VfsError('EAGAIN', {
      reason: kind === 'batch' ? 'stale-plan' : 'stale-version',
      ...detail,
    });
  if (base.kind === 'versions') {
    for (const e of base.entries) {
      const now = current(e.ino);
      if (now !== e.version) throw stale({ ino: e.ino, expected: e.version, actual: now ?? null });
    }
    return;
  }
  if (subtree === undefined) throw new VfsError('EINVAL', { reason: 'digest-without-subtree' });
  const actual = subtreeDigest(subtree(base.rootIno));
  if (actual !== base.digest) throw stale({ ino: base.rootIno });
}

/** The `base` of an op context, as vfsTxn's OpContext carries it. */
export function baseOf(op: OpContext): Base | undefined {
  const b = op.base;
  if (b === undefined) return undefined;
  if (b.kind === 'versions') {
    const entries = Array.isArray(b.value) ? (b.value as Versioned[]) : [];
    return { kind: 'versions', entries: entries.map((e) => ({ ino: e.ino, version: e.version })) };
  }
  const d = b.value as { rootIno?: unknown; digest?: unknown } | null;
  return typeof d?.rootIno === 'string' && typeof d.digest === 'string'
    ? { kind: 'digest', rootIno: d.rootIno, digest: d.digest }
    : undefined;
}

/**
 * Wraps a structural handler: after the locks, the base must match or the op is rejected with
 * nothing changed. `subtreeOf` lists the locked subtree for digest bases (rm -r, cp -r, chmod -R).
 */
export function withBaseCheck<Tx, R>(
  handler: OpHandler<Tx, R>,
  kind: StructuralKind,
  subtreeOf?: (locked: Locked, rootIno: Ino) => Iterable<Versioned>,
): OpHandler<Tx, R> {
  return {
    plan: (tx, extra) => handler.plan(tx, extra),
    ...(handler.replan === undefined ? {} : { replan: handler.replan.bind(handler) }),
    async recheck(tx, op, locked) {
      const base = baseOf(op);
      if (base !== undefined) {
        checkBase(
          base,
          (ino) => locked.rows.get(ino)?.version,
          kind,
          subtreeOf === undefined ? undefined : (root) => subtreeOf(locked, root),
        );
      }
      await handler.recheck(tx, op, locked);
    },
    body: (tx, locked) => handler.body(tx, locked),
  };
}
