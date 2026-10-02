# tests/ — the cross-package test harness

The suites that exercise more than one package: end-to-end, accessibility, performance, fault injection, integration against the Compose database, cross-package properties and the ui gallery's visual regression. Unit tests live next to their code in each package. The normative source is [specs/13-quality/testing-and-performance.md](../specs/13-quality/testing-and-performance.md); CI wiring is in [specs/14-devops/deployment-and-ci.md](../specs/14-devops/deployment-and-ci.md) and [`.github/workflows/e2e.yml`](../.github/workflows/e2e.yml).

- **Primary owner:** R5 QA/DevOps & Integration (harness, fixtures, budgets). Each subsystem owner writes the cases for their subsystem.
- **Secondary reviewer:** R1 Kernel.
- **Rule (C18):** every test title begins with its requirement ID, for example `DB-02 rm -r with a server fault at node 500 rolls back with zero orphans and unchanged checksum and quota`. `pnpm traceability` reads the titles.

## Layout

| Folder                                          | What                                                                                                                                                             | Runner and project                                                    | Needs                                                       |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------- |
| [`e2e/`](e2e/README.md)                         | E1 golden path, E2/E3 offline boot, E5 two-user lock, E9 throttled progress, boot menu by keyboard; the selector contract [`e2e/SELECTORS.md`](e2e/SELECTORS.md) | Playwright `e2e`                                                      | Compose stack built with `PLT_TEST_BUILD=1`; `PLT_E2E_UI=1` |
| [`a11y/`](a11y/README.md)                       | axe on every screen in four theme passes, keyboard-only flows, BOOT-13 announcement rate                                                                         | Playwright `a11y`                                                     | as e2e                                                      |
| [`performance/`](performance/README.md)         | `budgets.json` (every numeric target), `check-budgets`, frame-trace parser and LoAF attribution, boot timing, per-op sampler, calibration, k6 soak skeleton      | Playwright `perf` (lab-spec runner), Vitest `harness` for the parsers | lab-spec runner for gate evidence                           |
| [`fault-injection/`](fault-injection/README.md) | the §3.6.6 matrix at nodes 1/500/999/1000/M and M+1 for every bulk op, server oracle, reference bulk SQL                                                         | Vitest `integration`                                                  | `DATABASE_URL`                                              |
| [`integration/`](integration/README.md)         | template database, schema soundness, DB-03 concurrency torture                                                                                                   | Vitest `integration`                                                  | `DATABASE_URL`                                              |
| [`property/`](property/README.md)               | shared fast-check arbitraries, run profiles, pinned regressions, oracle properties                                                                               | Vitest `property`                                                     | –                                                           |
| [`fixtures/`](fixtures/README.md)               | seeded trees (mulberry32, seed 42), seed users, frozen clock, synthetic Chrome traces                                                                            | –                                                                     | –                                                           |
| [`visual/`](visual/README.md)                   | screenshots of every ui/gallery page in light and dark                                                                                                           | Playwright `visual`                                                   | `PLOTINIUM_GALLERY_URL`                                     |
| `support/`                                      | env switches, persistent-OS launcher, Compose control, CDP throttling, progress recorder, oracle, percentiles, SQL client, template databases, quarantine check  | –                                                                     | –                                                           |
| `quarantine.json`                               | flaky-test quarantine (TST-16: at most 2 entries, 7 days each)                                                                                                   | –                                                                     | –                                                           |

## Commands

