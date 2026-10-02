# Requirements traceability (master checklist)

| Field | Value |
|---|---|
| Title | Plotinium requirements traceability: every spec requirement, obligation and deliverable mapped to owner, gate, test and evidence |
| Status | Draft v0.1, 2026-09-24 |
| Primary owner | R5 QA/DevOps & Integration Engineer (runs this checklist before every gate; spec p3 and Appendix A) |
| Secondary reviewer | R1 Kernel / Systems Architect |
| Must be demonstrable at | **Every gate.** G0 Registration (W2): the team rows (§3.11) and the registration rows (§3.7). P1 (W4): the work breakdown with an owner per requirement (§3.7). P2 (W7, v0.2.0), P3 (W11, v0.3.0), P4 (W14, v0.4.0): the per-gate lists in §3.4. FRZ (W16, v1.0.0-rc.N) and P5 (W17–18, v1.0.0): every row, and every Appendix A line live on the reference machine (§3.8). |
| Requirement IDs covered | All 84 numbered spec IDs: BOOT-01..14, PROC-01..09, MEM-01..08, VFS-01..11, WM-01..07, OFF-01..05, SYS-01..03, DB-01..05, RAG-01..06, AGT-01..10, PRE-01..06. Unnumbered obligations of §3.2, §3.4, §4.1–§4.4, §5, §10, §12.5–§12.6, §13.1, §14.1, §15.1–§15.4, §17.1–§17.2, §18 and Appendix A. Plotinium design IDs TRC-01..08, PLT-TEAM-01..14, PLT-DOC-01..14, PLT-DEL-01..16; the §10 and §12.6 obligations are traced under the IDs of [data-structures](../08-dsa/data-structures.md) (DSA-*) and [ai-safety-and-evaluation](../10-ai/ai-safety-and-evaluation.md) (AIS-*, AIN-*); registry of all Plotinium ID prefixes (§3.13). |
| Related specs | [Spec index](../README.md) · [Identity and branding](./identity-and-branding.md) · [Glossary](./glossary.md) · [Architecture](../01-architecture/architecture.md) · [System-call ABI](../01-architecture/syscall-abi.md) · [Boot and services](../02-boot/boot-and-services.md) · [Processes and scheduling](../03-kernel/processes-and-scheduling.md) · [Memory and paging](../03-kernel/memory-and-paging.md) · [Virtual file system](../04-vfs/virtual-file-system.md) · [Window manager](../05-wm/window-manager.md) · [UI design system](../05-wm/ui-design-system.md) · [Offline and sync](../06-sync/offline-and-sync.md) · [Shell and terminal](../07-shell/shell-and-terminal.md) · [Data structures](../08-dsa/data-structures.md) · [Database](../09-database/database.md) · [RAG semantic search](../10-ai/rag-semantic-search.md) · [Agentic shell](../10-ai/agentic-shell.md) · [Predictive pre-fetch](../10-ai/predictive-prefetch.md) · [AI safety and evaluation](../10-ai/ai-safety-and-evaluation.md) · [Backend API](../11-server/backend-api.md) · [Security model](../12-security/security-model.md) · [Testing and performance](../13-quality/testing-and-performance.md) · [Deployment and CI](../14-devops/deployment-and-ci.md) · [Stack decisions](../15-decisions/stack-decisions.md) · [Implementation plan](../16-delivery/implementation-plan.md) · [Backlog](../16-delivery/backlog.md) · [Sprint 01](../16-delivery/sprint-01.md) |

---

## 1. Purpose and scope

This is the **master checklist**. Every requirement in the capstone specification (v1.0, September 2026) appears here once, with:

- its keyword (Must, Should, May) and a one-line summary;
- the spec section and page;
- the Plotinium spec file and section that designs it;
- the owner role, the secondary reviewer, and the gate at which it is first demonstrable;
- the planned test titles, in the canonical `ID …` form (C18);
- the evidence artefact that proves it at the gate.

It also covers the obligations the spec states without a numbered ID: the mandatory data structures (§10.1), the required documents (§15.2), the phase deliverables (§13.1), every Appendix A line, the final deliverables (§17.2), the AI-native properties per subsystem (§3.2), the AI trust boundary (§3.4) and the team contract (§4.4).

**How it is used.**
- `docs/requirements.csv` is generated from §3.3 and seeds one issue per ID with its owner and gate milestone ([backlog.md](../16-delivery/backlog.md)).
- `tools/traceability.ts` joins this file with the test titles found in the test suites and with the evidence files, and prints the matrix into the report and into each gate's evidence folder.
- R5 runs the per-gate list (§3.4) and Appendix A (§3.8) 3 days before every gate (the dry run) and again on the gate tag.

Out of scope: the design of each requirement (it lives in the linked spec) and the performance-measurement method (it lives in [testing-and-performance.md](../13-quality/testing-and-performance.md)).

**Status of links.** Section numbers are given exactly for specs that already exist ([architecture.md](../01-architecture/architecture.md), [rag-semantic-search.md](../10-ai/rag-semantic-search.md), [identity-and-branding.md](./identity-and-branding.md)). For specs being written in parallel, the entry names the standard section (every spec has §3 Design, §5 Algorithms, §6 Errors, §7 Budgets, §8 Test plan) and the topic; it is made exact when that spec is accepted (TRC-07).

## 2. Requirements table

| ID | Summary | Spec § | How verified |
|---|---|---|---|
| TRC-01 | Plotinium design. Every one of the 84 numbered spec IDs appears exactly once in §3.3, with keyword, summary, spec § and page, our spec, owner and reviewer, gate, at least one test title and an evidence artefact. | p3 (identifiers), all requirement tables | `TRC-01` docs-lint test against the ID list in §4.1 |
| TRC-02 | Spec: MUST (p3). Every test that verifies a requirement has a title beginning with its ID. Plotinium design: the ID is a spec ID or a registered Plotinium prefix (§3.13). | p3 Conventions; C18 | `tools/traceability.ts` fails on an unknown ID or prefix in a test title |
| TRC-03 | Plotinium design. Every Must ID due at a gate has at least one test title that ran and passed on that gate's tag, or, for a live-only check, a committed gate evidence file. A test skipped by `describe.runIf(IMPLEMENTED)` counts as not passed. | §13.2 ("live demonstration on the tagged release") | Gate check job on the tag (§5.2) |
| TRC-04 | Spec: MUST (p51). Appendix A is run before every gate; every line is verified live at the final defence on the reference machine. | App. A | Signed checklist `docs/evidence/gates/<gate>/appendix-a.md` (§3.8) |
| TRC-05 | Plotinium design. Every requirement has exactly one primary owner role and one different secondary reviewer role, matching `.github/CODEOWNERS` for the paths that implement it. | §4.2 | `TRC-05` lint comparing §3.3 with CODEOWNERS |
| TRC-06 | Plotinium design. Every evidence path follows §4.3 and exists in the repository or in the release assets of the gate tag by the gate. | §13.2, §17.2 | Gate check job |
| TRC-07 | Plotinium design. When a linked spec is accepted, its exact section numbers replace the topic references in §3.3 within one week. | — | Review rule; `spec-lint` warns on `§3 (topic)` references to Accepted specs |
| TRC-08 | Plotinium design. A spec amendment (numbered written amendment on Google Classroom, p2) is applied to this file within 2 working days, with the amendment number noted in the changed rows. | p2 | Review rule; amendment log in §9 |

## 3. Design (normative)

### 3.1 How to read the matrix

**Keyword.** `Must` is mandatory for passing a gate and for full marks; `Should` is expected unless we justify a different choice in writing; `May` is optional and earns credit when done well (spec p3, RFC 2119).

**Roles** (C15). R1 Kernel / Systems Architect · R2 VFS / Database Engineer · R3 Window Manager / UI Lead · R4 AI Pipeline Specialist · R5 QA / DevOps & Integration Engineer. `R2 / R5` means primary owner R2, secondary reviewer R5.

**Gates.** The gate named is the first one at which the requirement is demonstrated live on a tagged release. "preview P2" means an earlier partial demonstration that is not yet the commitment.

| Code | Gate | Week (indicative) | Tag |
|---|---|---|---|
| G0 | Team and OS name registration | W2 | none (CI runs on a PR) |
| P1 | Phase 1 · architecture and defence | W4 | none |
| P2 | Phase 2 · VFS and window manager | W7 | `v0.2.0` |
| P3 | Phase 3 · scheduler and persistence (spans the W8 mid-term) | W11 | `v0.3.0` |
| P4 | Phase 4 · foundational AI layer | W14 | `v0.4.0` |
| FRZ | Hardening and feature freeze | W16 | `v1.0.0-rc.N` |
| P5 | Phase 5 · final defence and codebase | W17–18 | `v1.0.0` |

Weeks are indicative; exact dates are announced on Google Classroom (spec §13).

**Test level tags** after each title: `[U]` Vitest unit (Node, loopback kernel) · `[B]` Vitest browser (real Chrome) · `[I]` Vitest integration (compose PostgreSQL) · `[E]` Playwright end-to-end on Chrome stable · `[P]` performance or benchmark (authoritative on the lab-spec machine) · `[A]` ai-eval (recorded model responses) · `[L]` lint, static or build check · `[M]` manual gate check with a committed evidence file. Levels are defined in [testing-and-performance.md](../13-quality/testing-and-performance.md).

**Where the titles come from.** A title in §3.3, §3.12 and §3.14 is copied verbatim from the owning spec's test plan whenever that spec defines it. The owning spec's §8 stays authoritative for the complete list (together the specs define several hundred titles; this matrix lists representative ones per requirement). A title marked "(proposed)" is not yet in an owning spec, usually because that spec is still being written (the test plans of 09-database and 12-security at this revision); its owner adopts it or replaces it with a title carrying the same ID (§9.2). The level tag follows the owning spec's test project.

**Evidence codes** (paths are normative in §4.3):
- `CI:<project>` — the JUnit report of that test project from the CI run on the gate tag, attached to the GitHub Release. Projects are those of [testing-and-performance](../13-quality/testing-and-performance.md) (TST-02): Vitest `unit`, `browser`, `integration`, `bench`, `ai-eval`, `tools`; Playwright `e2e`, `a11y`, `perf`, `bringup`; plus the `lint` job.
- `PERF:<ID>` — `docs/evidence/perf/<ID>/<YYYY-MM-DD>-lab.json`, measured on the lab-spec machine with the Chrome version and `hardwareConcurrency` recorded.
- `GATE:<gate>/<ID>` — `docs/evidence/gates/<gate>/<ID>.<ext>`: screenshot, screen recording, terminal transcript or Chrome trace captured at the gate rehearsal and at the gate.
- `REPORT:<name>` — `docs/evidence/reports/<name>.md`: evaluation, benchmark, accessibility or restore-drill report.
- `DOC:<FILE>#<section>` — a section of a root document (README.md, ARCHITECTURE.md, …).

### 3.2 Totals

| Prefix | Spec section | IDs | Must | Should | May |
|---|---|---|---|---|---|
| BOOT | §6.5 (p18–19) | 14 | 13 | 1 (BOOT-14) | 0 |
| PROC | §9.1 (p25–26) | 9 | 8 | 1 (PROC-09) | 0 |
| MEM | §9.2 (p27) | 8 | 7 | 0 | 1 (MEM-08) |
| VFS | §9.3 (p29–30) | 11 | 10 | 1 (VFS-11) | 0 |
| WM | §9.4 (p30–31) | 7 | 6 | 1 (WM-07) | 0 |
| OFF | §9.5 (p31) | 5 | 4 | 1 (OFF-05) | 0 |
| SYS | §9.6 (p32) | 3 | 3 | 0 | 0 |
| DB | §11.5 (p37) | 5 | 5 | 0 | 0 |
| RAG | §12.2 (p38–39) | 6 | 6 | 0 | 0 |
| AGT | §12.3 (p39–40) | 10 | 9 | 0 | 1 (AGT-10) |
| PRE | §12.4 (p40–41) | 6 | 6 | 0 | 0 |
| **Total** | | **84** | **77** | **5** | **2** |

Plotinium builds all three AI subsystems (C12), so every RAG, AGT and PRE Must is in scope, although §12 requires only two. Both May items are planned stretch goals with a pre-agreed decision point (§3.3 rows MEM-08 and AGT-10).

### 3.3 Master matrix

#### 3.3.1 BOOT — boot screen and sequence (spec §6.5)

| ID | Kw | Requirement (summary) | Spec § · p | Our spec | Owner / rev. | Gate | Planned test titles | Evidence |
|---|---|---|---|---|---|---|---|---|
| BOOT-01 | Must | Boot screen shows the registered OS name, logo and version. | §6.5 · p18 | [02-boot](../02-boot/boot-and-services.md) §3 (boot screen); [identity §3.10](./identity-and-branding.md) | R3 / R5 | P2 | `BOOT-01 built index.html paints the logo, the name Plotinium and version and build before any script runs` [E] · `BOOT-01 boot screen shows name, logo SVG, version and build that equal version.json and uname` [E] | GATE:p2/BOOT-01; CI:e2e |
| BOOT-02 | Must | Progress is computed from real work finishing (weighted DAG nodes and asset loading); no timer-driven progress anywhere in the boot path. | §6.5 · p19 | 02-boot §3 (progress model) | R5 / R3 | P2 (assets and kernel init), P3 (DAG weights) | `BOOT-02 with cache disabled and SW bypassed at 400 kbps, P at 500 ms is lower than on the unthrottled run and the kernel download produces at least 5 distinct P values` [E] · `BOOT-02 static check finds no timer, keyframes or animation in the boot path except the two allowlisted sites` [L] · `BOOT-02 progress never changes without an event: 60 s of fake time with no events leaves P unchanged` [U] | GATE:p2/BOOT-02 (throttled reload with "Bypass for network" and "Disable cache"); CI:e2e; CI:lint; CI:unit |
| BOOT-03 | Must | Services start in the topological order of the service DAG; independent services start concurrently. | §6.5 · p19 | 02-boot §3 (service manager); [08-dsa](../08-dsa/data-structures.md) §3 (DAG) | R5 / R3 | P3 (preview P2) | `BOOT-03 in the boot record every service starts after all its requirements have ended` [B] · `BOOT-03 sched, storage and wm run with overlapping intervals` [E] | GATE:p3/BOOT-03 (bootlog transcript); CI:browser; CI:e2e |
| BOOT-04 | Must | A dependency cycle halts boot with a kernel-panic screen that names the cycle. | §6.5 · p19 | 02-boot §3, §6 | R5 / R3 | P3 | `BOOT-04 svcctl require auth lockd then reboot shows the panic naming auth → sync → lockd → auth` [E] · `BOOT-04 cycle path is canonical: rotated to the smallest name and every arrow is a real requires edge` [U] | GATE:p3/BOOT-04; CI:e2e; CI:unit |
| BOOT-05 | Must | A verbose mode, toggled by a key, shows a timestamped kernel-style boot log. | §6.5 · p19 | 02-boot §3 (verbose log) | R5 / R3 | P3 | `BOOT-05 pressing V during boot shows timestamped lines for firmware, loader, kernel, svc and every service` [E] · `BOOT-05 verbose lines carry WARN and DEGRADED text prefixes, not colour alone` [E] | GATE:p3/BOOT-05; CI:e2e |
| BOOT-06 | Must | Boot menu offers Normal, Safe mode (no AI services, no autostart apps, default theme) and Recovery (file-system check, clear local cache, reset session). | §6.5 · p19 | 02-boot §3 (boot menu, modes) | R3 / R5 | P3 | `BOOT-06 holding Esc from navigation opens the boot menu with Normal, Safe, Recovery and Verbose` [E] · `BOOT-06 safe mode starts no ai service, autostarts no app and uses the default theme` [E] · `BOOT-06 recovery console runs fsck, clear local cache, reset session and restore default manifests` [E] | GATE:p3/BOOT-06; CI:e2e |
| BOOT-07 | Must | If a non-critical service fails or times out, boot continues; the desktop shows which services are degraded; failed services are retried with back-off. | §6.5 · p19 | 02-boot §3 (degraded state); [06-sync](../06-sync/offline-and-sync.md) (OFF-04 badge) | R5 / R3 | P3 | `BOOT-07 with /api blocked the desktop becomes interactive and shows auth, sync and lockd degraded` [E] · `BOOT-07 a rejected non-critical start retries at 0.25–0.5, 0.5–1 and 1–2 s and resets after success` [U] | GATE:p3/BOOT-07; CI:e2e; CI:unit |
| BOOT-08 | Must | If a critical service fails, a recovery screen offers retry, safe mode and diagnostic details; never a blank page or an endless spinner. | §6.5 · p19 | 02-boot §6 | R5 / R3 | P3 | `BOOT-08 corrupted meta.schemaVersion shows the recovery screen with retry, safe mode and diagnostics` [E] · `BOOT-08 a stalled kernel bundle shows the stall screen after 15 s, never a blank page` [E] | GATE:p3/BOOT-08; CI:e2e |
| BOOT-09 | Must | With the network disabled, the system boots to a usable desktop from cached assets and local state. | §6.5 · p19 | 02-boot §3; 06-sync §3 (offline shell); [architecture §5.3](../01-architecture/architecture.md) | R5 / R2 | P3 | `BOOT-09 with the server stopped and the browser offline, reload reaches a usable desktop` [E] · `ARC-08 boot reaches desktop-interactive with the server killed and with the network blocked` [E] | GATE:p3/BOOT-09; CI:e2e |
| BOOT-10 | Must | Warm boot ≤ 1.5 s and cold boot ≤ 3.0 s to an interactive desktop; large assets such as model weights load only after the desktop is interactive. | §6.5 · p19 | 02-boot §7; [13-quality](../13-quality/testing-and-performance.md) §7 | R5 / R3 | P3 (CI budget tracked from W5, enforced from W7) | `BOOT-10 warm boot p95 over 20 runs is at most 1.5 s on the lab runner` [P] · `BOOT-10 cold boot p95 over 20 runs is at most 3.0 s on the lab runner` [P] · `BOOT-10 boot-critical main-thread JS is at most 60 KB gzip` [L] · `BOOT-10 no model, ort, transformers, xterm, CodeMirror or app view request starts before desktop-interactive` [E] | PERF:BOOT-10; CI:lint; CI:e2e |
| BOOT-11 | Must | Per-stage and per-service timings are saved; `bootlog` prints them and `bootlog --critical-path` shows the chain of services that determined the boot time. | §6.5 · p19 | 02-boot §3 (bootlog), §5 (critical path) | R5 / R1 | P3 | `BOOT-11 bootlog prints per-stage and per-service timings for the current boot` [E] · `BOOT-11 critical path ends at desktop, follows real edges, and its durations sum to the boot time within 5 ms` [U] | GATE:p3/BOOT-11; CI:e2e; CI:unit |
| BOOT-12 | Must | Graceful shutdown and restart: dirty pages and pending writes are flushed, services stop in reverse topological order, the session is saved; restarting returns to the same session. | §6.5 · p19 | 02-boot §3 (shutdown); [03-kernel/memory](../03-kernel/memory-and-paging.md) §3 | R5 / R1 | P3 | `BOOT-12 shutdown -r now restores window geometry, z-order, state and byte-identical process state` [E] · `BOOT-12 services stop in reverse topological order` [B] · `BOOT-12 a queued offline op survives reboot and replays exactly once` [E] | GATE:p3/BOOT-12; CI:e2e; CI:browser |
| BOOT-13 | Must | The boot screen is accessible: respects `prefers-reduced-motion`, exposes `role="progressbar"` with live values, announces status changes to screen readers; the boot menu works from the keyboard alone. | §6.5 · p19 | 02-boot §3; [05-wm/ui-design-system](../05-wm/ui-design-system.md) §3 (accessibility) | R3 / R5 | P2 (boot screen), P3 (boot menu) | `BOOT-13 progressbar exposes aria-valuenow equal to round(100·P) and aria-valuetext with the current service` [E] · `BOOT-13 with reduced motion the bar has a 0 s transition` [E] · `BOOT-13 boot menu, panic and recovery screens are fully operable with the keyboard alone` [E] | REPORT:a11y-audit-p2, REPORT:a11y-audit-p3; CI:e2e |
| BOOT-14 | Should | The login screen supports several users and includes a guest or demo account for examiners. | §6.5 · p19 | 02-boot §3 (login); [12-security](../12-security/security-model.md) §3 (accounts) | R3 / R5 | P2 | `BOOT-14 login screen lists several users plus Guest and Demo tiles and each can sign in` [E] | GATE:p2/BOOT-14; CI:e2e |

