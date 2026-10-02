/**
 * Quota accounting (virtual-file-system.md §3.8, VFS-06; database.md MUST match, X-DB-2).
 *
 * Charged: one inode per inode of the synced `root` file system and the `size` of regular files
 * and symlinks (directories 0 bytes), once per inode to its `uid`, whatever its link count. `tmp`
 * inodes count against the device-wide tmpfs limits instead; synthesised files are never charged.
 * Root is exempt (its usage is maintained, not checked) and decreases never fail.
 */
import { SYNTH_FILES } from '@plotinium/protocol';
import type { Quota } from '@plotinium/protocol';

import { TMPFS_MAX_BYTES, TMPFS_MAX_INODES } from '../limits.ts';
import type { InodeRec, TmpfsUsage, UndoRec, UserRec } from '../store/records.ts';

export interface QuotaDelta {
  readonly uid: number;
  readonly dBytes: number;
  readonly dInodes: number;
}

export interface Charge {
  readonly bytes: number;
  readonly inodes: number;
}

const NONE: Charge = { bytes: 0, inodes: 0 };
const SYNTH_INOS: ReadonlySet<string> = new Set(SYNTH_FILES.map((f) => f.ino));

export function isSynthIno(ino: string): boolean {
  return SYNTH_INOS.has(ino);
}

type Chargeable = Pick<InodeRec, 'ino' | 'fs' | 'type' | 'size'>;

const bytesOf = (n: Chargeable): number => (n.type === 'd' ? 0 : n.size);

/** What `n` costs its owner's quota. */
export function userCharge(n: Chargeable): Charge {
  if (n.fs !== 'root' || isSynthIno(n.ino)) return NONE;
  return { bytes: bytesOf(n), inodes: 1 };
}

/** What `n` costs the device-local tmpfs (§3.3.4). */
export function tmpfsCharge(n: Chargeable): Charge {
  return n.fs === 'tmp' ? { bytes: bytesOf(n), inodes: 1 } : NONE;
}

/** Per-uid deltas of one op, merged; zero rows are dropped. */
export class DeltaSet {
  private readonly m = new Map<number, { dBytes: number; dInodes: number }>();

  add(uid: number, dBytes: number, dInodes: number): void {
    const cur = this.m.get(uid) ?? { dBytes: 0, dInodes: 0 };
    this.m.set(uid, { dBytes: cur.dBytes + dBytes, dInodes: cur.dInodes + dInodes });
  }

  /** Charge (sign +1) or release (sign −1) an inode. */
  charge(n: Pick<InodeRec, 'ino' | 'fs' | 'type' | 'size' | 'uid'>, sign: 1 | -1): void {
    const c = userCharge(n);
    if (c.inodes !== 0) this.add(n.uid, sign * c.bytes, sign * c.inodes);
  }

  get(uid: number): QuotaDelta {
    const d = this.m.get(uid);
    return { uid, dBytes: d?.dBytes ?? 0, dInodes: d?.dInodes ?? 0 };
  }

  list(): QuotaDelta[] {
    return [...this.m.entries()]
      .filter(([, d]) => d.dBytes !== 0 || d.dInodes !== 0)
      .sort((a, b) => a[0] - b[0])
      .map(([uid, d]) => ({ uid, dBytes: d.dBytes, dInodes: d.dInodes }));
  }
}

/** Whether applying `d` to `user` breaks a limit: only growth is checked, and never for root. */
export function exceeds(user: UserRec, d: QuotaDelta): boolean {
  if (user.uid === 0) return false;
  return (
    (d.dBytes > 0 && user.usedBytes + d.dBytes > user.quotaBytes) ||
    (d.dInodes > 0 && user.usedInodes + d.dInodes > user.quotaInodes)
  );
}

export function applyDelta(user: UserRec, d: QuotaDelta): UserRec {
  return { ...user, usedBytes: user.usedBytes + d.dBytes, usedInodes: user.usedInodes + d.dInodes };
}

/**
 * Phase-1 fast fail (§3.8 step 1). A uid missing from the mirror is not checked here: the
 * transaction and the server remain authoritative.
 */
export function fastFail(
  user: (uid: number) => UserRec | undefined,
  deltas: readonly QuotaDelta[],
): boolean {
  return deltas.some((d) => {
    const u = user(d.uid);
    return u !== undefined && exceeds(u, d);
  });
}

/** tmpfs limits bind every uid, root included; only growth is checked (§3.3.4). */
export function tmpfsExceeds(usage: TmpfsUsage, d: TmpfsUsage): boolean {
  return (
    (d.bytes > 0 && usage.bytes + d.bytes > TMPFS_MAX_BYTES) ||
    (d.inodes > 0 && usage.inodes + d.inodes > TMPFS_MAX_INODES)
  );
}

/**
 * I6 on the client: used = server-confirmed + the deltas of this uid's unacknowledged undo records
 * (§3.8 "The users mirror", §3.14.3 ack recomputation).
 */
export function recomputeUsed(user: UserRec, openUndo: readonly UndoRec[]): UserRec {
  let bytes = user.serverUsedBytes;
  let inodes = user.serverUsedInodes;
  for (const u of openUndo) {
    if (u.state !== 'open') continue;
    for (const d of u.users) {
      if (d.uid !== user.uid) continue;
      bytes += d.dBytes;
      inodes += d.dInodes;
    }
  }
  return { ...user, usedBytes: bytes, usedInodes: inodes };
}

/** The `quota` syscall result (syscall-abi.md §4.4.2): root's limits are null (exempt). */
export function quotaReport(user: UserRec, online: boolean): Quota {
  const exempt = user.uid === 0;
  return {
    uid: user.uid,
    usedBytes: Math.max(0, user.usedBytes),
    quotaBytes: exempt ? null : user.quotaBytes,
    usedInodes: Math.max(0, user.usedInodes),
    quotaInodes: exempt ? null : user.quotaInodes,
    source: online && user.serverAt !== undefined ? 'server' : 'mirror',
  };
}
