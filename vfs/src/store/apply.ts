/**
 * `apply(plan)`: phase 2 of a mutation as ONE readwrite transaction (virtual-file-system.md §3.11,
 * C4, DB-02 client rule 5). The builder issues, in order:
 *   1. the fencing epoch check (EIO `fencing`: another tab took the kernel lock, C2);
 *   2. the parent-version guards (EAGAIN: the plan is stale);
 *   3. quota: each affected owner's `users` row is read, checked and written (EDQUOT), and the
 *      tmpfs counters; then `meta.cseq` and `meta.lamport`, allocated in commit order;
 *   4. the row writes (each inode-row request is a fault point), blob refcounts and chunks;
 *   5. the undo record and the outbox op;
 *   6. registered hooks (audit mirror, `ai_*`).
 * Durability is strict for synced changes and relaxed for tmpfs-only ones.
 */
import type { Commit } from '../ops/commit.ts';
import { tmpfsExceeds } from '../quota/quota.ts';
import type { BlobRec, MetaRec, TmpfsUsage } from './records.ts';
import { SYNCED_SCOPE, TMPFS_SCOPE } from './schema.ts';
import type { AnyStoreName, ChangeSet, Store, TxHandle, TxResult, VfsTxnHook } from './store.ts';

export interface ApplyEnv {
  /** The kernel's fencing epoch (§3.13.3). */
  readonly epoch: number;
  /** Commit time: `zeroSince` of blobs whose refcount reaches 0 (GC grace, §3.13.4). */
  readonly now: number;
  readonly hooks?: readonly VfsTxnHook[];
  readonly change?: ChangeSet;
  /** The armed client fault for this op, if any (§3.20). */
  readonly fault?: { readonly after: number };
}

const numberMeta = (v: MetaRec | undefined): number => (typeof v?.v === 'number' ? v.v : 0);

function isTmpfsUsage(v: unknown): v is TmpfsUsage {
  return (
    typeof v === 'object' &&
    v !== null &&
    'bytes' in v &&
    'inodes' in v &&
    typeof v.bytes === 'number' &&
    typeof v.inodes === 'number'
  );
}

export function commitScope(c: Commit, hooks: readonly VfsTxnHook[] = []): AnyStoreName[] {
  const base: AnyStoreName[] = [...(c.plan.synced ? SYNCED_SCOPE : TMPFS_SCOPE)];
  for (const h of hooks) base.push(...h.stores());
  return [...new Set(base)];
}

/** The synchronous builder of a commit (no await, no promise continuations: C4, C14). */
export function commitBuilder(c: Commit, env: ApplyEnv): (t: TxHandle) => void {
  const { plan } = c;
  return (t) => {
    t.get<MetaRec>('meta', 'fencingEpoch', (v) =>
      numberMeta(v) === env.epoch ? null : { errno: 'EIO', detail: 'fencing' },
    );
    for (const g of plan.guards) {
      t.get<{ version: number }>('inodes', g.ino, (v) =>
        v?.version === g.version ? null : 'EAGAIN',
      );
    }
    if (plan.synced) for (const q of plan.quota) t.adjustUsers(q.uid, q.dBytes, q.dInodes);
    if (plan.tmpfs.bytes !== 0 || plan.tmpfs.inodes !== 0) {
      t.get<MetaRec>('meta', 'tmpfsUsage', undefined, (v) => {
        const cur = isTmpfsUsage(v?.v) ? v.v : { bytes: 0, inodes: 0 };
        if (tmpfsExceeds(cur, plan.tmpfs)) {
          t.abort('EDQUOT', 'tmpfs-full');
          return;
        }
        t.put('meta', {
          k: 'tmpfsUsage',
          v: { bytes: cur.bytes + plan.tmpfs.bytes, inodes: cur.inodes + plan.tmpfs.inodes },
        });
      });
    }
    for (const w of plan.writes) {
      if (w.op === 'del')
        t.del(w.store, w.store === 'inodes' ? w.key : [w.value.parent, w.value.name]);
      else if (w.op === 'add') t.add(w.store, w.value);
      else t.put(w.store, w.value);
    }
    for (const u of plan.blobs) {
      t.get<BlobRec>('blobs', u.sha, undefined, (cur) => {
        const rec = cur ?? u.record;
        if (rec === undefined) {
          t.abort('EIO', 'storage'); // a reference to content this device has no record of
          return;
        }
        const refcount = rec.refcount + u.delta;
        const { zeroSince: _old, ...rest } = rec;
        t.put(
          'blobs',
          refcount === 0 ? { ...rest, refcount, zeroSince: env.now } : { ...rest, refcount },
        );
      });
    }
    for (const chunk of plan.chunks) t.put('blob_chunks', chunk);
    if (c.undo !== null) t.put('undo', c.undo);
    const outbox = c.outbox;
    if (outbox !== null) {
      t.get<MetaRec>('meta', 'cseq', undefined, (cs) => {
        const cseq = numberMeta(cs) + 1;
        t.put('meta', { k: 'cseq', v: cseq });
        t.get<MetaRec>('meta', 'lamport', undefined, (lp) => {
          const lamport = numberMeta(lp) + 1;
          t.put('meta', { k: 'lamport', v: lamport });
          t.add('outbox', { ...outbox, cseq, lamport });
        });
      });
    }
    if (env.change !== undefined) for (const h of env.hooks ?? []) h.build(t, env.change);
  };
}

/** Commit a prepared plan; resolves after `oncomplete` (only then may memory and events change). */
export function applyCommit(store: Store, c: Commit, env: ApplyEnv): Promise<TxResult> {
  const scope = commitScope(c, env.change === undefined ? [] : (env.hooks ?? []));
  return store.tx(scope, c.plan.synced ? 'strict' : 'relaxed', commitBuilder(c, env), {
    label: c.plan.label,
    ...(env.fault === undefined ? {} : { fault: env.fault }),
  });
}