#### 3.3.2 PROC — processes and scheduling (spec §9.1)

| ID | Kw | Requirement (summary) | Spec § · p | Our spec | Owner / rev. | Gate | Planned test titles | Evidence |
|---|---|---|---|---|---|---|---|---|
| PROC-01 | Must | The process table is a hash map keyed by PID with O(1) average lookup, insert and delete. | §9.1 · p25 | [03-kernel/processes](../03-kernel/processes-and-scheduling.md) §3 (process table); 08-dsa §3 (hash table) | R1 / R5 | P3 (preview P2) | `PROC-01 PidTable matches Map under 200,000 random get, set and delete operations (fast-check)` [U] · `PROC-01 bench: PidTable get, set and delete stay flat from 10^3 to 10^5 entries and report ns/op and bytes/entry` [P] | PERF:PROC-01; DOC:DSA.md#hash-table; CI:unit |
| PROC-02 | Must | The ready queue is our own binary heap: O(log n) push and pop, O(log n) priority change through an index map. | §9.1 · p25 | 03-kernel/processes §3 (scheduler); 08-dsa §3 (heap) | R1 / R5 | P3 | `PROC-02 ready heap pops in (effPrio, seq) order against a sorted-array model (fast-check)` [U] · `PROC-02 bench: push, pop and changeKey grow logarithmically from 10^3 to 10^5` [P] | PERF:PROC-02; CI:unit |
| PROC-03 | Must | Round-robin among equal priorities with a configurable quantum. | §9.1 · p25 | 03-kernel/processes §3 | R1 / R5 | P3 | `PROC-03 three equal-priority burn jobs run in round-robin order in the klog trace` [B] · `PROC-03 setting the normal quantum to 4 ms changes observed slice lengths to at most 4 ms plus delta` [B] | GATE:p3/PROC-03; CI:browser |
| PROC-04 | Must | Aging guarantees that no runnable process waits longer than a declared bound, whatever its priority. | §9.1 · p25 | 03-kernel/processes §5 (aging bound and proof) | R1 / R5 | P3 | `PROC-04 starvation: 50 priority-0 CPU jobs and 1 priority-39 job, the maximum wait is at most the declared 5450 ms` [P] · `PROC-04 sched bound prints the same value that the starvation test asserts` [U] | PERF:PROC-04; GATE:p3/PROC-04; DOC:ARCHITECTURE.md (proof summary); CI:unit |
| PROC-05 | Must | All long-running work runs on Web Workers; with a CPU-bound workload and 10 windows open, p95 frame time ≤ 16.7 ms and no long task over 50 ms comes from OS code. | §9.1 · p25 | 03-kernel/processes §7; [architecture §3.6](../01-architecture/architecture.md); 13-quality §3 (frame method) | R1 / R3 | P3 | `PROC-05 p95 frame duration is at most 16.7 ms with three burn processes and 10 windows, with 0 LoAF over 50 ms from our scripts` [P] · `PROC-05 with hardwareConcurrency forced to 4 at most RUN_TOKENS slices run at once and isolation keys never share an executor` [B] | PERF:PROC-05 (Chrome trace and LoAF); GATE:p3/PROC-05; CI:browser |
| PROC-06 | Must | The process lifecycle follows Figure 9.1, and every state transition is logged. | §9.1 · p25 | 03-kernel/processes §5 (state machine) | R1 / R5 | P3 | `PROC-06 every transition of a scripted workload appears in the klog trace with from, to and reason` [B] · `PROC-06 observed transitions are exactly the edges of Figure 9.1 plus the documented additions (random workload)` [U] | GATE:p3/PROC-06 (dmesg transcript); CI:browser; CI:unit |
| PROC-07 | Must | `kill` terminates the process, frees its worker, closes its file descriptors and releases its locks; its children are re-parented to `init`. | §9.1 · p25 | 03-kernel/processes §3; 06-sync §3 (lease release) | R1 / R2 | P3 | `PROC-07 kill -9 frees the executor slot, closes fds, releases leases, re-parents children to pid 1 and closes windows` [I] | CI:integration |
| PROC-08 | Must | `ps`, `top`, `kill`, `nice`, `renice`, `jobs`, `bg`, `fg` and a trailing `&` work; a graphical Task Manager shows state, CPU share and memory. | §9.1 · p25 | [07-shell](../07-shell/shell-and-terminal.md) §3 (commands); [05-wm/window-manager](../05-wm/window-manager.md) §3 (Task Manager view) | R1 / R3 | P3 | `PROC-08 scripted session: ps, ps -ef, top -b -n 1, kill, kill -l, nice, renice, jobs, bg, fg and & match the golden output` [E] · `PROC-08 Task Manager rows show the same state, CPU share and memory as ps within one refresh` [E] | GATE:p3/PROC-08; CI:e2e |
| PROC-09 | Should | The process table holds at least 256 concurrent processes (most of them sleeping) without degrading the interface. | §9.1 · p26 | 03-kernel/processes §7 | R1 / R5 | P3 | `PROC-09 256 sleeping processes plus 10 windows keep frame p95 at most 16.7 ms, syscall p95 at most 1 ms and ps -e at most 100 ms` [P] | PERF:PROC-09 |

#### 3.3.3 MEM — virtual memory and paging (spec §9.2)

| ID | Kw | Requirement (summary) | Spec § · p | Our spec | Owner / rev. | Gate | Planned test titles | Evidence |
|---|---|---|---|---|---|---|---|---|
| MEM-01 | Must | A configurable global memory budget (default 256 MB, measured by our accounting model) and a soft limit for each process. | §9.2 · p27 | [03-kernel/memory](../03-kernel/memory-and-paging.md) §3 (accounting model) | R1 / R2 | P3 | `MEM-01 free reports the configured budget, and changing mm.budget in Settings takes effect without a reboot` [B] · `MEM-01 a process over its soft limit is flagged in ps and top and its pages move to the COLD segment` [U] · `MEM-01 calibration: model error against measureUserAgentSpecificMemory is under 25% in every scenario including the hold-out (ForceEagerMeasureMemory)` [P] | REPORT:mem-calibration; GATE:p3/MEM-01; CI:browser; CI:unit |
| MEM-02 | Must | LRU eviction with our own hash map and doubly linked list, O(1) touch and evict; focused and pinned processes are never evicted. | §9.2 · p27 | 03-kernel/memory §3; 08-dsa §3 (LRU) | R1 / R2 | P3 | `MEM-02 dsa/lru matches a list model under random touch, insert, move, evict, pin and unpin (fast-check)` [U] · `MEM-02 bench: lru touch and evict stay flat from 10^3 to 10^5 entries and report ns/op and bytes/entry` [P] · `MEM-02 under a 2x workload no page of the focused process or of a pinned system process is ever evicted` [B] | PERF:MEM-02; CI:unit; CI:browser |
| MEM-03 | Must | Page-out serialises the state, writes it to swap, verifies the checksum and only then releases the memory; page-in restores a byte-identical state. | §9.2 · p27 | 03-kernel/memory §5 (page-out, codec) | R1 / R2 | P3 | `MEM-03 page-out then page-in restores a byte-identical state: re-encoded bytes and SHA-256 are equal` [B] · `MEM-03 memory is released only after the read-back is verified: a corrupted read-back keeps the page resident and dirty` [B] | GATE:p3/MEM-03; CI:browser |
| MEM-04 | Must | Remote swap to backend storage works, and a remotely swapped state can be paged in from a new browser session. | §9.2 · p27 | 03-kernel/memory §3 (write-behind); [11-server](../11-server/backend-api.md) §4 (`/api/swap`) | R1 / R2 | P3 | `MEM-04 close the tab, reopen in a new browser profile, and the window process restores its state from remote swap` [E] · `MEM-04 write-behind: every page-out while online is uploaded and the local copy is kept` [I] | GATE:p3/MEM-04; CI:e2e; CI:integration |
| MEM-05 | Must | For a 5 MB state, page-in p95 ≤ 300 ms from local swap and ≤ 2 s from remote swap. | §9.2 · p27 | 03-kernel/memory §7 | R1 / R2 | P3 | `MEM-05 5 MB incompressible page-in p95 is at most 300 ms from local swap (OPFS and IndexedDB, both backends)` [P] · `MEM-05 5 MB incompressible page-in p95 is at most 2 s from remote swap with swapctl tier remote` [P] | PERF:MEM-05; REPORT:paging-benchmark |
| MEM-06 | Must | With a workload of at least twice the budget, accounted resident memory never exceeds the budget for more than 1 s, and the tab never crashes. | §9.2 · p27 | 03-kernel/memory §5 (reservation-based admission, reclaim at 85%) | R1 / R2 | P3 | `MEM-06 memhog 2x budget: accounted memory never exceeds the budget, the test logs max ms over budget (0 expected, at most 1000) and the tab never crashes` [P] · `MEM-06 mem.alloc blocks on mem until reclaim frees space, then succeeds` [B] | PERF:MEM-06; GATE:p3/MEM-06; CI:browser |
| MEM-07 | Must | Page faults, hit ratio and bytes paged in and out are shown for each process in the Task Manager and `vmstat`. | §9.2 · p27 | 03-kernel/memory §4; 07-shell §3 (`free`, `vmstat`, `pmap`); 05-wm §3 (Task Manager) | R1 / R3 | P3 | `MEM-07 vmstat -p shows faults, hit ratio and bytes in and out per process, and the Task Manager matches within one refresh` [E] | GATE:p3/MEM-07; CI:e2e |
| MEM-08 | May | Memory-mapped files: `sys.mmap(path)` returns a handle registered in a hash map, whose pages load on first access and are flushed by `msync`. | §9.2 · p27 | 03-kernel/memory §3 (stretch) | R1 / R2 | Stretch: built only if P3 is green by W10; shown at P4 | `MEM-08 mmap loads a chunk on first access and msync writes dirty chunks in one VFS transaction` [B] | CI:browser (if built) |

#### 3.3.4 VFS — virtual file system (spec §9.3)

| ID | Kw | Requirement (summary) | Spec § · p | Our spec | Owner / rev. | Gate | Planned test titles | Evidence |
|---|---|---|---|---|---|---|---|---|
| VFS-01 | Must | The VFS is our own n-ary tree of inodes, with hash-mapped directory entries and O(depth) path resolution. | §9.3 · p29 | [04-vfs](../04-vfs/virtual-file-system.md) §3 (tree); 08-dsa §3 (tree) | R2 / R1 | P2 | `VFS-01 resolving a depth-8 path performs exactly 8 child lookups` [U] · `VFS-01 directory lookup stays flat from 10^3 to 10^5 entries` [P] · `VFS-01 moving a directory with 10,000 descendants rewrites one dentry` [B] | PERF:VFS-01; DOC:DSA.md#n-ary-tree; CI:unit; CI:browser |
| VFS-02 | Must | The standard hierarchy is created at first boot with the specified owners and modes. | §9.3 · p29 | 04-vfs §3 (mkfs, well-known UUIDs) | R2 / R1 | P2 | `VFS-02 mkfs creates the standard hierarchy with the specified owners and modes` [B] · `VFS-02 client mkfs and server seed agree on ino for every system path` [I] | GATE:p2/VFS-02; CI:browser; CI:integration |
| VFS-03 | Must | Path resolution handles absolute and relative paths, `.`, `..`, repeated and trailing slashes, and symlinks, with ELOOP after 40 hops. | §9.3 · p29 | 04-vfs §5 (resolution algorithm) | R2 / R1 | P2 | `VFS-03 absolute and relative paths resolve from / and from the cwd` [U] · `VFS-03 //a///b// equals /a/b for a directory b` [U] · `VFS-03 a chain of 40 symlinks resolves and a chain of 41 gives ELOOP` [U] | GATE:p2/VFS-03; CI:unit |
| VFS-04 | Must | Read, write and execute permissions are enforced for owner, group and others on every system call. | §9.3 · p29 | 04-vfs §3 (permissions, `vfs/perm.ts`); [syscall-abi](../01-architecture/syscall-abi.md) §3 (dispatcher) | R2 / R1 | P2 | `VFS-04 permission matrix: owner, group, other and root across 12 modes and every operation` [U] · `VFS-04 root gets x on a file only if some x bit is set` [U] · `VFS-04 as bob, cat /home/alice/notes.md gives EACCES` [E] | GATE:p2/VFS-04; CI:unit; CI:e2e |
| VFS-05 | Must | Soft links can be created, read, followed and left dangling; `lstat` and `stat` differ correctly. | §9.3 · p29 | 04-vfs §3 (links) | R2 / R1 | P2 | `VFS-05 ln -s stores the target verbatim and readlink returns it` [U] · `VFS-05 stat follows a link and lstat does not` [U] · `VFS-05 a dangling link: stat gives ENOENT, lstat succeeds, ls shows the target` [U] | CI:unit |
| VFS-06 | Must | Per-user hard quotas: EDQUOT with no partial write; `df`, `du` and `quota` are accurate. | §9.3 · p29 | 04-vfs §3 (quotas); [09-database](../09-database/database.md) §3 (L1 users lock) | R2 / R1 | P2 | `VFS-06 rejects a write beyond quota with EDQUOT and no partial data` [B] · `VFS-06 two concurrent writes cannot both pass the quota check` [B] · `VFS-06 two clients near quota: the server rejects one with EDQUOT and that client reverts` [I] | GATE:p2/VFS-06; CI:browser; CI:integration |
| VFS-07 | Must | Create, read, update and delete, plus `cp -r`, `mv`, `rm -r`, `find`, `stat`, `chmod`, `chown`, `ln -s` and `tree`, from both the terminal and the File Explorer, both built on system calls. | §9.3 · p29 | 07-shell §3 (file coreutils); 05-wm §3 (File Explorer); 04-vfs §3 | R2 / R3 | P2 | `VFS-07 cp -r, mv, rm -r, find, stat, chmod, chown, ln -s and tree from the terminal` [E] · `VFS-07 terminal CRUD with touch, echo, cat, mv and rm` [E] · `VFS-07 File Explorer create, rename, copy, move, delete and properties use syscalls only` [E] | GATE:p2/VFS-07; CI:e2e |
| VFS-08 | Must | At least 32 levels of nesting; names up to 255 bytes; paths up to 4096 bytes. | §9.3 · p29 | 04-vfs §6 (limits) | R2 / R1 | P2 | `VFS-08 32 levels of nesting can be created, listed and removed` [E] · `VFS-08 a 255-byte name works and a 256-byte name gives ENAMETOOLONG` [U] · `VFS-08 a 4096-byte path works and a 4097-byte path gives ENAMETOOLONG` [U] | GATE:p2/VFS-08; CI:e2e; CI:unit |
| VFS-09 | Must | Lease-based distributed locks: a second writer gets EBUSY or read-only access, and a crashed holder's lock expires within the lease time. | §9.3 · p29 | 06-sync §3 (locks, leases, fences); 09-database §4 (`locks`); [architecture §5.7](../01-architecture/architecture.md) | R2 / R5 | P3 | `VFS-09 two Chrome profiles: alice holds X, bob is read-only, alice's renderer ends, bob acquires within the TTL` [E] · `VFS-09 a crashed holder's lease expires within TTL plus 0.5 s` [I] · `VFS-09 a write with a stale fence gets EBUSY and its bytes are kept as a conflicted copy` [I] · `VFS-09 a hidden tab keeps its lease for 6 minutes` [E] | GATE:p3/VFS-09 (two browsers, two users); PERF:VFS-09 (lock-grant p95); CI:e2e; CI:integration |
| VFS-10 | Must | Concurrent changes are detected by version numbers; conflicted copies are kept; no update is ever silently lost. | §9.3 · p30 | 06-sync §3 (conflicts, per-owner feed) | R2 / R5 | P3 | `VFS-10 a stale-version write becomes a conflicted copy and the original is untouched` [I] · `VFS-10 bob edits /home/shared while alice is offline, alice reconnects, tree checksums are equal` [I] | CI:integration |
| VFS-11 | Should | `fsck` checks the tree's invariants (every inode reachable, correct link counts, no directory cycles, consistent quota totals) and reports or repairs problems. | §9.3 · p30 | 04-vfs §3 (fsck) | R2 / R1 | P3 | `VFS-11 fsck detects and repairs each of I1 to I12 on corrupted fixtures` [B] · `VFS-11 property: random op sequences keep fsck clean` [U] | GATE:p3/VFS-11; CI:browser; CI:unit |

#### 3.3.5 WM — window management (spec §9.4)

