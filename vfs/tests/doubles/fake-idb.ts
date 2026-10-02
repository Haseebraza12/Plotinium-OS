/**
 * TEST-ONLY IndexedDB double for Node (the atomicity and durability claims themselves are verified
 * only against real Chrome, C14). It models what the VFS relies on: requests run in order, callbacks
 * may queue more requests, the transaction commits when none is pending, `abort()` or an unprevented
 * request error rolls every write back, `add` of an existing key or a unique-index clash is a
 * ConstraintError, keys order like IndexedDB keys (number < string < array, arrays element-wise).
 */
import type { IdbEnv } from '../../src/store/idb-store.ts';

type Key = IDBValidKey;

function rank(k: Key): number {
  if (typeof k === 'number') return 0;
  if (k instanceof Date) return 1;
  if (typeof k === 'string') return 2;
  if (Array.isArray(k)) return 4;
  return 3;
}

export function compareKeys(a: Key, b: Key): number {
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      const c = compareKeys(a[i] as Key, b[i] as Key);
      if (c !== 0) return c;
    }
    return a.length - b.length;
  }
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
  return 0;
}

export class FakeKeyRange {
  readonly lower: Key | undefined;
  readonly upper: Key | undefined;
  readonly lowerOpen: boolean;
  readonly upperOpen: boolean;

  constructor(
    lower: Key | undefined,
    upper: Key | undefined,
    lowerOpen: boolean,
    upperOpen: boolean,
  ) {
    this.lower = lower;
    this.upper = upper;
    this.lowerOpen = lowerOpen;
    this.upperOpen = upperOpen;
  }

  includes(k: Key): boolean {
    if (this.lower !== undefined) {
      const c = compareKeys(k, this.lower);
      if (c < 0 || (c === 0 && this.lowerOpen)) return false;
    }
    if (this.upper !== undefined) {
      const c = compareKeys(k, this.upper);
      if (c > 0 || (c === 0 && this.upperOpen)) return false;
    }
    return true;
  }
}

const asRange = (q: unknown): FakeKeyRange | null => (q instanceof FakeKeyRange ? q : null);

function domError(name: string): DOMException {
  return new DOMException(name, name);
}

type KeyPath = string | string[];

function extract(value: unknown, path: KeyPath): Key | undefined {
  const get = (p: string): unknown =>
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[p] : undefined;
  if (Array.isArray(path)) {
    const parts = path.map(get);
    return parts.every((x) => x !== undefined) ? (parts as Key[]) : undefined;
  }
  const v = get(path);
  return v === undefined ? undefined : (v as Key);
}

interface Row {
  key: Key;
  value: unknown;
}

class StoreData {
  readonly rows = new Map<string, Row>();
  readonly indexes = new Map<string, { keyPath: KeyPath; unique: boolean }>();
  next = 1;
  readonly keyPath: KeyPath;
  readonly autoIncrement: boolean;

  constructor(keyPath: KeyPath, autoIncrement: boolean) {
    this.keyPath = keyPath;
    this.autoIncrement = autoIncrement;
  }

  sorted(): Row[] {
    return [...this.rows.values()].sort((a, b) => compareKeys(a.key, b.key));
  }

  clone(): StoreData {
    const c = new StoreData(this.keyPath, this.autoIncrement);
    for (const [k, r] of this.rows) c.rows.set(k, r);
    for (const [k, i] of this.indexes) c.indexes.set(k, i);
    c.next = this.next;
    return c;
  }
}

type Handler = ((ev: Event) => void) | null;

class FakeRequest {
  result: unknown = undefined;
  error: DOMException | null = null;
  onsuccess: Handler = null;
  onerror: Handler = null;
  onupgradeneeded: ((ev: { oldVersion: number; newVersion: number }) => void) | null = null;
  transaction: FakeTransaction | null = null;
}

/** Test control: fail a write with a DOMException (for example QuotaExceededError). */
export type WriteFault = (
  store: string,
  op: 'add' | 'put' | 'delete',
  value: unknown,
) => string | null;

export class FakeTransaction {
  oncomplete: Handler = null;
  onabort: Handler = null;
  error: DOMException | null = null;
  private readonly queue: (() => void)[] = [];
  private readonly snapshots = new Map<string, StoreData>();
  private state: 'active' | 'done' | 'aborted' = 'active';
  readonly db: FakeDatabase;
  readonly scope: readonly string[];
  readonly mode: IDBTransactionMode;

  constructor(db: FakeDatabase, scope: readonly string[], mode: IDBTransactionMode) {
    this.db = db;
    this.scope = scope;
    this.mode = mode;
    setTimeout(() => this.run(), 0);
  }

