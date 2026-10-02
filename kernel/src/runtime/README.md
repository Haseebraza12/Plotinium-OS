# kernel/src/runtime

The executor runtime that hosts processes on nested worker executors: the slice loop over resumable generators (`init(argv)` then `*run(ctx, state)`), the 32-byte SharedArrayBuffer control block used for pre-emption, global shadowing before app code loads, and `sys.ts`, the port-bound sys client (`@plotinium/kernel/sys`), the only kernel module apps may import.

- **Primary owner:** R1 Kernel / Systems Architect
- **Secondary reviewer:** R5 QA/DevOps
- **Spec:** [specs/03-kernel/processes-and-scheduling.md](../../../specs/03-kernel/processes-and-scheduling.md), [specs/01-architecture/syscall-abi.md](../../../specs/01-architecture/syscall-abi.md)
- **Requirement IDs:** PROC-03, PROC-05, PROC-07, SYS-01, KPS-04, KPS-07

`executor-entry.ts` is the first code of every executor. It captures the control port (a bound
`postMessage` and the `message` listener) BEFORE `sandbox.ts` replaces `postMessage`, `fetch`,
`setTimeout`, `indexedDB`, `Worker` and the other escape hatches with throwing accessors; only then
does it send `hello {abi, digest}`. Program modules come from the injected `ProgramLoaders`
(`manifest.entry` → `() => import(...)`), so no program is evaluated before the sandbox; a `load`
frame's `libs` (the start-up closure, dependencies first) are imported before the program.

`executor.ts` runs one quantum per `dispatch`/`resume` frame and holds the process's data pages for
the pager (`ctx.mem`: an allocation's page ids start at its protocol `segId − 1`).
