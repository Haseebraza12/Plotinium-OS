/**
 * `lockd`: S/X leases with TTL, heartbeat at TTL/3, fencing tokens and local advisory locks
 * (specs/06-sync/offline-and-sync.md §3.14, specs/04-vfs/virtual-file-system.md §3.16).
 */
export * from './types.ts';
export * from './table.ts';
export * from './advisory.ts';
export * from './lockd.ts';
