/**
 * The stage-2 boot-volume read (boot-and-services.md §3.2.3, §3.7 rule 2; BOOT-04, UI-058).
 *
 * Right after the kernel lock is granted, and before the router decides the boot profile, the worker
 * reads the device database READ-ONLY for the loader:
 *   - `meta.bootFlags` (a one-shot `menuNextBoot`; the router keeps its own local copy as well);
 *   - the last 3 boot records, oldest first, as `{seq, outcome}`, so "the last 2 boots failed" opens
 *     the boot menu with Safe preselected (auto-safe).
 * `volumeOk` says whether the read succeeded. A first boot (no database yet) or a read that does not
 * finish within `BOOT_VOLUME_READ_MS` reports an empty history, so the boot never waits on it.
 *
 * Outcomes: the kernel's record says `incomplete` until desktop-interactive; this maps it to what
 * actually happened:
 *   - a Recovery boot never reaches the desktop by design: `recovery`;
 *   - a boot that reached the login screen (every critical service up, `loginAt` set) and was then
 *     left, reloaded or closed there is healthy: `interactive`. Without this, reloading twice at the
 *     login screen would open the menu and auto-boot Safe mode.
 * Everything else keeps its outcome (`incomplete` for a boot that stalled or panicked).
 *
 * `/system/services` is NOT read from the volume: every boot uses the built-in manifests (see the
 * `svc:` klog line). Volume manifests are only written by mkfs and never upgraded, so reading them
 * would pin an existing device to the manifests of the build that first formatted it.
 */
import type { BootFlags, BootOutcome } from './router-protocol.ts';

/** The loader waits at most this long for the volume before deciding without it. */
export const BOOT_VOLUME_READ_MS = 300;
/** Boot records the loader gets (auto-safe needs the last 2). */
export const RECENT_BOOTS = 3;

export interface LoaderConfig {
  readonly bootFlags: BootFlags;
  readonly recentBoots: readonly BootOutcome[];
  readonly volumeOk: boolean;
}

export const NO_VOLUME: LoaderConfig = { bootFlags: {}, recentBoots: [], volumeOk: false };

const OUTCOMES: ReadonlySet<string> = new Set([
  'interactive',
  'panic',
  'recovery',
  'incomplete',
  'unsupported',
]);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** One stored boot record's outcome as the loader should count it (see the module comment). */
export function outcomeOf(r: Record<string, unknown>): BootOutcome['outcome'] | null {
  const o = r['outcome'];
  if (typeof o !== 'string' || !OUTCOMES.has(o)) return null;
  const outcome = o as BootOutcome['outcome'];
  if (outcome !== 'incomplete') return outcome;
  if (r['profile'] === 'recovery') return 'recovery';
  return typeof r['loginAt'] === 'number' ? 'interactive' : 'incomplete';
}

/** The last `RECENT_BOOTS` records, oldest first; malformed rows are skipped. */
export function recentBootsOf(rows: readonly unknown[]): BootOutcome[] {
  const out: BootOutcome[] = [];
  for (const r of rows) {
    if (!isRecord(r) || typeof r['seq'] !== 'number' || !Number.isFinite(r['seq'])) continue;
    const outcome = outcomeOf(r);
    if (outcome !== null) out.push({ seq: r['seq'], outcome });
  }
  out.sort((a, b) => a.seq - b.seq);
  return out.slice(-RECENT_BOOTS);
}

/** `meta.bootFlags` (`{k: 'bootFlags', v: {menuNextBoot?}}`), or none. */
export function bootFlagsOf(meta: unknown): BootFlags {
  const v = isRecord(meta) ? meta['v'] : undefined;
  return isRecord(v) && v['menuNextBoot'] === true ? { menuNextBoot: true } : {};
}

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => {
      resolve(r.result);
    };
    r.onerror = () => {
      reject(r.error ?? new Error('IndexedDB request failed'));
    };
  });
}

/** Open an EXISTING database at its current version; null when it does not exist. */
async function openExisting(idb: IDBFactory, name: string): Promise<IDBDatabase | null> {
  if (typeof idb.databases === 'function') {
    const dbs = await idb.databases();
    if (!dbs.some((d) => d.name === name)) return null;
  }
  return new Promise((resolve, reject) => {
    const r = idb.open(name);
    let created = false;
    r.onupgradeneeded = () => {
      // No database yet (a browser without `databases()`): never create one here; the storage
      // service does that with its migrations.
      created = true;
      r.transaction?.abort();
    };
    r.onsuccess = () => {
      const db = r.result;
      db.onversionchange = () => {
        db.close();
      };
      resolve(db);
    };
    r.onerror = () => {
      if (created) resolve(null);
      else reject(r.error ?? new Error('IndexedDB open failed'));
    };
  });
}

/** Read the loader's view of the boot volume (see the module comment). Never throws. */
export async function readBootVolume(
  idb: IDBFactory | null | undefined,
  name: string,
): Promise<LoaderConfig> {
  if (idb === null || idb === undefined) return NO_VOLUME;
  let db: IDBDatabase | null = null;
  try {
    db = await openExisting(idb, name);
    if (db === null) return NO_VOLUME;
    const names = db.objectStoreNames;
    if (!names.contains('bootlog') || !names.contains('meta')) return NO_VOLUME;
    const tx = db.transaction(['bootlog', 'meta'], 'readonly');
    const [rows, meta] = await Promise.all([
      req(tx.objectStore('bootlog').getAll() as IDBRequest<unknown[]>),
      req(tx.objectStore('meta').get('bootFlags') as IDBRequest<unknown>),
    ]);
    return { bootFlags: bootFlagsOf(meta), recentBoots: recentBootsOf(rows), volumeOk: true };
  } catch {
    return NO_VOLUME;
  } finally {
    db?.close();
  }
}

/** `readBootVolume`, or `NO_VOLUME` if it takes longer than `ms`. */
export function readBootVolumeWithin(
  read: () => Promise<LoaderConfig>,
  ms: number,
  setTimer: (fn: () => void, ms: number) => unknown,
): Promise<LoaderConfig> {
  return new Promise((resolve) => {
    let done = false;
    setTimer(() => {
      if (done) return;
      done = true;
      resolve(NO_VOLUME);
    }, ms);
    void read().then((cfg) => {
      if (done) return;
      done = true;
      resolve(cfg);
    });
  });
}
