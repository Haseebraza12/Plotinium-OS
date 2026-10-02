/**
 * TEST-ONLY in-memory fakes of the browser storage APIs blkio uses: the origin private file
 * system (directory and file handles, sync access handles) and a minimal IndexedDB, with fault
 * injection for the MEM-03 crash and verify tests. They implement the same structural interfaces
 * the real APIs satisfy (opfs.ts, idb.ts).
 */
import type {
  IdbCursorLike,
  IdbDatabaseLike,
  IdbFactoryLike,
  IdbOpenRequestLike,
  IdbRequestLike,
  IdbStoreLike,
  IdbTransactionLike,
} from '../idb.ts';
import type { DirHandleLike, FileHandleLike, SyncAccessHandleLike } from '../opfs.ts';

class DomErr extends Error {
  constructor(name: string, message = name) {
    super(message);
    this.name = name;
  }
}

export interface OpfsFaults {
  /** Corrupt the next N read-backs of writes (flip a byte in the returned copy). */
  corruptReads: number;
  /** Throw from the next `move` (a crash between the .tmp write and the rename). */
  crashOnMove: number;
  /** Throw QuotaExceededError from the next N writes. */
  quotaWrites: number;
}

interface FileNode {
  data: Uint8Array<ArrayBuffer>;
  mtime: number;
  locked: boolean;
}

export class FakeFs {
  now = 1_000;
  readonly faults: OpfsFaults = { corruptReads: 0, crashOnMove: 0, quotaWrites: 0 };
  /** Every sync write (for the "hashes each buffer once / keeps blkio busy" checks). */
  writes = 0;
  readonly root: FakeDir = new FakeDir(this, '');
}

export class FakeSyncHandle implements SyncAccessHandleLike {
  private closed = false;
  private readonly fs: FakeFs;
  private readonly node: FileNode;
  constructor(fs: FakeFs, node: FileNode) {
    this.fs = fs;
    this.node = node;
  }
  private check(): void {
    if (this.closed) throw new DomErr('InvalidStateError');
  }
  read(buffer: Uint8Array<ArrayBuffer>, options: { at?: number } = {}): number {
    this.check();
    const at = options.at ?? 0;
    const n = Math.max(0, Math.min(buffer.byteLength, this.node.data.byteLength - at));
    buffer.set(this.node.data.subarray(at, at + n));
    if (this.fs.faults.corruptReads > 0 && n > 0 && at === 0 && buffer.byteLength > 64) {
      this.fs.faults.corruptReads--;
      buffer[buffer.byteLength - 1] = (buffer[buffer.byteLength - 1] ?? 0) ^ 0xff;
    }
    return n;
  }
  write(buffer: Uint8Array<ArrayBuffer>, options: { at?: number } = {}): number {
    this.check();
    if (this.fs.faults.quotaWrites > 0) {
      this.fs.faults.quotaWrites--;
      throw new DomErr('QuotaExceededError');
    }
    const at = options.at ?? 0;
    const end = at + buffer.byteLength;
    if (end > this.node.data.byteLength) {
      const grown = new Uint8Array(end);
      grown.set(this.node.data);
      this.node.data = grown;
    }
    this.node.data.set(buffer, at);
    this.node.mtime = this.fs.now;
    this.fs.writes++;
    return buffer.byteLength;
  }
  truncate(newSize: number): void {
    this.check();
    const d = new Uint8Array(newSize);
    d.set(this.node.data.subarray(0, newSize));
    this.node.data = d;
  }
  getSize(): number {
    this.check();
    return this.node.data.byteLength;
  }
  flush(): void {
    this.check();
  }
  close(): void {
    this.closed = true;
    this.node.locked = false;
  }
}

