/**
 * kernel/src/core/fs: the kernel side of the virtual file system (virtual-file-system.md;
 * syscall-abi.md §4.4.2).
 *
 * Boot (the `vfs` service):
 *
 *   const { store } = await createFsStore({ indexedDB: host.indexedDB, storage: host.storage });
 *   const fs = new KernelFs({ store, bus: kernel.bus, clock: host.clock, procs: kernel.procs,
 *     identity: host.identity, osSessionId: () => kernel.osSessionId,
 *     log: (level, msg) => kernel.log('vfs', level, msg) });
 *   await fs.mount();                          // fencing epoch, first-boot mkfs, tmpfs, mirrors, /
 *   registerFsSyscalls(kernel.handlers, fs);   // open … batch answer from now on
 */
export { KernelFs, actorOf } from './kfs.ts';
export type {
  FsActor,
  FsClock,
  FsLog,
  FsLogLevel,
  KernelFsDeps,
  MountOptions,
  MountReport,
  MutateOpts,
  Mutated,
  TreeFactory,
} from './kfs.ts';
export { FS_SYSCALLS, registerFsSyscalls } from './syscalls.ts';
export type { FsSyscall, FsSyscallOptions } from './syscalls.ts';
export { FsHandlers } from './handlers.ts';
export { IdbFsStore, createFsStore, openIdbFsStore } from './store.ts';
export type {
  CreateFsStoreOptions,
  CreatedFsStore,
  FsStore,
  FsStoreKind,
  IdbFsStoreOptions,
  StorageEstimateLike,
  StorageManagerLike,
} from './store.ts';
export { MEM_SCHEMA, MemStore } from './mem-store.ts';
export type { MemIndexDef, MemStoreDef, WriteFault } from './mem-store.ts';
export { FsEvents } from './events.ts';
export type { FsBus, PublishMeta, VfsListener } from './events.ts';
export { FileDescriptors } from './fds.ts';
export type { Closed, DescState } from './fds.ts';
export { ContentCache } from './content.ts';
export { fsError, fromVfsError, reasonOf, toKernelError } from './errno.ts';
export {
  FsUserDirectory,
  LOCAL_QUOTA_BYTES,
  LOCAL_QUOTA_INODES,
  provisionLocalUser,
} from './users.ts';
export type { LocalUser } from './users.ts';
