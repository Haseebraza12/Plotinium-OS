# server/src/storage

`FsBlobStore`: content-addressed blobs with a SHA-256 tee and atomic rename, uploaded before the DB transaction; GC after 1 h (never referenced) and 14 days (dereferenced).

- **Primary owner:** R1 Kernel
- **Secondary reviewer:** R2 VFS/DB
- **Spec:** [specs/11-server/backend-api.md](../../../specs/11-server/backend-api.md)
- **Requirement IDs:** MEM-04, DB-02
