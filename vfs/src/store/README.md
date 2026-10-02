# vfs/src/store

The IndexedDB layer: ONE database `plotinium` per device (stores: inodes, dentries keyed by [parent, name], blobs, blob_chunks, users, groups, outbox, undo, meta, os_sessions, credentials, telemetry, bootlog), client migrations, the synchronous `tx()` builder and `idb` read-only helpers. Durability is `strict` for outbox, credentials and users.

- **Primary owner:** R2 VFS / Database Engineer
- **Secondary reviewer:** R1 Kernel
- **Spec:** [specs/04-vfs/virtual-file-system.md](../../../specs/04-vfs/virtual-file-system.md), [specs/09-database/database.md](../../../specs/09-database/database.md)
- **Requirement IDs:** DB-02, VFS-06, OFF-01

Nothing is awaited inside a transaction builder: `local/no-await-in-idb-builder` fails the lint if it is.
