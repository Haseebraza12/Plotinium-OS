/**
 * The blkio request loop (specs/03-kernel/memory-and-paging.md §3.10, §4.4): serves the
 * SwapDevice methods over a port, transferring every buffer. The device is chosen once, at the
 * `init` request (POST): OPFS when sync access handles exist, else IndexedDB.
 *
 * Owner: R1 Kernel. Reviewer: R2 VFS/DB.
 */
import type { SwapDevice } from '../core/mm/swap.ts';
import { transferList } from './protocol.ts';
import type { BlkioEndpoint, BlkioReply, BlkioRequest } from './protocol.ts';

export interface OpenedDevice {
  device: SwapDevice;
  capBytes: number;
  /** Why the fallback was used (for bootlog), when it was. */
  fallback?: string;
}

export type DeviceOpener = (init: Extract<BlkioRequest, { t: 'init' }>) => Promise<OpenedDevice>;

/** Serve blkio requests arriving on `port`. Returns a function that stops serving. */
export function serveBlkio(
  port: BlkioEndpoint<BlkioRequest, BlkioReply>,
  open: DeviceOpener,
): () => void {
  let opened: Promise<OpenedDevice> | null = null;
  const reply = (msg: BlkioReply): void => port.postMessage(msg, transferList(msg));
  const device = (): Promise<OpenedDevice> => (opened ??= open({ t: 'init', id: 0 }));

  const handle = async (msg: BlkioRequest): Promise<void> => {
    try {
      if (msg.t === 'init') {
        opened ??= open(msg);
        const o = await opened;
        reply({
          t: 'ready',
          id: msg.id,
          device: o.device.kind,
          capBytes: o.capBytes,
          ...(o.fallback ? { fallback: o.fallback } : {}),
        });
        return;
      }
      const dev = (await device()).device;
      switch (msg.t) {
        case 'write':
          reply({
            t: 'written',
            id: msg.id,
            result: await dev.write(msg.key, msg.gen, msg.header, msg.body, msg.sha256),
          });
          return;
        case 'read': {
          const result = await dev.read(msg.key, msg.gen, msg.sha256, (d, total) =>
            reply({ t: 'progress', id: msg.id, done: d, total }),
          );
          reply({ t: 'readDone', id: msg.id, result });
          return;
        }
        case 'delete':
          await dev.delete(msg.key, msg.gens);
          reply({ t: 'done', id: msg.id, result: null });
          return;
        case 'deleteSession':
          await dev.deleteSession(msg.uid, msg.osSession);
          reply({ t: 'done', id: msg.id, result: null });
          return;
        case 'sweep':
          reply({ t: 'done', id: msg.id, result: await dev.sweep(msg.keep, msg.olderThanMs) });
          return;
        case 'usage':
          reply({ t: 'done', id: msg.id, result: await dev.usage() });
          return;
      }
    } catch (e) {
      reply({
        t: 'error',
        id: msg.id,
        errno: 'EIO',
        msg: e instanceof Error ? e.message : String(e),
      });
    }
  };

  port.onmessage = (ev) => {
    void handle(ev.data);
  };
  return () => {
    port.onmessage = null;
  };
}
