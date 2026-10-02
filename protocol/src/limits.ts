/**
 * Shared numeric limits of the Plotinium ABI and wire protocols.
 *
 * Every value cites its source. "Spec" values come from the capstone specification; "C<n>" values
 * from the canonical decisions (specs/15-decisions/stack-decisions.md); the rest from the named
 * Plotinium spec. Schemas in this package import these constants instead of repeating literals.
 */

/** Spec VFS-08: a name is at most 255 bytes of UTF-8 (after NFC normalisation, PVFS-12). */
export const NAME_MAX = 255;
/** Spec VFS-08: a path is at most 4096 bytes of UTF-8 (after NFC normalisation, PVFS-12). */
export const PATH_MAX = 4096;
/** Spec VFS-03: path resolution follows at most 40 symbolic links; the 41st hop fails with ELOOP. */
export const SYMLOOP_MAX = 40;
/** Spec VFS-08: at least 32 levels of nesting must work (the tested floor). */
export const MIN_NESTING_DEPTH = 32;

/** syscall-abi.md §3.1 rule 3 (ABI-13): binary payloads of 64 KiB or more MUST be transferred. */
export const TRANSFER_THRESHOLD_BYTES = 65_536;
/** syscall-abi.md §3.1 rule 3: worst-case non-binary size of an ordinary call. */
export const CALL_ARGS_MAX_BYTES = 65_536;
/** syscall-abi.md §3.1 rule 3: worst-case non-binary size of a call marked `large`. */
export const LARGE_CALL_ARGS_MAX_BYTES = 1_048_576;
/** syscall-abi.md §3.1 rule 2: request ids are uint32. */
export const REQUEST_ID_MAX = 0xffff_ffff;
/** syscall-abi.md §3.1 rule 5: at most 64 outstanding calls per view port; the 65th gets EAGAIN. */
export const VIEW_PORT_MAX_OUTSTANDING = 64;
/** syscall-abi.md §3.1 rule 4: page sizes of kernel-to-view replies. */
export const READDIR_PAGE_MAX = 1_000;
export const PROC_LIST_PAGE_MAX = 1_024;
export const DMESG_PAGE_MAX = 8_192;

/** syscall-abi.md §4.2 and §4.3 (EMFILE): a process's fd table holds fds 0..1023. */
export const FD_TABLE_SIZE = 1_024;
/** syscall-abi.md §4.2: process ids are 1..32767 (pid 0 means the kernel itself in logs). */
export const PID_MAX = 32_767;
/** syscall-abi.md §4.2: uids and gids are 0..2^31-1. */
export const UID_MAX = 2_147_483_647;
/** syscall-abi.md §4.2: modes are 0..0o7777 (database CHECK 0..4095, C7). */
export const MODE_MAX = 0o7777;
/** syscall-abi.md §4.4.1: scheduling priority 0 (highest) .. 39 (lowest); nice -20..19. */
export const PRIORITY_MIN = 0;
export const PRIORITY_MAX = 39;
export const NICE_MIN = -20;
export const NICE_MAX = 19;
/** syscall-abi.md §4.4.1: `spawn` takes at most 256 argv entries and 60 KiB of argv plus env. */
export const ARGV_MAX = 256;
export const ARGV_ENV_MAX_BYTES = 61_440;

/** syscall-abi.md §4.4.2: `read` and `write` move at most 16 MiB per call. */
export const IO_MAX_BYTES = 16 * 1_048_576;
/** syscall-abi.md §4.4.2: `writeFile` replaces at most 64 MiB. */
export const WRITE_FILE_MAX_BYTES = 64 * 1_048_576;
/** syscall-abi.md §4.4.2: `batch` carries 1..1000 ops; a `write` op carries at most 64 KiB of text. */
export const BATCH_MAX_OPS = 1_000;
export const BATCH_WRITE_TEXT_MAX_BYTES = 65_536;
/** syscall-abi.md §4.4.2 FindArgs: limit 1..10000 (default 1000); maxDepth 0..64. */
export const FIND_LIMIT_MAX = 10_000;
export const FIND_LIMIT_DEFAULT = 1_000;
export const TREE_DEPTH_ARG_MAX = 64;
/** syscall-abi.md §4.4.2: `grep` and `wc` take at most 64 paths; `grep` patterns are ≤ 1024 bytes. */
export const MULTI_PATH_MAX = 64;
export const GREP_PATTERN_MAX_BYTES = 1_024;
/** syscall-abi.md §4.2: a glob is 1..1024 bytes (never a regular expression). */
export const GLOB_MAX_BYTES = 1_024;

/** syscall-abi.md §4.4.3: pipe capacity 4 KiB..1 MiB, default 64 KiB. */
export const PIPE_CAPACITY_MIN = 4_096;
export const PIPE_CAPACITY_MAX = 1_048_576;
export const PIPE_CAPACITY_DEFAULT = 65_536;
/** syscall-abi.md §4.4.3: `tty.input` carries at most 4096 bytes. */
export const TTY_INPUT_MAX_BYTES = 4_096;

/** syscall-abi.md §4.4.4: 32 windows per process (EAGAIN `window-limit`). */
export const WINDOWS_PER_PROCESS_MAX = 32;
/** syscall-abi.md §4.4.4: `notify.post` is limited to 10 per minute per process (EAGAIN `rate`). */
export const NOTIFY_RATE_PER_MINUTE = 10;

/** syscall-abi.md §4.4.9: at most 16 topic patterns per subscription, 256 events per read. */
export const SUBSCRIBE_TOPICS_MAX = 16;
export const EVENTS_READ_MAX = 256;
/** syscall-abi.md §3.8 rule 4: a subscription holds at most 1,024 undelivered events. */
export const SUBSCRIPTION_QUEUE_MAX = 1_024;

/** syscall-abi.md §4.4.10 and agentic-shell.md §3.8: at most 6 planning turns per request. */
export const AGENT_TURNS_MAX = 6;
/** syscall-abi.md §5.4: plan tokens and `batch.grant` expire after 120 s. */
export const PLAN_TOKEN_TTL_MS = 120_000;
/** syscall-abi.md §5.4 rule 2 (C12): confirmation is required above 20 touched inodes. */
export const CONFIRM_INODE_THRESHOLD = 20;

/** processes-and-scheduling.md: the kernel log ring has 8,192 entries (dsa/ringbuffer). */
export const KLOG_SIZE = 8_192;
/** predictive-prefetch.md §3.2: the telemetry ring holds 4,096 events per uid (dsa/ringbuffer). */
export const TELEMETRY_RING_SIZE = 4_096;

/** C3 and syscall-abi.md §4.3: codes 1000..1099 are the Plotinium AI errno range. */
export const AI_ERRNO_MIN = 1_000;
export const AI_ERRNO_MAX = 1_099;
/** syscall-abi.md §4.8: a process ended by signal n exits with status 128 + n. */
export const SIGNAL_EXIT_BASE = 128;
