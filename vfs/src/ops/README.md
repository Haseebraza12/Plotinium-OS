# vfs/src/ops

File operations (open, read, write, unlink, rename, symlink, link, chmod, chown, cp, batch). Bulk operations plan in a pre-emptible phase, then commit in ONE non-pre-emptive transaction.

- **Primary owner:** R2 VFS / Database Engineer
- **Secondary reviewer:** R1 Kernel
- **Spec:** [specs/04-vfs/virtual-file-system.md](../../../specs/04-vfs/virtual-file-system.md)
- **Requirement IDs:** VFS-03, VFS-04, VFS-05, VFS-07, VFS-10, DB-02
