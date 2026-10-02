# tests/property

fast-check property suites and the shared arbitraries (testing §3.7; TST-10).

- `arbitraries.ts`: names (NFC, ≤ 255 bytes), bad names with their errno, messy absolute paths, modes, uids, permission questions (VFS-04), model-based VFS programs (VFS-11), fault cases over the §3.6.6 matrix (DB-02), heap workloads (PROC-02), random fixture trees, WebSocket frame fates (OFF-02). They generate values only; no DSA structure is implemented here (C16).
- `profile.ts`: pull requests use seed 42 and 100 runs; `PLT_FC_PROFILE=deep` runs 10,000 with a logged random seed. `regressions.json` pins failing seeds, replayed on every PR by property title.
- `oracle.prop.test.ts`: every generated tree is sound; any planted corruption is detected; the checksum ignores row order (TST-09).
- **How to run:** `pnpm exec vitest run --project property` (root config) or with `--config tests/vitest.config.ts`.
- **Runs:** every pull request; nightly with the deep profile.
- **Primary owner:** R5; property owners per testing §3.7. **Reviewer:** R1.

Every test title MUST begin with its requirement ID, for example `DB-02 rm -r with a server fault at node 500 rolls back with zero orphans and unchanged checksum and quota` (C18). `pnpm traceability` builds the requirement-to-test matrix from these titles.
