/**
 * TEST-ONLY in-memory LockStore with the semantics of the `locks` table: one row per
 * (ino, os_session_id), S and X never coexist (locks_sx_excl), at most one X (locks_one_writer),
 * fences from a sequence that never repeats, deadlines on the "database clock" (the test's
 * ManualClock, which stands in for clock_timestamp()), and an inode lock_fence stamp on X grants.
 * Permission is the file's own mode bits through vfs/perm (ancestors are the SQL store's job).
 */
import { may, R, W } from '@plotinium/vfs/perm';

import type { Clock } from '../../sync/clock.ts';
import { compatible } from '../store.ts';
import type { AcquireOutcome, AcquireRequest, LeaseRow, LockStore } from '../types.ts';

export interface MemInode {
  type: 'f' | 'd' | 'l';
  mode: number;
  uid: number;
  gid: number;
  lockFence: number;
}

export interface MemSession {
  authSessionId: string | null;
  deviceId: string | null;
  ownerUid: number;
  kernelEpoch: number;
}

let leaseCounter = 0;
/** Distinct UUIDv7-shaped lease ids (the schema only checks the shape). */
export function testLeaseId(): string {
  leaseCounter++;
  return `01900000-0000-7000-8000-${leaseCounter.toString(16).padStart(12, '0')}`;
}

export class MemoryLockStore implements LockStore {
  readonly rows = new Map<string, LeaseRow>();
  readonly inodes = new Map<string, MemInode>();
  readonly users = new Map<number, string>();
  readonly sessions = new Map<string, MemSession>();
  readonly calls: string[] = [];
  /** Throws once from the named method (then clears). */
  failNext: string | null = null;
  fenceSeq = 40;
  readonly #clock: Clock;

  constructor(clock: Clock) {
    this.#clock = clock;
  }

