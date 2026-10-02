/**
 * The store interface (virtual-file-system.md §4.6, §3.13). One IndexedDB database `plotinium` per
 * device (C4, PVFS-01). Every user-visible mutation is ONE readwrite transaction built by a
 * SYNCHRONOUS builder (lint rule `no-await-in-idb-builder`); follow-up requests are chained from
 * request callbacks, never from promises. Read-only scans are chunked to 500 keys per transaction
 * and yield between chunks (PVFS-14).
 */
import type { Errno } from '@plotinium/protocol';

import type { Cred } from '../perm.ts';
import type { OpKind, Uuid, VfsDetail } from './records.ts';

export type StoreName =
  | 'inodes'
  | 'dentries'
  | 'blobs'
  | 'blob_chunks'
  | 'users'
  | 'groups'
  | 'outbox'
  | 'undo'
  | 'meta'
  | 'os_sessions'
  | 'credentials'
  | 'telemetry'
  | 'bootlog';

/** A hook's own stores (the audit mirror, `ai_*`): cross-spec request X-ARC-1. */
export type AnyStoreName = StoreName | (string & {});

export type Durability = 'strict' | 'relaxed';

export interface KeyBounds {
  readonly lower: IDBValidKey;
  readonly upper: IDBValidKey;
  readonly lowerOpen?: boolean;
  readonly upperOpen?: boolean;
}

/** An abort requested from a request callback: an errno, optionally with its detail. */
export type TxCheck = Errno | { readonly errno: Errno; readonly detail: VfsDetail } | null;

export interface TxHandle {
  /** Queue a read; `check` runs in onsuccess and aborts the transaction with its errno. */
  get<T>(
    store: AnyStoreName,
    key: IDBValidKey,
    check?: (v: T | undefined) => TxCheck,
    then?: (v: T | undefined) => void,
  ): void;
  getAllByIndex<T>(
    store: AnyStoreName,
    index: string,
    key: IDBValidKey,
    then: (v: T[]) => void,
  ): void;
  /** ConstraintError (an existing key) aborts the whole transaction with EEXIST. */
  add(store: AnyStoreName, value: unknown): void;
  put(store: AnyStoreName, value: unknown): void;
  del(store: AnyStoreName, key: IDBValidKey): void;
  /** get, check the quota (EDQUOT), put (§3.8 step 2). */
  adjustUsers(uid: number, dBytes: number, dInodes: number): void;
  abort(errno: Errno, detail?: VfsDetail): void;
}

export interface TxOptions {
  readonly label: string;
  /** Client fault hook (§3.20): abort in the onsuccess of the Nth inode-row write. */
  readonly fault?: { readonly after: number };
}

export interface TxResult {
  /** Inode-row writes executed (the fault hook's unit). */
  readonly nodeOps: number;
  /** An armed fault whose N exceeded the op's node count: logged as `fault not reached (M < N)`. */
  readonly faultNotReached: boolean;
}

export interface ReadStore {
  get<T>(store: AnyStoreName, key: IDBValidKey): Promise<T | undefined>;
  /** Chunked scan by primary key, ascending; `each` sees every value in the bounds. */
  scan<T>(
    store: AnyStoreName,
    bounds: KeyBounds | null,
    each: (v: T) => void,
    opts?: { chunk?: number },
  ): Promise<void>;
  /** Read-only, chunked; results in the order of `keys`. */
  getMany<T>(store: AnyStoreName, keys: readonly IDBValidKey[]): Promise<(T | undefined)[]>;
  getByIndex<T>(store: AnyStoreName, index: string, key: IDBValidKey): Promise<T[]>;
}

export interface Store extends ReadStore {
  /** `build` MUST be synchronous. Resolves on `oncomplete`; rejects with a VfsError on abort. */
  tx(
    scope: readonly AnyStoreName[],
    durability: Durability,
    build: (t: TxHandle) => void,
    opts?: TxOptions,
  ): Promise<TxResult>;
}

/** What a transaction changed, for hooks (§4.6). */
export interface ChangeSet {
  readonly opId?: Uuid;
  readonly kind: OpKind | 'tmp' | 'remote';
  readonly pid: number;
  readonly cred: Cred;
  readonly created: readonly Uuid[];
  readonly changed: readonly Uuid[];
  readonly deleted: readonly Uuid[];
}

/** A seam for other subsystems' rows in the same transaction (audit mirror, `ai_*` stores). */
export interface VfsTxnHook {
  readonly name: string;
  stores(): readonly AnyStoreName[];
  /** Synchronous, called in phase 2 step 6 with the transaction handle. */
  build(t: TxHandle, change: ChangeSet): void;
}

/** A directory's entries: the key range `[dir] .. [dir, []]` of `dentries` (§3.13.2). */
export function dirBounds(dir: Uuid): KeyBounds {
  return { lower: [dir], upper: [dir, []] };
}
