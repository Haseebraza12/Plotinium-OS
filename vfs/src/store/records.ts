/**
 * Store records and the inode/dentry model (virtual-file-system.md §3.2, §4.2).
 *
 * TODO(R2): §4.1 places the shared shapes in protocol/src/vfs.ts; protocol does not export them yet,
 * so they are declared here and move there when the protocol owner adds them.
 */
import type { Base, Errno, VfsOp } from '@plotinium/protocol';

export type Uuid = string;
export type Sha256Hex = string;
export type InodeType = 'f' | 'd' | 'l';
/** `root` is synced; `tmp` is the device-local tmpfs below /tmp (§3.3.4). */
export type FsId = 'root' | 'tmp';

/** Machine-readable VFS reasons carried in `detail` (§4.1). */
export type VfsDetail =
  | 'injected'
  | 'device-full'
  | 'tmpfs-full'
  | 'ro-mount'
  | 'stale-base'
  | 'stale-plan'
  | 'not-mirrored-offline'
  | 'content-not-cached'
  | 'too-large'
  | 'lease'
  | 'intent-timeout'
  | 'well-known'
  | 'synthesised'
  | 'sticky'
  | 'protected-hardlink'
  | 'fencing'
  // syscall-abi.md §4.3.1 / §4.9 reasons the VFS also reports
  | 'storage'
  | 'abort'
  | 'not-a-link';

export interface InodeRec {
  ino: Uuid;
  fs: FsId;
  type: InodeType;
  mode: number;
  uid: number;
  gid: number;
  size: number;
  nlink: number;
  version: number;
  atime: number;
  mtime: number;
  ctime: number;
  btime: number;
  blob: Sha256Hex | null;
  target: string | null;
  /** Directories only, client-only: the entry set is fully mirrored (§3.17.2). */
  mir?: 0 | 1;
}

export interface DentryRec {
  parent: Uuid;
  name: string;
  ino: Uuid;
  dtype: InodeType;
}

export interface BlobRec {
  sha: Sha256Hex;
  size: number;
  /** Chunk hashes in order; `[]` for the empty blob; null when the bytes are not cached here. */
  chunks: Sha256Hex[] | null;
  /** Inode references + pins (undo, outbox, staging). */
  refcount: number;
  uploaded: boolean;
  /** Set only while refcount = 0. */
  zeroSince?: number;
}

export interface ChunkRec {
  sha: Sha256Hex;
  bytes: ArrayBuffer;
  t: number;
}

export interface UserRec {
  uid: number;
  username: string;
  gid: number;
  groups: number[];
  kind: 'user' | 'guest' | 'system';
  quotaBytes: number;
  quotaInodes: number;
  serverUsedBytes: number;
  serverUsedInodes: number;
  /** Server-confirmed values plus the deltas of this device's unacknowledged ops (I6). */
  usedBytes: number;
  usedInodes: number;
  serverAt?: number;
  homeIno?: Uuid;
}

export interface GroupRec {
  gid: number;
  name: string;
  members: number[];
}

export type OpKind =
  | 'create'
  | 'write'
  | 'unlink'
  | 'rename'
  | 'link'
  | 'copy'
  | 'chmod'
  | 'chown'
  | 'utimes'
  | 'batch';

export type OutboxState = 'pending' | 'sent' | 'reverted' | 'parked';

/**
 * Outbox op (§3.14.1). `op` and `base` use the wire shapes of @plotinium/protocol ws/ops.ts, so
 * syncd sends them unchanged inside `op.submit`.
 */
export interface OutboxRec {
  /** autoIncrement key: replay order = commit order. Absent until the store assigns it. */
  seq?: number;
  opId: Uuid;
  cseq: number;
  lamport: number;
  principal: number;
  osSessionId: Uuid;
  call: OpKind;
  op: VfsOp;
  base: Base;
  blobs: Sha256Hex[];
  touches: Uuid[];
  fence?: number;
  awaitSync: boolean;
  state: OutboxState;
  attempts: number;
  lastError?: { errno: Errno; detail?: string };
  createdAt: number;
}

export interface UndoRec {
  opId: Uuid;
  state: 'open' | 'committed';
  pre: { inodes: InodeRec[]; dentries: DentryRec[] };
  created: { inodes: Uuid[]; dentries: [Uuid, string][] };
  users: { uid: number; dBytes: number; dInodes: number }[];
  pins: Sha256Hex[];
  keepAfterAck: boolean;
  summary: string;
  createdAt: number;
}

export interface MetaRec {
  k: string;
  v: unknown;
}

export interface TmpfsUsage {
  bytes: number;
  inodes: number;
}

/** Meta keys used by the VFS (§4.2). */
export type VfsMetaKey =
  | 'schemaVersion'
  | 'deviceId'
  | 'fencingEpoch'
  | 'mkfsDone'
  | 'seedHash'
  | 'cseq'
  | 'lamport'
  | 'tmpfsUsage'
  | 'fsckDirty'
  | 'persistGranted'
  | `resume:${number}`;