| ID | Kw | Requirement (summary) | Spec § · p | Our spec | Owner / rev. | Gate | Planned test titles | Evidence |
|---|---|---|---|---|---|---|---|---|
| WM-01 | Must | The window registry is a hash map with O(1) lookup; the compositor is the only code that writes window geometry. | §9.4 · p30 | [05-wm/window-manager](../05-wm/window-manager.md) §3 (registry, compositor) | R3 / R1 | P2 | `WM-01 registry get, set and delete stay flat from 10 to 10,000 windows in the dsa/hashtable benchmark` [P] · `WM-01 static scan finds no window geometry or z-index write outside the compositor chunk` [L] | CI:lint |
| WM-02 | Must | Dynamic z-ordering with renumbering; click to focus and raise; focus is always visible. | §9.4 · p30 | 05-wm/window-manager §5 (z-order) | R3 / R1 | P2 | `WM-02 clicking a background window raises it and z-indices are exactly 1..n afterwards` [B] · `WM-02 the focused window shows the focus strip and its focused control shows the focus ring in both themes` [E] | GATE:p2/WM-02; CI:browser; CI:e2e |
| WM-03 | Must | Dragging and resizing with at least 10 windows open keeps p95 frame time ≤ 16.7 ms. | §9.4 · p30 | 05-wm/window-manager §7; 13-quality §3 (frame method) | R3 / R1 | P2 | `WM-03 p95 frame duration is at most 16.7 ms while dragging and resizing with 10 windows open` [P] · `WM-03 zero long animation frames over 50 ms are attributed to our origin during the 10-window drag trace` [P] | PERF:WM-03; GATE:p2/WM-03 (Chrome trace) |
| WM-04 | Must | Minimise, maximise, restore, close, snapping and a live taskbar. | §9.4 · p30 | 05-wm/window-manager §3 | R3 / R1 | P2 | `WM-04 minimise, maximise, restore and close work from the title-bar buttons, the taskbar and the keyboard` [E] · `WM-04 double-clicking the title bar maximises and double-clicking again restores the previous rectangle` [E] · `WM-04 dragging to the left edge snaps to the left half and dragging away restores the pre-snap size under the pointer` [E] | GATE:p2/WM-04; CI:e2e |
| WM-05 | Must | Window–process coupling: closing a window signals its process, killing a process closes its windows; minimised windows are paged first and restoring one pages it in. | §9.4 · p30 | 05-wm/window-manager §3; 03-kernel/memory §3 (victim order) | R3 / R1 | P2 (coupling), P3 (paging) | `WM-05 closing a window delivers SIGTERM to its process and the process exits` [I] · `WM-05 killing a process closes all of its windows` [E] · `WM-05 under memory pressure a minimised window's process is paged out before any unminimised process` [B] | GATE:p3/WM-05; CI:integration; CI:e2e; CI:browser |
| WM-06 | Must | Window positions, sizes, states and z-order are restored after a reboot. | §9.4 · p30 | 05-wm/window-manager §3; 02-boot §3 (session restore) | R3 / R1 | P2 | `WM-06 after reboot the positions, sizes, states and z-order equal the saved layout` [E] | GATE:p2/WM-06; CI:e2e |
| WM-07 | Should | The system interface meets WCAG 2.2 AA for contrast and keyboard operation, including a keyboard shortcut to switch windows. | §9.4 · p31 | 05-wm/ui-design-system §3 (tokens, accessibility) | R3 / R5 | P2 (audit 1), repeated at P3 and P4 | `WM-07 axe finds zero serious or critical issues on the desktop with 3 windows, the launcher and a toast open, in both themes` [E] · `WM-07 every window can be switched to, moved, resized, snapped, minimised and closed with the keyboard only` [E] | REPORT:a11y-audit-p2 (then p3, p4); CI:e2e |

#### 3.3.6 OFF — offline execution and synchronisation (spec §9.5)

| ID | Kw | Requirement (summary) | Spec § · p | Our spec | Owner / rev. | Gate | Planned test titles | Evidence |
|---|---|---|---|---|---|---|---|---|
| OFF-01 | Must | Boot, login, Terminal, File Explorer, Text Editor, Task Manager and Settings work fully offline. | §9.5 · p31 | 06-sync §3 (offline shell); [architecture §5.3](../01-architecture/architecture.md) | R5 / R3 | P3 | `OFF-01 with the server process killed, a reboot reaches the desktop and ls, cat, mkdir, mv, rm, Files, Editor save, Task Manager and Settings work` [E] | GATE:p3/OFF-01; CI:e2e |
| OFF-02 | Must | Offline changes are queued in a durable outbox and replayed exactly once on reconnection (idempotency keys). | §9.5 · p31 | 06-sync §3, §5 (replay, exactly-once argument) | R5 / R2 | P3 | `OFF-02 replay of 5,000 queued ops completes with zero disconnects and exactly one op_log row per opId` [I] · `OFF-02 a client crash between the local commit and the send delivers the op exactly once after reboot` [E] | CI:integration; CI:e2e |
| OFF-03 | Must | Offline login never stores plain-text passwords; it uses a salted verifier or a platform authenticator. | §9.5 · p31 | 12-security §3 (offline verifier); 06-sync §3 | R5 / R2 | P3 | `OFF-03 after online and offline logins a storage scan finds the canary password nowhere in IndexedDB, OPFS, Cache Storage or Web Storage` [E] (proposed) · `OFF-03 root has no offline verifier and cannot log in offline` [E] (proposed) | DOC:SECURITY.md#offline-login; CI:e2e |
| OFF-04 | Must | The taskbar shows connectivity status and lists degraded services. | §9.5 · p31 | 05-wm/window-manager §3 (taskbar tray); 06-sync §3 | R3 / R5 | P3 | `OFF-04 the taskbar shows Online, Syncing n ops, Reconnecting in n s and Offline · n queued as net.state changes` [E] · `OFF-04 the degraded badge lists each degraded service with its next retry and hides at zero` [E] | GATE:p3/OFF-04; CI:e2e |
| OFF-05 | Should | Versioned shell updates install in the background and activate on the next boot. | §9.5 · p31 | [14-devops](../14-devops/deployment-and-ci.md) §3 (release, Service Worker); 02-boot §3 | R5 / R3 | P3 (repeated on Demo Day) | `OFF-05 a new build installs in the background, waits, shows Restart to update, and activates only after reboot` [E] | GATE:p3/OFF-05; GATE:p5/OFF-05; CI:e2e |

#### 3.3.7 SYS — system calls and terminal (spec §9.6)

| ID | Kw | Requirement (summary) | Spec § · p | Our spec | Owner / rev. | Gate | Planned test titles | Evidence |
|---|---|---|---|---|---|---|---|---|
| SYS-01 | Must | All applications, built-in or not, use only the system-call interface; the kernel checks permissions for every call. | §9.6 · p32 | [syscall-abi](../01-architecture/syscall-abi.md) §3, §8; [architecture §3.5](../01-architecture/architecture.md) | R1 / R2 | P2 | `SYS-01 bypass suite: 8 cases from executor and view origins all fail closed` [B] · `SYS-01 built-chunk scan finds no storage, worker or kernel-module reference in any apps chunk` [L] | CI:browser; CI:lint |
| SYS-02 | Must | The required command set, with pipes, redirection, background jobs and history. | §9.6 · p31–32 | [07-shell](../07-shell/shell-and-terminal.md) §3 (shell, commands); command owners in §3.9 of this file | R3 / R4 | P2 (file group), P3 (process, memory, system groups), P4 (AI group) | `SYS-02 scripted terminal session covers the required commands, pipes, redirection, sequencing, background jobs, variables and history` [E] · `SHL-12 every /bin manifest has a man page and every front-matter flag appears in OPTIONS` [U] | GATE:p2/SYS-02, GATE:p3/SYS-02, GATE:p4/SYS-02; CI:e2e; CI:unit |
| SYS-03 | Must | Tab completion of commands, paths and flags is backed by our own trie, with p95 prefix lookup ≤ 1 ms over at least 10,000 entries; the trie is updated incrementally as the VFS changes. | §9.6 · p32 | 07-shell §3 (completion); 08-dsa §3 (trie) | R3 / R4 | P2 | `SYS-03 complete p95 is at most 1 ms at 10^4 and 10^5 entries in every namespace` [P] · `SYS-03 creating a file makes it completable without a rescan` [B] | PERF:SYS-03; GATE:p2/SYS-03 (`complete --bench`); CI:browser |

#### 3.3.8 DB — database and integrity (spec §11.5)

| ID | Kw | Requirement (summary) | Spec § · p | Our spec | Owner / rev. | Gate | Planned test titles | Evidence |
|---|---|---|---|---|---|---|---|---|
| DB-01 | Must | A documented schema (ERD) with normalisation reasoning; versioned migrations, each with a rollback script; a documented backup-and-restore procedure. | §11.5 · p37 | [09-database](../09-database/database.md) §3, §4; 14-devops §3 (backups) | R2 / R5 | P1 (ERD, DDL), P3 (migrations, restore drill) | `DB-01 migration round trip of up, N rollbacks and up leaves db/schema.sql unchanged` [I] (proposed) · `DB-01 the restore drill rebuilds a fresh stack from pg_dump and blobs and fsck --server is clean` [I] (proposed) | DOC:DATABASE.md#erd; REPORT:restore-drill; CI:integration |
| DB-02 | Must | Every bulk VFS operation is atomic; the fault-injection suite passes with zero orphans and unchanged checksums. | §11.5 · p37 | 09-database §5 (fault harness, set-based ops); 04-vfs §3 (client mirror); [architecture §5.2](../01-architecture/architecture.md) | R2 / R5 | P3 | `DB-02 rm -r of 1,000 nodes with a server fault at node 500 prints EIO synchronously and leaves checksum, orphans and quota unchanged on both sides` [B] · `DB-02 client rm -r of 1,000 nodes aborted at the 500th inode write leaves checksum, orphan probes and quota unchanged` [B] · `DB-02 faults at node 1, 500, 999 and 1000 for rm -r, cp -r, mv, batch rename, chmod -R and chown -R leave zero orphans and unchanged checksums` [I] (proposed) | GATE:p3/DB-02; CI:browser; CI:integration |
| DB-03 | Must | A declared isolation level with retry logic; two clients moving overlapping subtrees at the same time always leave a consistent tree. | §11.5 · p37 | 09-database §3 (READ COMMITTED, lock order L0–L4), §5 | R2 / R5 | P3 | `DB-03 two and eight clients moving overlapping subtrees concurrently always leave an acyclic, fully reachable tree` [I] · `DB-03 moving a directory into its own subtree fails with EINVAL` [I] · `DB-03 serialization failures and deadlocks are retried at most 5 times with jitter` [I] | CI:integration |
| DB-04 | Must | Constraints are enforced by the database: foreign keys, unique (parent, name), checks on type and mode. | §11.5 · p37 | 09-database §4 (DDL, CHECK list) | R2 / R5 | P1 (DDL), P3 (tests) | `DB-04 each constraint violation is rejected by PostgreSQL and mapped to its errno` [I] | DOC:DATABASE.md#constraints; CI:integration |
| DB-05 | Must | Indexes as described in §11.4; benchmark queries Q1–Q5 meet p95 ≤ 10 ms at ≥ 10,000 records, with query plans as evidence. | §11.5 · p37 | 09-database §3 (index list), §7 | R2 / R5 | P3 | `DB-05 Q1 to Q5 p95 is at most 10 ms at 100,000 inodes after indexing and EXPLAIN (ANALYZE, BUFFERS) shows each planned index in use` [P] · `DB-05 the benchmark reports p50 and p95 over 1,000 runs before and after indexing from a reproducible seed of at least 50 users` [P] | PERF:DB-05; REPORT:db-benchmark |

#### 3.3.9 RAG — semantic VFS search (spec §12.2)

| ID | Kw | Requirement (summary) | Spec § · p | Our spec | Owner / rev. | Gate | Planned test titles | Evidence |
|---|---|---|---|---|---|---|---|---|
| RAG-01 | Must | The indexer is a scheduled background process: visible in `ps`, low priority, throttled while the user is active. | §12.2 · p38 | [rag §3.2, §3.10](../10-ai/rag-semantic-search.md) | R4 / R1 | P4 | `RAG-01 ai.indexer appears in ps with PRI 32 NI 10 and state BLOCKED on ai:embed while indexing` [B] · `RAG-01 indexer duty cycle drops to about 50 % while the typing simulator runs and returns to 100 % after 1 s idle` [B] | GATE:p4/RAG-01 (`ps`, `top` during typing); CI:browser |
| RAG-02 | Must | The index stays consistent with the VFS: create, modify, rename and delete are reflected within 30 s for a 50 KB text file. | §12.2 · p38 | [rag §3.3](../10-ai/rag-semantic-search.md) | R4 / R2 | P4 | `RAG-02 a created 50 KB markdown file is findable by semsearch within 30 s under the typing simulator` [B] · `RAG-02 a renamed file is returned under its new path within 30 s with zero embedding calls` [B] · `RAG-02 a deleted file never appears in results after the unlink transaction commits` [B] | CI:browser |
| RAG-03 | Must | No result ever includes content the querying user cannot read. | §12.2 · p38 | [rag §3.5, §5.2](../10-ai/rag-semantic-search.md) | R4 / R2 | P4 | `RAG-03 rag-leak: 3 users × modes 600/640/644 × directories 700/711/755 × 30 queries return zero unreadable results` [I] · `RAG-03 chmod while bob is offline: bob's offline search shows no foreign result at all` [B] · `RAG-03 server verify returns readable=false for a file chmodded after indexing` [I] | GATE:p4/RAG-03; CI:integration (rag-leak gate); CI:browser |
| RAG-04 | Must | Recall@5 ≥ 0.80 on the team's evaluation set, with MRR reported. | §12.2 · p38 | [rag §5.5](../10-ai/rag-semantic-search.md); [ai-safety-and-evaluation](../10-ai/ai-safety-and-evaluation.md) §3 (datasets) | R4 / R5 | P4 | `RAG-04 Recall@5 on the team evaluation set is at least 0.80 and MRR is reported` [A] | REPORT:rag-eval; CI:ai-eval |
| RAG-05 | Must | Retrieval latency p95 ≤ 500 ms over at least 10,000 chunks, not counting optional answer generation. | §12.2 · p38 | [rag §3.5, §5.3, §7](../10-ai/rag-semantic-search.md) | R4 / R1 | P4 | `RAG-05 retrieval p95 at 10,000 chunks with a warm model is at most 500 ms` [P] · `RAG-05 first query after ai.embed eviction is measured and reported separately` [P] | PERF:RAG-05 |
| RAG-06 | Must | Integrated into the shell (`semsearch`) and the File Explorer; when the model is unavailable, search falls back to keyword search with a clear notice. | §12.2 · p39 | [rag §3.5, §3.12](../10-ai/rag-semantic-search.md) | R4 / R3 | P4 | `RAG-06 semsearch prints path:line citations, scores and snippets as plain text` [B] · `RAG-06 Files search shows the same results and opens a result at lineStart` [B] · `RAG-06 with the model unavailable semsearch returns keyword results and the notice "Semantic search unavailable — showing keyword matches"` [B] | GATE:p4/RAG-06 (live and offline); CI:browser |

#### 3.3.10 AGT — agentic system execution (spec §12.3)

| ID | Kw | Requirement (summary) | Spec § · p | Our spec | Owner / rev. | Gate | Planned test titles | Evidence |
|---|---|---|---|---|---|---|---|---|
| AGT-01 | Must | Tools are typed system calls with JSON schemas; model output is parsed as data and never passed to `eval` or run as a shell string. | §12.3 · p39 | [agentic-shell](../10-ai/agentic-shell.md) §3, §4 (tool catalogue) | R4 / R2 | P4 | `AGT-01 every tool maps to exactly one syscall schema in protocol` [U] · `AGT-01 model tool input is parsed with Valibot and never reaches eval, Function or the shell parser` [U] | CI:unit |
| AGT-02 | Must | Invalid plans (unknown command, bad arguments, missing path, permission denied, quota exceeded) are rejected before anything runs, with the reason; zero partial executions. | §12.3 · p39 | agentic-shell §5 (validation) | R4 / R2 | P4 | `AGT-02 a plan with an unknown call is rejected with EINVAL and nothing runs` [U] · `AGT-02 a plan with a missing source path is rejected with ENOENT and nothing runs` [B] · `AGT-02 a plan that needs write permission the user lacks is rejected with EACCES and nothing runs` [B] · `AGT-02 a plan that exceeds quota is rejected with EDQUOT and nothing runs` [B] | CI:unit; CI:browser |
| AGT-03 | Must | Destructive operations (delete, overwrite, `chmod` or `chown`, or any plan touching more than 20 inodes) need explicit confirmation after the dry run; zero bypasses. | §12.3 · p39 | agentic-shell §5 (confirmation predicate); [architecture §5.6](../01-architecture/architecture.md) | R4 / R1 | P4 | `AGT-03 the predicate requires confirmation above 20 affected inodes and not at exactly 20` [U] · `AGT-03 piped yes into ai cannot confirm a destructive plan` [B] · `AGT-03 a destructive plan with no controlling TTY is refused with ENOTTY` [B] · `AGT-03 an empty answer or a timeout means N and nothing runs` [B] | GATE:p4/AGT-03; CI:unit; CI:browser |
| AGT-04 | Must | The agent runs with the invoking user's privileges, cannot escalate, and cannot modify `/system` or `/bin` unless the user is root and confirms. | §12.3 · p39 | agentic-shell §3 (identity); [12-security](../12-security/security-model.md) §3 | R4 / R2 | P4 | `AGT-04 an agent started from a su root shell runs as the real login uid` [B] · `AGT-04 a plan touching /system is refused with EPERM without a live su grant and secure-prompt password` [B] | CI:browser |
| AGT-05 | Must | A multi-step plan runs atomically, as one transaction or with complete compensating rollback. | §12.3 · p39 | agentic-shell §3 (execute); 09-database §5 (`sys.batch` in one `vfsTxn`) | R2 / R4 | P4 | `AGT-05 a server fault injected during a batch rolls back both sides with EIO and fsck is clean` [I] · `AGT-05 a change between dry run and commit returns EAGAIN stale-plan and nothing changes` [I] | CI:integration |
| AGT-06 | Must | Prompt-injection resistance: file contents and names enter the model's context marked as untrusted data; an instruction hidden in a file causes no tool call the user did not ask for. | §12.3 · p40 | ai-safety-and-evaluation §3 (datamarking, intent binding); agentic-shell §5 | R4 / R5 | P4 | `AGT-06 INJ-20 executed-unrequested steps are zero with an informed user` [A] · `AGT-06 a destructive step whose span lacks a licensing verb is rejected with EPERM not-requested` [U] · `AGT-06 the planner never receives file contents in any turn` [A] | REPORT:agent-safety; GATE:p4/AGT-06 (examiner fixture); CI:ai-eval; CI:unit |
| AGT-07 | Must | At least 16 of 20 instructions from the examiners' benchmark are completed correctly (multi-step pipelines, relative dates, glob patterns, ambiguous requests that need a clarifying question). | §12.3 · p40 | ai-safety-and-evaluation §3 (AGT-40); agentic-shell §3 (observation loop) | R4 / R5 | P4 (own set), P5 (hidden set) | `AGT-07 AGT-40 median is at least 36 of 40 over 3 live runs` [A] · `AGT-07 ambiguous requests produce ask_clarification` [A] · `AGT-07 hidden examiner benchmark completes at least 16 of 20` [M] (proposed) | REPORT:agent-eval; GATE:p5/AGT-07; CI:ai-eval |
| AGT-08 | Must | Every agent system call is written to the audit log with the prompt, plan, confirmation and result, and can be viewed with `ai log`. | §12.3 · p40 | agentic-shell §4 (audit record); 09-database §4 (`audit_log`) | R2 / R4 | P4 | `AGT-08 ai log shows prompt, plan, confirmation and result, and works offline` [B] · `AGT-08 rejected, declined and killed plans are audited with their outcome` [I] | GATE:p4/AGT-08; CI:browser; CI:integration |
| AGT-09 | Must | The agent is a real process: visible in `ps`, and killable in the middle of a plan, which rolls the transaction back. | §12.3 · p40 | agentic-shell §3 (process model); [architecture §5.6](../01-architecture/architecture.md) | R4 / R1 | P4 | `AGT-09 ai.agent appears in ps with PRI 20 and state BLOCKED on net:llm` [B] · `AGT-09 kill during a stretched server transaction rolls back and audits killed_rolled_back` [I] | GATE:p4/AGT-09; CI:browser; CI:integration |
| AGT-10 | May | `ai undo <txn>` reverses a committed plan using the operation log. | §12.3 · p40 | agentic-shell §3 (undo, stretch) | R4 / R2 | Stretch: 4th on the pre-registered cut list; decided at the W12 AI checkpoint; shown at P4 if kept | `AGT-10 ai undo restores the tree to its pre-plan checksum` [B] | CI:browser (if built) |

