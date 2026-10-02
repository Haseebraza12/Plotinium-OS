/**
 * Migration 001: every store and index of virtual-file-system.md §3.13.1 / §4.2. Synchronous, run
 * inside the versionchange transaction.
 *
 * Plus `outbox.by_session_cseq` (unique `[osSessionId, cseq]`): offline-and-sync.md §4.8 keys the
 * outbox by that pair, the VFS spec by an autoIncrement `seq`; both orders are served until the two
 * specs converge.
 */
export const name = '001_init';

export function upgrade(db: IDBDatabase, _tx: IDBTransaction): void {
  const inodes = db.createObjectStore('inodes', { keyPath: 'ino' });
  inodes.createIndex('by_uid_mtime', ['uid', 'mtime']);
  inodes.createIndex('by_fs', 'fs');
  const dentries = db.createObjectStore('dentries', { keyPath: ['parent', 'name'] });
  dentries.createIndex('by_ino', 'ino');
  const blobs = db.createObjectStore('blobs', { keyPath: 'sha' });
  blobs.createIndex('by_zero', 'zeroSince');
  db.createObjectStore('blob_chunks', { keyPath: 'sha' });
  db.createObjectStore('users', { keyPath: 'uid' }).createIndex('by_name', 'username', {
    unique: true,
  });
  db.createObjectStore('groups', { keyPath: 'gid' }).createIndex('by_name', 'name', {
    unique: true,
  });
  const outbox = db.createObjectStore('outbox', { keyPath: 'seq', autoIncrement: true });
  outbox.createIndex('by_op', 'opId', { unique: true });
  outbox.createIndex('by_state', 'state');
  outbox.createIndex('by_session_cseq', ['osSessionId', 'cseq'], { unique: true });
  db.createObjectStore('undo', { keyPath: 'opId' }).createIndex('by_state', 'state');
  db.createObjectStore('meta', { keyPath: 'k' });
  db.createObjectStore('os_sessions', { keyPath: 'osSessionId' }).createIndex('by_uid', 'uid');
  db.createObjectStore('credentials', { keyPath: 'username' });
  db.createObjectStore('telemetry', { keyPath: ['uid', 'slot'] });
  db.createObjectStore('bootlog', { keyPath: 'bootId' });
}
