# tests/performance

Performance budgets that fail the build (testing §3.11, §4.1, §5.4, §7; TST-04, TST-05, TST-06, TST-19, TST-21). Authoritative numbers come from the lab-spec machine only (`machine: lab-spec`); hosted runs are smoke and never gate evidence.

| File                                                      | Purpose                                                                                                                                                                                        |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `budgets.json`                                            | the single source of every budget: all 180 numeric targets of testing §7.1-§7.3 (compound targets split into suffixed ids such as `VFS-08.limits-name`)                                        |
| `budgets.schema.ts`, `budgets.ts`                         | the §4.1 shape with a validator; `budget(id)` and `miss(budget, value)` for tests (Q-1: no threshold literals in tests)                                                                        |
| `methods.ts`                                              | the measurement methods a budget may name, and whether each runs in Chrome                                                                                                                     |
| `result.ts`, `envelope.ts`                                | the §4.2 result file: machine, Chrome version and channel, commit, build, sample counts (TST-06, TST-13)                                                                                       |
| `check-budgets.ts`                                        | §5.4: exit 0 pass, 1 regression, 2 infrastructure; hard budgets from `hardFrom`, a 10% ratchet before it; writes the job summary                                                               |
| `frame/parse.ts`                                          | §3.11.3 frame metric: vsync-quantised durations from `PipelineReporter`, p95, dropped and partial shares, the raw-interval validity check, LoAF attribution to our origin (blob URLs included) |
| `frame/capture.ts`, `frame/runs.ts`, `frame/drag.spec.ts` | CDP trace capture, the buffered LoAF observer, the WM §8.2 20-second drag script; WM-03 without load and PROC-05 with three `burn` processes, 3 runs, median of the p95s                       |
| `boot/runs.ts`, `boot/boot.spec.ts`                       | BOOT-10 warm, cold and cold-first: 20 runs, p95 of the boot record's `bootMs`, and no large asset before `desktop-interactive`                                                                 |
| `sampler.ts`                                              | the per-op sampler: warm-up discarded, nearest-rank percentiles                                                                                                                                |
| `calibration.ts`, `calibration.json`                      | TST-21: CPU throttle for hosted smoke runs = max(1, t_lab / t_runner); not measured yet (rate 1)                                                                                               |
| `k6/ws-soak.js`, `k6/to-result.ts`                        | skeleton k6 WebSocket and lock soak (`lock_grant_ms` p95 threshold) and its conversion to the VFS-09.lock-grant result                                                                         |

- **How to run:** `PLT_MACHINE_CLASS=lab-spec PLT_E2E_UI=1 pnpm exec playwright test -c tests/playwright.config.ts --project=perf`, then `node tests/performance/check-budgets.ts --results test-results/perf --cadence nightly --machine lab-spec --week <n>`. The parsers and the budget checker are unit-tested in the Vitest `harness` project.
- **hardFrom:** §7.1 rows carry the spec's week; §7.2 and §7.3 rows follow the gate of the owning spec (W7 boot, WM, shell basics; W10-W11 kernel, memory, sync, database, server; W14 AI; W5-W6 CI). R5 and each budget owner confirm them.
- **Runs:** nightly and each release on the lab-spec runner (`perf-lab.yml`); deterministic `pr` budgets on every pull request.
- **Primary owner:** R5 (harness); budget owners per `budgets.json`. **Reviewer:** R1.

Every test title MUST begin with its requirement ID, for example `DB-02 rm -r with a server fault at node 500 rolls back with zero orphans and unchanged checksum and quota` (C18). `pnpm traceability` builds the requirement-to-test matrix from these titles.
