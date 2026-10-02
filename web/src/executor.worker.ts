/**
 * The executor bundle: one nested module worker per executor, spawned by the kernel worker
 * (processes-and-scheduling.md §3.7.1; syscall-abi.md §3.2.3). It carries the executor side of
 * the program registry: `manifest.entry` → lazy loader for the shell, coreutils, the Terminal's
 * extras, the demo programs, the GUI apps' processes and (AI build) the AI processes.
 *
 * `startExecutor` sandboxes the realm before any loader runs, so program code never sees a live
 * platform object (ARC-07). The registry module itself is plain data and closures.
 */
import { AI_PROGRAM_LOADERS } from '@plotinium/ai/programs';
import { programModules } from '@plotinium/apps';
import { startExecutor } from '@plotinium/kernel/runtime/executor-entry';
import type { ProgramLoaders } from '@plotinium/kernel/sys';

declare const __AI__: boolean;

// The executor's code (this module and every static import) has downloaded once this line runs:
// the kernel stops counting network time against `sched`'s start budget here (UI-032). The ABI
// `hello` follows from startExecutor.
(self as unknown as DedicatedWorkerGlobalScope).postMessage({ t: 'booting' });

const loaders: ProgramLoaders = {
  ...programModules({ ai: __AI__ }),
  ...(__AI__ ? AI_PROGRAM_LOADERS : {}),
};

startExecutor({ loaders });
