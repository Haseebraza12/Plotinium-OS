/**
 * The kernel ↔ blkio message protocol (specs/03-kernel/memory-and-paging.md §4.4): one request
 * per SwapDevice method, `{t, id, …}`, with every ArrayBuffer in the transfer list, plus
 * `{t: 'progress', id, done, total}` during reads. Only the kernel talks to blkio (C2).
 *
 * Owner: R1 Kernel. Reviewer: R2 VFS/DB.
 */
import type { SwapKey, SwapReadResult, SwapWriteResult } from '../core/mm/swap.ts';

export type BlkioDeviceKind = 'opfs' | 'idb';

export type BlkioRequest =
  | { t: 'init'; id: number; prefer?: BlkioDeviceKind; capBytes?: number }
  | {
      t: 'write';
      id: number;
      key: SwapKey;
      gen: number;
      header: ArrayBuffer;
      body: ArrayBuffer;
      sha256: string;
    }
  | { t: 'read'; id: number; key: SwapKey; gen: number; sha256: string }
  | { t: 'delete'; id: number; key: SwapKey; gens?: number[] }
  | { t: 'deleteSession'; id: number; uid: number; osSession: string }
  | { t: 'sweep'; id: number; keep: Array<{ uid: number; osSession: string }>; olderThanMs: number }
  | { t: 'usage'; id: number };

export type BlkioReply =
  | {
      t: 'ready';
      id: number;
      device: BlkioDeviceKind | 'memory';
      capBytes: number;
      fallback?: string;
    }
  | { t: 'written'; id: number; result: SwapWriteResult }
  | { t: 'readDone'; id: number; result: SwapReadResult }
  | { t: 'done'; id: number; result: { files: number; bytes: number } | null }
  | { t: 'progress'; id: number; done: number; total: number }
  | { t: 'error'; id: number; errno: 'EIO'; msg: string };

/** The buffers to transfer with a message (ArrayBuffers of 64 KiB or more must be transferred). */
export function transferList(msg: BlkioRequest | BlkioReply): ArrayBuffer[] {
  switch (msg.t) {
    case 'write':
      return [msg.header, msg.body];
    case 'written':
      return [msg.result.body];
    case 'readDone':
      return msg.result.ok ? [msg.result.header, msg.result.body] : [];
    case 'init':
    case 'read':
    case 'delete':
    case 'deleteSession':
    case 'sweep':
    case 'usage':
    case 'ready':
    case 'done':
    case 'progress':
    case 'error':
      return [];
  }
}

/** The side of a MessagePort each end uses; a real MessagePort or Worker satisfies it. */
export interface BlkioEndpoint<In, Out> {
  postMessage(msg: Out, transfer: ArrayBuffer[]): void;
  onmessage: ((ev: { data: In }) => void) | null;
}
