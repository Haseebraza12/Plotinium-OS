/**
 * Writes under leases (offline-and-sync.md §3.14.4; database.md §3.10, §3.13; VFS-09).
 *
 * Evaluated inside vfsTxn after L4, against the lease rows of every inode the op modifies:
 *
 * | situation                                                          | verdict                  |
 * |--------------------------------------------------------------------|--------------------------|
 * | the op carries a fence below inodes.lock_fence (a zombie writer)   | EBUSY stale-fence        |
 * | the op carries a fence whose own lease is gone or expired          | EBUSY stale-fence        |
 * | a live lease (S or X) held by ANOTHER OS session                   | EBUSY lease / subtree-busy |
 * | this session holds X, carries its fence, lease live, fence >= lock_fence | allowed            |
 * | this session holds only S and nobody else holds a lease            | allowed                  |
 * | no live lease rows                                                  | allowed (the version CAS still applies) |
 *
 * A content op turns EBUSY into `conflict` with the bytes kept as a conflicted copy; a structural
 * op is `rejected` (persisted, §3.10). That split is the caller's; this module only decides.
 * Fences follow Kleppmann's fencing tokens (https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html).
 */
import type { LeaseMode } from './types.ts';

/** One `locks` row of a target inode, read inside the transaction. */
export interface LeaseState {
  readonly ino: string;
  readonly osSessionId: string;
  readonly mode: LeaseMode;
  readonly fence: number;
  /** lease_expires_at > clock_timestamp(), evaluated by the database. */
  readonly live: boolean;
}

export interface WriteTarget {
  readonly ino: string;
  /** inodes.lock_fence of the locked row (0 = never X-locked). */
  readonly lockFence: number;
}

export type LeaseVerdict =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly errno: 'EBUSY';
      readonly reason: 'lease' | 'stale-fence' | 'subtree-busy';
      readonly ino: string;
    };

export interface LeaseCheckInput {
  /** The OS session the op was committed under. */
  readonly osSessionId: string;
  /** `OpSubmit.fences`: the fences of the X leases the op writes under. */
  readonly fences: readonly { readonly ino: string; readonly fence: number }[];
  readonly targets: readonly WriteTarget[];
  /** Lease rows of the targets (any order; rows of other inodes are ignored). */
  readonly leases: readonly LeaseState[];
  /** A bulk op over a subtree (rm -r, chmod -R, ...): a foreign lease is `subtree-busy`. */
  readonly bulk: boolean;
}

/** Decides whether the op may modify every target (the first failing target decides). */
export function checkWriteLeases(input: LeaseCheckInput): LeaseVerdict {
  const byIno = new Map<string, LeaseState[]>();
  for (const l of input.leases) {
    const list = byIno.get(l.ino);
    if (list === undefined) byIno.set(l.ino, [l]);
    else list.push(l);
  }
  const fenceOf = new Map<string, number>();
  for (const f of input.fences) fenceOf.set(f.ino, f.fence);

  for (const target of input.targets) {
    const rows = byIno.get(target.ino) ?? [];
    const fence = fenceOf.get(target.ino);
    if (fence !== undefined) {
      // A zombie writer: its lease was lost and the inode was X-locked again since.
      if (fence < target.lockFence) return stale(target.ino);
      const own = rows.find((r) => r.osSessionId === input.osSessionId && r.fence === fence);
      if (own === undefined || !own.live) return stale(target.ino);
    }
    const foreign = rows.some((r) => r.live && r.osSessionId !== input.osSessionId);
    if (foreign) {
      return {
        ok: false,
        errno: 'EBUSY',
        reason: input.bulk ? 'subtree-busy' : 'lease',
        ino: target.ino,
      };
    }
  }
  return { ok: true };
}

function stale(ino: string): LeaseVerdict {
  return { ok: false, errno: 'EBUSY', reason: 'stale-fence', ino };
}