  objectStore(name: string): FakeObjectStore {
    if (!this.scope.includes(name) && this.mode !== 'versionchange')
      throw domError('NotFoundError');
    return new FakeObjectStore(this, name);
  }

  enqueue(
    exec: () => unknown,
    write: { store: string; op: 'add' | 'put' | 'delete'; value: unknown } | null,
  ): FakeRequest {
    if (this.state !== 'active') throw domError('TransactionInactiveError');
    const req = new FakeRequest();
    req.transaction = this;
    this.queue.push(() => {
      if (this.state !== 'active') return;
      try {
        const fault =
          write === null
            ? null
            : (this.db.writeFault?.(write.store, write.op, write.value) ?? null);
        if (fault !== null) throw domError(fault);
        if (write !== null) this.snapshot(write.store);
        req.result = exec();
        req.onsuccess?.({} as Event);
      } catch (e) {
        if (!(e instanceof DOMException)) throw e;
        req.error = e;
        let prevented = false;
        req.onerror?.({ preventDefault: () => (prevented = true) } as unknown as Event);
        if (!prevented) this.fail(e);
      }
    });
    return req;
  }

  private snapshot(store: string): void {
    if (this.snapshots.has(store)) return;
    const data = this.db.data(store);
    this.snapshots.set(store, data.clone());
  }

  private run(): void {
    while (this.queue.length > 0 && this.state === 'active') this.queue.shift()?.();
    if (this.state !== 'active') return;
    this.state = 'done';
    this.oncomplete?.({} as Event);
  }

  private fail(e: DOMException | null): void {
    if (this.state !== 'active') return;
    this.state = 'aborted';
    this.error = e;
    for (const [name, data] of this.snapshots) this.db.restore(name, data);
    this.queue.length = 0;
    setTimeout(() => this.onabort?.({} as Event), 0);
  }

  abort(): void {
    if (this.state !== 'active') throw domError('InvalidStateError');
    this.fail(null);
  }
}

class FakeIndex {
  private readonly tx: FakeTransaction;
  private readonly store: string;
  private readonly name: string;

  constructor(tx: FakeTransaction, store: string, name: string) {
    this.tx = tx;
    this.store = store;
    this.name = name;
  }

  private matches(key: Key): Row[] {
    const data = this.tx.db.data(this.store);
    const idx = data.indexes.get(this.name);
    if (idx === undefined) throw domError('NotFoundError');
    return data.sorted().filter((r) => {
      const v = extract(r.value, idx.keyPath);
      return v !== undefined && compareKeys(v, key) === 0;
    });
  }

  getAll(key: Key): FakeRequest {
    return this.tx.enqueue(() => this.matches(key).map((r) => structuredClone(r.value)), null);
  }

  getAllKeys(key: Key): FakeRequest {
    return this.tx.enqueue(() => this.matches(key).map((r) => r.key), null);
  }
}

class FakeObjectStore {
  private readonly tx: FakeTransaction;
  private readonly name: string;

  constructor(tx: FakeTransaction, name: string) {
    this.tx = tx;
    this.name = name;
  }

  private get data(): StoreData {
    return this.tx.db.data(this.name);
  }

  index(name: string): FakeIndex {
    return new FakeIndex(this.tx, this.name, name);
  }

  createIndex(name: string, keyPath: KeyPath, opts?: { unique?: boolean }): void {
    this.data.indexes.set(name, { keyPath, unique: opts?.unique === true });
  }

  private inRange(query: unknown): (r: Row) => boolean {
    const range = asRange(query);
    if (range !== null) return (r) => range.includes(r.key);
    if (query === null || query === undefined) return () => true;
    return (r) => compareKeys(r.key, query as Key) === 0;
  }

  get(key: Key): FakeRequest {
    return this.tx.enqueue(() => {
      const r = this.data.rows.get(JSON.stringify(key));
      return r === undefined ? undefined : structuredClone(r.value);
    }, null);
  }

  getAll(query?: unknown, count?: number): FakeRequest {
    return this.tx.enqueue(() => {
      const rows = this.data.sorted().filter(this.inRange(query));
      return (count === undefined ? rows : rows.slice(0, count)).map((r) =>
        structuredClone(r.value),
      );
    }, null);
  }

  getAllKeys(query?: unknown, count?: number): FakeRequest {
    return this.tx.enqueue(() => {
      const rows = this.data.sorted().filter(this.inRange(query));
      return (count === undefined ? rows : rows.slice(0, count)).map((r) => r.key);
    }, null);
  }

