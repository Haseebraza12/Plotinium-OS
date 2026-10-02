/**
 * @plotinium/protocol: the single source of truth for every message shape in Plotinium (C3).
 *
 * Implements specs/01-architecture/syscall-abi.md (system calls, errnos, capabilities, events,
 * audit, signals, ABI version), specs/06-sync/offline-and-sync.md §4 (WebSocket protocol v1 and the
 * op model), specs/10-ai/agentic-shell.md §3.6 (agent tools), specs/04-vfs/virtual-file-system.md
 * §4.1 and §4.7 (VFS core types, well-known inode ids), specs/07-shell/shell-and-terminal.md §4.5
 * (completion service shapes) and specs/02-boot/boot-and-services.md §4.1 and §4.4 (manifests).
 *
 * Primary owner: R1 Kernel; any change needs R1 + R2 + R4 approval (architecture.md §3.7).
 * Pure module: it imports valibot and nothing else (ESLint-enforced), and runs unchanged in the
 * browser main thread, in workers and on Node. Valibot is the only schema library (C3).
 *
 * Deep imports are available through the package's `./*` export, for example
 * `@plotinium/protocol/sys/fs` or `@plotinium/protocol/ws/frames`.
 */
export const PACKAGE_NAME = '@plotinium/protocol';

export * from './abi.ts';
export * from './apps.ts';
export * from './audit.ts';
export * from './caps.ts';
export * from './complete.ts';
export * from './errno.ts';
export * from './events.ts';
export * from './ids.ts';
export * from './limits.ts';
export * from './services.ts';
export * from './sha256.ts';
export * from './signals.ts';
export * from './vfs.ts';
export * from './wellknown.ts';

export * from './sys/common.ts';
export * from './sys/envelope.ts';
export * from './sys/ev.ts';
export * from './sys/fd.ts';
export * from './sys/fs.ts';
export * from './sys/lock.ts';
export * from './sys/mem.ts';
export * from './sys/mode.ts';
export * from './sys/names.ts';
export * from './sys/net.ts';
export * from './sys/proc.ts';
export * from './sys/registry.ts';
export * from './sys/sys.ts';
export * from './sys/time.ts';
export * from './sys/tty.ts';
export * from './sys/win.ts';

export * from './ai/agent.ts';
export * from './ai/predict.ts';
export * from './ai/rag.ts';
export * from './ai/tools.ts';

export * from './ws/constants.ts';
export * from './ws/frames.ts';
export * from './ws/ops.ts';
