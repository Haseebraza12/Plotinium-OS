# tests/e2e

End-to-end tests (Playwright, channel `chrome`, persistent contexts from `support/os.ts` so IndexedDB, OPFS and the Service Worker survive a reboot) against the Compose stack built with `PLT_TEST_BUILD=1`.

| File                              | Scenario (testing §3.8)                                                                                                                       | Requirement IDs                         |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `boot-to-session-restore.spec.ts` | E1: boot → login `demo` → Terminal file operations → reboot → same session, windows restored                                                  | BOOT-01, SYS-02, WM-06, BOOT-12         |
| `offline-boot.spec.ts`            | E2: `app` and `web` stopped, boot from the Service Worker, queue replays once; E3: `setOffline` variant and isolation after an offline reboot | OFF-01, OFF-02, OFF-04, BOOT-09, MEM-01 |
| `boot-progress.spec.ts`           | E9: cache off, SW bypassed, 400 kbps: progress at 500 ms is lower and moves in real steps                                                     | BOOT-02                                 |
| `boot-menu.spec.ts`               | boot menu by keyboard alone: held Esc, ↑/↓/Enter into Safe mode, Esc to boot normally                                                         | BOOT-06, BOOT-13                        |
| `lock-contention.spec.ts`         | E5: alice holds `/home/shared/plan.md`, bob is read-only; alice's renderer is killed and bob acquires within TTL + 0.5 s                      | VFS-09                                  |

- **Selectors:** only those in [SELECTORS.md](SELECTORS.md); the UI must render them.
- **Gating:** every suite is `fixme` until `PLT_E2E_UI=1`; E2 also needs `PLT_E2E_STACK=1` because it stops containers.
- **How to run:** `PLT_E2E_UI=1 pnpm exec playwright test -c tests/playwright.config.ts --project=e2e` (see [../README.md](../README.md)).
- **Runs:** push to `main`, each release and nightly on the lab runner ([e2e.yml](../../.github/workflows/e2e.yml)).
- **Primary owner:** R5 (harness); scenario owners write their cases. **Reviewer:** R1.

Every test title MUST begin with its requirement ID, for example `DB-02 rm -r with a server fault at node 500 rolls back with zero orphans and unchanged checksum and quota` (C18). `pnpm traceability` builds the requirement-to-test matrix from these titles.
