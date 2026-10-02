/**
 * Wiring of the sync engine, the lease manager, the broadcaster and the connection hub for one
 * server process (backend-api.md §3.2: the `locks` and `sync` plugins; C9). The Fastify plugins
 * call `createSyncRuntime` once, `await runtime.start()` before listening (rebuilds the lease
 * expiry index from the `locks` table), hand each upgraded socket to `runtime.hub.accept`, and call
 * `runtime.hub.shutdown` from the graceful-shutdown handler.
 */
import type { Kysely, Transaction } from 'kysely';

import type { BuildIdentity, OpSubmit } from '@plotinium/protocol';
import { may, R, X, type Cred } from '@plotinium/vfs/perm';

import type { DB } from '../../db/types.gen.ts';
import type { CancelRegistry } from '../../vfs/cancel.ts';
import { kyselySteps } from '../../vfs/steps.ts';
import type { OpHandler } from '../../vfs/tx.ts';
import type { ArmedFault } from '../../vfs/types.ts';
import type { HeapFactory } from '../locks/expiry-index.ts';
import { LockManager } from '../locks/manager.ts';
import { KyselyLockStore } from '../locks/store.ts';
import type { LockFrame, LockNotifier } from '../locks/types.ts';
import { systemClock, type Clock } from './clock.ts';
import { ContentWriteHandler } from './content-write.ts';
import { SyncEngine } from './engine.ts';
import { Broadcaster } from './feed.ts';
import { KyselyFeedReader, KyselyOsSessionStore } from './feed-reader.ts';
import { kyselyFeedSql } from './feed-steps.ts';
import { SyncHub } from './hub.ts';
import { kyselyContentSql } from './kysely-content.ts';
import type { StoredResult } from './outcome.ts';

type Tx = Transaction<DB>;

export interface SyncRuntimeOptions {
  readonly db: Kysely<DB>;
  readonly cancel: CancelRegistry;
  readonly build: BuildIdentity;
  /** config.leaseTtlMs (LEASE_TTL_MS: 30 s default, 15 s demo). */
  readonly leaseTtlMs: number;
  readonly lockTimeoutMs: number;
  readonly statementTimeoutMs: number;
  /** config.timeZone (PLOTINIUM_TZ) for conflicted-copy dates. */
  readonly timeZone: string;
  /** hb re-validation of the cookie session: SessionService lookup by id (true = still valid). */
  readonly validateAuth: (authSessionId: string) => Promise<boolean>;
  /** pg_cancel_backend(pid) on a separate pool connection (AGT-09). */
  readonly cancelBackendPid?: (pid: number) => void;
  /**
   * Handlers for the op kinds this module does not implement (create, unlink, rename, link, copy,
   * chmod, chown, batch: server/src/vfs/ops). Structural handlers should be wrapped in
   * `withBaseCheck` so a stale base is rejected EAGAIN stale-version with nothing changed.
   */
  readonly handlers?: (submit: OpSubmit) => OpHandler<Tx, StoredResult> | undefined;
  /** Only under FAULT_INJECTION=1: the armed fault for an op (admin/fault routes). */
  readonly faultFor?: (submit: OpSubmit) => ArmedFault | undefined;
  readonly clock?: Clock;
  readonly createHeap?: HeapFactory;
  readonly onError?: (err: unknown, context: string) => void;
}

export interface SyncRuntime {
  readonly hub: SyncHub;
  readonly locks: LockManager;
  readonly engine: SyncEngine<Tx>;
  readonly broadcaster: Broadcaster;
  /** Rebuilds the lease expiry index from the table (call before listening). */
  start(): Promise<void>;
}

export function createSyncRuntime(o: SyncRuntimeOptions): SyncRuntime {
  const clock = o.clock ?? systemClock;
  const onError = o.onError ?? (() => undefined);
  let hub: SyncHub | null = null;

  const notifier: LockNotifier = {
    toConn: (connId: string, frame: LockFrame) => hub?.lockNotifier.toConn(connId, frame),
    toSession: (osSessionId: string, frame: LockFrame) =>
      hub?.lockNotifier.toSession(osSessionId, frame),
  };
  const locks = new LockManager({
    store: new KyselyLockStore(o.db),
    notifier,
    clock,
    ttlMs: o.leaseTtlMs,
    ...(o.createHeap === undefined ? {} : { createHeap: o.createHeap }),
    onError,
  });

  const reader = new KyselyFeedReader(o.db);
  const sessions = new KyselyOsSessionStore(o.db);
  const broadcaster = new Broadcaster({
    clock,
    reader,
    dirs: reader,
    ...(o.createHeap === undefined ? {} : { createHeap: o.createHeap }),
    onError,
  });

  const engine = new SyncEngine<Tx>({
    steps: kyselySteps(o.db),
    cancel: o.cancel,
    lockTimeoutMs: o.lockTimeoutMs,
    statementTimeoutMs: o.statementTimeoutMs,
    feed: kyselyFeedSql,
    handlerFor: (submit) =>
      submit.op.kind === 'write'
        ? new ContentWriteHandler(kyselyContentSql, submit, { timeZone: o.timeZone })
        : o.handlers?.(submit),
    sessions: {
      ownsOsSession: (osSessionId, uid, deviceId) =>
        hub === null ? Promise.resolve(false) : hub.ownsOsSession(osSessionId, uid, deviceId),
    },
    onCommitted: (c) => hub?.committed(c),
    ...(o.faultFor === undefined ? {} : { faultFor: o.faultFor }),
    onError,
  });

  hub = new SyncHub({
    engine,
    locks,
    broadcaster,
    reader,
    dirs: reader,
    sessions,
    clock,
    config: { build: o.build, leaseTtlMs: o.leaseTtlMs },
    validateAuth: o.validateAuth,
    canWatch: async (cred: Cred, dirIno: string) => {
      const ctx = await reader.load([dirIno]);
      const dir = ctx.get(dirIno);
      if (dir === undefined || dir.row.type !== 'd' || !may(cred, dir.row, R | X)) return false;
      for (let p = dir.parent, depth = 0; p !== null && depth < 4096; depth++) {
        const up = ctx.get(p);
        if (up === undefined || !may(cred, up.row, X)) return false;
        p = up.parent;
      }
      return true;
    },
    cancelBackend: (opId) => {
      const pid = o.cancel.markCancelled(opId);
      if (pid !== undefined) o.cancelBackendPid?.(pid);
    },
    onError,
  });

  return {
    hub,
    locks,
    engine,
    broadcaster,
    start: () => locks.start(),
  };
}
