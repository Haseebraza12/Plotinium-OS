/**
 * The kernel side of blkio: a SwapDevice that forwards every call to the blkio worker
 * (specs/03-kernel/memory-and-paging.md §3.10, §4.4). Buffers are transferred, never copied:
 * `write` detaches the header and body in the kernel and the worker hands the body back.
 * Thread-agnostic (the host passes the Worker or a MessagePort).
 *
 * Owner: R1 Kernel. Reviewer: R2 VFS/DB.
 */
import type {
  ProgressFn,
  SwapDevice,
  SwapDeviceKind,
  SwapKey,
  SwapReadResult,
  SwapWriteResult,
} from '../core/mm/swap.ts';
import { transferList } from './protocol.ts';
import type { BlkioDeviceKind, BlkioEndpoint, BlkioReply, BlkioRequest } from './protocol.ts';

type Pending = {
  resolve: (reply: BlkioReply) => void;
  onProgress?: ProgressFn;
};

/** Distributes Omit over a union (TypeScript's Omit collapses unions). */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export class BlkioClient implements SwapDevice {
  private readonly port: BlkioEndpoint<BlkioReply, BlkioRequest>;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private deviceKind: SwapDeviceKind = 'memory';
  /** LOCAL_SWAP_CAP reported by the worker at init. */
  capBytes = 0;
  /** Set when the IndexedDB fallback is in use (bootlog, swapctl). */
  fallback: string | undefined;

  constructor(port: BlkioEndpoint<BlkioReply, BlkioRequest>) {
    this.port = port;
    port.onmessage = (ev) => this.onReply(ev.data);
  }

  /** Connect and choose the device (POST). */
  static async connect(
    port: BlkioEndpoint<BlkioReply, BlkioRequest>,
    opts: { prefer?: BlkioDeviceKind; capBytes?: number } = {},
  ): Promise<BlkioClient> {
    const c = new BlkioClient(port);
    const r = await c.call({ t: 'init', ...opts });
    if (r.t !== 'ready') throw new Error(r.t === 'error' ? r.msg : 'blkio did not start');
    c.deviceKind = r.device;
    c.capBytes = r.capBytes;
    c.fallback = r.fallback;
    return c;
  }

  get kind(): SwapDeviceKind {
    return this.deviceKind;
  }

  private onReply(msg: BlkioReply): void {
    const p = this.pending.get(msg.id);
    if (!p) return;
    if (msg.t === 'progress') {
      p.onProgress?.(msg.done, msg.total);
      return;
    }
    this.pending.delete(msg.id);
    p.resolve(msg);
  }

  private call(
    req: DistributiveOmit<BlkioRequest, 'id'>,
    onProgress?: ProgressFn,
  ): Promise<BlkioReply> {
    const id = this.nextId++;
    const msg: BlkioRequest = { ...req, id };
    return new Promise((resolve) => {
      this.pending.set(id, onProgress ? { resolve, onProgress } : { resolve });
      this.port.postMessage(msg, transferList(msg));
    });
  }

  async write(
    key: SwapKey,
    gen: number,
    header: ArrayBuffer,
    body: ArrayBuffer,
    sha256: string,
  ): Promise<SwapWriteResult> {
    const r = await this.call({ t: 'write', key, gen, header, body, sha256 });
    if (r.t === 'written') return r.result;
    return { ok: false, errno: 'EIO', body: new ArrayBuffer(0) };
  }

  async read(
    key: SwapKey,
    gen: number,
    sha256: string,
    onProgress?: ProgressFn,
  ): Promise<SwapReadResult> {
    const r = await this.call({ t: 'read', key, gen, sha256 }, onProgress);
    return r.t === 'readDone' ? r.result : { ok: false, errno: 'EIO' };
  }

  async delete(key: SwapKey, gens?: number[]): Promise<void> {
    await this.call(gens === undefined ? { t: 'delete', key } : { t: 'delete', key, gens });
  }

  async deleteSession(uid: number, osSession: string): Promise<void> {
    await this.call({ t: 'deleteSession', uid, osSession });
  }

  async sweep(
    keep: Array<{ uid: number; osSession: string }>,
    olderThanMs: number,
  ): Promise<{ files: number; bytes: number }> {
    const r = await this.call({ t: 'sweep', keep, olderThanMs });
    return r.t === 'done' && r.result ? r.result : { files: 0, bytes: 0 };
  }

  async usage(): Promise<{ bytes: number; files: number }> {
    const r = await this.call({ t: 'usage' });
    return r.t === 'done' && r.result
      ? { bytes: r.result.bytes, files: r.result.files }
      : { bytes: 0, files: 0 };
  }
}
