/**
 * kernel/src/blkio: tier-1 swap (OPFS, IndexedDB fallback) and the browser stream helpers
 * (specs/03-kernel/memory-and-paging.md §3.9-§3.11). The kernel host spawns `blkio.worker.ts`
 * and wraps its port in `BlkioClient`; `streamGzip` and `subtleSha256Hex` feed `HttpRemoteSwap`.
 *
 * Owner: R1 Kernel. Reviewer: R2 VFS/DB. Requirement IDs: MEM-03, MEM-04, MEM-05.
 */
export { BlkioClient } from './client.ts';
export { gunzipAll, streamGzip, streamOf, subtleSha256Hex } from './compress.ts';
export {
  IdbSwapDevice,
  openIdbSwapStore,
  SWAP_DB_NAME,
  SWAP_DB_VERSION,
  SWAP_STORE,
} from './idb.ts';
export type {
  IdbFactoryLike,
  SwapRecord,
  SwapRecordKey,
  SwapRecordMeta,
  SwapRecordStore,
} from './idb.ts';
export { OpfsSwapDevice } from './opfs.ts';
export type {
  AsyncDigestHex,
  DirHandleLike,
  FileHandleLike,
  SyncAccessHandleLike,
} from './opfs.ts';
export { transferList } from './protocol.ts';
export type { BlkioDeviceKind, BlkioEndpoint, BlkioReply, BlkioRequest } from './protocol.ts';
export { serveBlkio } from './server.ts';
export type { DeviceOpener, OpenedDevice } from './server.ts';