export class FakeFile implements FileHandleLike {
  readonly kind = 'file' as const;
  private readonly fs: FakeFs;
  private readonly parent: FakeDir;
  name: string;
  constructor(fs: FakeFs, parent: FakeDir, name: string) {
    this.fs = fs;
    this.parent = parent;
    this.name = name;
  }
  private node(): FileNode {
    const n = this.parent.files.get(this.name);
    if (!n) throw new DomErr('NotFoundError');
    return n;
  }
  createSyncAccessHandle(): Promise<SyncAccessHandleLike> {
    try {
      const n = this.node();
      if (n.locked) return Promise.reject(new DomErr('NoModificationAllowedError'));
      n.locked = true;
      return Promise.resolve(new FakeSyncHandle(this.fs, n));
    } catch (e) {
      return Promise.reject(e instanceof Error ? e : new Error(String(e)));
    }
  }
  getFile(): Promise<{ size: number; lastModified: number }> {
    try {
      const n = this.node();
      return Promise.resolve({ size: n.data.byteLength, lastModified: n.mtime });
    } catch (e) {
      return Promise.reject(e instanceof Error ? e : new Error(String(e)));
    }
  }
  move(newName: string): Promise<void> {
    if (this.fs.faults.crashOnMove > 0) {
      this.fs.faults.crashOnMove--;
      return Promise.reject(new DomErr('AbortError', 'crash before rename'));
    }
    const n = this.parent.files.get(this.name);
    if (!n) return Promise.reject(new DomErr('NotFoundError'));
    if (this.parent.files.has(newName))
      return Promise.reject(new DomErr('InvalidModificationError', 'target exists'));
    this.parent.files.delete(this.name);
    this.parent.files.set(newName, n);
    this.name = newName;
    return Promise.resolve();
  }
}

export class FakeDir implements DirHandleLike {
  readonly kind = 'directory' as const;
  readonly files = new Map<string, FileNode>();
  readonly dirs = new Map<string, FakeDir>();
  private readonly fs: FakeFs;
  readonly name: string;
  constructor(fs: FakeFs, name: string) {
    this.fs = fs;
    this.name = name;
  }
  getDirectoryHandle(name: string, options: { create?: boolean } = {}): Promise<DirHandleLike> {
    let d = this.dirs.get(name);
    if (!d) {
      if (this.files.has(name)) return Promise.reject(new DomErr('TypeMismatchError'));
      if (options.create !== true) return Promise.reject(new DomErr('NotFoundError'));
      d = new FakeDir(this.fs, name);
      this.dirs.set(name, d);
    }
    return Promise.resolve(d);
  }
  getFileHandle(name: string, options: { create?: boolean } = {}): Promise<FileHandleLike> {
    if (!this.files.has(name)) {
      if (this.dirs.has(name)) return Promise.reject(new DomErr('TypeMismatchError'));
      if (options.create !== true) return Promise.reject(new DomErr('NotFoundError'));
      this.files.set(name, { data: new Uint8Array(0), mtime: this.fs.now, locked: false });
    }
    return Promise.resolve(new FakeFile(this.fs, this, name));
  }
  removeEntry(name: string, options: { recursive?: boolean } = {}): Promise<void> {
    if (this.files.delete(name)) return Promise.resolve();
    const d = this.dirs.get(name);
    if (!d) return Promise.reject(new DomErr('NotFoundError'));
    if ((d.files.size > 0 || d.dirs.size > 0) && options.recursive !== true)
      return Promise.reject(new DomErr('InvalidModificationError'));
    this.dirs.delete(name);
    return Promise.resolve();
  }
  async *entries(): AsyncIterable<[string, FileHandleLike | DirHandleLike]> {
    await Promise.resolve();
    for (const name of [...this.dirs.keys()]) {
      const d = this.dirs.get(name);
      if (d) yield [name, d];
    }
    for (const name of [...this.files.keys()]) yield [name, new FakeFile(this.fs, this, name)];
  }
  /** Test helper: every file path below this directory. */
  paths(prefix = ''): string[] {
    const out: string[] = [];
    for (const f of this.files.keys()) out.push(`${prefix}${f}`);
    for (const [n, d] of this.dirs) out.push(...d.paths(`${prefix}${n}/`));
    return out.sort();
  }
  /** Test helper: the file node at a relative path. */
  node(path: string): FileNode | undefined {
    const [head = '', ...rest] = path.split('/');
    if (rest.length === 0) return this.files.get(head);
    return this.dirs.get(head)?.node(rest.join('/'));
  }
}

// ---------------------------------------------------------------------------------------------
// IndexedDB
// ---------------------------------------------------------------------------------------------

class Req<T> implements IdbRequestLike<T> {
  result!: T;
  error: { name: string; message: string } | null = null;
  onsuccess: (() => void) | null = null;
  onerror: (() => void) | null = null;
}

class OpenReq extends Req<IdbDatabaseLike> implements IdbOpenRequestLike {
  onupgradeneeded: (() => void) | null = null;
}

export interface IdbFaults {
  /** The next N readwrite transactions fail with QuotaExceededError. */
  quota: number;
  /** The next N `get`s return a corrupted body. */
  corruptGets: number;
  /** Fail `open`. */
  failOpen: boolean;
}

type Tables = Map<string, Map<string, { key: unknown; value: unknown }>>;

