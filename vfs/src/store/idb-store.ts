/**
 * `IdbStore`: the product implementation of `Store` over IndexedDB (virtual-file-system.md §3.13,
 * §3.20, §6.2). Only the kernel worker opens the database (C4).
 *
 * - `tx`: one readwrite transaction with the requested durability; the builder queues requests
 *   synchronously and chains follow-ups from request callbacks. Resolves on `oncomplete`, rejects
 *   with a VfsError on `onabort`: our own abort's errno, or the mapped DOMException (§6.2).
 * - Fault hook (PVFS-08): every request on `inodes` is a node operation; with `fault.after = N` the
 *   onsuccess of the Nth executed one calls `abort()`, so N writes really ran before the rollback.
 * - Scans are chunked read-only transactions of at most 500 keys, yielding between chunks.
 */
import type { Errno } from '@plotinium/protocol';

import { VfsError } from '../errors.ts';
import { SCAN_CHUNK } from '../limits.ts';
import { applyDelta, exceeds } from '../quota/quota.ts';
import type { UserRec, VfsDetail } from './records.ts';
import { DB_NAME, MIGRATIONS } from './schema.ts';
import type { Migration } from './schema.ts';
import type {
  AnyStoreName,
  Durability,
  KeyBounds,
  Store,
  TxCheck,
  TxHandle,
  TxOptions,
  TxResult,
} from './store.ts';

/** Host bindings, injectable so the store runs against a test double in Node. */
export interface IdbEnv {
  readonly bound: (
    lower: IDBValidKey,
    upper: IDBValidKey,
    lowerOpen: boolean,
    upperOpen: boolean,
  ) => IDBKeyRange;
  readonly lowerBound: (lower: IDBValidKey, open: boolean) => IDBKeyRange;
  /** Yield to the kernel's event loop between scan chunks. */
  readonly yieldNow: () => Promise<void>;
}

const defaultEnv = (): IdbEnv => ({
  bound: (l, u, lo, uo) => IDBKeyRange.bound(l, u, lo, uo),
  lowerBound: (l, open) => IDBKeyRange.lowerBound(l, open),
  yieldNow: () => new Promise((r) => setTimeout(r, 0)),
});

function errName(e: unknown): string {
  return typeof e === 'object' && e !== null && 'name' in e && typeof e.name === 'string'
    ? e.name
    : '';
}

/** §6.2 and syscall-abi.md §4.9: IndexedDB conditions to errnos. */
export function toVfsError(e: unknown): VfsError {
  if (e instanceof VfsError) return e;
  switch (errName(e)) {
    case 'ConstraintError':
      return new VfsError('EEXIST');
    case 'QuotaExceededError':
      return new VfsError('EDQUOT', 'device-full');
    case 'TransactionInactiveError':
    case 'InvalidStateError':
      return new VfsError('EIO', 'abort');
    default:
      return new VfsError('EIO', 'storage');
  }
}

function fromCheck(c: Exclude<TxCheck, null>): { errno: Errno; detail?: VfsDetail } {
  return typeof c === 'string' ? { errno: c } : c;
}

export class IdbStore implements Store {
  private readonly db: IDBDatabase;
  private readonly env: IdbEnv;

  constructor(db: IDBDatabase, env?: IdbEnv) {
    this.db = db;
    this.env = env ?? defaultEnv();
  }

