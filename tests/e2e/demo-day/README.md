# tests/e2e/demo-day — the Demo Day protocol as Playwright scripts

These scripts automate the 30-minute Demo Day protocol of spec §17.1, as it is laid out in [testing-and-performance.md §3.16](../../../specs/13-quality/testing-and-performance.md). They drive the OS the way the examiner will: the documented commands, a real Terminal, the secure prompt, the network cut, two Chrome profiles side by side. They are a **rehearsal tool**. They find what is broken or slow before the live rehearsals of §3.16.1, and they write a rehearsal record (TST-18). They do not replace the live runs, where the examiner types, the team narrates, and one member keeps the stopwatch. The human runbook is [docs/demo/REHEARSAL.md](../../../docs/demo/REHEARSAL.md).

- **Primary owner:** R5 (harness and rehearsals). **Reviewer:** R1. Each item's narrator reviews its script: R4 for items 1–3, R3 for item 4, R1 for item 5 and R2 for items 6–7.
- **Selectors:** only [SELECTORS.md](../SELECTORS.md), plus the proposed test ids below, which have their own gate.
- **Rule (C18):** every test title begins with its requirement ID.

## Scripts

Playwright runs the files in name order. That order is the protocol order, including AIS-11: the hidden semantic query runs before the 2x memory workload.

