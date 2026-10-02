# db/seed

Deterministic seeds (mulberry32, seed 42): at least 50 users, 10k and 100k inode trees for DB-05, the demo seed run by the container entrypoint, and precomputed vectors so a fresh machine searches 10k chunks without re-embedding. The well-known inode UUIDs come from `@plotinium/protocol` (C5). `VACUUM (ANALYZE)` runs after seeding.

- **Primary owner:** R2 VFS / Database Engineer
- **Secondary reviewer:** R5 QA/DevOps
- **Spec:** [specs/09-database/database.md](../../specs/09-database/database.md)
- **Requirement IDs:** DB-05, VFS-02, RAG-05