```sh
# pure harness tests (helpers, parsers, budgets, fixtures): no stack needed
pnpm exec vitest run --config tests/vitest.config.ts --project harness
pnpm exec vitest run --project property                # also in the root config

# database suites: fault-injection matrix, DB-03 torture, schema
docker compose -f compose.yaml -f compose.test.yaml up -d --wait db
export DATABASE_URL="postgres://plotinium_owner:$(docker compose exec -T db cat /run/plotinium/owner_password)@127.0.0.1:55432/plotinium"
pnpm exec vitest run --config tests/vitest.config.ts --project integration

# browser suites against the stack (Chrome stable: pnpm exec playwright install chrome)
PLT_TEST_BUILD=1 docker compose up -d --wait --build
PLT_E2E_UI=1 pnpm exec playwright test -c tests/playwright.config.ts --project=e2e
PLT_E2E_UI=1 PLT_E2E_STACK=1 pnpm exec playwright test -c tests/playwright.config.ts --project=e2e   # also stops/starts app and web (E2)
PLT_E2E_UI=1 pnpm exec playwright test -c tests/playwright.config.ts --project=a11y

# performance (lab-spec runner only for gate evidence), then the budget gate
PLT_MACHINE_CLASS=lab-spec PLT_E2E_UI=1 pnpm exec playwright test -c tests/playwright.config.ts --project=perf
node tests/performance/check-budgets.ts --results test-results/perf --cadence nightly --machine lab-spec --week 9

# visual regression of the ui gallery
pnpm --filter @plotinium/ui gallery &
PLOTINIUM_GALLERY_URL=http://localhost:4718 pnpm exec playwright test -c tests/playwright.config.ts --project=visual
```

## Environment switches

| Variable                                           | Effect                                                                                                             |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `PLOTINIUM_BASE_URL`, `PLOTINIUM_PORT`             | system under test (default `http://localhost:4717`)                                                                |
| `PLT_E2E_UI=1`                                     | runs the browser suites; without it they report `fixme` (skipped is never verified, T-3)                           |
| `PLT_E2E_STACK=1`                                  | lets E2 stop and start the `app` and `web` containers (TST-12)                                                     |
| `PLT_COMPOSE_FILES`                                | comma-separated compose files for stack control (default `compose.yaml`)                                           |
| `DATABASE_URL`                                     | owner-role URL of the Compose database; without it the database suites skip                                        |
| `PLT_MACHINE_CLASS`                                | `lab-spec`, `lab-matched` or `vps` on those machines; anything else records `hosted` (never gate evidence, TST-06) |
| `PLT_WEEK` or `PLT_SEMESTER_START`                 | semester week for `check-budgets` (`hardFrom` switch)                                                              |
| `PLT_FC_PROFILE=deep`                              | fast-check nightly profile: 10,000 runs, random logged seed (TST-10)                                               |
| `PLT_DB03_MOVES`, `PLT_FAULT_PROP_RUNS`            | DB-03 moves (1,000 on PRs, 20,000 nightly) and random fault-point runs                                             |
| `PLOTINIUM_GALLERY_URL`, `PLOTINIUM_GALLERY_PAGES` | served ui gallery, and an optional page subset                                                                     |

## Rules

- **Determinism (TST-22):** seed 42 (mulberry32) for every generated tree and property on PRs; frozen clock `2026-10-05T10:00:00+05:00` in AI tests; failing nightly seeds go to `property/regressions.json`.
- **No fakes (TST-23):** the database suites use the Compose `db` service; no Testcontainers, no `fake-indexeddb`. Each test file gets its own database cloned from `plotinium_template`.
- **Budgets (TST-04, Q-1):** performance tests read every threshold from `performance/budgets.json`; a lint test rejects numeric threshold literals in `performance/**/*.spec.ts`.
- **Fixes, not retries (§3.14):** wait on OS events (the `desktop-interactive` mark, test hooks), never on sleeps.

## Changes needed outside tests/ (tracked for R5)

The root configs are shared, so the harness runs through its own `tests/vitest.config.ts` and `tests/playwright.config.ts` until the W5 migration folds them in: the root `vitest.config.ts` should gain the `harness` and `integration` projects (spec §3.2), the root `playwright.config.ts` should use the four projects here, `pnpm check-budgets` should point at `tests/performance/check-budgets.ts`, and `pg` should become resolvable from tests/ (today it is loaded from the server package).
