/**
 * locks/: the lease manager (acquire, renew, release, the expiry index and its sweeper) for S/X
 * leases with fencing tokens (VFS-09; offline-and-sync.md §3.14; database.md §3.17). Primary
 * owner R2.
 *
 * It has no REST routes: lock.* frames travel on the /ws control lane. The manager itself
 * (engine/locks/manager.ts) is created inside createSyncRuntime (engine/sync/runtime.ts), which
 * buildApp calls once; `await sync.start()` rebuilds the expiry index from the `locks` table
 * BEFORE the server listens (backend-api.md §3.18.2 step 3), and the sweeper then keeps one timer
 * at the earliest deadline. Graceful shutdown stops the sweeper but leaves the leases in the table.
 * The plugin stays registered so the plugin order of backend-api.md §3.2 is visible in app.ts.
 */
import type { FastifyInstance } from 'fastify';

export function locksPlugin(_app: FastifyInstance): Promise<void> {
  return Promise.resolve();
}
