/**
 * The `vfs` service's port (boot-and-services.md §3.3; virtual-file-system.md §3.3.6, §3.5):
 * the kernel file system on the store `storage` opened, mounted with the fencing epoch, first-boot
 * mkfs (the well-known UUIDs plus the seed), tmpfs cleared, the users mirror loaded and `/` read;
 * every other directory loads lazily on first use. Then the file-system calls are registered, so
 * `open` … `batch` answer from here on (ENOSYS before, at stage 2).
 */
import type { BootProfile, KernelTimers, VfsMounted, VfsPort } from '@plotinium/services';
import { INO } from '@plotinium/protocol';

import type { BlobFetch } from '../fs/content.ts';
import type { KernelFs } from '../fs/kfs.ts';
import { KernelFs as KernelFsImpl } from '../fs/kfs.ts';
import { registerFsSyscalls } from '../fs/syscalls.ts';
import type { FsSyscallOptions } from '../fs/syscalls.ts';
import { FsUserDirectory } from '../fs/users.ts';
import type { Kernel } from '../kernel.ts';
import type { UserDirectory } from '../proc/users.ts';
import type { BootRecorder } from './bootlog.ts';
import { applySeedUpgrade, binSeed, buildSeed } from './seed.ts';
import type { StorageIo } from './storage.ts';
import type { SeedFile } from './types.ts';

/**
 * A `UserDirectory` the host can pass to `createKernel` before the file system exists; it answers
 * from the VFS users mirror once `bind` is called (the TODO(R2) of core/proc/users.ts).
 */
export class ConsoleUsers implements UserDirectory {
  private dir: UserDirectory | null = null;
  private readonly fallback: UserDirectory | undefined;

  constructor(fallback?: UserDirectory) {
    this.fallback = fallback;
  }

  bind(fs: KernelFs): void {
    this.dir = new FsUserDirectory(fs, this.fallback);
  }

  nameOf(uid: number): string {
    return (
      this.dir?.nameOf(uid) ??
      this.fallback?.nameOf(uid) ??
      (uid === 0 ? 'root' : `u${String(uid)}`)
    );
  }
}

export interface VfsIoDeps {
  readonly kernel: Kernel;
  readonly storage: StorageIo;
  readonly recorder: BootRecorder;
  readonly seed: (() => Promise<readonly SeedFile[]>) | undefined;
  /** Whether a sync engine is linked; without one the local store is authoritative. */
  readonly standalone: boolean;
  readonly users?: ConsoleUsers;
  /** Called after each committed op (`syncd.kick()`, the queued-op count). */
  readonly onCommit: (info: { opId: string; synced: boolean; bulk: boolean }) => void;
  readonly swapBytes: () => { local: number; remote: number };
  /** A lease or lock held by another session or process than `pid` (lockd): EBUSY. */
  readonly busy?: (ino: string, pid?: number) => boolean;
  readonly fsOptions?: FsSyscallOptions;
  readonly mounted: (fs: KernelFs) => void;
  /** The kernel timer heap (the later-boot seed fetch gives up on it). */
  readonly timers?: KernelTimers;
  /** Content synced as a hash only is fetched on first read (UI-006, VFS §3.13.4). */
  readonly fetchBlob?: BlobFetch;
}

/** How long a later boot waits for the host's seed files before mounting without them. */
export const SEED_FETCH_LATER_MS = 800;
/**
 * How long a first boot waits for them (UI-032): on a slow network mkfs goes ahead without the
 * branding files rather than letting the critical `vfs` start time out; a later boot's seed upgrade
 * adds them.
 */
export const SEED_FETCH_FIRST_MS = 1_500;

const encoder = new TextEncoder();

function buildTimeOf(buildDate: string): number {
  const t = Date.parse(buildDate);
  return Number.isFinite(t) && t >= 0 ? t : 0;
}

export class VfsIo implements VfsPort {
  private readonly deps: VfsIoDeps;
  private kfs: KernelFs | null = null;

  constructor(deps: VfsIoDeps) {
    this.deps = deps;
  }

  get fs(): KernelFs | null {
    return this.kfs;
  }

