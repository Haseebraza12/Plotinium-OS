/**
 * Schema and migration chain of the device database (virtual-file-system.md §3.13.1, §3.13.3). The
 * database version is the number of client migrations; migration i upgrades version i to i + 1.
 */
import * as m001 from './migrations/001_init.ts';
import type { StoreName } from './store.ts';

export interface Migration {
  readonly name: string;
  upgrade(db: IDBDatabase, tx: IDBTransaction): void;
}

export const DB_NAME = 'plotinium';

export const MIGRATIONS: readonly Migration[] = [m001];

export const SCHEMA_VERSION = MIGRATIONS.length;

/** Every store of migration 001, for tests and the recovery export. */
export const STORES: readonly StoreName[] = [
  'inodes',
  'dentries',
  'blobs',
  'blob_chunks',
  'users',
  'groups',
  'outbox',
  'undo',
  'meta',
  'os_sessions',
  'credentials',
  'telemetry',
  'bootlog',
];

/** The scope of a synced mutation (§3.11 phase 2): rows, content, quota, undo, outbox, meta. */
export const SYNCED_SCOPE: readonly StoreName[] = [
  'inodes',
  'dentries',
  'blobs',
  'blob_chunks',
  'users',
  'undo',
  'outbox',
  'meta',
];

/** The scope of a tmpfs-only mutation: no quota rows, no undo, no outbox (§3.3.4). */
export const TMPFS_SCOPE: readonly StoreName[] = [
  'inodes',
  'dentries',
  'blobs',
  'blob_chunks',
  'meta',
];
