# kernel/src/host

Host bindings: they bind the thread-agnostic kernel core (`kernel/src/core`) to a thread.

- **Primary owner:** R1 Kernel / Systems Architect
- **Secondary reviewer:** R5 QA/DevOps
- **Spec:** [architecture.md](../../../specs/01-architecture/architecture.md), [boot-and-services.md](../../../specs/02-boot/boot-and-services.md), [processes-and-scheduling.md](../../../specs/03-kernel/processes-and-scheduling.md), [memory-and-paging.md](../../../specs/03-kernel/memory-and-paging.md)
- **Requirement IDs:** SYS-01, BOOT-03, BOOT-09, BOOT-12, PROC-01…09, MEM-01…06, KPS-04…08, KPS-13

| File                                      | Contents                                                                                                                                                                                                                   |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `worker.ts`                               | The kernel module worker (`startKernelWorker`): Web Lock `plotinium:kernel`, ONE kernel timer heap on ONE platform timer, the executor transport, the blkio worker and `/api/swap`, the I/O platform, and the router link. |
| `boot-sequence.ts`                        | Boot stages 3–4: `createKernel` (which links the I/O layer), the service manager, router events → the process system and `kernel.io`, and `halt` (BOOT-12: stop the services, then `kernel.halted {restart}`).             |
| `router-protocol.ts`                      | The router port messages, including the I/O layer's LOGIN channel (`login.hello/submit/guest/unlock/logout` in, `login.state/result/session/loggedOut/lock` out).                                                          |
| `main.ts`                                 | The main-thread kernel-link router: progress, the Window-only calls, `desktop-interactive`, the ARC-07 shadows.                                                                                                            |
| `executors.ts`                            | `WorkerExecutorTransport`: one nested module worker per executor, a 32-byte SAB control block when cross-origin isolated, the ABI `hello` check.                                                                           |
| `blkio-host.ts`                           | The blkio worker (OPFS, IndexedDB fallback, in-memory last resort) and the tier-2 remote swap.                                                                                                                             |
| `kernel-timers.ts`                        | `drivePlatformTimer` (KPS-13) and the heap as the services' `KernelTimers`.                                                                                                                                                |
| `services.ts`                             | The kernel-host services (`kernel`, `sched`, `wm`, `desktop`); the system services come from `kernel.io`.                                                                                                                  |
| `inproc-executors.ts`, `proc-loopback.ts` | Node hosts: in-process executors and the whole process system on a virtual clock, for the PROC/MEM/KPS tests in `tests/`.                                                                                                  |
| `loopback.ts`                             | The minimal slice driver the dispatcher tests use.                                                                                                                                                                         |

## Program registry (injected; the kernel never imports apps)

The composing host (web) passes the registry in two halves:

```ts
// kernel worker bundle
import { startKernelWorker } from '@plotinium/kernel/host/worker';
startKernelWorker({
  programs: MANIFESTS, // AppManifestInput[]: the /bin/<name>.json manifests
  executorFactory: (i) =>
    new Worker(new URL('./executor.worker.ts', import.meta.url), {
      type: 'module',
      name: `executor-${i}`,
    }),
  io: { ai, seed, login }, // optional I/O extras; the worker supplies platform, timers, swap, post, halt
});

// executor bundle
import { startExecutor } from '@plotinium/kernel/runtime/executor-entry';
startExecutor({ loaders: LOADERS }); // manifest.entry → () => import(...), imported only after the sandbox
```

`spawn` resolves `/bin/<name>.json` through the catalog, builds the start-up closure with `dsa/dag`
(a cycle is EINVAL `dependency-cycle` with the path), and sends `load {entry, libs}` to the child's
executor, which imports the closure's libs first. Keep the kernel worker's import of the manifests
free of view code (the manifests are data; the views are main-thread modules).

## Verified in a browser

A scratch composition (the apps' manifests in the kernel worker, their loaders in the executor
bundle) was booted in Chrome under `vite` dev and a production build: cross-origin isolated, the real
system services (IndexedDB storage, vfs mkfs, OPFS swap), guest login over the router's LOGIN
channel, `desktop-interactive`, and apps launched from the compositor port creating their windows.