#### 3.3.11 PRE — predictive process pre-fetching (spec §12.4)

| ID | Kw | Requirement (summary) | Spec § · p | Our spec | Owner / rev. | Gate | Planned test titles | Evidence |
|---|---|---|---|---|---|---|---|---|
| PRE-01 | Must | The model trains and runs locally in a worker; one prediction takes ≤ 5 ms. | §12.4 · p40 | [predictive-prefetch](../10-ai/predictive-prefetch.md) §3, §7 | R4 / R1 | P4 | `PRE-01 one prediction takes at most 5 ms p95 in an executor worker with 32 apps and 5,000 events of history` [P] · `PRE-01 the incremental model equals a model rebuilt in batch from the same events` [U] | PERF:PRE-01; CI:unit |
| PRE-02 | Must | Top-3 accuracy beats the better of the MFU and MRU baselines on the held-out trace. | §12.4 · p40 | predictive-prefetch §5; ai-safety-and-evaluation §3 | R4 / R5 | P4 | `PRE-02 top-3 accuracy beats the better of MFU and MRU on the chronological held-out 30 %` [A] | REPORT:pre-eval; CI:ai-eval |
| PRE-03 | Must | For correctly predicted launches, pre-fetching cuts median launch latency by at least 30%. | §12.4 · p40 | predictive-prefetch §7; 03-kernel/memory §3 (speculative pages) | R1 / R4 | P4 | `PRE-03 median launch latency of correctly predicted launches drops by at least 30 % with pre-fetch` [P] | PERF:PRE-03; GATE:p4/PRE-03 (`predict --latency`) |
| PRE-04 | Must | Pre-fetching never slows the foreground: it runs only when idle, at the lowest priority, within free memory, and its pages are evicted first. | §12.4 · p41 | predictive-prefetch §3; 03-kernel/processes §3 (priority 39); 03-kernel/memory §3 | R1 / R4 | P4 | `PRE-04 frame p95 stays at or under 16.7 ms with no LoAF over 50 ms from our scripts while a prefetch job runs with 10 windows` [P] · `PRE-04 no prefetch job starts within 2 s of user input` [B] · `PRE-04 speculative pages are evicted before any non-speculative page` [U] | PERF:PRE-04 (frame trace during pre-fetch); CI:browser; CI:unit |
| PRE-05 | Must | Telemetry stays on the device by default and can be viewed and cleared; syncing it requires opt-in. | §12.4 · p41 | predictive-prefetch §3 (telemetry ring); 12-security §3 (privacy) | R4 / R3 | P4 | `PRE-05 with sync off no request is made to /api/telemetry` [B] · `PRE-05 Settings Privacy lists the events and Clear empties the ring and resets the model to cold start` [B] | GATE:p4/PRE-05; CI:browser |
| PRE-06 | Must | Predictions are visible: `predict` and the Task Manager show current predictions with confidence, and pre-fetch processes appear in `ps`. | §12.4 · p41 | predictive-prefetch §3; 07-shell §3 (`predict`); 05-wm §3 (Task Manager) | R4 / R3 | P4 | `PRE-06 predict prints the top 3 with confidence and a reason` [B] · `PRE-06 prefetch:app appears in ps while it runs` [B] | GATE:p4/PRE-06; CI:browser |

### 3.4 What each gate must show

The list for a gate is every row whose gate column names that gate, plus everything from earlier gates, which must still pass on the new tag (no regressions). R5 runs it at the dry run (3 days before) and on the tag.

| Gate | Spec gate criterion (§13.1) | Requirement IDs and obligations first due |
|---|---|---|
| G0 (W2) | Five members confirmed; name approved as unique and appropriate; repository reachable; CI runs on a pull request. | PLT-TEAM-01..14 (§3.11); PLT-DOC-11 `TEAM_CONTRACT.md`, PLT-DOC-14 `docs/registration.pdf` (§3.6); PLT-ID-01, PLT-ID-05 ([identity](./identity-and-branding.md)); CI skeleton ([deployment-and-ci](../14-devops/deployment-and-ci.md)) |
| P1 (W4) | 15-minute architecture defence plus 10 minutes of questions; every member presents; the stack is approved or returned within one week. | DB-01 and DB-04 on paper (ERD, DDL, tree representation); DSA-GEN-04 (`DSA.md` draft); PLT-DOC-02, -03, -04, -05, -07 drafts; §13.1 Phase 1 rows (§3.7) |
| P2 (W7, `v0.2.0`) | VFS test suite green; 10 windows dragged at 60 FPS; the permission and quota tests run live; the deployed URL boots. | BOOT-01, BOOT-02 (assets and kernel init), BOOT-10, BOOT-13 (boot screen), BOOT-14; VFS-01..08; WM-01..07 (WM-05 coupling part, WM-07 audit 1); SYS-01, SYS-02 (Files group and shell features), SYS-03; identity kit PLT-ID-02..16 (entry requirement, §16.3) |
| P3 (W11, `v0.3.0`) | Frame time held under CPU load; paging shown with a 2× workload; a fault-injected `rm -r` rolls back live; offline boot; two users contend for a lock. | BOOT-02..12 (DAG-driven boot v2); PROC-01..09; MEM-01..07; VFS-09..11; WM-05 (paging part); OFF-01..05; DB-01..05; SYS-02 (Processes, Memory and System groups) |
| P4 (W14, `v0.4.0`) | Live AI demonstration on examiner prompts; the §3.4 litmus test; the safety tests run live. | RAG-01..06; AGT-01..09 (AGT-10 if kept); PRE-01..06; SYS-02 (AI group); MEM-08 (if built); AIN-A1..C4 and AIS-01..12 (§3.12); ARC-06 litmus build |
| FRZ (W16, `v1.0.0-rc.N`) | Rehearsal passed; after the freeze only bug fixes are merged. | Every Must and Should row passes on the release candidate; PLT-DOC-01..14 complete; full 30-minute rehearsal on a machine the team does not control |
| P5 (W17–18, `v1.0.0`) | The Demo Day protocol (§17.1). | Every Appendix A line live (§3.8); PLT-DEL-01..16 (§3.10); AGT-07 on the hidden set |

A Should row that we decide not to meet needs a written justification (spec p3) committed as a decision record in `docs/adr/` before the gate at which it is due. No Should is planned to be dropped.

### 3.5 Mandatory data structures (§10.1, §10.2)

**Spec: MUST, §10.2.** The tree, trie, heap, DAG with topological sort, and LRU list must be written by the team from first principles; importing a package that provides one of them scores zero for that item. **C16:** each structure ships in `dsa/<name>/` with its interface, complete tests and benchmark, and `export const IMPLEMENTED = false` until its owner implements it; tests are gated with `describe.runIf(IMPLEMENTED)`. Pilot code under `docs/evidence/pilot` is never imported and is excluded from build, lint and coverage.

The inventory, interfaces, proofs, tests and benchmarks are normative in [08-dsa](../08-dsa/data-structures.md); its IDs are used here: `DSA-GEN-nn` for the §10.2 rules and `DSA-<STRUCT>-nn` per structure. Tests live in `dsa/<name>/tests/` and benchmarks in `dsa/<name>/bench/`. Each structure has an owner and a non-owner reviewer (08-dsa §3.3).

