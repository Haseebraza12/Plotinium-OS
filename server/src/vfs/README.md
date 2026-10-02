# server/src/vfs

`vfsTxn` under READ COMMITTED with the canonical lock order (L0-L4), set-based bulk operations, retries on 40001/40P01/55P03, and the root-only audited fault-injection harness (FAULT_INJECTION=1, never on production).

- **Primary owner:** R2 VFS/DB
- **Secondary reviewer:** R5 QA/DevOps
- **Spec:** [specs/09-database/database.md](../../../specs/09-database/database.md), [specs/04-vfs/virtual-file-system.md](../../../specs/04-vfs/virtual-file-system.md)
- **Requirement IDs:** DB-02, DB-03, VFS-06
