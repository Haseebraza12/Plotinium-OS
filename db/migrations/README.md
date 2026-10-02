# db/migrations

dbmate migrations: one plain-SQL file per change, named `YYYYMMDDHHMMSS_name.sql`, each with `-- migrate:up` and `-- migrate:down`. CI rolls back N times, migrates up again, dumps and diffs `db/schema.sql`. Never edit a merged migration; add a new one.

- **Primary owner:** R2 VFS / Database Engineer
- **Secondary reviewer:** R5 QA/DevOps (runs the round trip)
- **Spec:** [specs/09-database/database.md](../../specs/09-database/database.md)
- **Requirement IDs:** DB-01, DB-04