  /** `/system/log/boot.log` and `kernel.log` (kernel-synthesised, §3.3.5). */
  private synth(ino: string): Uint8Array | null {
    const max = ino === INO.LOG_BOOT ? 512 : ino === INO.LOG_KERNEL ? 2_000 : 0;
    if (max === 0) return null;
    const text = this.deps.recorder
      .timeline(max)
      .map((l) => {
        const lvl = l.level === 'info' ? '' : `${l.level.toUpperCase()} `;
        return `[${l.t.toFixed(3).padStart(9)}] ${l.sub}: ${lvl}${l.msg}`;
      })
      .join('\n');
    return encoder.encode(`${text}\n`);
  }

  /**
   * The host's seed files (branding, man pages). A first boot's mkfs waits for them up to
   * `SEED_FETCH_FIRST_MS`; later boots use them only to upgrade the seed and wait
   * `SEED_FETCH_LATER_MS`. A slow or offline fetch is abandoned instead of holding up the mount.
   */
  private async hostSeed(firstBoot: boolean): Promise<readonly SeedFile[]> {
    const fetchSeed = this.deps.seed;
    if (fetchSeed === undefined) return [];
    const k = this.deps.kernel;
    const timers = this.deps.timers;
    let handle: number | null = null;
    const giveUp = new Promise<readonly SeedFile[]>((resolve) => {
      if (timers === undefined) return;
      const waitMs = firstBoot ? SEED_FETCH_FIRST_MS : SEED_FETCH_LATER_MS;
      handle = timers.at(timers.now() + waitMs, () => {
        k.log(
          'vfs',
          'warn',
          firstBoot
            ? 'seed files not fetched in time: formatting without them (a later boot adds them)'
            : 'seed files not fetched in time: seed upgrade postponed',
        );
        resolve([]);
      });
    });
    try {
      return await Promise.race([fetchSeed(), giveUp]);
    } catch (e) {
      k.log('vfs', 'warn', `seed unavailable: ${e instanceof Error ? e.message : String(e)}`);
      return [];
    } finally {
      if (handle !== null) timers?.cancel(handle);
    }
  }

  async mount(profile: BootProfile): Promise<VfsMounted> {
    const store = this.deps.storage.store;
    if (store === null) throw new Error('storage is not open');
    const k = this.deps.kernel;
    const firstBoot = this.deps.storage.firstBoot;
    const seedFiles = await this.hostSeed(firstBoot);
    const buildTime = buildTimeOf(k.host.identity.buildDate);
    const seed = buildSeed([...binSeed(k.programs), ...seedFiles], buildTime);
    const readOnly = profile === 'recovery';
    if (!firstBoot && !readOnly) {
      // A volume made by an older build: add the seeded paths it lacks (new programs in /bin).
      try {
        const up = await applySeedUpgrade(store, seed, buildTime);
        if (up.created > 0) k.log('vfs', 'info', `seed upgrade: ${String(up.created)} paths added`);
        for (const why of up.skipped.slice(0, 5))
          k.log('vfs', 'warn', `seed upgrade skipped ${why}`);
      } catch (e) {
        k.log('vfs', 'warn', `seed upgrade failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    const fs = new KernelFsImpl({
      store,
      bus: k.bus,
      clock: k.host.clock,
      procs: k.procs,
      identity: k.host.identity,
      osSessionId: () => k.osSessionId,
      log: (level, msg) => {
        k.log('vfs', level, msg);
      },
      synth: (ino) => this.synth(ino),
      onCommit: this.deps.onCommit,
      swapBytes: this.deps.swapBytes,
      ...(this.deps.busy === undefined ? {} : { busy: this.deps.busy }),
      ...(this.deps.fetchBlob === undefined ? {} : { fetchBlob: this.deps.fetchBlob }),
    });
    const report = await fs.mount({
      standalone: this.deps.standalone,
      epoch: this.deps.storage.epoch,
      seed: { entries: seed.entries, chunks: seed.chunks, hash: seed.hash },
      readOnly,
    });
    registerFsSyscalls(k.handlers, fs, this.deps.fsOptions ?? {});
    this.deps.users?.bind(fs);
    this.kfs = fs;
    this.deps.mounted(fs);
    return {
      backend: store.kind,
      mkfs: report.mkfs,
      seeded: report.mkfs ? seed.files : 0,
      tmpCleared: report.tmpCleared,
      epoch: report.epoch,
      users: report.users,
      readOnly,
      standalone: this.deps.standalone,
    };
  }

  unmount(): Promise<void> {
    this.kfs?.unmount();
    this.kfs = null;
    return Promise.resolve();
  }
}