| File                         | §17.1 segment                 | What it does                                                                                                                                                                                                                                                                                                                                         | Requirement IDs                                                |
| ---------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `00-bringup.spec.ts`         | 0:00–0:05 clean bring-up      | `git clone` → `docker compose up -d --wait` → credentials from `docker compose logs app` → log in as `demo` → `desktop-interactive`, timed against `OPS-05.bringup` (240 s); loopback only; production `/readyz` and `/version.json`                                                                                                                 | OPS-05, OPS-02, PLT-DEL-02                                     |
| `01-boot.spec.ts`            | 0:05–0:08 boot                | cold boot with `?boot=verbose`, the verbose log; `bootlog`, `bootlog --critical-path` checked against the boot record; wait for Offline-ready, cut the network (and, with `PLT_E2E_STACK=1`, stop `app` and `web`), `reboot`; `ls`, `cat`, Files, Editor, Task Manager, Settings offline; reconnect and replay; boot menu → Verbose boot by keyboard | BOOT-05, BOOT-11, BOOT-09, OFF-01, OFF-02, BOOT-06             |
| `02-hidden-ai.spec.ts`       | 0:08–0:18 items 1–3           | `semsearch` as alice (ranked `path:line` citations) and as bob (none of alice's files); `ai "…"`: dry run, kernel `[y/N/e]` prompt, Enter = N with nothing changed, `y` commits one transaction, `ai log`; without a planner, the honest "unavailable, nothing was run"; `predict`, a `prefetch:*` job at PRI 39 seen in `top`, `predict --latency`  | RAG-06, RAG-03, AGT-03, AGT-05, AGT-08, AIS-02, PRE-06, PRE-03 |
| `03-cpu-drag.spec.ts`        | item 4                        | 10 windows, `burn --ms 120000 &` ×3, `top`, `framemeter on`, then every window dragged and resized under a Chrome trace: **trace p95 ≤ `PROC-05.frame` and 0 LoAF > 50 ms from our origin** (the gate method of testing §3.11.3, one run)                                                                                                            | PROC-05, WM-03, WMD-19                                         |
| `04-memory.spec.ts`          | item 5                        | minimise a window, `free` (budget), `memhog --total <2×budget> --procs 8 &`, sample `free` until pages go out: accounted never above the budget, the tab never crashes; `vmstat 1 3` shows page-out; Restoring… and the Task Manager Memory tab (proposed ids)                                                                                       | MEM-01, MEM-06, MEM-07, WM-05                                  |
| `05-fault-rm.spec.ts`        | item 6 (local stack only, C7) | `fsck --checksum`, `quota`, client oracle; `su -c 'debug inject rm N --target server'` through the secure prompt; `rm -r ~/fixtures/tree1000` → `Input/output error (injected fault at node N) — rolled back`, exit 1; checksum, `fsck`, `quota` and the oracle unchanged; `fsck --server` clean                                                     | DB-02                                                          |
| `06-lock-contention.spec.ts` | item 7                        | alice and bob open `/home/shared/plan.md`; bob read-only with "Locked by alice"; `lsof` countdown ≤ TTL; alice's renderer crashed (CDP `Page.crash`); bob acquires within TTL + 0.5 s                                                                                                                                                                | VFS-09                                                         |

Helpers:

| File          | What                                                                                                                                                                                                                                                |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `parse.ts`    | pure parsers for every screen the scripts judge (`bootlog --critical-path`, the verbose log, `free`, `vmstat`, `top`, `fsck`, `quota`, `lsof`, `debug`, `rm`, `semsearch`, `ai`, `predict`, the credentials block, Compose output, `/version.json`) |
| `session.ts`  | log in with the examiner's password, `Shell` (runs `clear`, the command, then `echo "rc=$?"`, and returns output and status), `su` through the secure prompt, `top` watching, renderer crash, the traced drag, the rehearsal recorder               |
| `compose.ts`  | the bring-up plan, Compose calls with the rehearsal's project name, credential resolution                                                                                                                                                           |
| `env.ts`      | switches, `fixme`/skip reasons, the proposed test ids                                                                                                                                                                                               |
| `protocol.ts` | the §17.1 schedule and item order as data, the rehearsal record, the Markdown report                                                                                                                                                                |
| `report.ts`   | `node tests/e2e/demo-day/report.ts` prints the record as Markdown for `docs/evidence/defence/rehearsal-<n>.md`                                                                                                                                      |
| `*.test.ts`   | Vitest (`harness` project): every parser against the spec's own sample output, the schedule, the order, the record, the Compose plan, the switches                                                                                                  |

## Running

```sh
# 0. Unit tests of the parsers and helpers (no stack, no browser)
pnpm exec vitest run --config tests/vitest.config.ts --project harness e2e/demo-day

# 1. The full scripted rehearsal on a clean machine (nothing named "plotinium" in `docker compose ls -a`)
PLT_DEMO_DAY=1 PLT_DEMO_BRINGUP=1 PLT_BRINGUP_REPO=https://github.com/<org>/plotinium.git PLT_BRINGUP_REF=v1.0.0 \
  PLT_E2E_UI=1 PLT_DEMO_REHEARSAL=rehearsal-1 PLT_DEMO_NETWORK="lab LAN" \
  pnpm exec playwright test -c tests/playwright.config.ts --project e2e demo-day

# 2. Segments only, against a stack that is already up and built as a TEST build
PLT_TEST_BUILD=1 docker compose up -d --wait --build
PLT_DEMO_DAY=1 PLT_E2E_UI=1 pnpm exec playwright test -c tests/playwright.config.ts --project e2e demo-day/01 demo-day/02 demo-day/03

# 3. The hidden AI prompts against production, with a planner
PLT_DEMO_DAY=1 PLT_E2E_UI=1 PLT_DEMO_AI=1 PLOTINIUM_BASE_URL=https://<domain> \
  PLT_TEST_ALICE_PASSWORD=… PLT_TEST_BOB_PASSWORD=… PLT_TEST_DEMO_PASSWORD=… \
  pnpm exec playwright test -c tests/playwright.config.ts --project e2e demo-day/02

# 4. The record as Markdown
node tests/e2e/demo-day/report.ts --run rehearsal-1
```

Item 4 runs **headed** by default, because headless Chrome does not produce frames the way the examiner's screen does. On a machine without a display, use `xvfb-run -a pnpm exec playwright test …`, or set `PLT_DEMO_HEADLESS=1` for a smoke run that is never evidence.

**Test build.** Every script except the bring-up reads the Terminal through `window.__plt`. That hook exists only in builds made with `PLT_TEST_BUILD=1`, and the release job fails if a release build contains it. The bring-up needs only test ids and the `desktop-interactive` mark, so it runs against the release build, which is the scored path. A script that finds no hook stops with a message that says so.

## Switches

| Variable                                                        | Effect                                                                                                                                                                           |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PLT_DEMO_DAY=1`                                                | runs the suite. Without it, every test is **skipped**. The suite is long: it reboots, cuts the network and burns CPU and memory, so it is not run on every push.                 |
| `PLT_E2E_UI=1`                                                  | the UI implements SELECTORS.md; until then every UI step is **fixme** (shared with the other e2e suites)                                                                         |
| `PLT_DEMO_BRINGUP=1`                                            | DOCKER gate: lets `00-bringup` run `docker compose up`. Without it, **fixme**.                                                                                                   |
| `PLT_BRINGUP_REPO`, `PLT_BRINGUP_REF`                           | clone source and tag; without them the working tree is used (recorded as "not a clean clone", timing not asserted)                                                               |
| `PLT_BRINGUP_BUILD=1`                                           | adds `--build` (images built locally): a developer smoke, never the scored path                                                                                                  |
| `PLT_BRINGUP_TEARDOWN=1`                                        | `docker compose down -v` of the stack the test created, afterwards. By default the stack is left up for the other scripts.                                                       |
| `PLT_DEMO_PROJECT`                                              | Compose project name (`COMPOSE_PROJECT_NAME`) for the rehearsal stack. Note that `compose.yaml` pins the subnet 172.30.47.0/24, so only one Plotinium project can run at a time. |
| `PLOTINIUM_BASE_URL`, `PLOTINIUM_PORT`                          | system under test (default `http://localhost:4717`)                                                                                                                              |
| `PLT_TEST_<USER>_PASSWORD`                                      | account passwords. On the local stack they are read from `docker compose logs app` when unset. They are never written to a file.                                                 |
| `PLT_E2E_STACK=1`                                               | `01-boot` also stops `app` and `web` for the offline reboot (the local-stack variant of testing §3.16.4 step 5)                                                                  |
| `PLT_DEMO_AI=1`                                                 | a planner answers (production, `LLM_MODE=replay`, or the upstream token of §3.16.5 item 8). Without it the AGT tests are **fixme** and the AIS-02 degradation test runs instead. |
| `PLT_DEMO_QUERY`, `PLT_DEMO_INSTRUCTION`                        | the hidden prompts. The defaults are rehearsal prompts; R4 sets examiner-style ones.                                                                                             |
| `PLT_DEMO_FAULT_NODE`                                           | N for `debug inject` (default 500; the examiner may choose)                                                                                                                      |
| `PLT_DEMO_PROPOSED_TIDS=1`                                      | the proposed test ids below are in SELECTORS.md; until then their steps are **fixme**                                                                                            |
| `PLT_DEMO_HEADLESS=1`                                           | item 4 headless (smoke only)                                                                                                                                                     |
| `PLT_PRODUCTION_URL`, `PLT_EXPECT_VERSION`                      | the T-1 hour production check (`/readyz`, `/version.json`)                                                                                                                       |
| `PLT_DEMO_REHEARSAL`, `PLT_DEMO_NETWORK`, `PLT_DEMO_RECORD_DIR` | label, network and directory of the rehearsal record (default `test-results/demo-day/rehearsal.jsonl`)                                                                           |

## Safety rules the scripts keep

- **They never destroy data they did not create.** `00-bringup` refuses to start if the project already has containers or volumes, and says how to clear them. It removes only the stack it created, and only with `PLT_BRINGUP_TEARDOWN=1`.
- **Fault injection runs only on the local stack.** `05-fault-rm` is skipped for any base URL that is not loopback (C7), and it clears a left-over armed fault in `afterAll`.
- **Credentials stay in memory** (C10). The FIRST-START block is parsed in memory and never logged, recorded or attached. The rehearsal record holds account names only.
- **Waits are on events.** Scripts wait on the `desktop-interactive` mark, `window.__plt.terminal.idle()`, test ids or `expect.poll` on screen text, never on a fixed sleep (testing §3.14).
- **Budgets come from `tests/performance/budgets.json`** (Q-1): `OPS-05.bringup`, `PROC-05.frame`, `PROC-05.loaf`, `MEM-01.default-budget`, `VFS-09.crash-expiry`, `OFF-04.*`.

## Proposed test ids (not yet in SELECTORS.md)

Four checks of §3.16.5 need UI that SELECTORS.md does not cover yet. Their steps are written against these ids, behind `PLT_DEMO_PROPOSED_TIDS=1`:

| `data-testid`                 | Element                                                                                     | Owner          |
| ----------------------------- | ------------------------------------------------------------------------------------------- | -------------- |
| `frame-meter`                 | the WM §3.18 overlay; `data-p95-ms`, `data-loaf-ours`                                       | R3             |
| `task-manager-tab`            | a Task Manager tab (many); `data-tab` ∈ `processes memory predictions services performance` | R3             |
| `task-manager-memory-row`     | a Memory tab row (many); `data-pid`, `data-faults`, `data-bytes-out`                        | R3 / R1        |
| `task-manager-prediction-row` | a Predictions tab row (many); `data-app`, `data-confidence`                                 | R3 / R4        |
| `window-restoring`            | the "Restoring… n / m MB" progressbar in a window (WM §3.12)                                | R3             |
| `files-search`                | the File Explorer semantic search box (RAG-06)                                              | owner of Files |
| `files-search-result`         | a Files search result (many); `data-path`, `data-line-start`                                | owner of Files |

## Known gaps (tracked for R5)

- `edit PATH` opens the Editor, as in `../lock-contention.spec.ts`. The shell spec §3.14 has no `edit` command yet (TODO(R3)).
- `predict --latency` has no fixed output layout in predictive-prefetch §3.9. `parseLaunchLatency` reads the first `… ms` figure on the "hits" and "without" lines. Fix the layout in the spec, then tighten the parser.
- The demo seed does not yet create `~/fixtures/tree1000` or `/home/shared/plan.md` (`server/src/seed/demo.ts`, TODO(R2, W8)). `05` and `06` fail with that message until it does.
- `OPS-` is not a registered prefix, and `TST-` is registered in requirements-traceability §3.13 but missing from `tools/traceability/ids.ts`. `pnpm traceability` warns on both while the spec is Draft.
