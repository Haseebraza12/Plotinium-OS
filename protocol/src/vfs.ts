/**
 * VFS core types shared by the kernel and the server (virtual-file-system.md §4.1).
 *
 * §4.1 places its core types in this module. The ones a system call carries (`Stat`,
 * `InodeType`, `Cred`, `Sha256Hex`, `Ino`) already live in sys/common.ts with the call schemas and
 * are re-exported from the package root; this module adds the three that no call schema owns:
 * the filesystem id, the permission subject and the machine-readable VFS error reasons.
 */
import * as v from 'valibot';

import { Gid, InodeType, Mode, Uid } from './sys/common.ts';

/** `root` is synced; `tmp` is the device-local tmpfs mounted at /tmp (PVFS-10). */
export const FS_IDS = ['root', 'tmp'] as const;
export const FsId = v.picklist(FS_IDS);
export type FsId = v.InferOutput<typeof FsId>;

/** What the permission helpers (vfs/perm.ts, isomorphic) read from an inode (VFS-04). */
export const PermSubject = v.strictObject({ type: InodeType, mode: Mode, uid: Uid, gid: Gid });
export type PermSubject = v.InferOutput<typeof PermSubject>;

/**
 * Machine-readable reasons the VFS puts in `SysErr.detail.reason` (§4.1, §6.1). Each is a
 * well-formed `Reason` (errno.ts), so they travel through the envelope unchanged.
 */
export const VFS_DETAILS = [
  'injected',
  'device-full',
  'tmpfs-full',
  'ro-mount',
  'stale-base',
  'stale-plan',
  'not-mirrored-offline',
  'content-not-cached',
  'too-large',
  'lease',
  'intent-timeout',
  'well-known',
  'synthesised',
  'sticky',
  'protected-hardlink',
  'fencing',
] as const;
export const VfsDetail = v.picklist(VFS_DETAILS);
export type VfsDetail = v.InferOutput<typeof VfsDetail>;
