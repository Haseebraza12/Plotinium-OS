/**
 * `MemStore`: the in-memory store adapter (virtual-file-system.md §4.6 "MemStore").
 *
 * It implements the same `Store` interface as the product `IdbStore` and keeps the IndexedDB
 * semantics the VFS relies on, so the kernel file system runs unchanged on it:
 *
 * - the stores, key paths and indexes of migration 001 (`vfs/src/store/migrations/001_init.ts`);
 * - ONE transaction per `tx` call: requests run in the order they are placed, a request callback
 *   may place more requests (they run after the ones already queued), and the transaction commits
 *   when none is pending. `abort()`, a failing `check`, a `ConstraintError` (an `add` of an existing
 *   key or a unique-index clash) or any throw rolls back EVERY write of the transaction;
 * - the client fault hook (§3.20, PVFS-08): with `fault.after = N`, the onsuccess of the Nth
 *   inode-row write aborts, so N writes really ran before the rollback, exactly like `IdbStore`;
 * - errnos through vfs `toVfsError` (§6.2): ConstraintError → EEXIST, QuotaExceededError → EDQUOT
 *   (`device-full`), anything else → EIO (`storage`).
 *
 * Uses: Node unit tests, the demo when IndexedDB is unavailable (private windows, blocked storage),
 * and fixtures. It is not durable: atomicity and durability claims are verified only against
 * `IdbStore` in real Chrome (C14). Values are structured-cloned on the way in and out, so callers can
 * never alias stored rows, as with IndexedDB.
 */
import type {
  AnyStoreName,
  Durability,
  KeyBounds,
  StoreName,
  TxCheck,
  TxHandle,
  TxOptions,
  TxResult,
  UserRec,
  VfsDetail,
} from '@plotinium/vfs';
import { VfsError, applyDelta, exceeds, toVfsError } from '@plotinium/vfs';
import type { Errno } from '@plotinium/protocol';

import type { Key, KeyPath } from './keys.ts';
import { DATA_ERROR, compareKeys, encodeKey, extractKey, inBounds, isValidKey } from './keys.ts';
import type { FsStore, StorageEstimateLike } from './store.ts';

export interface MemIndexDef {
  readonly keyPath: KeyPath;
  readonly unique?: boolean;
}

export interface MemStoreDef {
  readonly keyPath: KeyPath;
  readonly autoIncrement?: boolean;
  readonly indexes?: Readonly<Record<string, MemIndexDef>>;
}

/** Migration 001, store by store (keep in step with vfs/src/store/migrations/001_init.ts). */
export const MEM_SCHEMA: Readonly<Record<StoreName, MemStoreDef>> = {
  inodes: {
    keyPath: 'ino',
    indexes: { by_uid_mtime: { keyPath: ['uid', 'mtime'] }, by_fs: { keyPath: 'fs' } },
  },
  dentries: { keyPath: ['parent', 'name'], indexes: { by_ino: { keyPath: 'ino' } } },
  blobs: { keyPath: 'sha', indexes: { by_zero: { keyPath: 'zeroSince' } } },
  blob_chunks: { keyPath: 'sha' },
  users: { keyPath: 'uid', indexes: { by_name: { keyPath: 'username', unique: true } } },
  groups: { keyPath: 'gid', indexes: { by_name: { keyPath: 'name', unique: true } } },
  outbox: {
    keyPath: 'seq',
    autoIncrement: true,
    indexes: {
      by_op: { keyPath: 'opId', unique: true },
      by_state: { keyPath: 'state' },
      by_session_cseq: { keyPath: ['osSessionId', 'cseq'], unique: true },
    },
  },
  undo: { keyPath: 'opId', indexes: { by_state: { keyPath: 'state' } } },
  meta: { keyPath: 'k' },
  os_sessions: { keyPath: 'osSessionId', indexes: { by_uid: { keyPath: 'uid' } } },
  credentials: { keyPath: 'username' },
  telemetry: { keyPath: ['uid', 'slot'] },
  bootlog: { keyPath: 'bootId' },
};