class FakeTx implements IdbTransactionLike {
  oncomplete: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  error: { name: string; message: string } | null = null;
  private pending = 0;
  failed = false;
  private readonly tables: Tables;
  private readonly mode: 'readonly' | 'readwrite';
  private readonly faults: IdbFaults;
  constructor(tables: Tables, mode: 'readonly' | 'readwrite', faults: IdbFaults) {
    this.tables = tables;
    this.mode = mode;
    this.faults = faults;
    if (mode === 'readwrite' && faults.quota > 0) {
      faults.quota--;
      this.failed = true;
      this.error = { name: 'QuotaExceededError', message: 'quota' };
    }
    setTimeout(() => this.settle(), 0);
  }
  private settle(): void {
    if (this.pending > 0) {
      setTimeout(() => this.settle(), 0);
      return;
    }
    if (this.failed) this.onabort?.();
    else this.oncomplete?.();
  }
  schedule<T>(req: Req<T>, fn: () => T): Req<T> {
    this.pending++;
    setTimeout(() => {
      this.pending--;
      req.result = fn();
      req.onsuccess?.();
    }, 0);
    return req;
  }
  objectStore(name: string): IdbStoreLike {
    const table = this.tables.get(name);
    if (!table) throw new DomErr('NotFoundError');
    const k = (key: unknown): string => JSON.stringify(key);
    const faults = this.faults;
    const writable = this.mode === 'readwrite';
    const schedule = <T>(req: Req<T>, fn: () => T): Req<T> => this.schedule(req, fn);
    const failed = (): boolean => this.failed;
    return {
      put: (value: unknown, key?: unknown) => {
        if (!writable) throw new DomErr('ReadOnlyError');
        const clone = structuredClone(value);
        return schedule(new Req<unknown>(), () => {
          if (!failed()) table.set(k(key), { key, value: clone });
          return key;
        });
      },
      get: (key: unknown) => {
        return schedule(new Req<unknown>(), () => {
          const hit = table.get(k(key));
          if (!hit) return undefined;
          const v = structuredClone(hit.value) as { body?: ArrayBuffer };
          if (faults.corruptGets > 0 && v.body instanceof ArrayBuffer && v.body.byteLength > 0) {
            faults.corruptGets--;
            const u8 = new Uint8Array(v.body);
            u8[0] = (u8[0] ?? 0) ^ 0xff;
          }
          return v;
        });
      },
      delete: (key: unknown) => {
        if (!writable) throw new DomErr('ReadOnlyError');
        return schedule(new Req<undefined>(), () => {
          table.delete(k(key));
          return undefined;
        });
      },
      openCursor: () => {
        const req = new Req<IdbCursorLike | null>();
        const entries = [...table.entries()];
        let i = 0;
        const step = (): void => {
          const e = entries[i];
          if (!e) {
            schedule(req, () => null);
            return;
          }
          const [id, row] = e;
          const cursor: IdbCursorLike = {
            key: row.key,
            value: structuredClone(row.value),
            continue: () => {
              i++;
              step();
            },
            delete: () =>
              schedule(new Req<undefined>(), () => {
                table.delete(id);
                return undefined;
              }),
          };
          schedule(req, () => cursor);
        };
        step();
        return req;
      },
    };
  }
}

export class FakeIdbFactory implements IdbFactoryLike {
  readonly dbs = new Map<string, Tables>();
  readonly faults: IdbFaults = { quota: 0, corruptGets: 0, failOpen: false };
  open(name: string): IdbOpenRequestLike {
    const req = new OpenReq();
    setTimeout(() => {
      if (this.faults.failOpen) {
        req.error = { name: 'UnknownError', message: 'open failed' };
        req.onerror?.();
        return;
      }
      const isNew = !this.dbs.has(name);
      const tables: Tables =
        this.dbs.get(name) ?? new Map<string, Map<string, { key: unknown; value: unknown }>>();
      this.dbs.set(name, tables);
      const db: IdbDatabaseLike = {
        objectStoreNames: { contains: (n: string) => tables.has(n) },
        createObjectStore: (n: string) => {
          tables.set(n, new Map());
          return undefined;
        },
        transaction: (n, mode) => {
          if (!tables.has(n)) throw new DomErr('NotFoundError');
          return new FakeTx(tables, mode, this.faults);
        },
        close: () => undefined,
      };
      req.result = db;
      if (isNew) req.onupgradeneeded?.();
      req.onsuccess?.();
    }, 0);
    return req;
  }
}
