# tests/fixtures

Deterministic test data (TST-22). No secrets, ever; third-party documents are listed with their licence in `THIRD_PARTY.md`.

- `rng.ts`: mulberry32 (seed 42 by default, as db/seed).
- `trees.ts`: `tree1000` (exactly 1,000 nodes, depth ≥ 6), `flat1000`, `flat500`, `files20`; `contentOf` and `toRows` (oracle rows of a fixture).
- `users.ts`: seed users (root 0, alice 1000, bob 1001, demo 1002, guest 65534) with test-only passwords from `PLT_TEST_*_PASSWORD`; `SHARED_PLAN` for VFS-09.
- `clock.ts`: the frozen clock `2026-10-05T10:00:00+05:00` for AI tests.
- `frame-trace.ts`: synthetic Chrome traces (PipelineReporter slices, both argument names) for the TST-05 parser tests; replaced by a recorded golden trace when a Chrome major changes the shape.
- **Planned (owners):** AGT-40 and INJ-20 fixtures and the RAG corpus (R4), telemetry traces (R4).
- **Primary owner:** R5. **Reviewer:** R1.

Every test title MUST begin with its requirement ID, for example `DB-02 rm -r with a server fault at node 500 rolls back with zero orphans and unchanged checksum and quota` (C18). `pnpm traceability` builds the requirement-to-test matrix from these titles.