/**
 * Test and demo control: make a write fail as IndexedDB would, by returning the DOMException name
 * to raise (for example `QuotaExceededError` for a full device), or null to let it through.
 */
export type WriteFault = (
  store: string,
  op: 'add' | 'put' | 'delete',
  value: unknown,
) => string | null;

interface Row {
  readonly key: Key;
  readonly value: unknown;
}

/** A raised DOMException-like error: `toVfsError` maps it by `name`. */
function domError(name: string): Error {
  const e = new Error(name);
  e.name = name;
  return e;
}

class Table {
  readonly def: MemStoreDef;
  readonly rows = new Map<string, Row>();
  next = 1;
  private sortedCache: Row[] | null = null;

  constructor(def: MemStoreDef) {
    this.def = def;
  }

  sorted(): readonly Row[] {
    this.sortedCache ??= [...this.rows.values()].sort((a, b) => compareKeys(a.key, b.key));
    return this.sortedCache;
  }

  set(enc: string, row: Row): void {
    this.rows.set(enc, row);
    this.sortedCache = null;
  }

  remove(enc: string): void {
    if (this.rows.delete(enc)) this.sortedCache = null;
  }

  byIndex(index: string, key: Key): Row[] {
    const idx = this.def.indexes?.[index];
    if (idx === undefined) throw domError('NotFoundError');
    return this.sorted().filter((r) => {
      const v = extractKey(r.value, idx.keyPath);
      return v !== undefined && compareKeys(v, key) === 0;
    });
  }

  /** The unique-index clash a write of `value` under primary key `enc` would cause. */
  uniqueClash(enc: string, value: unknown): boolean {
    for (const idx of Object.values(this.def.indexes ?? {})) {
      if (idx.unique !== true) continue;
      const v = extractKey(value, idx.keyPath);
      if (v === undefined) continue;
      for (const [k, r] of this.rows) {
        if (k === enc) continue;
        const other = extractKey(r.value, idx.keyPath);
        if (other !== undefined && compareKeys(other, v) === 0) return true;
      }
    }
    return false;
  }
}

class MemTxn {
  failure: VfsError | null = null;
  nodeOps = 0;
  private readonly db: MemStore;
  private readonly scope: ReadonlySet<string>;
  private readonly fault: { readonly after: number } | undefined;
  private readonly queue: (() => void)[] = [];
  /** First pre-image of every row this transaction wrote, per table (undefined: row was absent). */
  private readonly undo = new Map<Table, Map<string, Row | undefined>>();
  private readonly nexts = new Map<Table, number>();
  readonly handle: TxHandle;

  constructor(db: MemStore, scope: readonly AnyStoreName[], fault?: { readonly after: number }) {
    this.db = db;
    this.scope = new Set(scope);
    this.fault = fault;
    this.handle = this.makeHandle();
  }

  private table(name: AnyStoreName): Table {
    if (!this.scope.has(name)) throw domError('NotFoundError');
    return this.db.table(name);
  }

  fail(e: VfsError): void {
    this.failure ??= e;
    this.queue.length = 0;
  }

  private enqueue(job: () => void): void {
    if (this.failure === null) this.queue.push(job);
  }

  /** Run a request callback; a throw aborts the transaction with the mapped errno. */
  private guarded(fn: () => void): void {
    try {
      fn();
    } catch (e) {
      this.fail(toVfsError(e));
    }
  }

  run(): void {
    while (this.failure === null) {
      const job = this.queue.shift();
      if (job === undefined) return;
      this.guarded(job);
    }
  }

  private remember(t: Table, enc: string): void {
    let m = this.undo.get(t);
    if (m === undefined) {
      m = new Map();
      this.undo.set(t, m);
    }
    if (!m.has(enc)) m.set(enc, t.rows.get(enc));
    if (!this.nexts.has(t)) this.nexts.set(t, t.next);
  }

  rollback(): void {
    for (const [t, rows] of this.undo) {
      for (const [enc, row] of rows) {
        if (row === undefined) t.remove(enc);
        else t.set(enc, row);
      }
    }
    for (const [t, next] of this.nexts) t.next = next;
  }

