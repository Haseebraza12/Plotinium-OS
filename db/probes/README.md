# db/probes

Integrity probes run after every fault-injection case: orphaned inodes, parentless dentries, unreachable inodes, nlink, quota drift and blob refcounts. Each must return zero rows.

- **Primary owner:** R2 VFS / Database Engineer
- **Secondary reviewer:** R5 QA/DevOps
- **Spec:** [specs/09-database/database.md](../../specs/09-database/database.md)
- **Requirement IDs:** DB-02, VFS-11
