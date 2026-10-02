/**
 * VFS-local limits (virtual-file-system.md §3.4, §3.3.4, §3.9, §3.13). Spec limits (NAME_MAX,
 * PATH_MAX, SYMLOOP_MAX) live in path.ts; ABI limits in @plotinium/protocol limits.ts.
 */

/** Per-process fds (EMFILE). */
export const OPEN_MAX = 256;
/** Open-file table entries per device (EMFILE). */
export const OFT_MAX = 4_096;
/** `read` returns at most 1 MiB per call. */
export const READ_MAX_BYTES = 1_048_576;
/** Inodes in one bulk plan (EINVAL, detail `too-large`). */
export const BULK_MAX_NODES = 50_000;
/** Ops in one `batch` (EINVAL). */
export const VFS_BATCH_MAX_OPS = 2_000;
/** Device-local tmpfs limits (EDQUOT, detail `tmpfs-full`). */
export const TMPFS_MAX_BYTES = 64 * 1_048_576;
export const TMPFS_MAX_INODES = 4_096;
/** Read-only scans read at most this many keys per transaction (PVFS-14). */
export const SCAN_CHUNK = 500;
/** Content-addressed chunk size (§3.13.4). */
export const CHUNK_SIZE = 1_048_576;
/** Dirty session bytes kept in memory before staging (§3.9.3). */
export const SESSION_MEM_MAX = 8 * 1_048_576;
/** Intent-lock wait before EBUSY (§3.11). */
export const INTENT_WAIT_MS = 2_000;
/** `readdir` page size: default and maximum (§3.10). */
export const READDIR_DEFAULT = 1_024;
export const READDIR_MAX = 4_096;
/** Event `items` arrays are cut beyond this, with `truncated: true` (§3.18). */
export const EVENT_ITEMS_MAX = 10_000;
/** A client fault arm expires after 10 minutes if unused (§3.20). */
export const FAULT_ARM_TTL_MS = 600_000;
/** SHA-256 of zero bytes: the blob of an empty file (§3.2). */
export const EMPTY_BLOB = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