  /** A write request's success: count inode-row writes and fire the armed fault (§3.20). */
  private written(store: AnyStoreName): void {
    if (store !== 'inodes') return;
    this.nodeOps++;
    if (this.fault !== undefined && this.nodeOps === this.fault.after) {
      this.fail(new VfsError('EIO', 'injected'));
    }
  }

  private write(store: AnyStoreName, value: unknown, add: boolean): void {
    const t = this.table(store);
    this.enqueue(() => {
      const fault = this.db.writeFault?.(store, add ? 'add' : 'put', value) ?? null;
      if (fault !== null) throw domError(fault);
      let stored: unknown = structuredClone(value);
      let key = extractKey(stored, t.def.keyPath);
      if (key === undefined) {
        const path = t.def.keyPath;
        if (t.def.autoIncrement !== true || typeof path !== 'string') throw domError(DATA_ERROR);
        this.remember(t, encodeKey(t.next));
        key = t.next;
        stored = { ...(stored as object), [path]: key };
      }
      const enc = encodeKey(key);
      if (add && t.rows.has(enc)) throw domError('ConstraintError');
      if (t.uniqueClash(enc, stored)) throw domError('ConstraintError');
      this.remember(t, enc);
      if (typeof key === 'number' && t.def.autoIncrement === true)
        t.next = Math.max(t.next, key + 1);
      t.set(enc, { key, value: stored });
      this.written(store);
    });
  }

  private makeHandle(): TxHandle {
    const handle: TxHandle = {
      get: <T>(
        store: AnyStoreName,
        key: IDBValidKey,
        check?: (v: T | undefined) => TxCheck,
        then?: (v: T | undefined) => void,
      ) => {
        const t = this.table(store);
        if (!isValidKey(key)) throw domError(DATA_ERROR);
        this.enqueue(() => {
          const row = t.rows.get(encodeKey(key));
          const v = (row === undefined ? undefined : structuredClone(row.value)) as T | undefined;
          const c = check?.(v) ?? null;
          if (c !== null) {
            const f = typeof c === 'string' ? { errno: c } : c;
            this.fail(new VfsError(f.errno, 'detail' in f ? f.detail : undefined));
            return;
          }
          then?.(v);
        });
      },
      getAllByIndex: <T>(
        store: AnyStoreName,
        index: string,
        key: IDBValidKey,
        then: (v: T[]) => void,
      ) => {
        const t = this.table(store);
        this.enqueue(() => {
          then(t.byIndex(index, key).map((r) => structuredClone(r.value) as T));
        });
      },
      add: (store, value) => {
        this.write(store, value, true);
      },
      put: (store, value) => {
        this.write(store, value, false);
      },
      del: (store, key) => {
        const t = this.table(store);
        if (!isValidKey(key)) throw domError(DATA_ERROR);
        this.enqueue(() => {
          const fault = this.db.writeFault?.(store, 'delete', key) ?? null;
          if (fault !== null) throw domError(fault);
          const enc = encodeKey(key);
          this.remember(t, enc);
          t.remove(enc);
          this.written(store);
        });
      },
      adjustUsers: (uid, dBytes, dInodes) => {
        handle.get<UserRec>('users', uid, undefined, (u) => {
          if (u === undefined) return; // not mirrored: the server remains authoritative
          const d = { uid, dBytes, dInodes };
          if (exceeds(u, d)) this.fail(new VfsError('EDQUOT'));
          else handle.put('users', applyDelta(u, d));
        });
      },
      abort: (errno: Errno, detail?: VfsDetail) => {
        this.fail(new VfsError(errno, detail));
      },
    };
    return handle;
  }
}

export class MemStore implements FsStore {
  readonly kind = 'memory';
  /** See `WriteFault`. */
  writeFault: WriteFault | null = null;
  /** The durability of every readwrite transaction, in order (test assertions). */
  readonly durabilities: Durability[] = [];
  private readonly tables = new Map<string, Table>();
  private readonly defs: Map<string, MemStoreDef>;

