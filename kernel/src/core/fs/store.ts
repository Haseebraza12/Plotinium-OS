/**
 * The kernel file system's store adapters: ONE interface, two implementations
 * (virtual-file-system.md §3.13, §4.6; C4).
 *
 * - `IdbFsStore`: the product adapter over the vfs `IdbStore` (one IndexedDB database `plotinium`
 *   per device, opened only by the kernel worker). kernel/src/core never touches the `indexedDB`
 *   global: the host passes its `IDBFactory` (and `navigator.storage`) in (architecture.md §3.7).
 * - `MemStore` (mem-store.ts): the in-memory adapter for Node tests, fixtures and the demo when
 *   IndexedDB is unavailable.
 *
 * Both implement the vfs `Store` contract (a synchronous transaction builder, one readwrite
 * transaction per call, errnos through `toVfsError`), plus `estimate()` for `statfs`.
 */
import type {
  AnyStoreName,
  Durability,
  IdbEnv,
  KeyBounds,
  Migration,
  Store,
  TxHandle,
  TxOptions,
  TxResult,
} from '@plotinium/vfs';
import { IdbStore, openDevice } from '@plotinium/vfs';

import { MemStore } from './mem-store.ts';

export type FsStoreKind = 'indexeddb' | 'memory';

/** What `statfs` reports about the device (`navigator.storage.estimate()` and `persisted()`). */
export interface StorageEstimateLike {
  readonly usage: number;
  readonly quota: number | null;
  readonly persisted: boolean;
}

export interface FsStore extends Store {
  readonly kind: FsStoreKind;
  estimate(): Promise<StorageEstimateLike>;
}

/** The part of `StorageManager` the kernel uses; the host passes `navigator.storage`. */
export interface StorageManagerLike {
  estimate(): Promise<{ usage?: number; quota?: number }>;
  persisted?(): Promise<boolean>;
}

export interface IdbFsStoreOptions {
  readonly env?: IdbEnv;
  readonly storage?: StorageManagerLike;
}

/** The product adapter: vfs `IdbStore` plus the device estimate. */
export class IdbFsStore implements FsStore {
  readonly kind = 'indexeddb';
  readonly db: IDBDatabase;
  private readonly inner: IdbStore;
  private readonly storage: StorageManagerLike | undefined;

  constructor(db: IDBDatabase, opts: IdbFsStoreOptions = {}) {
    this.db = db;
    this.inner = new IdbStore(db, opts.env);
    this.storage = opts.storage;
  }

  tx(
    scope: readonly AnyStoreName[],
    durability: Durability,
    build: (t: TxHandle) => void,
    opts?: TxOptions,
  ): Promise<TxResult> {
    return this.inner.tx(scope, durability, build, opts);
  }

  get<T>(store: AnyStoreName, key: IDBValidKey): Promise<T | undefined> {
    return this.inner.get<T>(store, key);
  }

  scan<T>(
    store: AnyStoreName,
    bounds: KeyBounds | null,
    each: (v: T) => void,
    opts?: { chunk?: number },
  ): Promise<void> {
    return this.inner.scan<T>(store, bounds, each, opts);
  }

  getMany<T>(store: AnyStoreName, keys: readonly IDBValidKey[]): Promise<(T | undefined)[]> {
    return this.inner.getMany<T>(store, keys);
  }

  getByIndex<T>(store: AnyStoreName, index: string, key: IDBValidKey): Promise<T[]> {
    return this.inner.getByIndex<T>(store, index, key);
  }

  async estimate(): Promise<StorageEstimateLike> {
    if (this.storage === undefined) return { usage: 0, quota: null, persisted: false };
    const e = await this.storage.estimate();
    const persisted = (await this.storage.persisted?.()) ?? false;
    return { usage: e.usage ?? 0, quota: e.quota ?? null, persisted };
  }
}

/** Open (creating or upgrading) the device database and wrap it (§3.13.3). */
export async function openIdbFsStore(
  factory: IDBFactory,
  opts: IdbFsStoreOptions & {
    readonly migrations?: readonly Migration[];
    readonly name?: string;
  } = {},
): Promise<IdbFsStore> {
  const db = await openDevice(factory, opts.migrations, opts.name);
  return new IdbFsStore(db, opts);
}

export interface CreateFsStoreOptions extends IdbFsStoreOptions {
  /** The host's `indexedDB`; null or undefined when the platform has none. */
  readonly indexedDB?: IDBFactory | null;
  /** Use the memory adapter even when IndexedDB exists (tests, `?storage=memory`). */
  readonly forceMemory?: boolean;
}

export interface CreatedFsStore {
  readonly store: FsStore;
  /** Why the memory adapter was chosen instead of IndexedDB; null when IndexedDB is used. */
  readonly fallback: string | null;
}

/**
 * Pick the adapter: IndexedDB when the host has it and the database opens, else the memory adapter
 * (the demo keeps working, but nothing survives a reload; the caller shows that).
 */
export async function createFsStore(opts: CreateFsStoreOptions = {}): Promise<CreatedFsStore> {
  if (opts.forceMemory === true) return { store: new MemStore(), fallback: 'memory requested' };
  const factory = opts.indexedDB ?? null;
  if (factory === null) return { store: new MemStore(), fallback: 'IndexedDB unavailable' };
  try {
    return { store: await openIdbFsStore(factory, opts), fallback: null };
  } catch (e) {
    const why = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    return { store: new MemStore(), fallback: `IndexedDB failed to open (${why})` };
  }
}
