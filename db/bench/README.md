# db/bench

The Q1-Q5 benchmark harness with `EXPLAIN (ANALYZE, BUFFERS)` before and after indexing; `perf-indexes.up.sql` and `perf-indexes.down.sql` produce the DB-05 before and after states. Reports go to `bench/reports/`.

- **Primary owner:** R2 VFS / Database Engineer
- **Secondary reviewer:** R5 QA/DevOps
- **Spec:** [specs/09-database/database.md](../../specs/09-database/database.md), [specs/13-quality/testing-and-performance.md](../../specs/13-quality/testing-and-performance.md)
- **Requirement IDs:** DB-05
