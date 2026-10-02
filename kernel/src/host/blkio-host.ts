/**
 * The blkio host (memory-and-paging.md §3.10, §4.4; the mm agent's "HOST WIRING" notes 1–2): the
 * kernel worker spawns the blkio worker as a nested module worker, connects a `BlkioClient`
 * (tier-1 swap on OPFS, falling back to the IndexedDB `plotinium-swap` store) and builds the
 * tier-2 `HttpRemoteSwap` over the same-origin `/api/swap`.
 *
 * The memory manager is created synchronously at kernel init, but the blkio handshake is
 * asynchronous, so the device handed to the kernel is a `DeferredSwapDevice`: every call waits for
 * the connection, and when blkio cannot start at all (no OPFS and no IndexedDB, a failed worker)
 * it falls back to an in-memory device so paging still works for the session (the fallback is
 * logged, and `swapctl` shows the device kind).
 */
import { BlkioClient } from '../blkio/client.ts';
import { streamGzip, subtleSha256Hex } from '../blkio/compress.ts';
import type { BlkioEndpoint, BlkioReply, BlkioRequest } from '../blkio/protocol.ts';
import { HttpRemoteSwap } from '../core/mm/remote.ts';
import type {
  ProgressFn,
  RemoteSwap,
  SwapDevice,
  SwapDeviceKind,
  SwapKey,
  SwapReadResult,
  SwapWriteResult,
} from '../core/mm/swap.ts';
import { MemorySwapDevice } from '../core/mm/swap.ts';

export type BlkioWorkerFactory = () => Worker;

/** Vite bundles `blkio.worker.ts` as its own ES-module chunk. */
export const defaultBlkioFactory: BlkioWorkerFactory = () =>
  new Worker(new URL('../blkio/blkio.worker.ts', import.meta.url), {
    type: 'module',
    name: 'blkio',
  });

/** A SwapDevice whose calls wait until the real device is connected. */
export class DeferredSwapDevice implements SwapDevice {
  private device: SwapDevice | null = null;
  private readonly ready: Promise<SwapDevice>;
  /** Why the in-memory fallback is in use, or the blkio fallback note (IndexedDB), or null. */
  note: string | null = null;
  capBytes = 0;

  constructor(connect: Promise<SwapDevice>, onFallback?: (why: string) => void) {
    this.ready = connect.then(
      (d) => {
        this.device = d;
        if (d instanceof BlkioClient) {
          this.capBytes = d.capBytes;
          this.note = d.fallback ?? null;
        }
        return d;
      },
      (e: unknown) => {
        const why = e instanceof Error ? e.message : String(e);
        this.note = `blkio unavailable (${why}); swapping to memory`;
        onFallback?.(this.note);
        const mem = new MemorySwapDevice();
        this.device = mem;
        return mem;
      },
    );
  }

  /** Resolves once the device is chosen (the `mm` service awaits it before reporting RUNNING). */
  whenReady(): Promise<SwapDevice> {
    return this.ready;
  }

  get kind(): SwapDeviceKind {
    return this.device?.kind ?? 'memory';
  }

  async write(
    key: SwapKey,
    gen: number,
    header: ArrayBuffer,
    body: ArrayBuffer,
    sha256: string,
  ): Promise<SwapWriteResult> {
    return (await this.ready).write(key, gen, header, body, sha256);
  }

  async read(
    key: SwapKey,
    gen: number,
    sha256: string,
    onProgress?: ProgressFn,
  ): Promise<SwapReadResult> {
    return (await this.ready).read(key, gen, sha256, onProgress);
  }

  async delete(key: SwapKey, gens?: number[]): Promise<void> {
    return (await this.ready).delete(key, gens);
  }

  async deleteSession(uid: number, osSession: string): Promise<void> {
    return (await this.ready).deleteSession(uid, osSession);
  }

  async sweep(
    keep: Array<{ uid: number; osSession: string }>,
    olderThanMs: number,
  ): Promise<{ files: number; bytes: number }> {
    return (await this.ready).sweep(keep, olderThanMs);
  }

  async usage(): Promise<{ bytes: number; files: number }> {
    return (await this.ready).usage();
  }
}

export interface BlkioHost {
  readonly device: DeferredSwapDevice;
  /** Tier 2 (`/api/swap`), or undefined without a same-origin fetch. */
  readonly remote: RemoteSwap | undefined;
  /** Terminate the blkio worker (kernel shutdown). */
  stop(): void;
}

/** Start the blkio worker and the remote tier. Never throws: failures become the memory fallback. */
export function startBlkioHost(opts: {
  readonly factory?: BlkioWorkerFactory | null;
  readonly fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  readonly onFallback?: (why: string) => void;
}): BlkioHost {
  let worker: Worker | null = null;
  let connect: Promise<SwapDevice>;
  try {
    if (opts.factory === null) throw new Error('no blkio worker in this host');
    worker = (opts.factory ?? defaultBlkioFactory)();
    const endpoint = worker as unknown as BlkioEndpoint<BlkioReply, BlkioRequest>;
    connect = BlkioClient.connect(endpoint);
  } catch (e) {
    connect = Promise.reject(e instanceof Error ? e : new Error(String(e)));
  }
  const device = new DeferredSwapDevice(connect, opts.onFallback);
  const f = opts.fetch;
  const remote =
    f === undefined
      ? undefined
      : new HttpRemoteSwap({
          fetch: (u, i) => f(u, i),
          gzip: streamGzip,
          digestHex: subtleSha256Hex,
        });
  return {
    device,
    remote,
    stop: () => {
      worker?.terminate();
      worker = null;
    },
  };
}
