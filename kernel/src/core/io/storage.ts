/**
 * The `storage` service's port (boot-and-services.md §3.3; virtual-file-system.md §3.13.3):
 * IndexedDB `plotinium` opened at this build's version and migrated, the fencing epoch bumped in
 * one strict transaction (ARC-02, PVFS-03: a stale tab's next transaction fails EIO `fencing`),
 * `persisted()` recorded, and this boot's record created in `bootlog` (SVC-09).
 *
 * A database the build cannot open (VersionError, a missing store) REJECTS: `storage` is critical,
 * so the boot ends on the BOOT-08 recovery screen instead of silently running from memory. The
 * memory store is used only when the host has no IndexedDB at all (Node, tests).
 */
import type { BootProfile, StorageOpened, StoragePort } from '@plotinium/services';
import type { MetaRec } from '@plotinium/vfs';
import { SCHEMA_VERSION } from '@plotinium/vfs';

import type { FsStore, StorageManagerLike } from '../fs/store.ts';
import { IdbFsStore, openIdbFsStore } from '../fs/store.ts';
import { MemStore } from '../fs/mem-store.ts';
import type { BootRecorder } from './bootlog.ts';

export interface StorageIoDeps {
  readonly indexedDB: IDBFactory | null;
  readonly storage: StorageManagerLike | undefined;
  /** Tests: this store instead of IndexedDB. */
  readonly store?: FsStore;
  readonly recorder: BootRecorder;
  readonly flags: () => readonly string[];
  readonly verbose: boolean;
}

export class StorageIo implements StoragePort {
  private readonly deps: StorageIoDeps;
  private opened: FsStore | null = null;
  private epochValue = 0;
  private fallbackWhy: string | null = null;
  private first = true;
  /** What `open()` reported for persistence (undefined: not opened yet). */
  private persistReported: boolean | null | undefined = undefined;
  /** The router's `navigator.storage.persist()` answer, if it came first. */
  private persistRequest: boolean | null = null;

  constructor(deps: StorageIoDeps) {
    this.deps = deps;
  }

  get store(): FsStore | null {
    return this.opened;
  }

  get epoch(): number {
    return this.epochValue;
  }

  get fallback(): string | null {
    return this.fallbackWhy;
  }

  /** No `meta.mkfsDone` when the database opened: the vfs service runs mkfs. */
  get firstBoot(): boolean {
    return this.first;
  }

  /**
   * The router's answer to `navigator.storage.persist()` (UI-063: ONE klog line per boot). Before
   * `open()` it is kept and reported by the storage service itself; after, it returns the line to
   * log only when it changes what the service already reported, else null.
   */
  notePersist(granted: boolean): { readonly level: 'info' | 'warn'; readonly msg: string } | null {
    this.persistRequest = granted;
    if (this.persistReported === undefined || this.persistReported === granted) return null;
    this.persistReported = granted;
    return granted
      ? { level: 'info', msg: 'persistent storage granted' }
      : { level: 'warn', msg: 'persistent storage not granted: the browser may evict local data' };
  }

  async open(profile: BootProfile): Promise<StorageOpened> {
    let store: FsStore;
    if (this.deps.store !== undefined) {
      store = this.deps.store;
      this.fallbackWhy = store.kind === 'memory' ? 'memory store supplied by the host' : null;
    } else if (this.deps.indexedDB === null) {
      store = new MemStore();
      this.fallbackWhy = 'no IndexedDB in this host';
    } else {
      store = await openIdbFsStore(this.deps.indexedDB, {
        ...(this.deps.storage === undefined ? {} : { storage: this.deps.storage }),
      });
      this.fallbackWhy = null;
    }
    this.opened = store;

    // Fencing epoch (§3.13.3): read, bump, write in one strict transaction.
    let epoch = 1;
    let firstBoot = true;
    await store.tx(
      ['meta'],
      'strict',
      (t) => {
        t.get<MetaRec>('meta', 'fencingEpoch', undefined, (rec) => {
          const prev = typeof rec?.v === 'number' ? rec.v : 0;
          epoch = prev + 1;
          t.put('meta', { k: 'fencingEpoch', v: epoch });
        });
        t.get<MetaRec>('meta', 'mkfsDone', undefined, (rec) => {
          firstBoot = rec === undefined;
        });
      },
      { label: 'fencing epoch' },
    );
    this.epochValue = epoch;
    this.first = firstBoot;

    let persisted: boolean | null;
    try {
      persisted = this.persistRequest ?? (await this.deps.storage?.persisted?.()) ?? null;
    } catch {
      persisted = null;
    }
    // The router's persist() answer may still arrive (notePersist): it logs only a change.
    this.persistReported = this.persistRequest ?? persisted;
    const bootId = await this.deps.recorder.create(store, {
      profile,
      flags: this.deps.flags(),
      verbose: this.deps.verbose,
    });
    return {
      backend: store.kind,
      fallback: this.fallbackWhy,
      schemaVersion: store.kind === 'indexeddb' ? SCHEMA_VERSION : 0,
      epoch,
      firstBoot,
      persisted,
      bootId,
    };
  }

  close(): Promise<void> {
    const s = this.opened;
    if (s instanceof IdbFsStore) s.db.close();
    this.opened = null;
    return Promise.resolve();
  }
}
