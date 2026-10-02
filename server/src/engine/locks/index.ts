/**
 * server/src/engine/locks: the S/X lease manager (VFS-09; offline-and-sync.md §3.14;
 * database.md §3.17, §4.11.16). Wired by the `locks` plugin through engine/sync/runtime.ts.
 */
export {
  defaultHeapFactory,
  ExpiryIndex,
  EXPIRY_INDEX_KIND,
  type HeapFactory,
} from './expiry-index.ts';
export {
  checkWriteLeases,
  type LeaseCheckInput,
  type LeaseState,
  type LeaseVerdict,
  type WriteTarget,
} from './fencing.ts';
export {
  LockManager,
  type LeaseInfo,
  type LockAcquireBody,
  type LockManagerOptions,
} from './manager.ts';
export { compatible, KyselyLockStore } from './store.ts';
export { Sweeper, type SweeperOptions } from './sweeper.ts';
export type {
  AcquireOutcome,
  AcquireRequest,
  HolderInfo,
  LeaseMode,
  LeaseRow,
  LockConnRef,
  LockFrame,
  LockNotifier,
  LockStore,
} from './types.ts';
