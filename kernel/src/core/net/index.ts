/**
 * kernel/src/core/net: connectivity (`net.state`, OFF-04), the sync and lock engine bridge, local
 * advisory locks, and the `net.status`, `sync.flush` and `lock.*` system calls. Wired by
 * `installIo` (core/io).
 */
export type {
  EngineFactory,
  EngineSession,
  LockEngine,
  LockEngineGrant,
  SyncEngine,
  SyncEngineHost,
} from './engines.ts';
export { LocalLocks } from './locks.ts';
export type { LocalLease, LocalLocksDeps } from './locks.ts';
export { LEASE_TTL_MS, NetMonitor } from './monitor.ts';
export type { Reachability } from './monitor.ts';
export { registerNetSyscalls } from './syscalls.ts';
export type { NetSyscallDeps } from './syscalls.ts';