  private write(value: unknown, add: boolean): Key {
    const data = this.data;
    let stored = structuredClone(value);
    let key = extract(stored, data.keyPath);
    if (key === undefined) {
      if (!data.autoIncrement || typeof data.keyPath !== 'string') throw domError('DataError');
      key = data.next++;
      stored = { ...(stored as object), [data.keyPath]: key };
    } else if (typeof key === 'number' && data.autoIncrement) {
      data.next = Math.max(data.next, key + 1);
    }
    const k = JSON.stringify(key);
    if (add && data.rows.has(k)) throw domError('ConstraintError');
    for (const [, idx] of data.indexes) {
      if (!idx.unique) continue;
      const v = extract(stored, idx.keyPath);
      if (v === undefined) continue;
      for (const [rk, r] of data.rows) {
        const other = extract(r.value, idx.keyPath);
        if (rk !== k && other !== undefined && compareKeys(other, v) === 0)
          throw domError('ConstraintError');
      }
    }
    data.rows.set(k, { key, value: stored });
    return key;
  }

  add(value: unknown): FakeRequest {
    return this.tx.enqueue(() => this.write(value, true), { store: this.name, op: 'add', value });
  }

  put(value: unknown): FakeRequest {
    return this.tx.enqueue(() => this.write(value, false), { store: this.name, op: 'put', value });
  }

  delete(query: unknown): FakeRequest {
    return this.tx.enqueue(
      () => {
        const pred = this.inRange(query);
        for (const [k, r] of [...this.data.rows]) if (pred(r)) this.data.rows.delete(k);
        return undefined;
      },
      { store: this.name, op: 'delete', value: query },
    );
  }
}

export class FakeDatabase {
  private readonly stores = new Map<string, StoreData>();
  onversionchange: (() => void) | null = null;
  writeFault: WriteFault | null = null;
  closed = false;
  /** Every transaction's durability, for assertions. */
  readonly durabilities: string[] = [];
  readonly name: string;
  version: number;

  constructor(name: string, version: number) {
    this.name = name;
    this.version = version;
  }

  data(store: string): StoreData {
    const d = this.stores.get(store);
    if (d === undefined) throw domError('NotFoundError');
    return d;
  }

  restore(store: string, data: StoreData): void {
    this.stores.set(store, data);
  }

  get objectStoreNames(): string[] {
    return [...this.stores.keys()].sort();
  }

  createObjectStore(
    name: string,
    opts: { keyPath: KeyPath; autoIncrement?: boolean },
  ): FakeObjectStore {
    this.stores.set(name, new StoreData(opts.keyPath, opts.autoIncrement === true));
    return new FakeTransaction(this, [name], 'versionchange').objectStore(name);
  }

  transaction(
    scope: string | string[],
    mode: IDBTransactionMode = 'readonly',
    opts?: { durability?: string },
  ): FakeTransaction {
    const names = typeof scope === 'string' ? [scope] : scope;
    for (const n of names) this.data(n);
    this.durabilities.push(opts?.durability ?? 'default');
    return new FakeTransaction(this, names, mode);
  }

  /** All rows of a store, sorted by key (test assertions). */
  dump<T>(store: string): T[] {
    return this.data(store)
      .sorted()
      .map((r) => structuredClone(r.value) as T);
  }

  close(): void {
    this.closed = true;
  }
}

export class FakeFactory {
  readonly databases = new Map<string, FakeDatabase>();

  open(name: string, version: number): FakeRequest {
    const req = new FakeRequest();
    setTimeout(() => {
      const existing = this.databases.get(name);
      if (existing !== undefined && existing.version > version) {
        req.error = domError('VersionError');
        req.onerror?.({} as Event);
        return;
      }
      const db = existing ?? new FakeDatabase(name, 0);
      this.databases.set(name, db);
      req.result = db;
      if (db.version < version) {
        const old = db.version;
        db.version = version;
        req.transaction = new FakeTransaction(db, [], 'versionchange');
        req.onupgradeneeded?.({ oldVersion: old, newVersion: version });
      }
      req.onsuccess?.({} as Event);
    }, 0);
    return req;
  }
}

/** The `IdbEnv` for `IdbStore` over this double. */
export const fakeEnv: IdbEnv = {
  // FakeKeyRange has IDBKeyRange's shape (bounds, openness, includes).
  bound: (l, u, lo, uo) => new FakeKeyRange(l, u, lo, uo),
  lowerBound: (l, open) => new FakeKeyRange(l, undefined, open, false),
  yieldNow: () => Promise.resolve(),
};