  constructor(extra: Readonly<Record<string, MemStoreDef>> = {}) {
    this.defs = new Map([...Object.entries(MEM_SCHEMA), ...Object.entries(extra)]);
  }

  /** Declare a hook's own store (the audit mirror, `ai_*`; X-ARC-1). */
  defineStore(name: string, def: MemStoreDef): void {
    if (this.defs.has(name)) return;
    this.defs.set(name, def);
  }

  table(name: string): Table {
    let t = this.tables.get(name);
    if (t === undefined) {
      const def = this.defs.get(name);
      if (def === undefined) throw domError('NotFoundError');
      t = new Table(def);
      this.tables.set(name, t);
    }
    return t;
  }

  tx(
    scope: readonly AnyStoreName[],
    durability: Durability,
    build: (t: TxHandle) => void,
    opts?: TxOptions,
  ): Promise<TxResult> {
    this.durabilities.push(durability);
    const txn = new MemTxn(this, scope, opts?.fault);
    try {
      build(txn.handle);
    } catch (e) {
      txn.fail(toVfsError(e));
    }
    txn.run();
    const failure = txn.failure;
    if (failure !== null) {
      txn.rollback();
      return Promise.reject(failure);
    }
    const fault = opts?.fault;
    return Promise.resolve({
      nodeOps: txn.nodeOps,
      faultNotReached: fault !== undefined && txn.nodeOps < fault.after,
    });
  }

  get<T>(store: AnyStoreName, key: IDBValidKey): Promise<T | undefined> {
    return this.read(() => {
      if (!isValidKey(key)) throw domError(DATA_ERROR);
      const row = this.table(store).rows.get(encodeKey(key));
      return (row === undefined ? undefined : structuredClone(row.value)) as T | undefined;
    });
  }

  getMany<T>(store: AnyStoreName, keys: readonly IDBValidKey[]): Promise<(T | undefined)[]> {
    return this.read(() => {
      const t = this.table(store);
      return keys.map((k) => {
        if (!isValidKey(k)) throw domError(DATA_ERROR);
        const row = t.rows.get(encodeKey(k));
        return (row === undefined ? undefined : structuredClone(row.value)) as T | undefined;
      });
    });
  }

  getByIndex<T>(store: AnyStoreName, index: string, key: IDBValidKey): Promise<T[]> {
    return this.read(() =>
      this.table(store)
        .byIndex(index, key)
        .map((r) => structuredClone(r.value) as T),
    );
  }

  scan<T>(
    store: AnyStoreName,
    bounds: KeyBounds | null,
    each: (v: T) => void,
    _opts?: { chunk?: number },
  ): Promise<void> {
    return this.read(() => {
      for (const r of this.table(store).sorted()) {
        if (inBounds(r.key, bounds)) each(structuredClone(r.value) as T);
      }
    });
  }

  /** Approximate bytes held: chunk payloads plus a flat 256 bytes per row. */
  estimate(): Promise<StorageEstimateLike> {
    let usage = 0;
    for (const [name, t] of this.tables) {
      usage += 256 * t.rows.size;
      if (name !== 'blob_chunks') continue;
      for (const r of t.rows.values()) {
        const bytes = (r.value as { bytes?: unknown }).bytes;
        if (bytes instanceof ArrayBuffer) usage += bytes.byteLength;
      }
    }
    return Promise.resolve({ usage, quota: null, persisted: false });
  }

  /** Every row of a store in key order (tests and the recovery export). */
  dump<T>(store: AnyStoreName): T[] {
    return this.table(store)
      .sorted()
      .map((r) => structuredClone(r.value) as T);
  }

  /** Rows in a store. */
  count(store: AnyStoreName): number {
    return this.table(store).rows.size;
  }

  private read<T>(fn: () => T): Promise<T> {
    try {
      return Promise.resolve(fn());
    } catch (e) {
      return Promise.reject(toVfsError(e));
    }
  }
}
