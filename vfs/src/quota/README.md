# vfs/src/quota

Per-user byte and inode quotas, checked and updated inside the same IndexedDB transaction as the write (EDQUOT, no partial data).

- **Primary owner:** R2 VFS / Database Engineer
- **Secondary reviewer:** R1 Kernel
- **Spec:** [specs/04-vfs/virtual-file-system.md](../../../specs/04-vfs/virtual-file-system.md)
- **Requirement IDs:** VFS-06