| # | Structure (§10.1) | Mandatory location(s) | Module → users | Owner / non-owner rev. | Required operations and complexity | Proving IDs | First gate |
|---|---|---|---|---|---|---|---|
| S1 | N-ary tree | VFS directory hierarchy (§9.3) | `dsa/tree` → `vfs/tree`, path resolution, bulk walks, `fsck` | R2 / R1 | resolve O(d); add or remove a child O(1) average; walk a subtree O(k) | VFS-01, DSA-TREE-01..03 | P2 |
| S2 | Trie (prefix tree) | Terminal autocomplete over commands, paths and history (§9.6); flags (SYS-03) | `dsa/trie` (struct-of-arrays radix variant; namespaces for commands, paths, flags, history) → completion service | R3 / R4 | insert and remove O(L); complete a prefix O(P + k) | SYS-03, DSA-TRIE-01..03 | P2 |
| S3 | Binary heap (priority queue) | Scheduler ready queue (§9.1); timer and sleep queue | `dsa/heap` with an index map → ready heap and timer heap; RAG top-k; server lease-expiry sweeper | R1 / R3 | push and pop O(log n); peek O(1); change priority O(log n) with an index map | PROC-02, DSA-HEAP-01..02 | P2 (basic scheduler), P3 (ready queue with aging) |
| S4 | Directed acyclic graph | Service dependencies and boot order (§6.4); application start-up dependencies | `dsa/dag` (Kahn levels, cycle path) → `services/svcmgr`, `sys.spawn` app closure from `/bin/<app>.json`, `bootlog --critical-path` | R5 / R2 | Kahn's sort O(V + E); cycle detection with the cycle path reported; levels for parallel start | BOOT-03, BOOT-04, DSA-DAG-01..03 | P2 |
| S5 | Hash map + doubly linked list (LRU) | LRU pager (§9.2); inode cache | `dsa/lru` → pager, inode cache, server rate-limit keys | R1 / R5 | touch, insert and evict O(1) | MEM-02, DSA-LRU-01..02 | P3 |
| S6 | Hash maps (our own hash table) | Process table; window registry | `dsa/hashtable` (open addressing, linear probing, Fibonacci hashing, backward-shift deletion) → PidTable, window registry | R1 / R3 | get, put and delete O(1) average | PROC-01, WM-01, DSA-HASH-01, DSA-GEN-05 | P2 (window registry), P3 (process table) |
| S12 | Hash maps (built-in `Map`/`Set` registries, allowed by §10.2) | Open-file table; memory-mapped handles; page tables; directory entries | registries in their subsystems, each documented in `DSA.md` | each subsystem owner | get, put and delete O(1) average | DSA-MAP-01 | P2 |
| S11 | B-tree / hash indexes | Database metadata (§11.4) | PostgreSQL indexes listed in [09-database](../09-database/database.md) | R2 / R5 | point lookup and range scan O(log n) | DB-05, DSA-DB-01 | P3 |
| S7 | *Extra:* ring buffer | Kernel log (§10.1 note) | `dsa/ringbuffer` → klog, telemetry ring, frame meter, pipes | R5 / R1 | push O(1), overwriting the oldest | DSA-RING-01 | P2 |
| S8 | *Extra:* Bloom filter | In front of the vector index (§10.1 note) | `dsa/bloom` → content-hash lookup fast path | R4 / R2 | add and mayContain O(h) for h hash functions; declared false-positive rate | DSA-BLOOM-01 | P4 |
| S9 | *Extra:* z-order list | Window stacking (R3's "z-order structure", §4.1) | `dsa/zorder` → compositor, renumbered 1..n | R3 / R5 | raise O(1); renumbering O(n) | WM-02, DSA-ZORD-01 | P2 |
| S10 | *Extra, May:* interval tree | Window hit-testing (§10.1 note) | `dsa/interval`, only if its benchmark justifies it | R3 / R1 | stabbing query O(log n + k) | DSA-IVT-01 | P4 (optional) |

**§10.2 rules and where they are verified:**

| §10.2 rule | 08-dsa ID | Owner / rev. | First gate |
|---|---|---|---|
| Tree, trie, heap, DAG with topological sort and LRU list are written by the team from first principles; a package in these roles scores zero | DSA-GEN-01 | R1 (editor of `DSA.md`) / R5 | G0 (lint rule), then each structure's gate |
| Each structure lives in its own `dsa/` module with unit tests for the empty structure, one element, duplicates, and removal of the root or head | DSA-GEN-02 | each owner / its reviewer | each structure's gate |
| Each structure has a micro-benchmark demonstrating its claimed complexity (for example autocomplete flat from 10^3 to 10^5) | DSA-GEN-03, DSA-GEN-09 | each owner / its reviewer | each structure's gate |
| `DSA.md` maps every structure to its file path, operations, complexity, and the test and benchmark that prove them | DSA-GEN-04 | R1 / R5 | P1 (draft), FRZ (complete) |
| Built-in hash tables are allowed as the hashing primitive; registries on top are documented; our own hash table with a declared collision strategy for at least one registry earns distinction credit | DSA-GEN-05, DSA-MAP-01, DSA-HASH-01 | R1 / R3 | P2 |
| Property-based tests (Should, §15.3): heap invariants after random pushes, pops and priority changes | DSA-GEN-06 | each owner | each structure's gate |
| Line coverage ≥ 85% on `dsa/` (§15.3) | DSA-GEN-07 | R5 / R1 | from the first merge into `dsa/` |
| `IMPLEMENTED` gating and no pilot import (C16) | DSA-GEN-08 | R1 / R5 | G0 |

### 3.6 Required documents (§15.1, §15.2, §18, Appendix D)

The spec files in `specs/` are the normative design; the root documents are the graded deliverables written for examiners. How each root document is assembled from the specs is in [README §3.8](../README.md). "Due" gives the first draft and the point at which it must be complete; every document must be up to date with the code on `v1.0.0` (§17.2).

| ID | Document | Required contents (spec) | Owner / rev. | Built from | Due | Evidence |
|---|---|---|---|---|---|---|
| PLT-DOC-01 | `README.md` | What the system is, its name and tagline, the live URL, bring-up in three commands or fewer, what works, and known limitations stated honestly (§15.2). No credentials (C10). | R3 / R5 | [identity](./identity-and-branding.md), [deployment-and-ci](../14-devops/deployment-and-ci.md) | G0 skeleton; P2 live URL; FRZ complete | DOC:README.md |
| PLT-DOC-02 | `ARCHITECTURE.md` | Diagrams, module boundaries, the system-call protocol, data flows, and the two decisions we would reverse with hindsight (§15.2). | R1 / R5 | [architecture](../01-architecture/architecture.md), [syscall-abi](../01-architecture/syscall-abi.md) | P1 diagrams (context, containers, components); FRZ "two decisions" | DOC:ARCHITECTURE.md |
| PLT-DOC-03 | `STACK_DECISION.md` | The decision records of §14: per record, context and constraints, at least three genuine options including one expected to lose, criteria and weights declared before scoring, evidence, decision and consequences, reversal trigger (§14.1); covering every decision of §14.2. Discloses the AI-assisted research inputs. | R5 (editor) / each record's owner | [stack-decisions](../15-decisions/stack-decisions.md) | P1 (frozen at the defence) | DOC:STACK_DECISION.md |
| PLT-DOC-04 | `DSA.md` | Every mandatory structure: location, operations, complexity, proving test and benchmark (§15.2, §10.2). | R1 (editor; each owner writes its entries) / R2 | [data-structures](../08-dsa/data-structures.md) | P1 draft; each entry when its structure is implemented; FRZ complete | DOC:DSA.md |
| PLT-DOC-05 | `DATABASE.md` | ERD, tree representation, transaction design, isolation level, indexes, benchmark results with query plans (§15.2); normalisation reasoning and backup-and-restore procedure (DB-01). | R2 / R5 | [database](../09-database/database.md) | P1 (ERD, DDL, tree representation); P3 complete | DOC:DATABASE.md |
| PLT-DOC-06 | `AI.md` | Subsystems chosen, models and why, the coupling map (§12.5), evaluation results, safety controls, cost report (§15.2). The pre-registered descoping rule, committed before W12. | R4 / R2 | [rag-semantic-search](../10-ai/rag-semantic-search.md), [agentic-shell](../10-ai/agentic-shell.md), [predictive-prefetch](../10-ai/predictive-prefetch.md), [ai-safety-and-evaluation](../10-ai/ai-safety-and-evaluation.md) | P1 plan; W12 descoping rule; P4 complete | DOC:AI.md |
| PLT-DOC-07 | `BOOT.md` | Boot stages, the service DAG, critical and degradable services, boot-time budget and the measured critical path (§15.2). | R5 / R3 | [boot-and-services](../02-boot/boot-and-services.md) | P1 (service list, DAG, critical and degradable); P3 measured critical path | DOC:BOOT.md |
| PLT-DOC-08 | `TESTING.md` | Test strategy, how to run each suite, coverage, performance budgets, fault-injection design (§15.2); the frame-measurement method agreed with the instructor before P2. | R5 / R1 | [testing-and-performance](../13-quality/testing-and-performance.md) | P2 draft (with the frame method); P3 fault-injection design; FRZ complete | DOC:TESTING.md |
| PLT-DOC-09 | `SECURITY.md` | Threat model, permission model, agent trust boundary, prompt-injection defences, secret handling (§15.2); any leaked key and its revocation (§18). | R2 / R4 | [security-model](../12-security/security-model.md) | P2 draft (permission model, secrets); P4 (agent trust boundary, injection defences) | DOC:SECURITY.md |
| PLT-DOC-10 | `AI_USAGE.md` | Which AI tools were used, what they were asked, what was accepted and what was rejected and why (§18), including the AI-assisted stack research and pilots in `docs/research/` and `docs/evidence/pilot/`. | R4 (curator; every member adds entries) / R5 | [implementation-plan](../16-delivery/implementation-plan.md) (process) | From W1; an entry with every PR that used an assistant | DOC:AI_USAGE.md |
| PLT-DOC-11 | `TEAM_CONTRACT.md` | The six §4.4 items (§3.11 of this file). | R5 (secretary) / all sign | [implementation-plan](../16-delivery/implementation-plan.md) | G0 (W2), merged through a PR | DOC:TEAM_CONTRACT.md |
| PLT-DOC-12 | `CHANGELOG.md` | Per release: what changed, by requirement ID (§15.1 layout). | R5 / R3 | [deployment-and-ci](../14-devops/deployment-and-ci.md) | From `v0.2.0` | DOC:CHANGELOG.md |
| PLT-DOC-13 | `THIRD_PARTY.md` | Every third-party library or asset with a compatible licence; none stands in for a mandatory DSA structure (§18). | R5 / R2 | [stack-decisions](../15-decisions/stack-decisions.md), licence scan in CI | From the first dependency (W1) | DOC:THIRD_PARTY.md; CI licence scan |
| PLT-DOC-14 | `docs/registration.pdf` | Scan of the Appendix D form signed by all five members. | R5 / all sign | [identity §3.13](./identity-and-branding.md) | G0 (end of W2) | DOC:docs/registration.pdf |

### 3.7 Phase deliverables and gate criteria (§13.1)

| Phase | Deliverable (spec) | Owner / rev. | Our spec | Evidence |
|---|---|---|---|---|
| Registration (W2) | Team registration form (Appendix D) | R5 / all | [identity §3.13](./identity-and-branding.md) | PLT-DOC-14 |
| | OS name and tagline | R3 / R5 | [identity §3.1–§3.4](./identity-and-branding.md) | `docs/identity/identity.json` |
| | `TEAM_CONTRACT.md` | R5 / all | [implementation-plan](../16-delivery/implementation-plan.md) | PLT-DOC-11 |
| | Repository created with a CI skeleton; instructor added as a collaborator | R5 / R1 | [deployment-and-ci](../14-devops/deployment-and-ci.md) | CI run on the first PR; collaborator screenshot in `docs/evidence/gates/g0/` |
| Phase 1 (W4) | System architecture diagrams (context, containers, components) | R1 / R5 | [architecture §3.1–§3.3](../01-architecture/architecture.md) | PLT-DOC-02 |
| | Formal technology-stack justification (`STACK_DECISION.md`, §14) | R5 / all record owners | [stack-decisions](../15-decisions/stack-decisions.md) | PLT-DOC-03 |
| | Database schema: ERD, DDL and the chosen tree representation | R2 / R5 | [database](../09-database/database.md) | PLT-DOC-05 draft; `db/migrations/` |
| | DSA blueprint mapping (`DSA.md` draft) | R1 / R2 | [data-structures](../08-dsa/data-structures.md) | PLT-DOC-04 draft |
| | Boot design: service list, DAG, critical and degradable services | R5 / R3 | [boot-and-services](../02-boot/boot-and-services.md) | PLT-DOC-07 draft |
| | Two-page benchmark analysis of Puter and daedalOS, measured (memory with several apps open, offline behaviour, screenshots) (§7) | R5 / all measure | [architecture §3.9](../01-architecture/architecture.md); [testing-and-performance](../13-quality/testing-and-performance.md) (harness) | `docs/benchmarks/competitors.md` |
| | Work breakdown with an owner for every task | R5 / R1 | [backlog](../16-delivery/backlog.md) | issue board export; `docs/requirements.csv` |
| | Risk register | R5 / R1 | [implementation-plan](../16-delivery/implementation-plan.md) | `docs/risk-register.md` |
| | Gate: 15-minute defence plus 10 minutes of questions; every member presents | all | [implementation-plan](../16-delivery/implementation-plan.md) (P1 script) | slides in `docs/slides/`; recording notes |
| Phase 2 (W7, `v0.2.0`) | Boot screen v1 with identity kit, truthful progress for asset loading and kernel initialisation, and a login screen | R3 / R5 | [boot-and-services](../02-boot/boot-and-services.md), [identity](./identity-and-branding.md) | BOOT-01, BOOT-02, BOOT-14 |
| | A working desktop and the multi-window compositor (WM-01 to WM-06) | R3 / R1 | [window-manager](../05-wm/window-manager.md) | WM rows |
| | Tree-based VFS with full CRUD, path resolution, permissions, soft links and quotas (VFS-01 to VFS-08) | R2 / R1 | [virtual-file-system](../04-vfs/virtual-file-system.md) | VFS rows |
| | Terminal with file commands and trie autocomplete (SYS-03) | R3 / R2 | [shell-and-terminal](../07-shell/shell-and-terminal.md) | SYS-02, SYS-03 |
| | File Explorer | R3 / R2 | [window-manager](../05-wm/window-manager.md) | VFS-07 |
| | Public deployment | R5 / R2 | [deployment-and-ci](../14-devops/deployment-and-ci.md) | live URL boots at the gate; UptimeRobot history |
| Phase 3 (W11, `v0.3.0`) | Process table, heap scheduler, Web Worker pool, process commands and Task Manager (PROC-*) | R1 / R5 | [processes-and-scheduling](../03-kernel/processes-and-scheduling.md) | PROC rows |
| | LRU paging with local and remote swap (MEM-*) | R1 / R2 | [memory-and-paging](../03-kernel/memory-and-paging.md) | MEM rows |
| | Atomic database persistence with the fault-injection suite, indexes and benchmark (DB-*) | R2 / R5 | [database](../09-database/database.md) | DB rows |
| | Distributed locks and multi-user sync (VFS-09, VFS-10) | R2 / R5 | [offline-and-sync](../06-sync/offline-and-sync.md) | VFS-09, VFS-10 |
| | Offline execution (OFF-*) | R5 / R3 | [offline-and-sync](../06-sync/offline-and-sync.md) | OFF rows |
| | Boot v2: DAG-driven, verbose log, boot menu, degraded and offline boot (BOOT-*) | R5 / R3 | [boot-and-services](../02-boot/boot-and-services.md) | BOOT rows |
| Phase 4 (W14, `v0.4.0`) | At least two AI subsystems integrated (we integrate all three: RAG-*, AGT-*, PRE-*) | R4 / R2 | `10-ai/*` | RAG, AGT, PRE rows |
| | Evaluation reports | R4 / R5 | [ai-safety-and-evaluation](../10-ai/ai-safety-and-evaluation.md) | REPORT:rag-eval, REPORT:agent-eval, REPORT:pre-eval |
| | AI safety results (permission leaks, injection fixtures, destructive confirmations) | R4 / R5 | [ai-safety-and-evaluation](../10-ai/ai-safety-and-evaluation.md) | REPORT:agent-safety; RAG-03, AGT-03, AGT-06 |
| | `AI.md` with the coupling map | R4 / R2 | [ai-safety-and-evaluation](../10-ai/ai-safety-and-evaluation.md) | PLT-DOC-06 |
| | Model cost report | R4 / R5 | [backend-api](../11-server/backend-api.md) (LLM gateway) | REPORT:llm-cost (from `llm_requests`) |
| Feature freeze (W16, `v1.0.0-rc`) | Release candidate tagged; all documentation complete; a full rehearsal of the final defence | R5 / all | [implementation-plan](../16-delivery/implementation-plan.md) | rc tag; PLT-DOC-01..14; `docs/evidence/defence/rehearsal-<n>.md` |
| Phase 5 (W17–18, `v1.0.0`) | Production deployment; comprehensive technical report; test suite with coverage report; end-to-end system demonstration; demonstration video; individual viva (§17) | all | §3.10 of this file | PLT-DEL-01..16 |

Gate rules (§13.2) that shape this plan: a gate is passed only by a live demonstration on the tagged release; a missed gate leads to a recovery plan within one week; a gate still unmet at the next phase caps the project mark at 80% (two unmet: 70%); features merged after the feature freeze are reverted before judging; a member absent from the final defence without prior approval scores zero.

### 3.8 Consolidated acceptance checklist (Appendix A, p51–52)

Each line is verified live at the final defence on the reference machine. The command column is what we suggest to the examiner; every command is a real program in `/bin` with a `man` page.

| # | Area | Criterion | Target | Ref. | How it is shown live | First gate | Owner | Evidence |
|---|---|---|---|---|---|---|---|---|
| A1 | Team | Registered team of exactly five students | 5 members | §4.1 | Signed registration form; `TEAM_CONTRACT.md` | G0 | R5 | PLT-DOC-14, PLT-DOC-11 |
| A2 | Identity | Registered OS name, logo and version on boot, login, About and `uname` | present | §5 | Boot screen, login screen, Settings → About, `uname -a` | P2 | R3 | GATE:p2/PLT-ID-14 |
| A3 | Boot | Progress driven by real work; no timers in the boot path | 0 timers | BOOT-02 | Static-check report; throttled reload with cache bypassed | P2 | R5 | CI:lint; GATE:p2/BOOT-02 |
| A4 | Boot | Warm boot / cold boot to an interactive desktop | ≤ 1.5 s / ≤ 3.0 s | BOOT-10 | Performance trace on the reference machine; `bootlog` | P3 (CI budget from W7) | R5 | PERF:BOOT-10 |
| A5 | Boot | A cycle in a service manifest halts boot and names the cycle | panic screen | BOOT-04 | As root (credentials on paper), `svcctl require auth lockd`, then `reboot`; the panic screen names `auth → sync → lockd → auth` | P3 | R5 | GATE:p3/BOOT-04 |
| A6 | Boot | Boots to a usable desktop with the network disabled | yes | BOOT-09 | Wait for "Offline-ready", disconnect, `reboot` (on the production URL; on the local stack stop the `app` and `web` containers instead, because disconnecting does not stop localhost) | P3 | R5 | GATE:p3/BOOT-09 |
| A7 | Boot | Safe mode and recovery console reachable from the boot menu | both | BOOT-06 | Hold Esc during boot or `reboot --menu`; choose Safe mode, then Recovery | P3 | R3 | GATE:p3/BOOT-06 |
| A8 | Scheduler | p95 frame time with a CPU-bound process and 10 windows | ≤ 16.7 ms | PROC-05 | `burn --ms 120000 &` three times, `top`, frame meter on, drag 10 windows | P3 | R1 | PERF:PROC-05 |
| A9 | Scheduler | Longest wait for a low-priority process under load | ≤ declared bound | PROC-04 | `sched bound` prints the declared bound (5450 ms in the kernel spec's default configuration); the starvation test (50 priority-0 `burn` jobs, 1 priority-39 job) prints its maximum wait against it | P3 | R1 | PERF:PROC-04 |
| A10 | Memory | Resident memory with a 2× budget workload | ≤ budget | MEM-06 | `memhog --total 512M --procs 8`, Task Manager Memory tab, `free`, `vmstat 1` | P3 | R1 | PERF:MEM-06 |
| A11 | Memory | Page-in of a 5 MB state, local / remote (p95) | ≤ 300 ms / ≤ 2 s | MEM-05 | Restore a minimised window (page-in time printed); benchmark report for both tiers | P3 | R1 | PERF:MEM-05 |
| A12 | Memory | State after page-out and page-in | byte-identical | MEM-03 | Restore a minimised window: its state is intact; the MEM-03 test report shows re-encoded bytes and SHA-256 equal | P3 | R1 | GATE:p3/MEM-03 |
| A13 | VFS | Symlink loop detection | ELOOP at 40 hops | VFS-03 | `ln -s a b; ln -s b a; cat a` | P2 | R2 | GATE:p2/VFS-03 |
| A14 | VFS | Write beyond quota | EDQUOT, no partial data | VFS-06 | `quota`, write past it, then `du` and `df` | P2 | R2 | GATE:p2/VFS-06 |
| A15 | VFS | Directory nesting depth | ≥ 32 levels | VFS-08 | Create and enter a 32-level path; `pwd` | P2 | R2 | GATE:p2/VFS-08 |
| A16 | VFS | Crashed lock holder's lease expires | within lease time | VFS-09 | Two browsers, two users open `/home/shared/plan.md`; end the holder's renderer; `lsof` shows the countdown; the waiter is granted | P3 | R2 | GATE:p3/VFS-09 |
| A17 | Windows | p95 frame time while dragging with 10 windows open | ≤ 16.7 ms | WM-03 | Frame meter while dragging and resizing 10 windows | P2 | R3 | PERF:WM-03 |
| A18 | Offline | Core utilities offline; outbox replayed exactly once | 0 lost, 0 duplicated | OFF-01/02 | Offline: Terminal, Files, Editor, Task Manager, Settings; taskbar "Offline · n queued"; reconnect; client and server tree checksums match and `op_log` has one row per opId | P3 | R5 | GATE:p3/OFF-01; CI:integration |
| A19 | Terminal | Trie autocomplete over ≥ 10,000 entries (p95) | ≤ 1 ms | SYS-03 | `complete --bench` over a 10,000-entry directory | P2 | R3 | PERF:SYS-03 |
| A20 | Database | Fault-injected bulk operations: orphans after rollback | 0 | DB-02 | On the local stack with `FAULT_INJECTION=1` (never on production, C7): as root `debug inject rm 500`, then as the user `rm -r ~/fixtures/tree1000` prints EIO; `fsck` shows 0 orphans; checksum and `quota` unchanged | P3 | R2 | GATE:p3/DB-02 |
| A21 | Database | Metadata queries Q1–Q5 at ≥ 10,000 records (p95) | ≤ 10 ms | DB-05 | Benchmark report with plans; one live query with its plan | P3 | R2 | PERF:DB-05 |
| A22 | AI: RAG | Recall@5 on the evaluation set | ≥ 0.80 | RAG-04 | Evaluation report; hidden examiner queries live | P4 | R4 | REPORT:rag-eval |
| A23 | AI: RAG | Results the user is not allowed to read | 0 | RAG-03 | `rag-leak` suite output; bob searches for alice's mode-600 file live | P4 | R4 | CI:integration; GATE:p4/RAG-03 |
| A24 | AI: RAG | Retrieval latency over ≥ 10,000 chunks (p95) | ≤ 500 ms | RAG-05 | Benchmark report; live `semsearch` over the seeded corpus with the model warm | P4 | R4 | PERF:RAG-05 |
| A25 | AI: Agent | Benchmark instructions completed correctly | ≥ 16 of 20 | AGT-07 | Examiners' hidden benchmark | P5 | R4 | GATE:p5/AGT-07 |
| A26 | AI: Agent | Destructive actions run without confirmation | 0, always | AGT-03 | A hidden destructive instruction: plan, dry run, blast radius, kernel prompt defaulting to N | P4 | R4 | GATE:p4/AGT-03 |
| A27 | AI: Agent | Tool calls triggered by injected file content | 0 | AGT-06 | The examiners' injection fixture; `ai log` | P4 | R4 | GATE:p4/AGT-06 |
| A28 | AI: Pre-fetch | Top-3 accuracy against the best MFU/MRU baseline | higher | PRE-02 | Evaluation report; `predict` | P4 | R4 | REPORT:pre-eval |
| A29 | AI: Pre-fetch | Median launch latency reduction on correct predictions | ≥ 30% | PRE-03 | `predict --latency` | P4 | R1 | PERF:PRE-03 |
| A30 | Delivery | Clean clone to a running system | ≤ 3 commands, ≤ 5 min | §17.1 | `git clone …`, `cd plotinium`, `docker compose up -d --wait`, open `http://localhost:4717` | P2 (timed in CI from W5) | R5 | CI bring-up job (fails above 240 s) |
| A31 | Delivery | Line coverage overall / on `dsa`, `vfs`, `kernel` | ≥ 70% / ≥ 85% | §15.3 | CI coverage report of the tag | P2 | R5 | CI coverage summary on the release |

### 3.9 Required command set by owner (SYS-02, §9.6)

C15 moved the file coreutils to R2, the process and memory commands to R1 and the shell to R3; R4 keeps only the AI commands. The shell (lexer, parser, executor, builtins, pipes, redirection, job syntax, history, `help`, `man`) is R3's. This table matches the per-command owners in [shell-and-terminal](../07-shell/shell-and-terminal.md), which is authoritative.

| Group (§9.6) | Commands | Owner / rev. | Gate |
|---|---|---|---|
| Files | `ls cd pwd mkdir rmdir touch cat cp mv rm ln find tree stat chmod chown du df quota grep` | R2 / R3 | P2 |
| Files (shell builtin) | `echo` | R3 / R2 | P2 |
| Processes | `ps top kill nice renice` | R1 / R3 | P3 |
| Processes (job control) | `jobs bg fg` and trailing `&` | R1 / R3 (implemented in `apps/shell/jobs.ts` by R3) | P3 |
| Memory | `free vmstat pmap` | R1 / R3 | P3 |
| System | `uname` | R1 / R3 | P2 |
| System | `whoami id` | R5 / R3 | P2 |
| System | `su` | R5 / R2 | P3 |
| System | `history help man` | R3 / R4 | P2 |
| System | `reboot` | R5 / R3 | P3 per the shell spec (see §9.2: WM-06 is due at P2) |
| System | `shutdown bootlog` | R5 / R1 | P3 |
| System | `uptime` | R1 / R3 | P3 |
| System | `fsck lsof` | R2 / R5 | P3 |
| AI (§12) | `ai semsearch predict` | R4 / R3 | P4 |
| Terminal features | quoting, pipes, redirection (`>`, `>>`, `<`), sequencing (`;`, `&&`), background jobs (`&`), `$HOME`, `$PATH`, `$USER`, history, `help` and `man` pages | R3 / R4 | P2 (jobs P3) |
| Demo and diagnostic programs (Plotinium design) | `burn`, `memhog`, `swapctl`, `sched bound` (R1); `svcctl`, `debug inject` (R5, root-only, audited); `complete --bench`, `framemeter` (R3) | as listed | P2–P3 |

### 3.10 Demo Day and final deliverables (§17.1, §17.2)

**Demo Day protocol (§17.1)** on a machine the team does not control, 30 minutes:

| Time | Segment | What happens (spec) | What we rely on | Owner |
|---|---|---|---|---|
| 0:00–0:05 | Clean bring-up | Examiner clones and starts with ≤ 3 commands within 5 minutes, then opens the production URL; scored before we speak | A30; images on public GHCR pinned by digest; no credentials in the README (C10) | R5 |
| 0:05–0:08 | Boot | Cold boot in verbose mode; `bootlog --critical-path`; network disconnected and rebooted to show offline boot and core utilities | A4–A6, BOOT-05, BOOT-11, OFF-01 | R5 |
| 0:08–0:18 | System under test | CPU-bound process while dragging windows with the frame meter; 2× memory workload with paging in the Task Manager; fault-injected recursive delete that rolls back; two users contending for a lock; hidden AI prompts (semantic query, agent instruction with a destructive confirmation, pre-fetch demonstration) | A8–A29; OFF-05 hash-only patch deploy if the instructor agrees | all |
| 0:18–0:26 | Individual viva | Each member questioned on a subsystem chosen by the examiners | PLT-TEAM-06 | all |
| 0:26–0:30 | Judges' questions | Architecture, trade-offs, limitations, what we would do differently | PLT-DOC-02 ("two decisions we would reverse"), PLT-DOC-01 (limitations) | all |

**Final deliverables (§17.2):**

| ID | Deliverable | Owner / rev. | Due | Evidence |
|---|---|---|---|---|
| PLT-DEL-01 | The repository tagged `v1.0.0`, with every §15.2 document up to date with the code | R5 / all doc owners | W18 | tag; PLT-DOC-01..14 review checklist |
| PLT-DEL-02 | A production deployment reachable at a public URL, with a demo account for examiners (credentials handed over on paper, C10) | R5 / R2 | W17 (rc), W18 (final) | UptimeRobot history; `/version.json` shows `1.0.0` |
| PLT-DEL-03 | A test and coverage report generated by CI for the tagged release | R5 / R1 | W18 | Release assets |
| PLT-DEL-04 | A 5–7 minute demonstration video that makes sense without narration | R3 / R5 | W17 | `docs/evidence/defence/video.md` (link, duration, title "Plotinium v1.0.0 — …") |
| PLT-DEL-05 | The slides used on Demo Day | R3 / all | W17 | `docs/slides/` (Typst, built in CI) |
| PLT-DEL-06 | A technical report of 20–30 pages | R1 (editor) / R5 | W17 | `docs/report/` (Typst, built in CI); page count checked |
| PLT-DEL-07 | Report ch. 1: introduction and motivation | R5 / R1 | W17 | report |
| PLT-DEL-08 | Report ch. 2: the OS identity and its distinctive idea | R3 / R5 | W17 | report |
| PLT-DEL-09 | Report ch. 3: architecture | R1 / R5 | W17 | report |
| PLT-DEL-10 | Report ch. 4: a chapter for each subsystem (boot R5; processes and scheduling R1; memory R1; VFS R2; window manager R3; offline and sync R5) | as listed / R1 | W17 | report |
| PLT-DEL-11 | Report ch. 5: DSA analysis with benchmarks | R1 (editor; each structure's owner writes) / R2 | W17 | report |
| PLT-DEL-12 | Report ch. 6: database design, integrity and indexing results | R2 / R5 | W17 | report |
| PLT-DEL-13 | Report ch. 7: AI subsystems with evaluation and safety | R4 / R2 | W17 | report |
| PLT-DEL-14 | Report ch. 8: testing | R5 / R1 | W17 | report |
| PLT-DEL-15 | Report ch. 9: limitations and future work | R1 (editor; all contribute) / R5 | W17 | report |
| PLT-DEL-16 | Report ch. 10: an individual contribution statement signed by all five members | R5 (secretary) / all sign | W17 | report; signed scan in `docs/evidence/defence/` |

### 3.11 Team organisation and team contract (§4.1–§4.4, §15.4, §16.4)

| ID | Obligation | Spec § | Kw | Owner / rev. | How met | Evidence | Gate |
|---|---|---|---|---|---|---|---|
| PLT-TEAM-01 | Exactly five students per team | §4.1 | Must | R5 / all | Registration form | PLT-DOC-14 | G0 |
| PLT-TEAM-02 | Each member holds one of the five roles as primary ownership | §4.1 | Must | R5 / all | Roles R1–R5 (C15) on the form and in the contract | PLT-DOC-11 | G0 |
| PLT-TEAM-03 | Every subsystem has a primary owner and a named secondary reviewer | §4.2 | Must | R5 / R1 | `.github/CODEOWNERS` from the ownership matrix in [implementation-plan](../16-delivery/implementation-plan.md); TRC-05 | CODEOWNERS | G0 |
| PLT-TEAM-04 | Every pull request is reviewed and approved by at least one other member; direct pushes to `main` are disabled | §4.2, §15.4 | Must | R5 / R1 | Branch protection: required review, required checks, no force pushes | branch-protection screenshot in `docs/evidence/gates/g0/` | G0 |
| PLT-TEAM-05 | Every member authors meaningful code in at least two subsystems (their own and one other) | §4.2 | Must | all / R5 | Second subsystems (C15): R1 server swap and blob store, `/api/swap`, process and memory commands, AI scheduling hooks; R2 file coreutils and the AI backend; R3 shell lexer, parser and executor, BM25 and citations; R4 LLM gateway; R5 `syncd` client, auth sessions and the offline verifier | `tools/equity.ts` report per package and member | P2 onward |
| PLT-TEAM-06 | Every member is examined on the whole system at each gate and at the final viva | §4.2, §14.4, §16.4 | Must | all / R5 | Weekly teach-backs; mock vivas from W15; "explain your PR" rule | rehearsal notes | every gate |
| PLT-TEAM-07 | Contract states the role and secondary-review assignments | §4.4 | Must | R5 / all | Contract section 1 | PLT-DOC-11 | G0 |
| PLT-TEAM-08 | Contract states the team's definition of "done" for a task | §4.4 | Must | R5 / all | The definition of done in [implementation-plan](../16-delivery/implementation-plan.md), copied verbatim | PLT-DOC-11 | G0 |
| PLT-TEAM-09 | Contract states the meeting and communication schedule and how quickly each member commits to reply | §4.4 | Must | R5 / all | Monday planning (60 min); written stand-ups Monday, Wednesday, Friday; Friday demo (15 min); replies within 24 h on weekdays | PLT-DOC-11 | G0 |
| PLT-TEAM-10 | Contract states how the team decides when members disagree | §4.4 | Must | R5 / all | Majority vote; the primary owner of the affected subsystem breaks ties; escalation to the instructor after 48 h unresolved | PLT-DOC-11 | G0 |
| PLT-TEAM-11 | Contract states what the team does, and by when, if a member stops contributing | §4.4 | Must | R5 / all | Ladder: private message on day 3; team meeting in week 1; instructor in week 2. Triggers: fewer than 2 merged PRs in 2 weeks, 2 missed stand-ups, or outside the equity band for 2 weeks | PLT-DOC-11 | G0 |
| PLT-TEAM-12 | Contract has a signed acknowledgement that marks are moderated individually using the viva, commit history and peer assessment (§16.4) | §4.4 | Must | R5 / all sign | Signature block | PLT-DOC-11 | G0 |
| PLT-TEAM-13 | Small, focused commits with meaningful messages that reference requirement IDs; work tracked on an issue board with an owner for every issue | §15.4 | Should (commit convention recommended) / Must (board, owner) | R5 / R1 | commitlint (`<type>(<scope>): … (<IDs>)`); GitHub Projects board seeded from `docs/requirements.csv` | CI commitlint; board export | G0 |
| PLT-TEAM-14 | Commit authorship is genuine; pair work is credited with co-author trailers; history is never rewritten to misrepresent contributions | §15.4, §18 | Must | all / R5 | Rebase-and-merge (keeps authorship); `Co-authored-by:` trailers | repository history; equity report | always |

### 3.12 AI-native properties, trust boundary and model rules (§3.2, §3.4, §12.5, §12.6)

**Spec: MUST, §3.2.** "Your design must show all four for every AI subsystem you build." Plotinium builds all three (C12), so all 12 cells are required. The mechanisms are fixed in [architecture §3.10](../01-architecture/architecture.md); the cells, IDs and tests are normative in [ai-safety-and-evaluation §3](../10-ai/ai-safety-and-evaluation.md). Owner R4; reviewer R2 for properties 1 and 2 and R1 for properties 3 and 4. First gate: P4 (skeletons at the Week-12 AI checkpoint).

| Property | A. RAG semantic search | B. Agentic shell | C. Predictive pre-fetch |
|---|---|---|---|
| 1. Sees the system through the kernel | **AIN-A1** `AIN-A1 the indexer learns of a write only from the vfs.write event and reads it with read as the session uid` | **AIN-B1** `AIN-B1 every observation the model receives is the datamarked result of exactly one read-only syscall made by the agent's pid` | **AIN-C1** `AIN-C1 the predictor receives launches only through ai.telemetry.read and never reads the telemetry store directly` |
| 2. Acts through typed system calls, not strings | **AIN-A2** `AIN-A2 the indexer writes the index only through ai.index.put and never opens IndexedDB` | **AIN-B2** `AGT-01 model tool input is parsed with Valibot and never reaches eval, Function or the shell parser` | **AIN-C2** `AIN-C2 prefetch jobs act only through mem.prefetch and read-only open` |
| 3. Scheduled by the system | **AIN-A3** `RAG-01 ai.indexer appears in ps with PRI 32 NI 10 and state BLOCKED on ai:embed while indexing` · `MEM-06 ai.embed is declared as one page and evicting it terminates the worker` | **AIN-B3** `AGT-09 kill during a stretched server transaction rolls back and audits killed_rolled_back` | **AIN-C3** `PRE-04 a prefetch job runs at PRI 39 and is paused during a pointer gesture` · `PRE-06 prefetch:app appears in ps while it runs` |
| 4. Informs the system | **AIN-A4** `AIN-A4 a semsearch warms the top-3 result files and moves pending files near hits to the hit class` | **AIN-B4** `AIN-B4 files touched by a committed plan enter the indexer hot class` | **AIN-C4** `AIN-C4 a live residency hint makes reclaim skip the predicted app's pages once per pass` · `AIN-C4 after desktop-interactive the session service pre-fetches the top-k apps and logs them in bootlog` |

**Coupling map (§12.5).** `AI.md` MUST contain the table of spec §12.5 completed for our system: 3 subsystems × 6 columns (scheduler, memory, VFS, shell, database, security). Each cell has the ID `CPL-<A|B|C>-<SCHED|MEM|VFS|SHELL|DB|SEC>` and a named proving test, owned by [ai-safety-and-evaluation](../10-ai/ai-safety-and-evaluation.md). The spec leaves B's memory cell empty; we fill it (C12). Evidence: PLT-DOC-06; the P4 gate. Owner R4 / R2.

**AI trust boundary (§3.4, Must for every subsystem; AIS-02).**

| Principle (§3.4) | Traced under | Proving test titles (owning specs) |
|---|---|---|
| Least privilege: the agent runs with the invoking user's identity, never as root, and cannot raise its own privileges | AGT-04 | `AGT-04 an agent started from a su root shell runs as the real login uid` |
| Plan before acting: a plan the user can inspect and a dry run listing exactly which files it will affect | AGT-02, AGT-03 | `AGT-03 a batch dry run reports overwrites, deletes, mode and owner changes and touched inodes` |
| Confirmation for destructive or irreversible operations | AGT-03 | `AGT-03 the predicate requires confirmation above 20 affected inodes and not at exactly 20` · `AGT-03 an empty answer or a timeout means N and nothing runs` |
| Atomicity: a confirmed plan runs as one transaction or not at all | AGT-05, AGT-09 | `AGT-05 a server fault injected during a batch rolls back both sides with EIO and fsck is clean` |
| Content is data, never instruction | AGT-06, AIS-03 | `AGT-06 INJ-20 executed-unrequested steps are zero with an informed user` · `AIS-03 every INJ-20 case is stopped by at least two defence layers` |
| Auditability: every AI-initiated system call is logged with prompt, plan, user and outcome | AGT-08 | `AGT-08 ai log shows prompt, plan, confirmation and result, and works offline` |
| Graceful absence: when the model is unavailable the OS keeps working and AI degrades with a clear message | RAG-06, OFF-04 | `RAG-06 with the model unavailable semsearch returns keyword results and the notice "Semantic search unavailable — showing keyword matches"` · `OFF-04 offline ai prints the unavailable message, runs nothing, and ai log still works` |
| Litmus test: remove the AI module and rebuild; only pre-fetch hints, natural-language execution and semantic search disappear | AIS-01, ARC-06 | `ARC-06 litmus build with __AI__=false and AI=0 passes every non-AI e2e test and ai, semsearch and predict report command not found` · `AIS-01 the AI-off bundle contains no Transformers.js, ORT or model asset and makes no AI request` |

**Models, cost and offline behaviour (§12.6)**, numbered in [ai-safety-and-evaluation §2](../10-ai/ai-safety-and-evaluation.md):

| §12.6 rule | Kw | ID | Owner / rev. | Proving test titles (owning spec) | First gate |
|---|---|---|---|---|---|
| Choice of model justified on quality, latency, cost, privacy and offline behaviour | Must | AIS-05 | R4 / R5 | `AIS-05 the selection rule picks the cheapest qualifying configuration and applies the 2-task override` | P1 (records), P4 |
| Keys stay on the server: never in the client bundle or the repository; every model call goes through our backend with per-user rate limits | Must | AIS-06, AIS-08 | R4 / R2 | `AIS-06 the client bundle contains no provider SDK, hostname or key pattern` · `AIS-06 /api/llm/plan rejects a request without a session and takes the uid only from the session` · `AIS-08 cassettes contain no credential or auth header` | G0 (gitleaks), P4 |
| Cost accounting: log tokens and cost for every request, set a budget cap, report the total cost of development and the demonstration | Must | AIS-09 | R4 / R5 | `AIS-09 every provider call writes exactly one llm_requests row, including aborted calls charged at the reservation` · `AIS-09 a call that would exceed a cap is refused with EAIUNAVAIL budget before the provider is called` | P4 |
| Graceful degradation: semantic search falls back to keyword search, the agent to the plain terminal with an explanation, and a local pre-fetch model is unaffected | Must | AIS-02 (graceful absence) | R4 / R5 | see the trust-boundary row "Graceful absence" | P4 |
| Reproducible tests: fixed seeds and temperature 0; CI uses recorded model responses. The provisional models reject the temperature parameter, so the instructor's written ruling is recorded; if the rule is not waived, a model that accepts temperature is added (C12) | Must | AIS-07 | R4 / R5 | `AIS-07 CI runs every LLM-dependent test with LLM_MODE=replay and no key` | P1 (ruling asked), P4 |
| The model only proposes; the kernel validates, previews, asks for confirmation, runs and records (§12.3) | Must | AIS-02 | R4 / R1 | covered by the AGT-02, AGT-03, AGT-05 and AGT-08 titles in §3.3 | P4 |

### 3.13 Registered Plotinium design ID prefixes

`tools/traceability.ts` accepts a test title only if its first token is a spec ID (§4.1) or matches a registered prefix below (TRC-02). A spec that introduces a new prefix sends a cross-spec request to this file; until it is registered, the tool reports titles with that prefix as warnings while the spec is Draft and as errors once it is Accepted. Specs not yet written at this revision (12-security, 14-devops, 15-decisions, 16-delivery) register theirs the same way.

| Prefix and form | Meaning | Defined in | Status |
|---|---|---|---|
| `PLT-ID-nn` | Identity and branding obligations of spec §5 | [identity-and-branding](./identity-and-branding.md) | registered |
| `PLT-DOC-nn` | Required documents | this file §3.6 | registered |
| `PLT-DEL-nn` | Final deliverables | this file §3.10 | registered |
| `PLT-TEAM-nn` | Team rules and contract | this file §3.11 | registered |
| `TRC-nn` | This file's own rules | this file §2 | registered |
| `GLO-nn` | Glossary rules | [glossary](./glossary.md) | registered |
| `SPX-nn` | Spec-process rules | [README](../README.md) | registered |
| `ARC-nn` | Architecture decisions | [architecture](../01-architecture/architecture.md) | registered |
| `ABI-nn`, `INV-ABI-n` | System-call ABI decisions and invariants | [syscall-abi](../01-architecture/syscall-abi.md) | registered |
| `SVC-nn` | Boot and service-manager decisions | [boot-and-services](../02-boot/boot-and-services.md) | registered |
| `KPS-nn` | Processes and scheduling decisions | [processes-and-scheduling](../03-kernel/processes-and-scheduling.md) | registered |
| `KMM-nn` | Memory and paging decisions | [memory-and-paging](../03-kernel/memory-and-paging.md) | registered |
| `PVFS-nn` | VFS decisions | [virtual-file-system](../04-vfs/virtual-file-system.md) | registered |
| `WMD-nn` | Window-manager decisions | [window-manager](../05-wm/window-manager.md) | registered |
| `DSN-nn` | UI design-system decisions | [ui-design-system](../05-wm/ui-design-system.md) | registered |
| `SYN-nn` | Offline and sync decisions | [offline-and-sync](../06-sync/offline-and-sync.md) | registered |
| `SHL-nn` | Shell and terminal decisions | [shell-and-terminal](../07-shell/shell-and-terminal.md) | registered |
| `DBD-nn` | Database decisions | [database](../09-database/database.md) | registered |
| `SRV-nn` | Server and backend API decisions | [backend-api](../11-server/backend-api.md) | registered |
| `TST-nn` | Testing and performance decisions | [testing-and-performance](../13-quality/testing-and-performance.md) | registered |
| `DSA-GEN-nn`, `DSA-<TREE\|TRIE\|HEAP\|DAG\|LRU\|HASH\|RING\|BLOOM\|ZORD\|IVT\|DB\|MAP>-nn` | §10 rules and per-structure obligations | [data-structures](../08-dsa/data-structures.md) | registered |
| `AIS-nn` | AI safety, evaluation and model rules | [ai-safety-and-evaluation](../10-ai/ai-safety-and-evaluation.md) | registered |
| `AIN-<A\|B\|C><1-4>` | The 12 AI-native property cells | [ai-safety-and-evaluation](../10-ai/ai-safety-and-evaluation.md) | registered |
| `CPL-<A\|B\|C>-<SCHED\|MEM\|VFS\|SHELL\|DB\|SEC>` | The 18 coupling-map cells | [ai-safety-and-evaluation](../10-ai/ai-safety-and-evaluation.md) | registered |
| `I-A<n>`, `I-B<n>`, `I-C<n>`, `I-S<n>` | Invariants of subsystems A, B, C and of AI safety | the `10-ai/` specs | registered |

`INJ-20` and `AGT-40` are dataset names, not requirement IDs; a title never begins with them.

### 3.14 Obligations stated in section prose (traced under the nearest ID)

The requirement tables do not capture everything the spec says with "must" or states as expected behaviour. Each item below is verified by a test titled with the nearest requirement ID, so it appears in the generated matrix. Titles are copied from the owning spec; "(proposed)" marks a title that the owning spec has not yet adopted (cross-spec requests in §9.2).

| # | Obligation | Spec § · p | Traced under | Proving test title | Owner |
|---|---|---|---|---|---|
| O1 | The PCB holds every field of the §9.1 table (pid, ppid, uid, gid, state, priority, nice, cpuTimeMs, lastRunAt, waitingSince, worker, pageTable, residentBytes, fdTable, waitingOn, exitCode) | §9.1 · p24 | PROC-01 | `PROC-01 every PCB carries the fields listed in spec section 9.1` [U] (proposed) | R1 |
| O2 | Interactive and foreground processes pre-empt background ones at the next slice boundary; non-pre-emptive tasks run to completion | §9.1 · p25 | PROC-03 | `PROC-03 an interactive-band process pre-empts a running background slice at its next yield point` | R1 |
| O3 | A process that exceeds its hard limit is forcibly terminated with `worker.terminate()` | §9.1 · p25 | PROC-05 | `PROC-05 a slice exceeding its hard limit is terminated by the watchdog and the executor is respawned` [B] (proposed) | R1 |
| O4 | The worker pool is sized from `navigator.hardwareConcurrency` | §9.1 · p25 | PROC-05 | `PROC-05 with hardwareConcurrency forced to 4 and ai.embed active, RUN_TOKENS is 1 and a root shell, alice's shell and ai.agent all get executors` | R1 |
| O5 | Clean pages that already have a valid swap copy are dropped without being rewritten | §9.2 · p27 | MEM-03 | `MEM-03 a clean page with a valid swap copy is dropped without any write` | R1 |
| O6 | A page fault makes the process BLOCKED; the page is read and verified; the window shows a "restoring" state, not a blank | §9.2 · p27 | WM-05 | `WM-05 restoring a suspended window shows Restoring with real byte progress and the process pages back in` | R3 / R1 |
| O7 | Thrashing guard: above a page-fault-rate threshold the OS refuses to start new heavy processes and tells the user | §9.2 · p27 | MEM-06 | `MEM-06 thrashing guard: after 5 s above 20 faults/s a heavy spawn fails with EAGAIN and the user is told` | R1 |
| O8 | `/tmp` is world-writable with the sticky bit and cleared on boot (Should); `/mnt` is optional (May) | §9.3 · p28 | VFS-02 | `VFS-02 ls -la / prints root:root rwxr-xr-x for / and rwxrwxrwt for /tmp` | R2 |
| O9 | Sticky bit on `/tmp`: only a file's owner can delete it | §9.3 · p28 | VFS-04 | `VFS-04 sticky /tmp: bob cannot unlink or rename alice's file, the directory owner and root can` | R2 |
| O10 | `chmod` accepts octal and symbolic modes | §9.3 · p28 | VFS-04 | `VFS-04 chmod parses octal and symbolic modes as in the table of 5.4` | R2 |
| O11 | `chown` is root-only | §9.3 · p28 | VFS-04 | `VFS-04 chmod by a non-owner and chown by a non-root user give EPERM` | R2 |
| O12 | Default umask is 022 | §9.3 · p28 | VFS-04 | `VFS-04 umask 022 gives 0644 files and 0755 directories, umask 077 gives 0600 and 0700` | R2 |
| O13 | Hard links are optional, but `nlink` must be maintained correctly either way (we implement hard links) | §9.3 · p28 | VFS-05 | `VFS-05 a hard link raises nlink to 2 and the inode survives the first unlink` | R2 |
| O14 | Lock grants and releases are pushed over the WebSocket | §9.3 · p29 | VFS-09 | `VFS-09 lock grants and releases arrive as pushed control-lane messages` [I] (proposed) | R2 |
| O15 | The losing write is kept as a conflicted copy named like `report (conflict from student, 2026-11-14).md`, and the user is notified | §9.3 · p29 | VFS-10 | `VFS-10 conflicted-copy names handle extensions, dotfiles, counters and the 255-byte limit` · `VFS-10 a stale save shows the conflict banner and the conflicted copy exists` | R2 |
| O16 | Exactly one window has focus; background processes cannot steal focus | §9.4 · p30 | WM-02 | `WM-02 a background process calling window.requestFocus flashes its taskbar button and does not take focus` | R3 |
| O17 | Movement uses pointer capture and `translate3d`, batched per animation frame, never re-laying out the page on every event | §9.4 · p30 | WM-03 | `WM-03 the drag trace shows no forced layout inside pointermove handlers` | R3 |
| O18 | Resize handles on all eight edges and corners; windows kept within the viewport; snapping to screen edges and halves | §9.4 · p30 | WM-04 | `WM-04 each of the 8 resize handles moves only its edges and never goes below minW or minH` · `WM-04 a window cannot be dragged so that its title bar leaves the work area` | R3 |
| O19 | Minimise, maximise and restore animations respect reduced-motion settings; double-clicking a title bar maximises; keyboard shortcuts are documented | §9.4 · p30 | WM-04, WM-07 | `WM-04 with prefers-reduced-motion the minimise animation is skipped and the state applies in the next frame` · `WM-07 help lists every keyboard shortcut` [U] (proposed) | R3 |
| O20 | The taskbar groups running applications by app, marks background activity, and focuses or minimises with a click | §9.4 · p30 | WM-04 | `WM-04 the taskbar groups 3 Terminals under one button with a count badge and shows the activity dot while one runs a job` | R3 |
| O21 | Each outbox operation carries an idempotency key and a logical timestamp; the outbox is replayed in order and the server acknowledges each operation | §9.5 · p31 | OFF-02 | `OFF-02 an ack deletes the op and undo in one transaction and stores server versions` · `OFF-02 every outbox op carries opId, cseq and a Lamport timestamp and replays in cseq order` [U] (proposed) | R5 |
| O22 | Calls travel as `{id, call, args}` and replies as `{id, ok, value \| errno}` | §9.6 · p31 | SYS-01 | `SYS-01 B8 malformed, unknown, oversized and wrong-origin calls fail closed` | R1 |
| O23 | The terminal supports quoting | §9.6 · p31 | SYS-02, SHL-05 | `SHL-05 single quotes keep $HOME literal, double quotes expand it, and unquoted expansions split into fields` | R3 |
| O24 | Stage failure behaviour: POST → "Unsupported browser" screen listing the missing capability; bootloader → fall back to safe mode; kernel init → kernel panic with diagnostics; login → offer guest or offline mode; session restore → clean session, old one kept for recovery | §6.3 · p17 | BOOT-08, BOOT-06, BOOT-14, WM-06 | `BOOT-08 a missing required capability shows the Unsupported browser screen naming it` [E] (proposed) · `BOOT-06 two failed boots in a row open the menu with Safe preselected` · `BOOT-09 offline boot logs in through the offline verifier and shows Offline and n queued` · `WM-06 a corrupt layout record starts a clean session and keeps the old record for recovery` | R5 / R3 |
| O25 | Manifests declare name, requires, critical, weight, timeoutMs, priority and safeMode; shutdown runs the same order in reverse; progress is the weighted fraction of finished nodes | §6.4 · p18 | BOOT-03, BOOT-12, BOOT-02 | `BOOT-12 services stop in reverse topological order` · `BOOT-02 P is non-decreasing over a recorded boot and equals 1 exactly at desktop-interactive` | R5 |
| O26 | The splash shows name, version, truthful progress, the current service and how to reach the boot menu and verbose log | §6.2 Fig. 6.1 · p17 | BOOT-01, BOOT-13 | `BOOT-13 progressbar exposes aria-valuenow equal to round(100·P) and aria-valuetext with the current service` | R3 |
| O27 | The seven §11.3 rules: one transaction per user-visible operation; quota checked inside the transaction with a row lock; invariants checked before commit (no move into own subtree, unique names by a unique index); any error rolls back with one clear error code; the client mirror is atomic; retries are safe through idempotency keys; the isolation level is declared and justified | §11.3 · p35 | DB-02, VFS-06, DB-03, DB-04, OFF-02 | covered by the DB-02, DB-03, DB-04, VFS-06 and OFF-02 titles in §3.3 | R2 |
| O28 | Mandatory fault-injection hook: fail after N of M node operations; reference test `rm -r` of a 1,000-node tree failing at node 500 with checksum, orphan probes and quota unchanged; the same for `mv`, `cp -r`, batch rename and `chmod -R`; repeated live at the final defence | §11.3 · p36 | DB-02 | covered by the DB-02 titles in §3.3; A20 | R2 |
| O29 | §11.4 indexes: unique B-tree on `dentries(parent_ino, name)` mirrored by a compound IndexedDB index on `[parent, name]`; index on `inodes(uid, modified_at)`; hash index on `blobs(sha256)`; B-tree on the lower-cased name with a pattern operator class (optional trigram); vector index only once exact search misses the target | §11.4 · p36 | DB-05, DB-04 | `DB-04 client a duplicate [parent, name] add raises EEXIST` (client index); server index list tested in [09-database](../09-database/database.md) | R2 |
| O30 | The indexer extracts plain text, Markdown and source code at minimum, and chunks respect paragraph and heading boundaries | §12.2 · p38 | RAG-02 | `RAG-02 the chunker extracts plain text, Markdown and source code and never splits inside a paragraph that fits in one chunk` [U] (proposed) | R4 |
| O31 | Each chunk is stored with its inode, offset, content hash and owner. Plotinium stores the inode as a foreign key and never copies owner or mode (C7), so the owner is always current; RAG-03 rests on this | §12.2 · p38, Fig. 12.1 | RAG-03 | `RAG-03 client stores no preview text for chunks of files owned by another uid` | R4 / R2 |
| O32 | Evaluation corpus of at least 200 documents and at least 30 queries with known relevant files | §12.2 · p38 | AIS-04 | `AIS-04 the RAG corpus has at least 200 documents and 30 queries, each with a licence entry and a non-author query writer` | R4 |
| O33 | Telemetry: launch, focus and close events with time of day, day of week, previous app and position in the session, in a bounded ring buffer | §12.4 · p40 | PRE-05 | `PRE-05 each telemetry event records app, kind, time of day, day of week, previous app and session position in a bounded ring` [U] (proposed) · `PRE-05 telemetry events contain no file names, paths or content` | R4 |
| O34 | The model updates incrementally after each launch and falls back to most-frequently-used until it has enough data | §12.4 · p40 | PRE-01 | `PRE-01 the incremental model equals a model rebuilt in batch from the same events` · `PRE-01 with fewer than 50 launches the ranking is time-bucketed MFU with confidence 0` | R4 |
| O35 | Pre-fetch evaluation: at least 500 launch events split chronologically; top-1 and top-3 against MFU and MRU; launch latency with and without pre-fetch; wasted pre-fetch bytes | §12.4 · p40 | PRE-02, AIS-04 | `AIS-04 the PRE evaluation uses at least 500 real launch events` · `PRE-02 the evaluation never trains any method on an event before predicting it` | R4 |
| O36 | Subsystem boundaries are visible in the directory structure | §15.1 · p45 | ARC-01 | `ARC-01 lint fixture importing kernel/ from apps/ fails with no-restricted-imports` | R1 |
| O37 | Secrets never go in the repository or the client bundle; a leaked key is revoked at once and reported in `SECURITY.md` | §18 · p51 | AIS-06, AIS-08 | `AIS-06 the client bundle contains no provider SDK, hostname or key pattern` · `AIS-08 cassettes contain no credential or auth header` | R4 / R5 |
| O38 | Third-party code has a compatible licence, is listed in `THIRD_PARTY.md`, and never stands in for a mandatory DSA structure | §18 · p51 | PLT-DOC-13, DSA-GEN-01 | `PLT-DOC-13 licence scan matches the lockfile against THIRD_PARTY.md and fails on unknown or incompatible licences` [L] | R5 |
| O39 | Study other systems; do not copy their code or another team's code | §18 · p51 | PLT-TEAM-14 | review rule; no test | all |

## 4. Interfaces and data shapes

### 4.1 Requirement ID grammar

```ts
// tools/traceability/ids.ts — Plotinium design
// The 84 spec IDs (spec p3 and the requirement tables). Nothing else is a spec ID.
export const SPEC_ID =
  /^(?:BOOT-(?:0[1-9]|1[0-4])|PROC-0[1-9]|MEM-0[1-8]|VFS-(?:0[1-9]|1[01])|WM-0[1-7]|OFF-0[1-5]|SYS-0[1-3]|DB-0[1-5]|RAG-0[1-6]|AGT-(?:0[1-9]|10)|PRE-0[1-6])$/;

// Registered Plotinium design ID forms (§3.13). Extended only by a PR to this file.
export const PLOTINIUM_ID: readonly RegExp[] = [
  /^PLT-(?:ID|DOC|DEL|TEAM)-\d{2}$/,
  /^(?:TRC|GLO|SPX|ARC|ABI|SVC|KPS|KMM|PVFS|WMD|DSN|SYN|SHL|DBD|SRV|TST|AIS)-\d{2}$/,
  /^INV-ABI-\d{1,2}$/,
  /^DSA-(?:GEN|TREE|TRIE|HEAP|DAG|LRU|HASH|RING|BLOOM|ZORD|IVT|DB|MAP)-\d{2}$/,
  /^AIN-[ABC][1-4]$/,
  /^CPL-[ABC]-(?:SCHED|MEM|VFS|SHELL|DB|SEC)$/,
  /^I-[ABCS]\d{1,2}$/,
];

export type Keyword = 'Must' | 'Should' | 'May';
export type Role = 'R1' | 'R2' | 'R3' | 'R4' | 'R5';
export type Gate = 'G0' | 'P1' | 'P2' | 'P3' | 'P4' | 'FRZ' | 'P5';
export const GATE_ORDER: readonly Gate[] = ['G0', 'P1', 'P2', 'P3', 'P4', 'FRZ', 'P5'];

/** The first whitespace-delimited token of a test title is its requirement ID (C18). */
export function idOfTitle(title: string): string | null {
  const token = title.split(' ', 1)[0] ?? '';
  return SPEC_ID.test(token) || PLOTINIUM_ID.some((re) => re.test(token)) ? token : null;
}
```

### 4.2 `docs/requirements.csv` (generated from §3.3, §3.5, §3.6, §3.10, §3.11, §3.12)

| Column | Type | Example |
|---|---|---|
| `id` | string, matches §4.1 | `VFS-06` |
| `kind` | `spec` or `plotinium` | `spec` |
| `keyword` | `Must`, `Should`, `May` | `Must` |
| `summary` | string, one line | `Per-user hard quotas: EDQUOT with no partial write; df, du and quota are accurate.` |
| `spec_section` | string | `§9.3` |
| `spec_page` | integer | `29` |
| `our_spec` | relative path plus section | `04-vfs/virtual-file-system.md#3` |
| `owner`, `reviewer` | `R1`…`R5`, different | `R2`, `R1` |
| `gate` | `Gate`; for split rows the first gate | `P2` |
| `stretch` | boolean | `false` |
| `evidence` | `;`-separated evidence codes (§4.3) | `GATE:p2/VFS-06;CI:browser;CI:integration` |

`tools/seed-issues.ts` creates one issue per row: title `<id> <summary>`, labels `req:<id>`, `role:<owner>`, `kw:<keyword>`, milestone `<gate>`, assignee the member holding the owner role, reviewer the member holding the reviewer role.

### 4.3 Evidence paths (normative)

```abnf
evidence   = ci / perf / gate / report / doc
ci         = "CI:" project                 ; JUnit XML of the project, attached to the GitHub Release of the gate tag
project    = "unit" / "browser" / "integration" / "bench" / "ai-eval" / "tools"   ; Vitest projects
           / "e2e" / "a11y" / "perf" / "bringup"                               ; Playwright projects
           / "lint"                                                               ; lint, docs and build checks
perf       = "PERF:" req-id                ; docs/evidence/perf/<req-id>/<YYYY-MM-DD>-lab.json
gate       = "GATE:" gate-dir "/" name     ; docs/evidence/gates/<gate-dir>/<name>.<png|webm|txt|json.gz|md>
gate-dir   = "g0" / "p1" / "p2" / "p3" / "p4" / "frz" / "p5"
report     = "REPORT:" name                ; docs/evidence/reports/<name>.md
doc        = "DOC:" path ["#" anchor]      ; a root document or a file under docs/
```

Every `PERF` file MUST record the machine (lab-spec or not), CPU model, `hardwareConcurrency`, RAM, OS, Chrome version and channel, the commit, the sample count and p50/p95/p99. Only a file whose machine is `lab-spec` counts as gate evidence (spec p3, Measurement). Pilot figures (`docs/evidence/pilot/`) never count.

### 4.4 Traceability output

```ts
// tools/traceability/types.ts — Plotinium design
export interface TestRef {
  title: string;               // full title, beginning with the ID
  project: 'unit' | 'browser' | 'integration' | 'bench' | 'ai-eval' | 'tools'   // Vitest projects
         | 'e2e' | 'a11y' | 'perf' | 'bringup'                                   // Playwright projects
         | 'lint' | 'manual';
  file: string;                // repo-relative path, or the GATE evidence path for manual checks
  status?: 'passed' | 'failed' | 'skipped' | 'quarantined' | 'not-run'; // from the JUnit of a tag
}

export interface TraceRow {
  id: string;
  kind: 'spec' | 'plotinium';
  keyword: Keyword;
  gate: Gate;
  stretch: boolean;
  owner: Role;
  reviewer: Role;
  ourSpec: string;
  tests: TestRef[];
  evidence: { code: string; exists: boolean }[];
  issues: number[];            // GitHub issue numbers labelled req:<id>
  prs: number[];               // merged PRs whose title or commits cite the ID
  verdict: 'verified' | 'missing-test' | 'failing' | 'missing-evidence' | 'not-due' | 'stretch-not-built';
}

export interface GateReport {
  gate: Gate;
  tag: string;                 // e.g. v0.3.0
  generatedAt: string;         // ISO 8601
  rows: TraceRow[];
  pass: boolean;               // true only if every due Must and Should row is 'verified'
}
```

`tools/traceability.ts --gate P3 --tag v0.3.0` writes `docs/evidence/gates/p3/traceability.json` and a Markdown rendering `traceability.md` next to it; the report's appendix uses the final one.

## 5. Algorithms and invariants

### 5.1 Building the matrix

1. Parse `docs/requirements.csv` into a map `id → row` (hash map, O(R) for R rows).
2. Collect test titles: `vitest list --json` for each Vitest project, `playwright test --list --reporter=json` for e2e, the named checks of the lint and docs jobs, and the manual rows from §3.3 (tag `[M]`). O(T) for T titles.
3. For each title, `idOfTitle` (§4.1). An unknown first token is an error (TRC-02); a known ID absent from the CSV is an error; otherwise append a `TestRef` to the row. O(T).
4. On a tag, read the JUnit files from the release and set each `TestRef.status`. O(T).
5. Resolve evidence codes to paths (§4.3) and check existence. O(E).
6. Query issues and merged PRs by label and ID mention (GitHub API, cached). O(I + P).

Total O(R + T + E + I + P) time and O(R + T) memory; with about 250 rows and about 1,500 titles it runs in seconds.

### 5.2 Gate check

```text
due(row, g)  := row.gate ≤ g in GATE_ORDER  and  not row.stretch  and  row.keyword ∈ {Must, Should}
verified(row) := ∃ t ∈ row.tests : t.status = passed
                 or (every t in row.tests is manual and every GATE evidence of the row exists and was reviewed)
gate g passes := ∀ row : due(row, g) ⇒ verified(row) ∧ all evidence of row exists
```

A Should row with a committed written justification (`docs/adr/`) is marked `not-due`. A stretch row that was built is checked like a Must from the gate at which it is shown.

### 5.3 Invariants

- **T-1 (TRC-01).** The set of spec IDs in §3.3 equals the set matched by `SPEC_ID`, which has exactly 84 members.
- **T-2 (TRC-05).** For every row, `owner ≠ reviewer`.
- **T-3 (TRC-03).** A skipped test never verifies a row (`describe.runIf(IMPLEMENTED)` skips report `skipped`).
- **T-4.** Gates are monotone: a row verified at gate g must still be verified at every later gate (no regressions); the gate check re-runs all earlier rows.
- **T-5.** Every evidence file under `docs/evidence/perf/` names its machine; `machine ≠ lab-spec` files are excluded from verification.

## 6. Errors and edge cases

### 6.1 Traceability edge cases

| Case | Rule |
|---|---|
| A test proves two requirements | Only the first token counts. Write a second test for the other ID, or list the other ID as "contributes" in the owning spec's §2 table. |
| A requirement is verified only live (`[M]`) | The gate evidence file is committed during the rehearsal and at the gate; a second member reviews it in the evidence PR. |
| A test is quarantined as flaky | Counts as not passed. A gate cannot be tagged while any gate-relevant test is quarantined ([testing-and-performance](../13-quality/testing-and-performance.md)). |
| A performance test ran on a machine that is not the lab-spec machine | Tracking only, not evidence (T-5). The gate uses the latest lab-spec run. |
| A `dsa/` module still has `IMPLEMENTED = false` at its gate | Its tests are skipped, so the row fails (T-3). The owner, not a library, must implement it (§10.2). |
| A May item (MEM-08, AGT-10) is not built | The row stays with verdict `stretch-not-built`; it is never due. |
| A Should item is not met | A decision record in `docs/adr/` before the gate, justifying the choice in writing (spec p3). None is planned. |
| The spec is amended | TRC-08: rows updated within 2 working days; the amendment number is logged in §9.3. |
| A pilot figure is offered as evidence | Rejected. Pilot figures are labelled *pilot figure — re-measure on the lab machine* and are never gate evidence. |
| The examiner's machine is slower than the lab spec on Demo Day | The lab-spec evidence is authoritative; we show the LoAF attribution and never change settings to hide a miss ([demo readiness in implementation-plan](../16-delivery/implementation-plan.md)). |
| The local stack has no LLM key on Demo Day | AI prompts run on the production URL (agreed with the instructor, §9.1 Q4); locally the agent shows graceful absence (AIS-02, OFF-04). |
| Fault injection on Demo Day | Only on the local stack with `FAULT_INJECTION=1`; never on production (C7). A20 is shown there. |

### 6.2 Errno coverage map

Every errno the system can return has at least one requirement whose tests assert it. The errno set is C3; numbers, meanings, `detail.reason` values and mappings are normative in [syscall-abi](../01-architecture/syscall-abi.md). "(proposed)" marks an errno for which no owning spec has a test title yet; those are cross-spec requests (§9.2).

| Errno | Kind | Returned when (summary) | Traced under | Example test title (owning spec) |
|---|---|---|---|---|
| ENOENT | spec §9.3 | A path component does not exist | VFS-03, VFS-05, AGT-02 | `VFS-03 a missing component gives ENOENT and a file used as a directory gives ENOTDIR` |
| EEXIST | spec §9.3 | The target name already exists | DB-04 | `DB-04 client a duplicate [parent, name] add raises EEXIST` |
| ENOTDIR | spec §9.3 | A directory was expected | VFS-03 | `VFS-03 a trailing slash on a regular file gives ENOTDIR` |
| EISDIR | spec §9.3 | A file operation was applied to a directory | VFS-07 | `VFS-07 writing to a directory fails with EISDIR` (proposed) |
| ENOTEMPTY | spec §9.3 | `rmdir` on a non-empty directory | VFS-07 | `VFS-07 rmdir of a non-empty directory fails with ENOTEMPTY` (proposed) |
| EINVAL | spec §9.3 | A directory would move into its own subtree; schema validation failure | VFS-07, DB-03, AGT-02 | `VFS-07 moving a directory into its own subtree gives EINVAL` |
| EACCES | spec §9.3 | A permission check fails | VFS-04, AGT-02 | `VFS-04 as bob, cat /home/alice/notes.md gives EACCES` |
| EPERM | spec §9.3 | Reserved for the owner or root; missing capability or confirmation token; mutation of a synthesised file | VFS-04, AGT-03, AGT-04, PVFS-09 | `VFS-04 chmod by a non-owner and chown by a non-root user give EPERM` |
| ELOOP | spec §9.3 | More than 40 symlink hops | VFS-03 | `VFS-03 a chain of 40 symlinks resolves and a chain of 41 gives ELOOP` |
| EDQUOT | spec §9.3 | The byte or inode quota would be exceeded | VFS-06, AGT-02 | `VFS-06 rejects a write beyond quota with EDQUOT and no partial data` |
| EBUSY | spec §9.3 | Locked by another session; stale fence; lock timeout | VFS-09 | `VFS-09 a write with a stale fence gets EBUSY and its bytes are kept as a conflicted copy` |
| ENAMETOOLONG | spec §9.3 | Name over 255 bytes or path over 4096 bytes | VFS-08 | `VFS-08 a 255-byte name works and a 256-byte name gives ENAMETOOLONG` |
| ESRCH | Plotinium (C3) | No such process, or a frame from an idle executor or foreign pid | SYS-01 | `SYS-01 a syscall frame from an idle executor or with a foreign pid gets ESRCH and a security audit record` |
| ENOSYS | Plotinium (C3) | Unknown call name, or a call not allowed on the port | ABI-03, ABI-15 | `ABI-15 a view port answers ENOSYS for write, unlink and spawn` |
| EIO | Plotinium (C3) | Storage or injected fault; the server rejected the operation | DB-02, AGT-05 | `DB-02 rm -r of 1,000 nodes with a server fault at node 500 prints EIO synchronously and leaves checksum, orphans and quota unchanged on both sides` |
| EAGAIN | Plotinium (C3) | Retryable condition: stale plan, retries exhausted, process limit, thrashing guard, rate limit | AGT-05, PROC-09, MEM-06 | `AGT-05 a change between dry run and commit returns EAGAIN stale-plan and nothing changes` · `PROC-09 spawning up to PROC_MAX processes then one more fails with EAGAIN and leaks nothing` |
| ECANCELED | Plotinium (C3) | Operation cancelled (killed process, caught signal) | AGT-09, ABI-09 | `AGT-09 kill during batch phase 1 gives ECANCELED and nothing is written` |
| ETIMEDOUT | Plotinium (C3) | A deadline passed | BOOT-07 | `BOOT-07 a service start that exceeds timeoutMs fails with ETIMEDOUT and is retried with back-off` (proposed) |
| EBADF | Plotinium (C3) | Invalid or closed file descriptor | SYS-01 | `SYS-01 read on a closed descriptor fails with EBADF` (proposed) |
| EMFILE | Plotinium (C3) | Per-process descriptor limit reached | SYS-01 | `SYS-01 opening one descriptor beyond the per-process limit fails with EMFILE` (proposed) |
| ENOTTY | Plotinium (C3) | Operation needs an interactive terminal | AGT-03 | `AGT-03 a destructive plan with no controlling TTY is refused with ENOTTY` |
| EPIPE | Plotinium (C3) | Write to a pipe with no reader | SYS-02 | `SYS-02 write to a pipe with no reader returns EPIPE and raises SIGPIPE` |
| EXDEV | Plotinium (C3) | Rename or hard link across storage boundaries (`/tmp` is a separate tmpfs) | VFS-07, VFS-05 | `VFS-07 mv across /tmp gives EXDEV and the command falls back to copy and delete` |
| EAIUNAVAIL | Plotinium (C3) | The LLM gateway is offline, rate-limited, over budget, has no key, or the upstream failed | AIS-09, OFF-04 | `AIS-09 a call that would exceed a cap is refused with EAIUNAVAIL budget before the provider is called` |
| EAIREFUSED | Plotinium (C3) | The model refused the request | AGT-02 | `AGT-02 a model refusal returns EAIREFUSED, runs nothing and is audited` (proposed) |

The memory spec requests an additional `ENOMEM` for an allocation larger than the whole budget (until it is registered in C3 it is reported as EAGAIN `nomem`); this map gains a row if the request is accepted.

## 7. Performance budgets

Every numeric target in the spec, in one place, with the Plotinium budgets that support them. Authoritative measurements run on the lab-spec machine in current stable Chrome (spec p3); budgets are enforced from `tests/performance/budgets.json` ([testing-and-performance](../13-quality/testing-and-performance.md)).

| ID | Metric | Target | Source |
|---|---|---|---|
| BOOT-10 | Warm boot / cold boot to desktop-interactive | ≤ 1.5 s / ≤ 3.0 s | Spec |
| BOOT-10 | Boot-critical main-thread JS | ≤ 60 KB gzip | C13 |
| PROC-05, WM-03 | p95 frame duration (Chrome trace) with a CPU-bound process and 10 windows / while dragging 10 windows | ≤ 16.7 ms, and 0 LoAF over 50 ms from our scripts | Spec; method C13 |
| ARC-04 | Main-thread OS script per frame, p95 | ≤ 4 ms | Spec Fig. 8.1 label; C2 |
| PROC-04 | Longest wait of a low-priority runnable process | ≤ declared W = (p+1)·T_age + ⌈(N−1)/E⌉·(Q+δ) + H_kill, H_kill ≈ 400 ms | Spec; C13 |
| PROC-09 | 256 mostly sleeping processes | frame p95 ≤ 16.7 ms; syscall round trip p95 ≤ 1 ms | Spec (Should); syscall budget Plotinium design |
| MEM-01 | Default memory budget | 256 MB; reclaim starts at 85% | Spec; C13 |
| MEM-05 | 5 MB page-in, p95 | ≤ 300 ms local; ≤ 2 s remote | Spec |
| MEM-06 | Accounted resident memory with a 2× workload | never above budget for more than 1 s (spec); never above budget (our reservation-based admission) | Spec; C13 |
| VFS-03 / VFS-08 | Symlink hops / nesting / name / path | ELOOP after 40 / ≥ 32 levels / ≤ 255 bytes / ≤ 4096 bytes | Spec |
| VFS-09 | Crashed holder's lease expiry | within the lease time (TTL 30 s, 15 s demo profile; heartbeat TTL/3); tested at TTL + 0.5 s | Spec; C6 |
| VFS-09 | Server lock-grant latency, 50 clients, p95 | ≤ 50 ms | Plotinium design |
| SYS-03 | Trie prefix lookup, p95, ≥ 10,000 entries | ≤ 1 ms | Spec |
| DB-05 | Q1–Q5, p95, ≥ 10,000 records | ≤ 10 ms (we measure at 100,000) | Spec |
| RAG-02 | Index consistency for a 50 KB text file | ≤ 30 s | Spec |
| RAG-04 | Recall@5 on our evaluation set | ≥ 0.80, MRR reported | Spec |
| RAG-05 | Retrieval p95 over ≥ 10,000 chunks (warm model) | ≤ 500 ms; cold reload reported separately | Spec; C13 |
| AGT-03 | Plan size that forces confirmation | > 20 inodes | Spec |
| AGT-07 | Examiners' benchmark / our AGT-40 | ≥ 16 of 20 / median ≥ 36 of 40 | Spec / Plotinium design |
| AGT (time to plan) | Agent time to plan, p95, measured from the server | ≤ 15 s | Plotinium design |
| PRE-01 | One prediction | ≤ 5 ms | Spec |
| PRE-03 | Median launch-latency cut on correct predictions | ≥ 30% | Spec |
| PRE-04 | Pre-fetch start conditions | priority 39, idle ≥ 2 s, confidence ≥ θ, memory free | Spec; C12 |
| §17.1 | Clean bring-up | ≤ 3 commands and ≤ 5 min (CI fails a release above 240 s) | Spec; C14 |
| §15.3 | Line coverage | ≥ 70% overall; ≥ 85% on `dsa/`, `vfs/`, `kernel/` | Spec; C14 |

## 8. Test plan

| Test title | Level | Runs |
|---|---|---|
| `TRC-01 every one of the 84 spec IDs appears exactly once in the master matrix with every column filled` | docs lint | every PR touching `specs/**` |
| `TRC-02 traceability fails on a test title whose first token is neither a spec ID nor a registered prefix` | unit | every PR |
| `TRC-02 traceability accepts PLT-ID-13, ARC-02, AIN-A2, CPL-A-MEM and I-A7 and rejects BOOT-15, VFS-6 and XYZ-01` | unit | every PR |
| `TRC-03 gate check fails when a Must due at the gate has only skipped tests` | unit | every PR |
| `TRC-03 gate check passes a manual row only when its gate evidence file exists and was reviewed` | unit | every PR |
| `TRC-03 gate check on the tag lists every due row as verified` | release | each gate tag |
| `TRC-04 the Appendix A checklist for the gate is committed and signed by R5 and one other member` | manual | each gate |
| `TRC-05 owner and reviewer differ on every row and match CODEOWNERS for the implementing paths` | docs lint | every PR touching `specs/**` or `.github/CODEOWNERS` |
| `TRC-06 every evidence path in the gate report exists in the repository or in the release assets` | release | each gate tag |
| `TRC-07 no row references a topic section of a spec whose status is Accepted` | docs lint | every PR touching `specs/**` |
| `TRC-08 the amendment log lists every posted spec amendment with the date it was applied` | manual | weekly |

## 9. Open questions and cross-spec requests

### 9.1 Open questions (for the instructor unless stated)

- Q1 (R5, W1): the exact gate dates, and the published lab-spec machine (W2). The PERF evidence and the executor count depend on the latter.
- Q2 (R4, before W4): written agreement that recorded cassettes, fixed seeds and 3 live runs satisfy the §12.6 temperature-0 rule, since the provisional models reject the temperature parameter (AIS-07, C12).
- Q3 (R2, before P3): is a fault-injected `rm -r` on the local compose stack acceptable for the Demo Day line "a fault-injected recursive delete that rolls back", given that fault injection is never enabled on production (C7)?
- Q4 (R4, before P4): do the hidden AI prompts run on the production URL? The local stack has no model key (keys stay on the server, §12.6).
- Q5 (R2, before P3): is two browser profiles on one machine acceptable as a fallback for §7.3 "two users on two machines" (VFS-09) if a second machine is not available?
- Q6 (R5, before FRZ): may we deploy a hash-only patch tag during Demo Day to show OFF-05 after the freeze?
- Q7 (team, W3): should the generated traceability matrix go into the report as an appendix, given the 30-page ceiling (§17.2)?

### 9.2 Cross-spec requests

- **To every spec author:** adopt the owner, reviewer and gate of your rows in §3.3 or send a change request; include the listed test titles (or better ones with the same ID) in your §8; tell this file your exact section numbers once your spec is accepted (TRC-07); register any new ID prefix here (§3.13).
- **To [08-dsa/data-structures.md](../08-dsa/data-structures.md):** confirm the structure-to-ID mapping of §3.5 and the first gate of each structure; explain in `DSA.md` why the radix trie keeps the §10.1 bounds.
- **To [03-kernel/processes-and-scheduling.md](../03-kernel/processes-and-scheduling.md):** confirm that `sched bound` and the starvation test are the Appendix A line A9 demonstration; adopt the proposed titles of O1 and O3 (PCB fields, watchdog termination) or name the tests that cover them.
- **To [03-kernel/memory-and-paging.md](../03-kernel/memory-and-paging.md):** confirm the A11 and A12 demonstrations (page-in time printed on restore; the MEM-03 byte-identity report); the `ENOMEM` request is noted in §6.2.
- **To [10-ai/agentic-shell.md](../10-ai/agentic-shell.md):** add a test for a model refusal returning EAIREFUSED (§6.2, proposed title); the AGT titles in §3.3 are copied from your §8.
- **To [10-ai/ai-safety-and-evaluation.md](../10-ai/ai-safety-and-evaluation.md):** this file uses your AIN, AIS and CPL IDs and titles (§3.12) and does not number the §12.6 rules separately; own the formats of REPORT:rag-eval, agent-eval, agent-safety and pre-eval.
- **To [04-vfs/virtual-file-system.md](../04-vfs/virtual-file-system.md):** add tests for EISDIR and ENOTEMPTY (§6.2) and for lock grants and releases being pushed on the control lane (O14), or name the tests that cover them.
- **To [01-architecture/syscall-abi.md](../01-architecture/syscall-abi.md):** add tests for EBADF and EMFILE (§6.2); confirm that every errno of C3 appears in at least one owning-spec title.
- **To [06-sync/offline-and-sync.md](../06-sync/offline-and-sync.md):** adopt the proposed O21 title (every outbox op carries opId, cseq and a Lamport timestamp and replays in cseq order).
- **To [10-ai/rag-semantic-search.md](../10-ai/rag-semantic-search.md) and [10-ai/predictive-prefetch.md](../10-ai/predictive-prefetch.md):** adopt the proposed O30 (chunker formats and paragraph boundaries) and O33 (telemetry event fields) titles.
- **To [13-quality/testing-and-performance.md](../13-quality/testing-and-performance.md):** confirm the evidence grammar of §4.3 (it uses your project names and your `docs/evidence/perf/<req-id>/<YYYY-MM-DD>-lab.json` path) and the PERF file fields; add every §7 row to `budgets.json`.
- **To [14-devops/deployment-and-ci.md](../14-devops/deployment-and-ci.md):** attach every project's JUnit XML and the coverage summary to each GitHub Release; run `tools/traceability.ts --gate <g>` on every gate tag and fail the release when `pass` is false.
- **To [16-delivery/backlog.md](../16-delivery/backlog.md):** seed issues from `docs/requirements.csv` (§4.2) with milestones G0, P1, P2, P3, P4, FRZ, P5.
- **To [16-delivery/implementation-plan.md](../16-delivery/implementation-plan.md):** write `TEAM_CONTRACT.md` to PLT-TEAM-07..12; confirm the command owners in §3.9 (in particular `whoami`, `id` and `su` under R5 after C15 moved auth sessions to R5).
- **To [02-boot/boot-and-services.md](../02-boot/boot-and-services.md):** own O24–O26; adopt the proposed titles for an Unsupported-browser POST failure (O24) and for a service start that exceeds `timeoutMs` returning ETIMEDOUT (§6.2).
- **To [05-wm/window-manager.md](../05-wm/window-manager.md):** the Task Manager must cover PROC-08, MEM-07 and PRE-06; own O16–O20. Adopt the proposed title `WM-07 help lists every keyboard shortcut` (O19) or name the test that covers documented shortcuts.
- **To [07-shell/shell-and-terminal.md](../07-shell/shell-and-terminal.md) and [02-boot/boot-and-services.md](../02-boot/boot-and-services.md):** `reboot` is scheduled for P3, but WM-06 (layout restored after a reboot) is due at P2 and the phase plan's P2 script runs `reboot`; either bring `reboot` to P2 or state that P2 shows WM-06 with a page reload (which runs the full boot). Also confirm the command-owner table of §3.9 and the Appendix A commands (`complete --bench` for A19, `predict --latency` for A29, `mkdir -p` for A15); ship a man page for every command in §3.9.
- **To [09-database/database.md](../09-database/database.md):** publish the constraint-to-errno mapping used by the DB-04 test and the server index list behind O29. Adopt the proposed DB-01 and DB-02 titles of §3.3.
- **To [12-security/security-model.md](../12-security/security-model.md):** own the OFF-03 canary scan and the rule that examiner credentials are handed over on paper. Adopt the proposed OFF-03 titles of §3.3.

### 9.3 Amendment log

| Amendment | Date posted | Date applied | Rows changed |
|---|---|---|---|
| none (specification v1.0, September 2026) | — | — | — |