  tx(
    scope: readonly AnyStoreName[],
    durability: Durability,
    build: (t: TxHandle) => void,
    opts?: TxOptions,
  ): Promise<TxResult> {
    return new Promise<TxResult>((resolve, reject) => {
      let tx: IDBTransaction;
      try {
        tx = this.db.transaction([...new Set(scope)], 'readwrite', { durability });
      } catch (e) {
        reject(toVfsError(e));
        return;
      }
      const fault = opts?.fault;
      let failure: VfsError | null = null;
      let nodeOps = 0;
      const abort = (errno: Errno, detail?: VfsDetail): void => {
        failure ??= new VfsError(errno, detail);
        try {
          tx.abort();
        } catch {
          // Already finished or aborting: the first failure is the one reported.
        }
      };
      const guarded = (fn: () => void): void => {
        try {
          fn();
        } catch (e) {
          const v = toVfsError(e);
          abort(v.errno, v.detail);
        }
      };
      const track = <T>(req: IDBRequest<T>, node: boolean, onOk?: (v: T) => void): void => {
        req.onsuccess = () => {
          if (failure !== null) return;
          if (node) {
            nodeOps++;
            if (fault !== undefined && nodeOps === fault.after) {
              abort('EIO', 'injected');
              return;
            }
          }
          if (onOk !== undefined) guarded(() => onOk(req.result));
        };
        // Not prevented: the error aborts the transaction, which reports this errno.
        req.onerror = () => {
          failure ??= toVfsError(req.error);
        };
      };
      const os = (name: AnyStoreName): IDBObjectStore => tx.objectStore(name);
      const handle: TxHandle = {
        get: <T>(
          store: AnyStoreName,
          key: IDBValidKey,
          check?: (v: T | undefined) => TxCheck,
          then?: (v: T | undefined) => void,
        ) => {
          track(os(store).get(key), false, (raw) => {
            const v = raw as T | undefined;
            const c = check?.(v) ?? null;
            if (c !== null) {
              const f = fromCheck(c);
              abort(f.errno, f.detail);
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
          track(os(store).index(index).getAll(key), false, (raw) => then(raw as T[]));
        },
        add: (store, value) => track(os(store).add(value), store === 'inodes'),
        put: (store, value) => track(os(store).put(value), store === 'inodes'),
        del: (store, key) => track(os(store).delete(key), store === 'inodes'),
        adjustUsers: (uid, dBytes, dInodes) => {
          handle.get<UserRec>('users', uid, undefined, (u) => {
            if (u === undefined) return; // not mirrored: the server remains authoritative
            const d = { uid, dBytes, dInodes };
            if (exceeds(u, d)) abort('EDQUOT');
            else handle.put('users', applyDelta(u, d));
          });
        },
        abort,
      };
      tx.oncomplete = () =>
        resolve({ nodeOps, faultNotReached: fault !== undefined && nodeOps < fault.after });
      tx.onabort = () => reject(failure ?? toVfsError(tx.error));
      guarded(() => build(handle));
    });
  }

  get<T>(store: AnyStoreName, key: IDBValidKey): Promise<T | undefined> {
    return this.read(store, (os) => os.get(key)).then((v) => v as T | undefined);
  }

  getByIndex<T>(store: AnyStoreName, index: string, key: IDBValidKey): Promise<T[]> {
    return this.read(store, (os) => os.index(index).getAll(key)).then((v) => v as T[]);
  }

  async getMany<T>(store: AnyStoreName, keys: readonly IDBValidKey[]): Promise<(T | undefined)[]> {
    const out: (T | undefined)[] = [];
    for (let i = 0; i < keys.length; i += SCAN_CHUNK) {
      const part = keys.slice(i, i + SCAN_CHUNK);
      const values = await new Promise<(T | undefined)[]>((resolve, reject) => {
        const tx = this.db.transaction([store], 'readonly');
        const os = tx.objectStore(store);
        const got: (T | undefined)[] = new Array<T | undefined>(part.length);
        part.forEach((k, j) => {
          const r = os.get(k);
          r.onsuccess = () => {
            got[j] = r.result as T | undefined;
          };
        });
        tx.oncomplete = () => resolve(got);
        tx.onabort = () => reject(toVfsError(tx.error));
      });
      out.push(...values);
      if (i + SCAN_CHUNK < keys.length) await this.env.yieldNow();
    }
    return out;
  }

  async scan<T>(
    store: AnyStoreName,
    bounds: KeyBounds | null,
    each: (v: T) => void,
    opts?: { chunk?: number },
  ): Promise<void> {
    const chunk = opts?.chunk ?? SCAN_CHUNK;
    let lower = bounds?.lower;
    let lowerOpen = bounds?.lowerOpen ?? false;
    for (;;) {
      let range: IDBKeyRange | null = null;
      if (bounds !== null && lower !== undefined)
        range = this.env.bound(lower, bounds.upper, lowerOpen, bounds.upperOpen ?? false);
      else if (lower !== undefined) range = this.env.lowerBound(lower, lowerOpen);
      const { values, keys } = await this.readChunk(store, range, chunk);
      for (const v of values) each(v as T);
      const last = keys[keys.length - 1];
      if (values.length < chunk || last === undefined) return;
      lower = last;
      lowerOpen = true;
      await this.env.yieldNow();
    }
  }

  private readChunk(
    store: AnyStoreName,
    range: IDBKeyRange | null,
    count: number,
  ): Promise<{ values: unknown[]; keys: IDBValidKey[] }> {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction([store], 'readonly');
      const os = tx.objectStore(store);
      let values: unknown[] = [];
      let keys: IDBValidKey[] = [];
      const v = os.getAll(range, count);
      v.onsuccess = () => {
        values = v.result;
      };
      const k = os.getAllKeys(range, count);
      k.onsuccess = () => {
        keys = k.result;
      };
      tx.oncomplete = () => resolve({ values, keys });
      tx.onabort = () => reject(toVfsError(tx.error));
    });
  }

  private read(store: AnyStoreName, req: (os: IDBObjectStore) => IDBRequest): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction([store], 'readonly');
      const r = req(tx.objectStore(store));
      let value: unknown;
      r.onsuccess = () => {
        value = r.result;
      };
      tx.oncomplete = () => resolve(value);
      tx.onabort = () => reject(toVfsError(tx.error));
    });
  }
}

/**
 * Open (and create or upgrade) the device database (§3.13.3). A stored version newer than the code
 * (`VersionError`) rejects with EIO: the `storage` service then opens the recovery screen (BOOT-08).
 * A `versionchange` from another context closes this connection.
 */
export function openDevice(
  factory: IDBFactory,
  migrations: readonly Migration[] = MIGRATIONS,
  name = DB_NAME,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = factory.open(name, migrations.length);
    req.onupgradeneeded = (ev) => {
      const tx = req.transaction;
      if (tx === null) return;
      for (let v = ev.oldVersion; v < migrations.length; v++)
        migrations[v]?.upgrade(req.result, tx);
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(toVfsError(req.error));
  });
}