  #maybeFail(method: string): void {
    this.calls.push(method);
    if (this.failNext === method) {
      this.failNext = null;
      throw Object.assign(new Error('connection terminated'), { code: '08006' });
    }
  }

  #rowsOf(ino: string): LeaseRow[] {
    return [...this.rows.values()].filter((r) => r.ino === ino);
  }

  #delete(pred: (r: LeaseRow) => boolean): LeaseRow[] {
    const out: LeaseRow[] = [];
    for (const [id, r] of this.rows) {
      if (pred(r)) {
        this.rows.delete(id);
        out.push(r);
      }
    }
    return out;
  }

  acquire(req: AcquireRequest): Promise<AcquireOutcome> {
    this.#maybeFail('acquire');
    const now = this.#clock.now();
    const expired = this.#delete((r) => r.ino === req.ino && r.expiresAt <= now);
    const inode = this.inodes.get(req.ino);
    if (inode === undefined) return Promise.resolve({ kind: 'denied', errno: 'ENOENT', expired });
    if (inode.type === 'd') return Promise.resolve({ kind: 'denied', errno: 'EISDIR', expired });
    const cred = { uid: req.holderUid, gid: req.holderUid, groups: [req.holderUid] };
    if (!may(cred, inode, req.mode === 'S' ? R : W)) {
      return Promise.resolve({ kind: 'denied', errno: 'EACCES', expired });
    }
    const rows = this.#rowsOf(req.ino);
    const own = rows.find((r) => r.osSessionId === req.osSessionId) ?? null;
    const others = rows.filter((r) => r.osSessionId !== req.osSessionId);
    if (!compatible(req.mode, others)) {
      const h = [...others].sort((a, b) => (a.mode === 'X' ? -1 : b.mode === 'X' ? 1 : 0))[0];
      const username = h === undefined ? undefined : this.users.get(h.holderUid);
      return Promise.resolve({
        kind: 'busy',
        holder:
          h === undefined || username === undefined
            ? null
            : { username, mode: h.mode, expiresAt: h.expiresAt },
        expired,
      });
    }
    if (own !== null) this.rows.delete(own.leaseId);
    const lease: LeaseRow = {
      leaseId: testLeaseId(),
      ino: req.ino,
      osSessionId: req.osSessionId,
      holderUid: req.holderUid,
      mode: req.mode,
      fence: ++this.fenceSeq,
      expiresAt: now + req.ttlMs,
    };
    this.rows.set(lease.leaseId, lease);
    if (lease.mode === 'X') inode.lockFence = lease.fence;
    return Promise.resolve({ kind: 'granted', lease, replaced: own, expired });
  }

  release(leaseId: string, osSessionId: string): Promise<LeaseRow | null> {
    this.#maybeFail('release');
    const r = this.rows.get(leaseId);
    if (r === undefined || r.osSessionId !== osSessionId) return Promise.resolve(null);
    this.rows.delete(leaseId);
    return Promise.resolve(r);
  }

  releaseSessions(osSessionIds: readonly string[]): Promise<readonly LeaseRow[]> {
    this.#maybeFail('releaseSessions');
    const set = new Set(osSessionIds);
    return Promise.resolve(this.#delete((r) => set.has(r.osSessionId)));
  }

  releaseAuthSessions(authSessionIds: readonly string[]): Promise<readonly LeaseRow[]> {
    this.#maybeFail('releaseAuthSessions');
    const set = new Set(authSessionIds);
    return Promise.resolve(
      this.#delete((r) => {
        const auth = this.sessions.get(r.osSessionId)?.authSessionId;
        return auth !== undefined && auth !== null && set.has(auth);
      }),
    );
  }

  releaseDevicePredecessors(q: {
    readonly deviceId: string;
    readonly uid: number;
    readonly osSessionId: string;
    readonly kernelEpoch: number;
  }): Promise<readonly LeaseRow[]> {
    this.#maybeFail('releaseDevicePredecessors');
    return Promise.resolve(
      this.#delete((r) => {
        const s = this.sessions.get(r.osSessionId);
        return (
          s !== undefined &&
          s.deviceId === q.deviceId &&
          s.ownerUid === q.uid &&
          r.osSessionId !== q.osSessionId &&
          s.kernelEpoch < q.kernelEpoch
        );
      }),
    );
  }

  renew(
    osSessionId: string,
    leaseIds: readonly string[] | 'all',
    ttlMs: number,
  ): Promise<readonly LeaseRow[]> {
    this.#maybeFail('renew');
    const now = this.#clock.now();
    const out: LeaseRow[] = [];
    for (const r of this.rows.values()) {
      if (r.osSessionId !== osSessionId || r.expiresAt <= now) continue;
      if (leaseIds !== 'all' && !leaseIds.includes(r.leaseId)) continue;
      const renewed = { ...r, expiresAt: now + ttlMs };
      this.rows.set(r.leaseId, renewed);
      out.push(renewed);
    }
    return Promise.resolve(out);
  }

  verifyHeld(
    osSessionId: string,
    refs: readonly { readonly leaseId: string; readonly ino: string; readonly fence: number }[],
    ttlMs: number,
  ): Promise<readonly LeaseRow[]> {
    this.#maybeFail('verifyHeld');
    const now = this.#clock.now();
    const out: LeaseRow[] = [];
    for (const ref of refs) {
      const r = this.rows.get(ref.leaseId);
      if (
        r === undefined ||
        r.osSessionId !== osSessionId ||
        r.ino !== ref.ino ||
        r.fence !== ref.fence
      )
        continue;
      if (r.expiresAt <= now) continue;
      const renewed = { ...r, expiresAt: now + ttlMs };
      this.rows.set(r.leaseId, renewed);
      out.push(renewed);
    }
    return Promise.resolve(out);
  }

  expire(leaseIds: readonly string[]): Promise<readonly LeaseRow[]> {
    this.#maybeFail('expire');
    const now = this.#clock.now();
    const set = new Set(leaseIds);
    return Promise.resolve(this.#delete((r) => set.has(r.leaseId) && r.expiresAt <= now));
  }

  get(leaseIds: readonly string[]): Promise<readonly LeaseRow[]> {
    this.#maybeFail('get');
    return Promise.resolve(
      leaseIds.flatMap((id) => {
        const r = this.rows.get(id);
        return r === undefined ? [] : [r];
      }),
    );
  }

  loadAll(): Promise<readonly LeaseRow[]> {
    this.#maybeFail('loadAll');
    return Promise.resolve([...this.rows.values()]);
  }

  usernameOf(uid: number): Promise<string | null> {
    return Promise.resolve(this.users.get(uid) ?? null);
  }
}
