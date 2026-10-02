/**
 * The blkio worker entry (specs/03-kernel/memory-and-paging.md §3.10; architecture.md §3 special
 * workers). A kernel-owned dedicated module worker that only the kernel talks to: a 5 MB
 * write-flush-read-verify blocks for 15-58 ms (pilot figure — re-measure on the lab machine),
 * which must not stall syscalls, so tier-1 swap lives here.
 *
 * Device choice, once at POST (the `init` request):
 *   - OPFS (default) when `FileSystemFileHandle.prototype.createSyncAccessHandle` exists
 *     (dedicated workers only, secure context);
 *   - else IndexedDB `plotinium-swap` (C1, C4); `bootlog` and `swapctl` show the fallback.
 * Capacity: LOCAL_SWAP_CAP = min(2 GiB, 25 % of navigator.storage.estimate().quota).
 *
 * Messages: kernel/src/blkio/protocol.ts (one request per SwapDevice method, buffers transferred,
 * `progress` during reads). Owner: R1 Kernel. Reviewer: R2 VFS/DB.
 */
import { localSwapCap } from '../core/mm/params.ts';
import { subtleSha256Hex } from './compress.ts';
import { IdbSwapDevice, openIdbSwapStore } from './idb.ts';
import type { IdbFactoryLike } from './idb.ts';
import { OpfsSwapDevice } from './opfs.ts';
import type { AsyncDigestHex, DirHandleLike } from './opfs.ts';
import type { BlkioEndpoint, BlkioReply, BlkioRequest } from './protocol.ts';
import { serveBlkio } from './server.ts';
import type { OpenedDevice } from './server.ts';

/** What the worker needs from its environment; injected so the choice is unit-tested. */
export interface BlkioEnv {
  /** True when OPFS sync access handles are available. */
  opfs: boolean;
  getDirectory(): Promise<DirHandleLike>;
  indexedDB: IdbFactoryLike | null;
  estimate(): Promise<{ quota?: number; usage?: number }>;
  digestHex: AsyncDigestHex;
  now(): number;
}

/** The real browser environment of a dedicated worker. */
export function browserEnv(): BlkioEnv {
  const storage = typeof navigator === 'undefined' ? undefined : navigator.storage;
  const handleProto: object | undefined =
    typeof FileSystemFileHandle === 'undefined' ? undefined : FileSystemFileHandle.prototype;
  return {
    opfs:
      handleProto !== undefined &&
      'createSyncAccessHandle' in handleProto &&
      typeof storage?.getDirectory === 'function',
    // The DOM handle types are wider than DirHandleLike (and `move` is not in the TS lib yet).
    getDirectory: async () =>
      (await (storage as StorageManager).getDirectory()) as unknown as DirHandleLike,
    indexedDB: typeof indexedDB === 'undefined' ? null : (indexedDB as unknown as IdbFactoryLike),
    estimate: async () => (storage ? storage.estimate() : {}),
    digestHex: subtleSha256Hex,
    now: () => Date.now(),
  };
}

/** Choose and open the tier-1 device (§3.10): OPFS, else the IndexedDB fallback. */
export async function openDevice(
  init: Extract<BlkioRequest, { t: 'init' }>,
  env: BlkioEnv,
): Promise<OpenedDevice> {
  const est = await env.estimate().catch(() => ({ quota: 0 }));
  const capBytes = init.capBytes ?? localSwapCap(est.quota ?? 0);
  let fallback: string | undefined;
  if (init.prefer !== 'idb' && env.opfs) {
    try {
      const dev = new OpfsSwapDevice(await env.getDirectory(), {
        capBytes,
        digestHex: env.digestHex,
        now: () => env.now(),
      });
      await dev.init();
      return { device: dev, capBytes };
    } catch (e) {
      fallback = `opfs failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  } else {
    fallback = init.prefer === 'idb' ? 'idb requested' : 'no OPFS sync access handles';
  }
  if (!env.indexedDB) throw new Error('no swap device: neither OPFS nor IndexedDB is available');
  const dev = new IdbSwapDevice(await openIdbSwapStore(env.indexedDB), {
    capBytes,
    digestHex: env.digestHex,
    now: () => env.now(),
  });
  await dev.init();
  return { device: dev, capBytes, fallback };
}

/** Start serving on the worker's own global scope (called at module load inside the worker). */
export function startBlkioWorker(
  scope: BlkioEndpoint<BlkioRequest, BlkioReply>,
  env: BlkioEnv = browserEnv(),
): () => void {
  return serveBlkio(scope, (init) => openDevice(init, env));
}

if (typeof WorkerGlobalScope !== 'undefined' && globalThis instanceof WorkerGlobalScope) {
  // DedicatedWorkerGlobalScope: postMessage(msg, transfer) and onmessage, as BlkioEndpoint expects.
  startBlkioWorker(globalThis as unknown as BlkioEndpoint<BlkioRequest, BlkioReply>);
}
