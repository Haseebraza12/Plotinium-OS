/**
 * Helpers for the synchronous transaction builders of syncd (C4; lint `no-await-in-idb-builder`).
 *
 * IndexedDB runs requests in the order they are queued, and a request callback queues after every
 * request already queued. Two consequences shape these helpers:
 * - read-then-write on the same row twice in one transaction loses an update unless the reads are
 *   aggregated first (`BlobDeltas`, `UserDeltas` apply one get→put per key at the end);
 * - a step whose reads must see an earlier step's writes starts only after that step queued them
 *   (`runSteps`).
 */
import { recomputeUsed } from '../quota/quota.ts';
import type { StoreWrite } from '../ops/plan.ts';
import type { BlobRec, DentryRec, InodeRec, UndoRec, UserRec } from '../store/records.ts';
import type { AnyStoreName, TxHandle } from '../store/store.ts';

/** One step of a transaction; calls `next` exactly once, after queuing its writes. */
export type Step = (next: () => void) => void;

/** Run `steps` in order inside one transaction, then `end`. */
export function runSteps(steps: readonly Step[], end: () => void = () => undefined): void {
  const go = (i: number): void => {
    const step = steps[i];
    if (step === undefined) {
      end();
      return;
    }
    step(() => go(i + 1));
  };
  go(0);
}

/** Queue one `get` per key; `then` receives the values in key order once all have completed. */
export function readAll<T>(
  t: TxHandle,
  store: AnyStoreName,
  keys: readonly IDBValidKey[],
  then: (values: (T | undefined)[]) => void,
): void {
  if (keys.length === 0) {
    then([]);
    return;
  }
  const out = new Array<T | undefined>(keys.length);
  let left = keys.length;
  keys.forEach((k, i) => {
    t.get<T>(store, k, undefined, (v) => {
      out[i] = v;
      left--;
      if (left === 0) then(out);
    });
  });
}

/** Records every write of a sync transaction, for `VfsTree.apply` after commit. */
export class WriteLog {
  readonly writes: StoreWrite[] = [];
  private readonly t: TxHandle;

  constructor(t: TxHandle) {
    this.t = t;
  }

  putInode(rec: InodeRec, isNew = false): void {
    this.t.put('inodes', rec);
    this.writes.push({ store: 'inodes', op: isNew ? 'add' : 'put', value: rec });
  }

  delInode(ino: string): void {
    this.t.del('inodes', ino);
    this.writes.push({ store: 'inodes', op: 'del', key: ino });
  }

  putDentry(d: DentryRec): void {
    this.t.put('dentries', d);
    this.writes.push({ store: 'dentries', op: 'add', value: d });
  }

  delDentry(d: DentryRec): void {
    this.t.del('dentries', [d.parent, d.name]);
    this.writes.push({ store: 'dentries', op: 'del', value: d });
  }
}

/** Blob reference changes, applied once per sha at the end of the transaction. */
export class BlobDeltas {
  private readonly deltas = new Map<string, { delta: number; size: number }>();
  private readonly uploaded = new Map<string, boolean>();

  add(sha: string | null | undefined, delta: number, size = 0): void {
    if (sha === null || sha === undefined || delta === 0) return;
    const cur = this.deltas.get(sha);
    this.deltas.set(sha, {
      delta: (cur?.delta ?? 0) + delta,
      size: Math.max(cur?.size ?? 0, size),
    });
  }

  markUploaded(sha: string, uploaded: boolean): void {
    this.uploaded.set(sha, uploaded);
  }

  flush(t: TxHandle, now: number): void {
    const shas = new Set([...this.deltas.keys(), ...this.uploaded.keys()]);
    for (const sha of shas) {
      const d = this.deltas.get(sha);
      const delta = d?.delta ?? 0;
      const up = this.uploaded.get(sha);
      if (delta === 0 && up === undefined) continue;
      t.get<BlobRec>('blobs', sha, undefined, (cur) => {
        if (cur === undefined) {
          // Content known only by its hash (remote apply): fetched on first read (VFS §3.13.4).
          if (delta > 0)
            t.put('blobs', {
              sha,
              size: d?.size ?? 0,
              chunks: null,
              refcount: delta,
              uploaded: true,
            } satisfies BlobRec);
          return;
        }
        const refcount = Math.max(0, cur.refcount + delta);
        const { zeroSince: _old, ...rest } = cur;
        const next: BlobRec =
          refcount === 0
            ? { ...rest, refcount, zeroSince: cur.zeroSince ?? now }
            : { ...rest, refcount };
        if (up !== undefined) next.uploaded = up;
        t.put('blobs', next);
      });
    }
  }
}

export interface QuotaRow {
  readonly uid: number;
  readonly usedBytes: number;
  readonly usedInodes: number;
  readonly quotaBytes: number;
  readonly quotaInodes: number;
}

/**
 * Changes to the `users` mirror: plain deltas (a revert gives back what the op charged; never
 * checked against the quota, a revert must not fail), and the server's authoritative row from an
 * `op.result.quota`, after which `used = server + the deltas of the remaining open undo records`
 * (VFS §3.14.3, I6).
 */
export class UserDeltas {
  private readonly deltas = new Map<number, { dBytes: number; dInodes: number }>();
  private server: QuotaRow | null = null;

  add(uid: number, dBytes: number, dInodes: number): void {
    const cur = this.deltas.get(uid);
    this.deltas.set(uid, {
      dBytes: (cur?.dBytes ?? 0) + dBytes,
      dInodes: (cur?.dInodes ?? 0) + dInodes,
    });
  }

  setServer(q: QuotaRow | undefined): void {
    if (q !== undefined) this.server = q;
  }

  /** `finalized`: undo records this transaction closes (excluded from the recomputation). */
  flush(t: TxHandle, now: number, finalized: ReadonlySet<string>): void {
    const server = this.server;
    const uids = new Set(this.deltas.keys());
    if (server !== null) uids.add(server.uid);
    if (uids.size === 0) return;
    const withServer = (then: (open: UndoRec[]) => void): void => {
      if (server === null) then([]);
      else
        t.getAllByIndex<UndoRec>('undo', 'by_state', 'open', (all) =>
          then(all.filter((u) => !finalized.has(u.opId))),
        );
    };
    withServer((open) => {
      for (const uid of uids) {
        t.get<UserRec>('users', uid, undefined, (u) => {
          if (u === undefined) return; // not mirrored: the server stays authoritative
          if (server !== null && server.uid === uid) {
            const confirmed: UserRec = {
              ...u,
              quotaBytes: server.quotaBytes,
              quotaInodes: server.quotaInodes,
              serverUsedBytes: server.usedBytes,
              serverUsedInodes: server.usedInodes,
              serverAt: now,
            };
            t.put('users', recomputeUsed(confirmed, open));
            return;
          }
          const d = this.deltas.get(uid);
          if (d === undefined) return;
          t.put('users', {
            ...u,
            usedBytes: u.usedBytes + d.dBytes,
            usedInodes: u.usedInodes + d.dInodes,
          });
        });
      }
    });
  }
}
