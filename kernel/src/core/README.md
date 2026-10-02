# kernel/src/core

Environment-free kernel logic: `proc/` (PCB, lifecycle, signals, job control), `sched/` (ready heap, round-robin, aging, bands), `mm/` (accounting, pages, reservation-based admission, reclaim from 85%, swap tiers), `ipc/` (dispatcher: ESRCH > ENOSYS > schema EINVAL > capability > rwx > audit > handler), `hooks/` (no-op AI seams) and `klog/`. This folder uses no `self`, `window`, `document`, `Worker` or `indexedDB`, so it runs unchanged under the Node loopback host (ESLint-enforced).

- **Primary owner:** R1 Kernel / Systems Architect
- **Secondary reviewer:** R5 QA/DevOps (`proc`, `sched`, `ipc`); R2 VFS/DB (`mm`)
- **Spec:** [specs/03-kernel/processes-and-scheduling.md](../../../specs/03-kernel/processes-and-scheduling.md), [specs/03-kernel/memory-and-paging.md](../../../specs/03-kernel/memory-and-paging.md), [specs/01-architecture/syscall-abi.md](../../../specs/01-architecture/syscall-abi.md)
- **Requirement IDs:** PROC-01..09, MEM-01..08, SYS-01
