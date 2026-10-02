# server/src/swap

`/api/swap`: tier-2 swap pages keyed by (owner_uid, os_session_id, pid, page_id), write-behind from the client.

- **Primary owner:** R1 Kernel
- **Secondary reviewer:** R2 VFS/DB
- **Spec:** [specs/03-kernel/memory-and-paging.md](../../../specs/03-kernel/memory-and-paging.md), [specs/11-server/backend-api.md](../../../specs/11-server/backend-api.md)
- **Requirement IDs:** MEM-04, MEM-05
