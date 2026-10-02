# Backlog

| Field | Value |
|---|---|
| Title | Plotinium backlog: the work breakdown with an owner, a reviewer, a week, an estimate and acceptance criteria for every task |
| Status | Draft v0.1, 2026-09-25 |
| Primary owner | R5 QA/DevOps & Integration Engineer (keeps the board and runs the coverage check) |
| Secondary reviewer | R2 VFS / Database Engineer |
| Must be demonstrable at | **G0 Registration (W2):** the board is seeded from `backlog.csv` and every issue has an owner (PLT-TEAM-13). **P1 defence (W4):** this file is the "work breakdown with an owner for every task" of spec §13.1, with the coverage check green. **Every Monday to P5:** re-estimated, re-assigned and re-checked at planning. |
| Requirement IDs covered | Spec §13.1 (Phase 1 work breakdown), §15.4 (issue board with an owner for every issue); PLT-TEAM-13, TRC-01, TRC-05; every one of the 218 requirement IDs of the [traceability matrix](../00-product/requirements-traceability.md) (84 spec IDs and 134 Plotinium design IDs, ranges expanded) appears in at least one issue (§3.4); Plotinium design IDs PLN-05, PLN-06, PLN-14 of the [implementation plan](./implementation-plan.md) |
| Related specs | [Implementation plan](./implementation-plan.md) · [Sprint 01](./sprint-01.md) · [Requirements traceability](../00-product/requirements-traceability.md) · [Spec index](../README.md) · [Testing and performance](../13-quality/testing-and-performance.md) · [Deployment and CI](../14-devops/deployment-and-ci.md) · [Stack decisions](../15-decisions/stack-decisions.md) · [Data structures](../08-dsa/data-structures.md) |

---

## 1. Purpose and scope

This file is the team's work breakdown from Week 1 to Week 18: **216 issues, 652.5 estimated hours**, grouped into 22 epics. Every issue names the requirement IDs it serves, the spec section it implements, one owner role and a different reviewer role, the target week and gate, an estimate in hours, its dependencies and its acceptance criteria. Acceptance criteria are written as test titles that begin with the requirement ID (C18) or as named evidence files, so an issue is ready the moment it is written (definition of ready, [implementation-plan §3.8](./implementation-plan.md)).

`backlog.csv` in this folder is the machine-readable copy with the same rows. `tools/seed-issues.ts` (or the `gh` script of issue PLT-021) creates one GitHub issue per row. The board, not this file, is the live record once seeded; this file is regenerated from the board export before each gate and at P1.

Out of scope: the calendar, capacity model, rituals and gate scripts (see [implementation-plan.md](./implementation-plan.md)) and the day-by-day plan of Weeks 1–2 (see [sprint-01.md](./sprint-01.md)). The designs themselves live in the linked specs.

## 2. Requirements table

| ID | Summary | Spec § | How verified |
|---|---|---|---|
| §13.1 (Phase 1) | Spec: MUST. A work breakdown with an owner for every task is a Phase 1 deliverable | §13.1 | This file at P1; board export in `docs/evidence/gates/p1/` |
| §15.4 | Spec: MUST (board and owner) / SHOULD (commit convention). Work is tracked on an issue board with an owner for every issue | §15.4 | Board export; `PLN-06` lint |
| PLT-TEAM-13 | Small commits referencing requirement IDs; an issue board with an owner for every issue | §15.4 | commitlint; seeded board |
| TRC-01 | Every spec ID has a traceability row; the backlog seeds one or more issues per row | p3 | §3.4 of this file |
| PLN-05 | Plotinium design. Every requirement ID of the traceability matrix, Must, Should and May, appears in at least one issue of this file | — | `PLN-05` coverage check (§8) |
| PLN-06 | Plotinium design. Every issue has all the fields of §4.1; owner ≠ reviewer; estimate ≤ 6 h; every dependency exists and is scheduled no later than the dependent issue; the dependency graph is acyclic | — | `PLN-06` backlog lint (§8) |
| PLN-14 | Plotinium design. An issue owned outside the owner's C15 area (a loan) is reviewed by that area's primary owner; loans never change CODEOWNERS or the requirement's owner in the traceability matrix | §4.2 | Review; the loan table in §3.2 |

## 3. Design (normative)

### 3.1 How to read an issue

- **ID** `PLT-###` is the issue key. It is not a requirement ID: a test title never begins with it, and the traceability tool ignores it.
- **Requirement IDs** are spec IDs (BOOT, PROC, MEM, VFS, WM, OFF, SYS, DB, RAG, AGT, PRE) or registered Plotinium prefixes ([traceability §3.13](../00-product/requirements-traceability.md)). `§x.y` marks an unnumbered spec obligation.
- **Owner / rev.** are roles (C15): R1 Kernel, R2 VFS/DB, R3 WM/UI, R4 AI, R5 QA/DevOps. The owner does the work and opens the PR; the reviewer approves it. "(on loan)" in the title marks a task done outside the owner's C15 area to balance the load (PLN-14).
- **Week** is the week the issue must be merged by, relative to Week 1 (the calendar is in [implementation-plan §3.2](./implementation-plan.md)). **Gate** is the milestone the issue belongs to: G0 (W1–W2), P1 (W3–W4), P2 (W5–W7), P3 (W8–W11), P4 (W12–W14), FRZ (W15–W16), P5 (W17–W18).
- **Est. h** is the owner's working time in hours, excluding review (review time is budgeted separately in the capacity model).
- **Base** is the starting point: `new` (nothing exists), `scaffold` (interfaces, tests or templates exist; the owner writes the implementation) or `ai-draft` (an AI-assisted implementation exists or is being produced in parallel; the owner reviews it against the spec, tests it, measures it, fixes it and must be able to explain every line). 123 issues are `new`, 18 `scaffold` and 75 `ai-draft`. **An `ai-draft` estimate assumes the draft exists; if it does not, the issue is re-estimated at Monday planning (typically ×2) and the scope-cut list is consulted** ([implementation-plan §3.13](./implementation-plan.md)).
- **Mandatory data structures are never `ai-draft`.** The `dsa/` issues (E05) are written by their owners from first principles (§10.2, C16); only interfaces, tests and benchmarks exist as scaffold.

### 3.2 Summary

**Issues and hours by epic.**

| Epic | Issues | Hours | Owners (hours) |
|---|---|---|---|
| E00 Team, registration and process | 10 | 34.5 | R1 5, R2 5, R3 8.5, R4 9, R5 7 |
| E01 Repository, CI and tooling | 8 | 22 | R2 2, R4 8, R5 12 |
| E02 Stack decisions and spikes | 16 | 50.5 | R1 8, R2 15.5, R3 5, R4 16.5, R5 5.5 |
| E03 Phase 1 documents and defence | 10 | 34.5 | R1 9, R2 6.5, R3 10, R4 4.5, R5 4.5 |
| E04 Protocol and system-call ABI | 1 | 3 | R1 3 |
| E05 Data structures (dsa/, team-written) | 11 | 42.5 | R1 16, R2 5, R3 11, R4 3, R5 7.5 |
| E06 Kernel: processes and scheduling | 13 | 41 | R1 38, R3 3 |
| E07 Kernel: memory and paging | 6 | 19 | R1 17, R3 2 |
| E08 VFS client and file commands | 10 | 28.5 | R2 28.5 |
| E09 Database and server VFS | 10 | 32.5 | R2 32.5 |
| E10 Sync, locks and offline | 7 | 21 | R3 5, R5 16 |
| E11 Boot and services | 9 | 31 | R3 12, R5 19 |
| E12 Window manager, UI and apps | 18 | 53.5 | R3 45, R4 8.5 |
| E13 Shell, terminal and commands | 8 | 16.5 | R3 6.5, R4 8, R5 2 |
| E14 Server API, auth and security | 5 | 11 | R1 2, R2 1.5, R4 4, R5 3.5 |
| E15 AI A: RAG semantic search | 9 | 27 | R1 2, R2 5, R3 3, R4 17 |
| E16 AI B: agentic shell | 9 | 24.5 | R1 2, R2 7, R4 14, R5 1.5 |
| E17 AI C: predictive pre-fetch | 6 | 14 | R1 5.5, R3 1.5, R4 4.5, R5 2.5 |
| E18 AI safety, evaluation and AI.md | 6 | 17.5 | R1 1.5, R4 11.5, R5 4.5 |
| E19 Deployment and operations | 13 | 31.5 | R2 3, R5 28.5 |
| E20 Quality: tests, performance, accessibility | 10 | 25 | R1 8.5, R4 11, R5 5.5 |
| E21 Hardening, freeze, final deliverables and defence | 21 | 72 | R1 18, R2 8, R3 15.5, R4 7.5, R5 23 |
| **Total** | **216** | **652.5** | |

**Planned load by role and phase** (hours of issue work; percentage of the member's focus capacity for that phase from [implementation-plan §3.5](./implementation-plan.md); "surge" is the agreed extra time in the two weeks before a gate's feature cut-off):

| Role | Phases 0–1 (W1–W4) | Phase 2 (W5–W7) | Phase 3 (W8–W11) | Phase 4 (W12–W14) | Hardening and freeze (W15–W16) | Phase 5 (W17–W18) | Semester |
|---|---|---|---|---|---|---|---|
| R1 | 32.5 h (81%) | 32 h (112%) | 35 h (109%) | 14 h (49%) | 13.5 h (71%) | 8.5 h (45%) | 135.5 h (81%) |
| R2 | 37 h (92%) | 32.5 h (114%) | 28.5 h (89%) | 13.5 h (47%) | 5 h (26%) | 3 h (16%) | 119.5 h (71%) |
| R3 | 33 h (82%) | 33 h (116%) | 32 h (99%) | 14.5 h (51%) | 6.5 h (34%) | 9 h (47%) | 128 h (77%) |
| R4 | 28 h (70%) | 31.5 h (111%) | 34.5 h (107%) | 25.5 h (89%) | 5 h (26%) | 2.5 h (13%) | 127 h (76%) |
| R5 | 35.5 h (89%) | 31 h (109%) | 33.5 h (104%) | 14.5 h (51%) | 16.5 h (87%) | 11.5 h (61%) | 142.5 h (85%) |
| Focus capacity per member | 40 h | 28.5 h (+4 surge) | 32.2 h (+4 surge) | 28.5 h (+4 surge) | 19 h (+4 surge) | 19 h | 167.2 h |
| Team | 166 h (83%) | 160 h (112%) | 163.5 h (102%) | 82 h (58%) | 46.5 h (49%) | 34.5 h (36%) | 652.5 h (78%) |

**Loans (PLN-14).** Phase 2 is over capacity for R1, R2, R3 and R5 while the AI work of R4 has not started, so 22 tasks are done on loan: most by R4 in Phases 2 and 3, a few by R3 in Phase 3 and one by R5 in Phase 4. Each loan is reviewed by the area's primary owner.

| Issue | Work | Owner (on loan) | Area owner (reviews) | Week |
|---|---|---|---|---|
| PLT-052 | tools/spec-lint in the lint job | R4 | R5 | W5 |
| PLT-054 | tools/traceability.ts gate mode | R4 | R5 | W5 |
| PLT-065 | SECURITY.md draft | R4 | R2 | W5 |
| PLT-067 | tools/equity.ts | R4 | R5 | W6 |
| PLT-068 | Licence scan of the lockfile against THIRD_PART… | R4 | R5 | W6 |
| PLT-081 | Line discipline in kernel/core/tty | R4 | R1 | W6 |
| PLT-082 | history, help and man | R4 | R3 | W6 |
| PLT-086 | axe in CI for both themes | R4 | R5 | W6 |
| PLT-097 | File Explorer through syscalls | R4 | R3 | W7 |
| PLT-100 | complete service on dsa/trie (cmd, path, flag,… | R4 | R3 | W7 |
| PLT-101 | SYS-02 scripted terminal session for the P2 fil… | R4 | R3 | W7 |
| PLT-102 | Server hardening for the first public deploy | R4 | R2 | W7 |
| PLT-105 | e2e boot → login → terminal → file operations →… | R4 | R5 | W7 |
| PLT-113 | Signals, process groups, sessions and job-contr… | R3 | R1 | W9 |
| PLT-122 | Update flow | R3 | R5 | W9 |
| PLT-124 | Text Editor (CodeMirror 6, lazy) with expectedV… | R4 | R3 | W9 |
| PLT-126 | Fault-injection oracle on both sides and the pr… | R4 | R5 | W9 |
| PLT-129 | free, vmstat, pmap and swapctl | R3 | R1 | W10 |
| PLT-144 | k6 lock soak (50 clients) and rate-limit values… | R4 | R5 | W10 |
| PLT-148 | Offline e2e | R3 | R5 | W11 |
| PLT-149 | Boot evidence | R3 | R5 | W11 |
| PLT-180 | Pre-fetch evaluation | R5 | R4 | W13 |

### 3.3 Issues by epic

### E00 Team, registration and process (10 issues, 34.5 h)

| ID | Title | Requirement IDs | Spec | Owner / rev. | Week (gate) | Est. h | Depends on | Acceptance criteria | Base |
|---|---|---|---|---|---|---|---|---|---|
| PLT-001 | Vote the tagline, commit docs/identity/identity.json and submit the Appendix D form in Week 1 (Plotinium; alternative Tabium) | PLT-ID-01, PLT-DOC-14, PLT-TEAM-01, PLT-TEAM-02, PLT-ID-05, PLT-ID-02 | [identity-and-branding §3.13](../00-product/identity-and-branding.md) | R3 / R5 | W1 (G0) | 3 | — | `PLT-ID-01 registration.pdf exists, carries five signatures and registers Plotinium` [M]; submitted in W1 (names are first come, first served); instructor approval recorded in `docs/evidence/gates/g0/`; `docs/identity/identity.json` merged with the voted tagline (at most 90 characters, all three differentiators named); the same string is on the registration form | scaffold |
| PLT-002 | Send the Week-1 instructor questions and log the written answers | AIS-07, TRC-08, PLT-ID-17, VFS-09, OFF-05 | [implementation-plan §3.18](./implementation-plan.md) | R5 / R1 | W1 (G0) | 1 | — | Questions Q1–Q15 of implementation-plan §3.18 sent in W1; answers logged in `docs/evidence/gates/g0/instructor-answers.md` with dates; the amendment log of the traceability spec is checked weekly | new |
| PLT-013 | Complete, sign and merge TEAM_CONTRACT.md (the six §4.4 items) | PLT-DOC-11, PLT-TEAM-07, PLT-TEAM-08, PLT-TEAM-09, PLT-TEAM-10, PLT-TEAM-11, PLT-TEAM-12 | [implementation-plan §3.8, §3.11](./implementation-plan.md) | R5 / R1 | W2 (G0) | 2 | — | Merged through a PR approved by all five; names, roll numbers, meeting times and signatures filled; definition of done identical to implementation-plan §3.8 | scaffold |
| PLT-014 | Onboarding (R1): review and adopt the AI-generated protocol/, kernel stubs and package-boundary lint rules; do the S1b Task-Manager kata | ARC-01, PLT-DOC-10, PROC-08, PLT-DOC-03 | [syscall-abi §3, §4](../01-architecture/syscall-abi.md) | R1 / R5 | W2 (G0) | 5 | PLT-007 | Explain-your-code session held with the reviewer; every finding filed as an issue; accepted and rejected items written for AI_USAGE.md row 1; Kata result row committed to `docs/evidence/D1/s1b.csv` (hours, bugs found in review, UI script per frame) | ai-draft |
| PLT-015 | Onboarding (R2): review and adopt the AI-generated db/, server/src/{vfs,db} and vfs/src modules; do the S1b Task-Manager kata | DB-04, PLT-DOC-10, PROC-08, PLT-DOC-03 | [database §3, §4](../09-database/database.md) | R2 / R5 | W2 (G0) | 5 | PLT-007 | Explain-your-code session held; migration round trip run locally; findings filed; AI_USAGE notes written; Kata result row committed to `docs/evidence/D1/s1b.csv` (hours, bugs found in review, UI script per frame) | ai-draft |
| PLT-016 | Onboarding (R3): review and adopt the AI-generated ui/ tokens and icons, apps/shell lexer and parser, and the Stitch screens; do the S1b Task-Manager kata | SHL-05, PLT-ID-06, PLT-DOC-10, PROC-08, PLT-DOC-03 | [shell-and-terminal §3.5](../07-shell/shell-and-terminal.md) | R3 / R1 | W2 (G0) | 5.5 | PLT-007 | Explain-your-code session held; the Stitch screens checked against ui-design-system; findings filed; AI_USAGE notes written; Kata result row committed to `docs/evidence/D1/s1b.csv`; R3 applies the rule: keep Solid only if at least 4 of 5 finish within 1.5× their React time with at most 3 lint-missed reactivity bugs each | ai-draft |
| PLT-017 | Onboarding (R4): review and adopt the AI-generated ai/ indexer modules and server/src/llm stubs; do the S1b Task-Manager kata | AIS-08, PLT-DOC-10, PROC-08, PLT-DOC-03 | [ai-safety-and-evaluation §3.9–§3.11](../10-ai/ai-safety-and-evaluation.md) | R4 / R2 | W2 (G0) | 5 | PLT-007 | Explain-your-code session held; findings filed; AI_USAGE notes written; Kata result row committed to `docs/evidence/D1/s1b.csv` (hours, bugs found in review, UI script per frame) | ai-draft |
| PLT-018 | Onboarding (R5): review and adopt the AI-generated CI workflows, tools/, tests/ support, compose files, Dockerfile and ops/; do the S1b Task-Manager kata | TST-02, PLT-DOC-10, PROC-08, PLT-DOC-03 | [testing-and-performance §3.2](../13-quality/testing-and-performance.md) | R5 / R1 | W2 (G0) | 4 | PLT-007 | Explain-your-code session held; findings filed; AI_USAGE notes written; Kata result row committed to `docs/evidence/D1/s1b.csv` (hours, bugs found in review, UI script per frame) | ai-draft |
| PLT-019 | Complete AI_USAGE.md row 1: what each member accepted and rejected from the AI-assisted work, and why | PLT-DOC-10 | [implementation-plan §3.15](./implementation-plan.md) | R4 / R5 | W2 (G0) | 2 | PLT-014, PLT-015, PLT-016, PLT-017, PLT-018 | Row 1 filled per area with accepted and rejected items; the DEC-08 disclosure paragraph drafted for STACK_DECISION.md | scaffold |
| PLT-067 | tools/equity.ts: weekly contribution report in the CI job summary (R4 on loan; R5 reviews) | PLT-TEAM-05, PLT-TEAM-14 | [implementation-plan §3.17](./implementation-plan.md) | R4 / R5 | W6 (P2) | 2 | PLT-020 | Per member: commits, non-generated lines by package, PRs authored and reviewed, co-author trailers counted; posted every Monday; out-of-band members flagged | new |

### E01 Repository, CI and tooling (8 issues, 22 h)

| ID | Title | Requirement IDs | Spec | Owner / rev. | Week (gate) | Est. h | Depends on | Acceptance criteria | Base |
|---|---|---|---|---|---|---|---|---|---|
| PLT-003 | Create the GitHub organisation, one-member teams r1–r5 and the plotinium repository; add the instructor | PLT-TEAM-03, PLT-ID-11 | [deployment-and-ci §3.8, §3.17](../14-devops/deployment-and-ci.md) | R5 / R1 | W1 (G0) | 2 | PLT-002 | Repository `plotinium` exists (public if the instructor agrees); instructor added with read access; screenshot in `docs/evidence/gates/g0/` | new |
| PLT-004 | Main-branch ruleset, tag ruleset and CODEOWNERS with real team handles | PLT-TEAM-04, PLT-TEAM-03, PLT-TEAM-14, TRC-05 | [deployment-and-ci §3.8](../14-devops/deployment-and-ci.md) | R5 / R1 | W1 (G0) | 2 | PLT-003 | `docs/evidence/gates/g0/ruleset-main.json` exported; a direct push to main is rejected; rebase-and-merge only; CODEOWNERS dsa/ reviewer lines match data-structures §3.3 | scaffold |
| PLT-020 | CI green on the first PR (format, lint, typecheck, traceability --strict, Vitest with coverage, gitleaks, commitlint) and S11 toolchain timing | PLT-TEAM-13, TRC-02, AIS-06, DSA-GEN-01, DSA-GEN-08, TST-02, BOOT-10 | [deployment-and-ci §3.7.1](../14-devops/deployment-and-ci.md) | R5 / R1 | W2 (G0) | 4 | PLT-004 | `TRC-02 traceability fails on a test title whose first token is neither a spec ID nor a registered prefix`; the pilot-import and dsa external-import lint fixtures fail as expected; run link recorded for G0; PR wall time under 8 min and 0 flakes over 20 reruns, results in `docs/evidence/D14/`; `tsc` and `tsc6` bin names verified | scaffold |
| PLT-021 | Seed the GitHub board from backlog.csv and docs/requirements.csv (gh CLI script) | PLT-TEAM-13, TRC-01 | [requirements-traceability §4.2](../00-product/requirements-traceability.md) | R2 / R5 | W2 (G0) | 2 | PLT-003 | Every PLT-### issue exists with owner, reviewer, milestone, estimate and labels `req:<ID>`; `TRC-01 every one of the 84 spec IDs appears exactly once in the master matrix with every column filled` | new |
| PLT-052 | tools/spec-lint in the lint job: SPX header, section, link, index and freeze checks; TRC-05 and TRC-07 checks (R4 on loan; R5 reviews) | TRC-05, TRC-07, TRC-01 | [README §4.3, §8](../README.md) | R4 / R5 | W5 (P2) | 3 | PLT-020 | `SPX-05 every relative link in specs resolves and every cited ID is a spec ID or a registered prefix`; `TRC-05 owner and reviewer differ on every row and match CODEOWNERS for the implementing paths` | new |
| PLT-053 | Migrate the per-package Vitest projects to the six TST-02 projects; coverage ratchet per package | TST-02, DSA-GEN-07, DSA-GEN-08 | [testing-and-performance §3.2, §3.5](../13-quality/testing-and-performance.md) | R5 / R1 | W5 (P2) | 4 | PLT-020 | `vitest list` shows exactly unit, browser, integration, bench, ai-eval and tools; thresholds 70% overall and 85% on dsa/, vfs/ and kernel/ from the first merge; A structure still `false` at its gate tag fails the release workflow; the pending-structures table appears in the CI summary | scaffold |
| PLT-054 | tools/traceability.ts gate mode: JUnit statuses, evidence existence, gate report per tag (R4 on loan; R5 reviews) | TRC-03, TRC-06, TRC-04 | [requirements-traceability §5.2](../00-product/requirements-traceability.md) | R4 / R5 | W5 (P2) | 3 | PLT-053 | `TRC-03 gate check fails when a Must due at the gate has only skipped tests`; `TRC-06 every evidence path in the gate report exists in the repository or in the release assets` | scaffold |
| PLT-068 | Licence scan of the lockfile against THIRD_PARTY.md (R4 on loan; R5 reviews) | PLT-DOC-13 | [deployment-and-ci OPS-20](../14-devops/deployment-and-ci.md) | R4 / R5 | W6 (P2) | 2 | PLT-020 | `PLT-DOC-13 licence scan matches the lockfile against THIRD_PARTY.md and fails on unknown or incompatible licences` | new |

### E02 Stack decisions and spikes (16 issues, 50.5 h)

| ID | Title | Requirement IDs | Spec | Owner / rev. | Week (gate) | Est. h | Depends on | Acceptance criteria | Base |
|---|---|---|---|---|---|---|---|---|---|
| PLT-005 | Pre-register D2a and D2b: criteria, weights, anchored scales, spike rules | PLT-DOC-03 | [stack-decisions §3.2](../15-decisions/stack-decisions.md) | R1 / R5 | W1 (G0) | 2 | — | `prereg/D2a` and `prereg/D2b` merged with two approvals before any file under `docs/evidence/D2*/` (git-timestamp check) | new |
| PLT-006 | Pre-register D5, D6 and D7 | PLT-DOC-03, DB-05 | [stack-decisions §3.2](../15-decisions/stack-decisions.md) | R2 / R5 | W1 (G0) | 2.5 | — | Three prereg PRs merged by Friday of W1, before any evidence commit | new |
| PLT-007 | Pre-register D1 (UI framework) including the S1b kata rule | PLT-DOC-03, WM-03 | [stack-decisions §3.2](../15-decisions/stack-decisions.md) | R3 / R1 | W1 (G0) | 2 | — | `prereg/D1` merged by Friday of W1 with the S1 thresholds and the S1b rule | new |
| PLT-008 | Pre-register D8, D9, D10 and D11 with the single LLM selection rule | PLT-DOC-03, AIS-05 | [ai-safety-and-evaluation §3.8](../10-ai/ai-safety-and-evaluation.md) | R4 / R2 | W1 (G0) | 2.5 | — | Four prereg PRs merged by Friday of W1; the LLM rule states the qualifying thresholds and "cheapest qualifying configuration wins" | new |
| PLT-009 | Pre-register D3, D4, D12, D13 and D14 | PLT-DOC-03 | [stack-decisions §3.2](../15-decisions/stack-decisions.md) | R5 / R1 | W1 (G0) | 2.5 | — | Five prereg PRs merged by Friday of W1, before any evidence commit | new |
| PLT-010 | S0 capability probe on Chrome stable and beta (nested module workers, SAB in executors, OPFS sync handles, isolation, Web Locks, memory API) | ARC-02, ARC-05, MEM-01 | [stack-decisions §3.7 (D2b)](../15-decisions/stack-decisions.md) | R1 / R5 | W1 (G0) | 3 | PLT-005 | All green on stable, or the placement record is reopened before other spikes; the probe page becomes the nightly capability probe (risk R11) | new |
| PLT-011 | S4 setup: compose PostgreSQL 18 + pgvector; seed at least 50 users with 10k and 100k inodes (depth histogram) | DB-05, DB-01 | [database §7](../09-database/database.md) | R2 / R5 | W1 (G0) | 3 | PLT-006 | Seed manifest and depth histogram in `docs/evidence/D5/`; the seed is deterministic (mulberry32, seed 42) | ai-draft |
| PLT-012 | Write AGT-40 v0 and INJ-20 v0 with the fixture VFS (about 300 files, 3 users, frozen clock) | AGT-07, AGT-06, AIS-04 | [ai-safety-and-evaluation §3.6](../10-ai/ai-safety-and-evaluation.md) | R4 / R2 | W1 (G0) | 4 | PLT-008 | Datasets committed under `ai/eval/`; each prompt has an expected plan; INJ-20 cases carry the injected instruction in file content and names | new |
| PLT-022 | S1 framework benchmark: the 10-window desktop in Solid, React, Svelte and vanilla on the lab machine | WM-03, BOOT-10 | [stack-decisions §3.5 (D1)](../15-decisions/stack-decisions.md) | R3 / R5 | W2 (G0) | 3 | PLT-007 | Boot chunk contribution, per-update script time, drag p95 and LoAF count per framework committed to `docs/evidence/D1/`; pilot figures replaced | new |
| PLT-023 | S7 reduced LLM bake-off: AGT-40 and INJ-20, 3 runs per configuration, within USD 25 | AGT-07, AGT-06, AIS-05, AIS-07 | [ai-safety-and-evaluation §3.8](../10-ai/ai-safety-and-evaluation.md) | R4 / R5 | W2 (G0) | 5 | PLT-012 | Selection rule applied; `claude-sonnet-4-6` included as the §12.6 fallback that accepts temperature; requested and served model recorded; table in `docs/evidence/D10/` | new |
| PLT-027 | S4 core: Q1–Q5 before and after indexing with EXPLAIN; faults at nodes 1/500/999/1000; DB-03 torture with 2 and 8 clients; SQLite as the loser | DB-02, DB-03, DB-05 | [stack-decisions §3.10 (D5)](../15-decisions/stack-decisions.md) | R2 / R5 | W3 (P1) | 5 | PLT-011 | Q1–Q5 p95 ≤ 10 ms after indexing; 100% rollback with zero orphans; zero unreachable nodes under the lock protocol; results and plans in `docs/evidence/D5/` | ai-draft |
| PLT-028 | S5 M1: OPFS (blkio) versus IndexedDB relaxed swap at 5 and 8 MB on disk | MEM-05, MEM-03 | [stack-decisions §3.12 (D7)](../15-decisions/stack-decisions.md) | R1 / R2 | W3 (P1) | 3 | PLT-010 | OPFS page-out at least 1.5× faster than IndexedDB, otherwise the record keeps IndexedDB swap; disk-backed profile only | new |
| PLT-029 | S5 M2: atomic 1,000-node client bulk op with a fault at node 500 (×100) | DB-02 | [stack-decisions §3.12 (D7)](../15-decisions/stack-decisions.md) | R2 / R5 | W3 (P1) | 2 | PLT-011 | Bulk op p95 ≤ 500 ms and 100/100 correct rollbacks; evidence in `docs/evidence/D7/` | new |
| PLT-030 | S6 embedding bake-off and pilot retrieval evaluation in Chrome on the lab machine | RAG-04, RAG-05, AIS-05 | [stack-decisions §3.14 (D9)](../15-decisions/stack-decisions.md) | R4 / R5 | W3 (P1) | 5 | PLT-008 | Switch to bge-small if leaf Recall@5 is below 0.80 or more than 0.03 below bge-small; frame p95 during indexing recorded; `docs/evidence/D9/` | new |
| PLT-031 | S3-lite: campus wss test (20 connections, lab network and 4G) and the 6-minute hidden-tab lease test | VFS-09, OFF-02 | [offline-and-sync §9 Q1](../06-sync/offline-and-sync.md) | R2 / R5 | W3 (P1) | 3 | PLT-009 | More than 1 failed wss connection in 20 triggers the SSE-adapter record; a hidden tab keeps its lease for 6 minutes, otherwise the TTL question goes to the instructor | new |
| PLT-032 | Evidence freeze (Friday W3) with sensitivity tables; docs/risk-register.md | PLT-DOC-03, §13.1, PLT-TEAM-13 | [stack-decisions §3.3, §4.3](../15-decisions/stack-decisions.md) | R5 / R1 | W3 (P1) | 3 | PLT-010, PLT-022, PLT-016, PLT-027, PLT-028, PLT-029, PLT-030, PLT-023, PLT-031, PLT-024 | Every record has the team matrix, the research matrix and the sensitivity table; pilot figures replaced or labelled; Top-12 risks with measurable triggers, owners, mitigations and contingencies | new |

### E03 Phase 1 documents and defence (10 issues, 34.5 h)

| ID | Title | Requirement IDs | Spec | Owner / rev. | Week (gate) | Est. h | Depends on | Acceptance criteria | Base |
|---|---|---|---|---|---|---|---|---|---|
| PLT-033 | S10 Puter and daedalOS measurements (each member measures 2 scenarios) and the two-page analysis | §7.3 | [architecture §3.9](../01-architecture/architecture.md) | R3 / R5 | W3 (P1) | 4.5 | — | `docs/benchmarks/competitors.md` with measured numbers and screenshots, reviewed by all; Memory with 1, 5 and 10 apps, offline reload behaviour and basic file-operation timings recorded with screenshots in `docs/benchmarks/raw/` | new |
| PLT-034 | DSA.md draft: every structure mapped to path, operations, complexity and proving test | PLT-DOC-04, DSA-GEN-04, DSA-MAP-01 | [data-structures §3.6](../08-dsa/data-structures.md) | R1 / R2 | W3 (P1) | 2 | — | Every §10.1 row has an entry; the registries on Map/Set are listed (S12) | ai-draft |
| PLT-039 | Write and present records D2a and D2b | PLT-DOC-03 | [stack-decisions §3.6–§3.7](../15-decisions/stack-decisions.md) | R1 / R5 | W4 (P1) | 3 | PLT-032 | Six §14.1 parts present (DEC-01 lint); 3-minute defence section rehearsed twice; the D2a/D2b confirmatory claims use cited benchmarks plus a lab re-run of the pilot kernel harness (M1 stat round trip, M4 5 MB transfer), labelled as such | new |
| PLT-040 | Write and present records D4 (transport, with R5), D5, D6 and D7 | PLT-DOC-03, DB-01 | [stack-decisions §3.10–§3.12](../15-decisions/stack-decisions.md) | R2 / R5 | W4 (P1) | 3.5 | PLT-032 | Six §14.1 parts present; 3-minute defence section rehearsed twice | new |
| PLT-041 | Write and present record D1 with the S1b outcome | PLT-DOC-03, WM-03 | [stack-decisions §3.5](../15-decisions/stack-decisions.md) | R3 / R1 | W4 (P1) | 2.5 | PLT-032 | Six §14.1 parts present; a third terminal candidate scored; 3-minute defence section rehearsed twice | new |
| PLT-042 | Write and present D8, D9, D10 and D11; AI.md plan (subsystems, models, the 12 AI-native and 18 coupling cells as a plan) | PLT-DOC-03, AIS-05, PLT-DOC-06, AIS-12 | [stack-decisions §3.13–§3.16](../15-decisions/stack-decisions.md) | R4 / R2 | W4 (P1) | 4.5 | PLT-032, PLT-030, PLT-023 | All five §12.6 criteria scored for the embedding and LLM records; 3-minute defence section rehearsed twice; The temperature-0 ruling (or its request) recorded; each cell names its planned test | new |
| PLT-043 | Write D3, D12, D13 and D14; edit STACK_DECISION.md with the disclosure paragraph; BOOT.md draft | PLT-DOC-03, PLT-DOC-07, BOOT-03, BOOT-10 | [stack-decisions §3.1](../15-decisions/stack-decisions.md) | R5 / R1 | W4 (P1) | 4.5 | PLT-032, PLT-019 | STACK_DECISION.md passes the DEC lints; the DEC-08 disclosure paragraph is present; The 18 manifests, 7 levels and the critical path are shown; warm and cold boot defined | ai-draft |
| PLT-044 | ARCHITECTURE.md for P1: context, container and component diagrams, boundaries, thread model, data-flow walk-throughs | PLT-DOC-02, ARC-01, ARC-02, ARC-04 | [architecture §3, §5](../01-architecture/architecture.md) | R1 / R5 | W4 (P1) | 4 | PLT-032 | Mermaid diagrams render on GitHub; every member walks through data flows 1–6 at a rehearsal | ai-draft |
| PLT-045 | DATABASE.md for P1: ERD, DDL, tree representation, isolation argument, lock order, index list | PLT-DOC-05, DB-01, DB-04, DSA-DB-01 | [database §3, §4](../09-database/database.md) | R2 / R5 | W4 (P1) | 3 | PLT-027 | ERD and DDL match `db/schema.sql`; CHECK constraints on type and mode listed with their errnos | ai-draft |
| PLT-046 | P1 slides (Typst) and two defence rehearsals with cross-examination | §14.4, PLT-TEAM-06 | [implementation-plan §3.7.2](./implementation-plan.md) | R3 / R5 | W4 (P1) | 3 | PLT-039, PLT-040, PLT-041, PLT-042, PLT-043, PLT-044, PLT-045 | Every member presents 3 minutes and answers questions on any record; `docs/evidence/gates/p1/rehearsal-<n>.md` for both rehearsals | new |

### E04 Protocol and system-call ABI (1 issues, 3 h)

| ID | Title | Requirement IDs | Spec | Owner / rev. | Week (gate) | Est. h | Depends on | Acceptance criteria | Base |
|---|---|---|---|---|---|---|---|---|---|
| PLT-047 | Freeze the protocol ABI v1 after the defence: errno set, envelope, call catalogue and WebSocket frames checked against the ABI spec | SYS-01, ABI-03, ABI-15 | [syscall-abi §3, §4](../01-architecture/syscall-abi.md) | R1 / R2 | W4 (P1) | 3 | PLT-014 | Protocol tests green; approvals from R1, R2 and R4; ABI version constant 1; fixture files for every WS frame | ai-draft |

### E05 Data structures (dsa/, team-written) (11 issues, 42.5 h)

| ID | Title | Requirement IDs | Spec | Owner / rev. | Week (gate) | Est. h | Depends on | Acceptance criteria | Base |
|---|---|---|---|---|---|---|---|---|---|
| PLT-035 | Implement dsa/heap (binary min-heap with index map) and flip IMPLEMENTED | PROC-02, DSA-HEAP-01, DSA-HEAP-02, DSA-GEN-02, DSA-GEN-03, DSA-GEN-06 | [data-structures §3.5 S3, §5](../08-dsa/data-structures.md) | R1 / R3 | W3 (P1) | 5 | — | `DSA-HEAP-01 pop on an empty heap returns undefined`; `PROC-02 ready heap pops in (effPrio, seq) order against a sorted-array model (fast-check)`; bench JSON committed; DSA.md entry; teach-back given | scaffold |
| PLT-036 | Implement dsa/dag (Kahn levels, cycle path, reversed graph, ancestor closure) and flip IMPLEMENTED | BOOT-03, BOOT-04, DSA-DAG-01, DSA-DAG-02, DSA-DAG-03, DSA-GEN-02 | [data-structures §3.5 S4, §5](../08-dsa/data-structures.md) | R5 / R2 | W3 (P1) | 5 | — | `BOOT-04 cycle path is canonical: rotated to the smallest name and every arrow is a real requires edge`; Kahn O(V + E) bench flat per edge; DSA.md entry; teach-back given | scaffold |
| PLT-037 | Implement dsa/zorder (O(1) raise, 1..n renumbering) and flip IMPLEMENTED | WM-02, DSA-ZORD-01 | [data-structures §3.5 S9](../08-dsa/data-structures.md) | R3 / R5 | W3 (P1) | 3 | — | `WM-02 clicking a background window raises it and z-indices are exactly 1..n afterwards` (structure part); bench and DSA.md entry | scaffold |
| PLT-048 | Implement dsa/tree (n-ary tree, O(d) resolve, O(1) re-parent, no recursion) and flip IMPLEMENTED | VFS-01, DSA-TREE-01, DSA-TREE-02, DSA-TREE-03, DSA-GEN-02 | [data-structures §3.5 S1](../08-dsa/data-structures.md) | R2 / R1 | W4 (P1) | 5 | — | `VFS-01 resolving a depth-8 path performs exactly 8 child lookups`; depth 10^4 works; move bench flat; DSA.md entry; teach-back given | scaffold |
| PLT-049 | Implement dsa/ringbuffer and flip IMPLEMENTED | DSA-RING-01 | [data-structures §3.5 S7](../08-dsa/data-structures.md) | R5 / R1 | W4 (P1) | 2.5 | — | Push O(1) overwriting the oldest; used by klog; DSA.md entry | scaffold |
| PLT-055 | Implement dsa/trie (struct-of-arrays radix trie with cmd, path, flag and hist namespaces) and flip IMPLEMENTED | SYS-03, DSA-TRIE-01, DSA-TRIE-02, DSA-TRIE-03, DSA-GEN-03 | [data-structures §3.5 S2](../08-dsa/data-structures.md) | R3 / R4 | W5 (P2) | 5 | — | Complete p95 ≤ 1 ms at 10^4 and 10^5 entries per namespace; ≤ 32 MB at 10^5; DSA.md explains the radix choice; teach-back given | scaffold |
| PLT-056 | Implement dsa/hashtable (open addressing, linear probing, Fibonacci hashing, backward-shift deletion) and flip IMPLEMENTED | PROC-01, WM-01, DSA-HASH-01, DSA-GEN-05 | [data-structures §3.5 S6](../08-dsa/data-structures.md) | R1 / R3 | W5 (P2) | 5 | — | `PROC-01 PidTable matches Map under 200,000 random get, set and delete operations (fast-check)`; bench flat from 10^3 to 10^5; DSA.md entry; teach-back given | scaffold |
| PLT-110 | Implement dsa/lru (Map + typed-array doubly linked list, pin, speculative segment) and flip IMPLEMENTED | MEM-02, DSA-LRU-01, DSA-LRU-02 | [data-structures §3.5 S5](../08-dsa/data-structures.md) | R1 / R5 | W9 (P3) | 4 | — | `MEM-02 dsa/lru matches a list model under random touch, insert, move, evict, pin and unpin (fast-check)`; bench flat; DSA.md entry; teach-back given | scaffold |
| PLT-111 | Implement dsa/bloom with a declared false-positive rate and flip IMPLEMENTED | DSA-BLOOM-01 | [data-structures §3.5 S8](../08-dsa/data-structures.md) | R4 / R2 | W9 (P3) | 3 | — | Measured false-positive rate within the declared bound; DSA.md entry | scaffold |
| PLT-169 | Interval tree for window hit-testing (MAY; only if its benchmark justifies it; cut-list item 1) | DSA-IVT-01 | [data-structures §3.5 S10](../08-dsa/data-structures.md) | R3 / R1 | W13 (P4) | 3 | PLT-063 | Benchmark crossover against the linear scan committed; shipped only if it wins | new |
| PLT-192 | Re-run every DSA benchmark on the lab machine; generate the measured tables in DSA.md | DSA-GEN-03, DSA-GEN-09, DSA-GEN-04, PLT-DOC-04 | [data-structures §7](../08-dsa/data-structures.md) | R1 / R2 | W15 (FRZ) | 2 | PLT-110, PLT-111 | ns/op and bytes/entry at 10^3, 10^4 and 10^5 for every structure; no structure above 32 MB at 10^5 | new |

### E06 Kernel: processes and scheduling (13 issues, 41 h)

| ID | Title | Requirement IDs | Spec | Owner / rev. | Week (gate) | Est. h | Depends on | Acceptance criteria | Base |
|---|---|---|---|---|---|---|---|---|---|
| PLT-057 | Kernel worker boot, host bindings and exactly one kernel per origin (Web Lock plus fencing epoch) | ARC-02, ARC-05 | [architecture §3.6](../01-architecture/architecture.md) | R1 / R5 | W5 (P2) | 3 | PLT-047 | Two-tab e2e shows the takeover screen; a stale-epoch commit is refused | ai-draft |
| PLT-058 | Syscall dispatcher: Valibot validation, identity from the port, fixed order, errno replies | SYS-01, ABI-03, ABI-15 | [syscall-abi §3.3–§3.5](../01-architecture/syscall-abi.md) | R1 / R2 | W5 (P2) | 3 | PLT-057 | `SYS-01 B8 malformed, unknown, oversized and wrong-origin calls fail closed`; `ABI-15 a view port answers ENOSYS for write, unlink and spawn` | ai-draft |
| PLT-069 | Process model and executor pool: PidTable, spawn, exit, wait and kill; isolation executors and run tokens | PROC-01, PROC-06, PROC-07, PROC-05, ARC-05 | [processes-and-scheduling §3.3–§3.6](../03-kernel/processes-and-scheduling.md) | R1 / R5 | W6 (P2) | 5 | PLT-056, PLT-058, PLT-057 | `PROC-06 every transition of a scripted workload appears in the klog trace with from, to and reason`; `PROC-01 every PCB carries the fields listed in spec section 9.1`; `PROC-05 with hardwareConcurrency forced to 4 at most RUN_TOKENS slices run at once and isolation keys never share an executor` | ai-draft |
| PLT-070 | Basic scheduler on dsa/heap with round-robin and the kernel timer heap | PROC-02, PROC-03 | [processes-and-scheduling §3.10](../03-kernel/processes-and-scheduling.md) | R1 / R3 | W6 (P2) | 2.5 | PLT-035, PLT-069 | `PROC-03 three equal-priority burn jobs run in round-robin order in the klog trace` | ai-draft |
| PLT-071 | Pipes over kernel ring buffers, event bus, window syscalls and view ports | SYS-02, WM-05, ABI-15 | [syscall-abi §3.8](../01-architecture/syscall-abi.md) | R1 / R3 | W6 (P2) | 2.5 | PLT-049, PLT-058 | `SYS-02 write to a pipe with no reader returns EPIPE and raises SIGPIPE`; kernel events delivered at most once per frame | ai-draft |
| PLT-087 | SYS-01 bypass suite (8 cases from executor and view origins) and main-thread storage shadowing | SYS-01, ARC-07, ARC-01 | [syscall-abi §8.1](../01-architecture/syscall-abi.md) | R1 / R2 | W7 (P2) | 3 | PLT-058 | `SYS-01 bypass suite: 8 cases from executor and view origins all fail closed`; `SYS-01 built-chunk scan finds no storage, worker or kernel-module reference in any apps chunk` | new |
| PLT-088 | uname, /system/release and one build identity for every surface | PLT-ID-07, PLT-ID-13, PLT-ID-14, PVFS-09 | [identity-and-branding §3.8–§3.10](../00-product/identity-and-branding.md) | R1 / R3 | W7 (P2) | 2 | PLT-058 | `PLT-ID-07` uname formatter test; `PLT-ID-14` consistency e2e (boot screen, uname, About, /system/release, version.json); a write to /system/release fails | new |
| PLT-089 | sys.spawn resolves /bin/&lt;app&gt;.json requires with dsa/dag; a cycle is refused and named | BOOT-04, DSA-DAG-03, SVC-12 | [processes-and-scheduling KPS-07](../03-kernel/processes-and-scheduling.md) | R1 / R5 | W7 (P2) | 2 | PLT-036, PLT-069 | Spawning an app with a manifest cycle fails with the cycle path; the closure is started in Kahn order | new |
| PLT-107 | Written proof of the PROC-04 aging bound; `sched bound` prints the declared value | PROC-04 | [processes-and-scheduling §5](../03-kernel/processes-and-scheduling.md) | R1 / R5 | W8 (P3) | 2.5 | — | `PROC-04 sched bound prints the same value that the starvation test asserts`; proof summary ready for ARCHITECTURE.md | new |
| PLT-112 | Priority bands, quanta, aging, SAB pre-emption, watchdog and placement | PROC-03, PROC-04, KPS-11, KPS-12, PROC-05, KPS-06, KPS-08 | [processes-and-scheduling §3.10–§3.13](../03-kernel/processes-and-scheduling.md) | R1 / R5 | W9 (P3) | 5 | PLT-070, PLT-069 | `PROC-03 an interactive-band process pre-empts a running background slice at its next yield point`; `PROC-03 setting the normal quantum to 4 ms changes observed slice lengths to at most 4 ms plus delta`; `PROC-05 a slice exceeding its hard limit is terminated by the watchdog and the executor is respawned` | ai-draft |
| PLT-113 | Signals, process groups, sessions and job-control semantics (R3 on loan: shares the job-control work with the shell) | ABI-09, PROC-07 | [syscall-abi §3.9](../01-architecture/syscall-abi.md) | R3 / R1 | W9 (P3) | 3 | PLT-069 | Signal tests for SIGINT, SIGTSTP, SIGCONT, SIGTERM and SIGKILL; orphaned groups re-parented to init | ai-draft |
| PLT-127 | Process commands (ps, top, kill, nice, renice, uptime), burn and memhog; kill semantics | PROC-08, SYS-02, KPS-14, PROC-07, WM-05 | [shell-and-terminal §3.9](../07-shell/shell-and-terminal.md) | R1 / R3 | W10 (P3) | 3.5 | PLT-113, PLT-119 | `PROC-08 scripted session: ps, ps -ef, top -b -n 1, kill, kill -l, nice, renice, jobs, bg, fg and & match the golden output`; `PROC-07 kill -9 frees the executor slot, closes fds, releases leases, re-parents children to pid 1 and closes windows` [I] | ai-draft |
| PLT-145 | Starvation test and the PROC-05 frame gate under CPU load (3 × burn, 10 windows) on the lab machine | PROC-04, PROC-05, PROC-09 | [processes-and-scheduling §7](../03-kernel/processes-and-scheduling.md) | R1 / R5 | W11 (P3) | 4 | PLT-112, PLT-127 | `PROC-04 starvation: 50 priority-0 CPU jobs and 1 priority-39 job, the maximum wait is at most the declared 5450 ms`; `PROC-05 p95 frame duration is at most 16.7 ms with three burn processes and 10 windows, with 0 LoAF over 50 ms from our scripts`; `PROC-09 256 sleeping processes plus 10 windows keep frame p95 at most 16.7 ms, syscall p95 at most 1 ms and ps -e at most 100 ms` | new |

### E07 Kernel: memory and paging (6 issues, 19 h)

| ID | Title | Requirement IDs | Spec | Owner / rev. | Week (gate) | Est. h | Depends on | Acceptance criteria | Base |
|---|---|---|---|---|---|---|---|---|---|
| PLT-114 | Memory accounting, budget and soft limits; reservation-based admission; reclaim at 85% | MEM-01, MEM-06, KMM-06 | [memory-and-paging §3.2–§3.4](../03-kernel/memory-and-paging.md) | R1 / R2 | W9 (P3) | 2.5 | PLT-069 | `MEM-06 mem.alloc blocks on mem until reclaim frees space, then succeeds`; `MEM-01 free reports the configured budget, and changing mm.budget in Settings takes effect without a reboot` | ai-draft |
| PLT-128 | LRU pager: page tables, deterministic codec, blkio OPFS swap with verify-before-release, page-in | MEM-02, MEM-03, KMM-07, KMM-08 | [memory-and-paging §3.5–§3.8](../03-kernel/memory-and-paging.md) | R1 / R2 | W10 (P3) | 4 | PLT-110, PLT-114 | `MEM-03 page-out then page-in restores a byte-identical state: re-encoded bytes and SHA-256 are equal`; `MEM-03 memory is released only after the read-back is verified: a corrupted read-back keeps the page resident and dirty` | ai-draft |
| PLT-129 | free, vmstat, pmap and swapctl; Task Manager memory feed (R3 on loan; R1 reviews) | MEM-07, KMM-14 | [memory-and-paging §4](../03-kernel/memory-and-paging.md) | R3 / R1 | W10 (P3) | 2 | PLT-128 | `MEM-07 vmstat -p shows faults, hit ratio and bytes in and out per process, and the Task Manager matches within one refresh` | ai-draft |
| PLT-130 | Remote swap: write-behind client, checkpoints on hide, /api/swap with owner_uid authorisation and GC (R1 second subsystem) | MEM-04, KMM-09, KMM-10, SRV-11 | [memory-and-paging §3.9](../03-kernel/memory-and-paging.md) | R1 / R2 | W10 (P3) | 3 | PLT-128, PLT-125 | `MEM-04 close the tab, reopen in a new browser profile, and the window process restores its state from remote swap`; `MEM-04 write-behind: every page-out while online is uploaded and the local copy is kept` | ai-draft |
| PLT-146 | MEM-05 and MEM-06 on the lab machine: 5 MB incompressible page-in (local and remote) and the 2× memhog workload; thrashing guard | MEM-05, MEM-06, MEM-01, KMM-02 | [memory-and-paging §7](../03-kernel/memory-and-paging.md) | R1 / R2 | W11 (P3) | 4.5 | PLT-130, PLT-114 | `MEM-05 5 MB incompressible page-in p95 is at most 300 ms from local swap (OPFS and IndexedDB, both backends)`; `MEM-06 memhog 2x budget: accounted memory never exceeds the budget, the test logs max ms over budget (0 expected, at most 1000) and the tab never crashes`; `REPORT:mem-calibration` committed | new |
| PLT-170 | Memory-mapped files sys.mmap and msync (MAY; built only if P3 is green by W10; cut-list item 6) | MEM-08 | [memory-and-paging §3 (stretch)](../03-kernel/memory-and-paging.md) | R1 / R2 | W13 (P4) | 3 | PLT-128 | `MEM-08 mmap loads a chunk on first access and msync writes dirty chunks in one VFS transaction` | new |

### E08 VFS client and file commands (10 issues, 28.5 h)

| ID | Title | Requirement IDs | Spec | Owner / rev. | Week (gate) | Est. h | Depends on | Acceptance criteria | Base |
|---|---|---|---|---|---|---|---|---|---|
| PLT-059 | Inode tree on dsa/tree, one IndexedDB database per device, mkfs with well-known ids, path resolver | VFS-01, VFS-02, PVFS-01, PVFS-02, VFS-03, VFS-08 | [virtual-file-system §3.1–§3.3](../04-vfs/virtual-file-system.md) | R2 / R1 | W5 (P2) | 3.5 | PLT-048 | `VFS-02 mkfs creates the standard hierarchy with the specified owners and modes`; `VFS-02 ls -la / prints root:root rwxr-xr-x for / and rwxrwxrwt for /tmp`; `VFS-03 a chain of 40 symlinks resolves and a chain of 41 gives ELOOP`; `VFS-08 a 4096-byte path works and a 4097-byte path gives ENAMETOOLONG` | ai-draft |
| PLT-060 | IndexedDB store: synchronous tx() builders, one readwrite transaction per mutation, events only after oncomplete | DB-02, PVFS-03, PVFS-07 | [virtual-file-system §3.4](../04-vfs/virtual-file-system.md) | R2 / R5 | W5 (P2) | 2.5 | PLT-059 | The `no-await-in-idb-builder` lint passes; a failed builder leaves no partial state (browser test on disk) | ai-draft |
| PLT-072 | Permission matrix on every call (chmod, chown, umask, sticky /tmp); soft and hard links | VFS-04, PVFS-16, VFS-05 | [virtual-file-system §3.6](../04-vfs/virtual-file-system.md) | R2 / R1 | W6 (P2) | 3 | PLT-059, PLT-058 | `VFS-04 permission matrix: owner, group, other and root across 12 modes and every operation`; `VFS-04 root gets x on a file only if some x bit is set`; `VFS-04 sticky /tmp: bob cannot unlink or rename alice's file, the directory owner and root can`; `VFS-05 a dangling link: stat gives ENOENT, lstat succeeds, ls shows the target`; `VFS-05 a hard link raises nlink to 2 and the inode survives the first unlink` | ai-draft |
| PLT-073 | Quotas inside the transaction; open-file table with close-to-open write sessions | VFS-06, PVFS-11, SYS-01, DSA-MAP-01 | [virtual-file-system §3.8](../04-vfs/virtual-file-system.md) | R2 / R1 | W6 (P2) | 3 | PLT-060 | `VFS-06 rejects a write beyond quota with EDQUOT and no partial data`; `VFS-06 two concurrent writes cannot both pass the quota check`; `SYS-01 read on a closed descriptor fails with EBADF`; `SYS-01 opening one descriptor beyond the per-process limit fails with EMFILE` | ai-draft |
| PLT-074 | File commands ls, cd, pwd, mkdir, rmdir, touch and cat (R2 second subsystem) | SYS-02, VFS-07 | [shell-and-terminal §3.9](../07-shell/shell-and-terminal.md) | R2 / R3 | W6 (P2) | 1.5 | PLT-072, PLT-064 | `VFS-07 terminal CRUD with touch, echo, cat, mv and rm`; man page front matter matches the flags | ai-draft |
| PLT-090 | Two-phase bulk operations cp -r, mv and rm -r with the client fault hook; /tmp tmpfs and EXDEV | VFS-07, DB-02, PVFS-08, PVFS-10, PVFS-07, SYS-03 | [virtual-file-system §3.10–§3.11](../04-vfs/virtual-file-system.md) | R2 / R5 | W7 (P2) | 4 | PLT-073, PLT-060 | `DB-02 client rm -r of 1,000 nodes aborted at the 500th inode write leaves checksum, orphan probes and quota unchanged`; `VFS-07 mv across /tmp gives EXDEV and the command falls back to copy and delete`; `SYS-03 creating a file makes it completable without a rescan` | ai-draft |
| PLT-091 | VFS test suite complete for the P2 gate: 32 levels, name and path limits, CRUD end to end | VFS-08, VFS-01, VFS-07 | [virtual-file-system §8](../04-vfs/virtual-file-system.md) | R2 / R1 | W7 (P2) | 2 | PLT-090, PLT-092 | `VFS-08 32 levels of nesting can be created, listed and removed`; `VFS-01 directory lookup stays flat from 10^3 to 10^5 entries` [P]; `VFS-01 moving a directory with 10,000 descendants rewrites one dentry` | new |
| PLT-092 | File commands cp, mv, rm, ln, find, tree, stat, chmod, chown, du, df, quota and grep | SYS-02, VFS-07, VFS-04, VFS-06 | [shell-and-terminal §3.9](../07-shell/shell-and-terminal.md) | R2 / R3 | W7 (P2) | 3 | PLT-074, PLT-090, PLT-072, PLT-073 | `VFS-07 cp -r, mv, rm -r, find, stat, chmod, chown, ln -s and tree from the terminal`; `VFS-04 chmod parses octal and symbolic modes as in the table of 5.4`; `VFS-06` df, du and quota agree with the quota table after writes and deletes | ai-draft |
| PLT-131 | Mirroring states (offline EAGAIN, never a false ENOENT) and the directory cache on dsa/lru | PVFS-18, OFF-01, PVFS-17, MEM-02 | [virtual-file-system §3.16](../04-vfs/virtual-file-system.md) | R2 / R5 | W10 (P3) | 3 | PLT-094, PLT-110 | `PVFS-18` offline readdir of an unmirrored directory returns EAGAIN; `PVFS-17` a pinned directory is never evicted; hit ratio reported | ai-draft |
| PLT-132 | fsck invariants I1–I14 with repairs and lost+found; fsck and lsof commands | VFS-11, PVFS-15, SYS-02 | [virtual-file-system §3.15](../04-vfs/virtual-file-system.md) | R2 / R1 | W10 (P3) | 3 | PLT-090 | `VFS-11 fsck detects and repairs each of I1 to I12 on corrupted fixtures`; `VFS-11 property: random op sequences keep fsck clean` | ai-draft |

### E09 Database and server VFS (10 issues, 32.5 h)

| ID | Title | Requirement IDs | Spec | Owner / rev. | Week (gate) | Est. h | Depends on | Acceptance criteria | Base |
|---|---|---|---|---|---|---|---|---|---|
| PLT-061 | All remaining migrations with down scripts; normalised schema.sql diff and kysely-codegen --verify in CI | DB-01, DBD-11 | [database §3.20](../09-database/database.md) | R2 / R5 | W5 (P2) | 2 | — | `DB-01 migration round trip of up, N rollbacks and up leaves db/schema.sql unchanged` [I] | ai-draft |
| PLT-075 | Identity and VFS-core migrations on the production database; client mkfs and server seed agree on system inos | VFS-02, DB-04, DB-01 | [database §3.2, §4](../09-database/database.md) | R2 / R5 | W6 (P2) | 1.5 | PLT-015, PLT-061 | `VFS-02 client mkfs and server seed agree on ino for every system path` [I]; migration round trip green in CI | ai-draft |
| PLT-076 | Server vfsTxn and lockPlan: L0–L4 lock order, READ COMMITTED, retries with jitter, errno mapping | DB-03, VFS-06, DBD-03 | [database §3.4–§3.6](../09-database/database.md) | R2 / R5 | W6 (P2) | 2.5 | PLT-075 | `DB-03 serialization failures and deadlocks are retried at most 5 times with jitter`; `VFS-06 two clients near quota: the server rejects one with EDQUOT and that client reverts` | ai-draft |
| PLT-093 | Sync-engine skeleton: op.submit → vfsTxn → op.result with op_log dedup and the per-owner feed, on cookie-authenticated /ws | OFF-02, VFS-04, SYN-01, SYN-04, SYN-05 | [offline-and-sync §3.3–§3.8](../06-sync/offline-and-sync.md) | R2 / R5 | W7 (P2) | 4 | PLT-076, PLT-083 | Two users on the deployed URL: bob gets server-side EACCES on alice's file; a duplicate opId is answered from op_log without a second effect | ai-draft |
| PLT-108 | Lock manager: S/X leases, fencing tokens, expiry sweeper on dsa/heap, pushed grants (built against protocol-schema mocks) | VFS-09, SYN-09, DBD-09 | [offline-and-sync §3.10](../06-sync/offline-and-sync.md) | R2 / R5 | W8 (P3) | 4 | PLT-093 | `VFS-09 a crashed holder's lease expires within TTL plus 0.5 s` [I]; `VFS-09 lock grants and releases arrive as pushed control-lane messages` [I] | ai-draft |
| PLT-115 | Set-based bulk SQL, the acyclicity trigger and the GUC-gated fault trigger | DB-02, DB-03, DBD-04, DBD-05, DBD-06, DB-04 | [database §5](../09-database/database.md) | R2 / R5 | W9 (P3) | 5 | PLT-076 | `DB-03 moving a directory into its own subtree fails with EINVAL` [I]; the fault trigger is inert unless armed; `DB-03 two and eight clients moving overlapping subtrees concurrently always leave an acyclic, fully reachable tree` [I]; `DB-04 each constraint violation is rejected by PostgreSQL and mapped to its errno` [I] | ai-draft |
| PLT-116 | Fault-injection matrix: rm -r, cp -r, mv, batch rename, chmod -R and chown -R at nodes 1, 500, 999 and 1000, client and server | DB-02, TST-08 | [testing-and-performance §3.6.6](../13-quality/testing-and-performance.md) | R2 / R5 | W9 (P3) | 3 | PLT-115, PLT-126, PLT-090 | `DB-02 faults at node 1, 500, 999 and 1000 for rm -r, cp -r, mv, batch rename, chmod -R and chown -R leave zero orphans and unchanged checksums` [I]; `DB-02 rm -r of 1,000 nodes with a server fault at node 500 prints EIO synchronously and leaves checksum, orphans and quota unchanged on both sides` [B] | new |
| PLT-117 | Sync engine: conflicted copies, structural conflicts to lost+found, per-owner resume, redacted feed entries | VFS-10, SYN-08, SYN-17, SYN-18 | [offline-and-sync §3.8–§3.9](../06-sync/offline-and-sync.md) | R2 / R5 | W9 (P3) | 4 | PLT-093 | `VFS-10 a stale-version write becomes a conflicted copy and the original is untouched` [I]; `VFS-10 bob edits /home/shared while alice is offline, alice reconnects, tree checksums are equal` [I] | ai-draft |
| PLT-133 | VFS-09 lease tests: stale fence to conflicted copy, hidden-tab lease, lsof countdown | VFS-09 | [offline-and-sync §8](../06-sync/offline-and-sync.md) | R2 / R5 | W10 (P3) | 2 | PLT-108, PLT-119 | `VFS-09 a write with a stale fence gets EBUSY and its bytes are kept as a conflicted copy` [I]; `VFS-09 a hidden tab keeps its lease for 6 minutes` [E] | new |
| PLT-147 | Q1–Q5 indexes, benchmark at 100k inodes with EXPLAIN plans, DB-05 report; DATABASE.md complete for P3 | PLT-DOC-05, DB-05, DB-01, DSA-DB-01, DBD-10 | [database §7](../09-database/database.md) | R2 / R5 | W11 (P3) | 4.5 | PLT-156, PLT-061 | `REPORT:db-benchmark` with p50 and p95 before and after indexing from a seed of at least 50 users; backup-and-restore procedure documented; `DB-05 Q1 to Q5 p95 is at most 10 ms at 100,000 inodes after indexing and EXPLAIN (ANALYZE, BUFFERS) shows each planned index in use` [P] | new |

### E10 Sync, locks and offline (7 issues, 21 h)

| ID | Title | Requirement IDs | Spec | Owner / rev. | Week (gate) | Est. h | Depends on | Acceptance criteria | Base |
|---|---|---|---|---|---|---|---|---|---|
| PLT-094 | syncd client skeleton: WS v1 connect, op submit and result, outbox and undo written in the same transaction (R5 second subsystem) | OFF-02, SYN-03, PVFS-04 | [offline-and-sync §3.4](../06-sync/offline-and-sync.md) | R5 / R2 | W7 (P2) | 3 | PLT-093, PLT-060 | `OFF-02 every outbox op carries opId, cseq and a Lamport timestamp and replays in cseq order` [U] | ai-draft |
| PLT-118 | Outbox replay with op.batch and a credit window; reconnect state machine; per-owner resume | OFF-02, SYN-06, SYN-10, DB-02, SYN-07, PVFS-05 | [offline-and-sync §3.5–§3.7](../06-sync/offline-and-sync.md) | R5 / R2 | W9 (P3) | 5 | PLT-094, PLT-117 | `OFF-02 replay of 5,000 queued ops completes with zero disconnects and exactly one op_log row per opId` [I]; `OFF-02 a client crash between the local commit and the send delivers the op exactly once after reboot` [E]; `DB-02` server fault at node 500 prints EIO before the prompt returns | ai-draft |
| PLT-119 | lockd client: leases with heartbeat at TTL/3 from the kernel worker, read-only fallback, local advisory locks when degraded | VFS-09, PVFS-13 | [offline-and-sync §3.10](../06-sync/offline-and-sync.md) | R5 / R2 | W9 (P3) | 3 | PLT-108 | `VFS-09 two Chrome profiles: alice holds X, bob is read-only, alice's renderer ends, bob acquires within the TTL` [E] | ai-draft |
| PLT-120 | Offline login with the PBKDF2 verifier (never for root) | OFF-03 | [security-model §3.5](../12-security/security-model.md) | R5 / R2 | W9 (P3) | 2 | PLT-083 | `OFF-03 after online and offline logins a storage scan finds the canary password nowhere in IndexedDB, OPFS, Cache Storage or Web Storage` [E]; `OFF-03 root has no offline verifier and cannot log in offline` [E] | new |
| PLT-121 | Service Worker precache of the versioned shell, registered after desktop-interactive; offline boot | OFF-01, BOOT-09, SYN-14 | [offline-and-sync §3.12](../06-sync/offline-and-sync.md) | R5 / R3 | W9 (P3) | 3 | PLT-062 | `BOOT-09 with the server stopped and the browser offline, reload reaches a usable desktop` [E] | ai-draft |
| PLT-122 | Update flow: install in the background, Restart to update, SKIP_WAITING on reboot (R3 on loan; R5 reviews) | OFF-05, OPS-21 | [deployment-and-ci §3.11.4](../14-devops/deployment-and-ci.md) | R3 / R5 | W9 (P3) | 2 | PLT-121 | `OFF-05 a new build installs in the background, waits, shows Restart to update, and activates only after reboot` [E] | ai-draft |
| PLT-148 | Offline e2e: server killed, reboot, core utilities, "Offline · n queued", exactly-once replay after reconnect (R3 on loan; R5 reviews) | OFF-01, OFF-02, TST-12 | [testing-and-performance §3.8](../13-quality/testing-and-performance.md) | R3 / R5 | W11 (P3) | 3 | PLT-121, PLT-118 | `OFF-01 with the server process killed, a reboot reaches the desktop and ls, cat, mkdir, mv, rm, Files, Editor save, Task Manager and Settings work` [E] | new |

### E11 Boot and services (9 issues, 31 h)

| ID | Title | Requirement IDs | Spec | Owner / rev. | Week (gate) | Est. h | Depends on | Acceptance criteria | Base |
|---|---|---|---|---|---|---|---|---|---|
| PLT-050 | Inlined boot-ui v1: logo, name, version and build before any script; progressbar ARIA; reduced motion | BOOT-01, BOOT-13, PLT-ID-08 | [boot-and-services §3.2](../02-boot/boot-and-services.md) | R3 / R5 | W4 (P1) | 4 | PLT-038 | `BOOT-01 built index.html paints the logo, the name Plotinium and version and build before any script runs` [E]; `BOOT-13 progressbar exposes aria-valuenow equal to round(100·P) and aria-valuetext with the current service` [E] | new |
| PLT-062 | svcmgr v1 and truthful progress: 18 manifests, completion-driven Kahn start, cycle panic, no timers in the boot path | BOOT-03, BOOT-04, SVC-01, SVC-02, BOOT-02, SVC-10, SVC-15 | [boot-and-services §3.4–§3.6](../02-boot/boot-and-services.md) | R5 / R3 | W5 (P2) | 5 | PLT-036 | `BOOT-03 in the boot record every service starts after all its requirements have ended` [B]; `BOOT-02 static check finds no timer, keyframes or animation in the boot path except the two allowlisted sites` [L]; `BOOT-02 progress never changes without an event: 60 s of fake time with no events leaves P unchanged` [U] | ai-draft |
| PLT-095 | Minimal reboot for P2: services stop in reverse order, layout saved, reload (full BOOT-12 at P3) | WM-06, BOOT-12 | [boot-and-services §3.9](../02-boot/boot-and-services.md) | R5 / R3 | W7 (P2) | 2 | PLT-062, PLT-096 | `WM-06 after reboot the positions, sizes, states and z-order equal the saved layout` [E] runs with `reboot` at P2 | new |
| PLT-134 | Boot v2 orchestration: degraded state with back-off, safe and recovery modes, timeouts on the kernel timer heap | BOOT-06, BOOT-07, BOOT-08, SVC-03, SVC-04 | [boot-and-services §3.6–§3.8](../02-boot/boot-and-services.md) | R5 / R3 | W10 (P3) | 4 | PLT-062, PLT-112 | `BOOT-07 with /api blocked the desktop becomes interactive and shows auth, sync and lockd degraded` [E]; `BOOT-06 safe mode starts no ai service, autostarts no app and uses the default theme` [E] | ai-draft |
| PLT-135 | bootlog (--critical-path), svcctl and debug inject (root-only, audited, local stack only) | BOOT-11, BOOT-05, SVC-09, BOOT-04, SVC-17, TST-08 | [boot-and-services §3.10, §5](../02-boot/boot-and-services.md) | R5 / R1 | W10 (P3) | 3.5 | PLT-062, PLT-134 | `BOOT-11 critical path ends at desktop, follows real edges, and its durations sum to the boot time within 5 ms` [U]; `BOOT-04 svcctl require auth lockd then reboot shows the panic naming auth → sync → lockd → auth` [E] | ai-draft |
| PLT-136 | shutdown and reboot: flush dirty pages and the outbox, reverse-order stop, session saved and restored | BOOT-12, SVC-11 | [boot-and-services §3.9](../02-boot/boot-and-services.md) | R5 / R1 | W10 (P3) | 3 | PLT-095, PLT-128, PLT-118 | `BOOT-12 shutdown -r now restores window geometry, z-order, state and byte-identical process state` [E]; `BOOT-12 a queued offline op survives reboot and replays exactly once` [E] | ai-draft |
| PLT-137 | Boot menu (Esc buffered, reboot --menu, Settings flag), verbose log, panic, recovery console and stall screens | BOOT-05, BOOT-06, BOOT-08, PLT-ID-08 | [boot-and-services §3.7–§3.8](../02-boot/boot-and-services.md) | R3 / R5 | W10 (P3) | 4 | PLT-050, PLT-134 | `BOOT-06 holding Esc from navigation opens the boot menu with Normal, Safe, Recovery and Verbose` [E]; `BOOT-05 pressing V during boot shows timestamped lines for firmware, loader, kernel, svc and every service` [E]; `BOOT-08 a stalled kernel bundle shows the stall screen after 15 s, never a blank page` [E] | new |
| PLT-149 | Boot evidence: offline and degraded boot tests; BOOT-10 warm and cold boot on the lab machine (R3 on loan; R5 reviews) | BOOT-10, BOOT-07, BOOT-09, ARC-08 | [boot-and-services §7](../02-boot/boot-and-services.md) | R3 / R5 | W11 (P3) | 4 | PLT-134, PLT-121 | `BOOT-10 warm boot p95 over 20 runs is at most 1.5 s on the lab runner` [P]; `BOOT-10 no model, ort, transformers, xterm, CodeMirror or app view request starts before desktop-interactive` [E]; `ARC-08 boot reaches desktop-interactive with the server killed and with the network blocked` [E]; `BOOT-07 a rejected non-critical start retries at 0.25–0.5, 0.5–1 and 1–2 s and resets after success` [U] | new |
| PLT-171 | After desktop-interactive the session service pre-fetches the top-k apps and logs them in bootlog | AIN-C4, SVC-13 | [boot-and-services §3.11](../02-boot/boot-and-services.md) | R5 / R4 | W13 (P4) | 1.5 | PLT-166 | `AIN-C4 after desktop-interactive the session service pre-fetches the top-k apps and logs them in bootlog` | new |

### E12 Window manager, UI and apps (18 issues, 53.5 h)

| ID | Title | Requirement IDs | Spec | Owner / rev. | Week (gate) | Est. h | Depends on | Acceptance criteria | Base |
|---|---|---|---|---|---|---|---|---|---|
| PLT-038 | Identity kit: logo SVG legible at 16 and 256 px, /system/branding and docs/identity | PLT-ID-02, PLT-ID-03, PLT-ID-12, PLT-ID-16 | [identity-and-branding §3.5–§3.6, §3.12](../00-product/identity-and-branding.md) | R3 / R5 | W3 (P1) | 2.5 | PLT-001 | `PLT-ID-03 favicon at 16 px and boot logo at 256 px render in both themes and match the reviewed snapshots`; `PLT-ID-02 wordmark lint finds no variant spelling of Plotinium in UI strings, docs or the manifest` | scaffold |
| PLT-063 | Compositor core: registry, focus, z-order 1..n, drag with pointer capture and translate3d in one rAF flush | WM-01, WM-02, WM-03 | [window-manager §3.1–§3.4](../05-wm/window-manager.md) | R3 / R1 | W5 (P2) | 5 | PLT-037 | `WM-01 static scan finds no window geometry or z-index write outside the compositor chunk` [L]; `WM-03 the drag trace shows no forced layout inside pointermove handlers` | new |
| PLT-077 | Window operations and the live taskbar: 8 resize handles, snapping, minimise, maximise, restore, title-bar double-click, grouping, keyboard switching | WM-04, WM-07 | [window-manager §3.5–§3.6](../05-wm/window-manager.md) | R3 / R1 | W6 (P2) | 5 | PLT-063 | `WM-04 each of the 8 resize handles moves only its edges and never goes below minW or minH`; `WM-04 double-clicking the title bar maximises and double-clicking again restores the previous rectangle` [E]; `WM-04 the taskbar groups 3 Terminals under one button with a count badge and shows the activity dot while one runs a job`; `WM-07 every window can be switched to, moved, resized, snapped, minimised and closed with the keyboard only` [E] | new |
| PLT-078 | Desktop, launcher and window chrome built from the ui/ component library and tokens (light and dark) | PLT-ID-06, WM-07 | [ui-design-system §3](../05-wm/ui-design-system.md) | R3 / R1 | W6 (P2) | 1.5 | PLT-063 | Both themes render from `tokens.css` only; axe clean on the desktop with 3 windows | scaffold |
| PLT-079 | Login screen with several users plus Guest and Demo tiles | BOOT-14, PLT-ID-08 | [boot-and-services §3.2](../02-boot/boot-and-services.md) | R3 / R5 | W6 (P2) | 2 | PLT-083, PLT-050 | `BOOT-14 login screen lists several users plus Guest and Demo tiles and each can sign in` [E] | new |
| PLT-080 | Terminal view: xterm.js as the TTY device only; output batched per frame | SYS-02 | [shell-and-terminal §3.1–§3.3](../07-shell/shell-and-terminal.md) | R3 / R4 | W6 (P2) | 3 | PLT-063, PLT-081 | `SHL-03` terminal output arrives in at most one batch per frame of at most 64 KiB | new |
| PLT-096 | Layout persistence and window–process coupling | WM-06, WM-05 | [window-manager WMD-16](../05-wm/window-manager.md) | R3 / R1 | W7 (P2) | 3 | PLT-077, PLT-071 | `WM-06 a corrupt layout record starts a clean session and keeps the old record for recovery`; `WM-05 closing a window delivers SIGTERM to its process and the process exits` [I]; `WM-05 killing a process closes all of its windows` [E] | new |
| PLT-097 | File Explorer through syscalls; Settings → About, manifest, tab title and favicon (R4 on loan; R3 reviews) | VFS-07, PLT-ID-09, PLT-ID-10, PLT-ID-03 | [window-manager §3.12](../05-wm/window-manager.md) | R4 / R3 | W7 (P2) | 5.5 | PLT-063, PLT-074, PLT-078, PLT-088 | `VFS-07 File Explorer create, rename, copy, move, delete and properties use syscalls only` [E]; `PLT-ID-09` About shows name, version, build hash, build date and the five members; `PLT-ID-10` manifest unit test | new |
| PLT-098 | Frame meter and the WM-03 drag and resize trace with 10 windows on the lab machine | WM-03, ARC-04, TST-05 | [window-manager §7](../05-wm/window-manager.md) | R3 / R1 | W7 (P2) | 3.5 | PLT-077, PLT-104, PLT-063 | `WM-03 p95 frame duration is at most 16.7 ms while dragging and resizing with 10 windows open` [P]; `WM-03 zero long animation frames over 50 ms are attributed to our origin during the 10-window drag trace` [P]; The meter matches the Chrome-trace parser within one frame on a recorded drag | new |
| PLT-099 | Accessibility audit 1: axe in both themes and keyboard-only flows | WM-07, BOOT-13 | [ui-design-system §3.10](../05-wm/ui-design-system.md) | R3 / R5 | W7 (P2) | 2 | PLT-077, PLT-079, PLT-086 | `WM-07 axe finds zero serious or critical issues on the desktop with 3 windows, the launcher and a toast open, in both themes` [E]; `REPORT:a11y-audit-p2` | new |
| PLT-123 | Task Manager (processes, memory tab, kill, renice) and the Settings app | PROC-08, MEM-07, MEM-01, BOOT-06 | [window-manager §3.13](../05-wm/window-manager.md) | R3 / R1 | W9 (P3) | 5 | PLT-069 | `PROC-08 Task Manager rows show the same state, CPU share and memory as ps within one refresh` [E] (enabled once ps lands in W10); Changing mm.budget takes effect without a reboot; the boot-menu flag opens the menu once | new |
| PLT-124 | Text Editor (CodeMirror 6, lazy) with expectedVersion saves, conflict banner and lock read-only banner (R4 on loan; R3 reviews) | VFS-10, VFS-09, OFF-01 | [window-manager §3.14](../05-wm/window-manager.md) | R4 / R3 | W9 (P3) | 3 | PLT-063, PLT-119 | `VFS-10 a stale save shows the conflict banner and the conflicted copy exists` [E] | new |
| PLT-138 | "Restoring…" window state with real byte progress; minimised windows paged first | WM-05 | [window-manager WMD-13](../05-wm/window-manager.md) | R3 / R1 | W10 (P3) | 2 | PLT-128 | `WM-05 restoring a suspended window shows Restoring with real byte progress and the process pages back in`; `WM-05 under memory pressure a minimised window's process is paged out before any unminimised process` [B] | new |
| PLT-139 | Taskbar tray: connectivity states, degraded badge with next retry, Restart to update | OFF-04, OFF-05 | [window-manager WMD-11](../05-wm/window-manager.md) | R3 / R5 | W10 (P3) | 2 | PLT-077, PLT-118 | `OFF-04 the taskbar shows Online, Syncing n ops, Reconnecting in n s and Offline · n queued as net.state changes` [E]; `OFF-04 the degraded badge lists each degraded service with its next retry and hides at zero` [E] | new |
| PLT-150 | Accessibility audit 2: boot menu, panic, recovery console, Task Manager | WM-07, BOOT-13 | [ui-design-system §3.10](../05-wm/ui-design-system.md) | R3 / R5 | W11 (P3) | 1.5 | PLT-137, PLT-123 | `BOOT-13 boot menu, panic and recovery screens are fully operable with the keyboard alone` [E]; `REPORT:a11y-audit-p3` | new |
| PLT-159 | Files semantic search with citations; Settings → Privacy; Task Manager → Predictions | RAG-06, PRE-05, PRE-06 | [ui-design-system §3.9](../05-wm/ui-design-system.md) | R3 / R4 | W12 (P4) | 3 | PLT-161 | `RAG-06 Files search shows the same results and opens a result at lineStart` [B]; `PRE-05 Settings Privacy lists the events and Clear empties the ring and resets the model to cold start` [B] | new |
| PLT-172 | Secure prompt and confirmation sheet: focus trap, default N, blast radius in text | AGT-03 | [window-manager WMD-17](../05-wm/window-manager.md) | R3 / R4 | W13 (P4) | 2.5 | PLT-175 | `AGT-03 an empty answer or a timeout means N and nothing runs` [B]; axe clean on the sheet | new |
| PLT-183 | Accessibility audit 3: AI screens | WM-07 | [ui-design-system §3.10](../05-wm/ui-design-system.md) | R3 / R5 | W14 (P4) | 1.5 | PLT-159, PLT-172 | `REPORT:a11y-audit-p4` | new |

### E13 Shell, terminal and commands (8 issues, 16.5 h)

| ID | Title | Requirement IDs | Spec | Owner / rev. | Week (gate) | Est. h | Depends on | Acceptance criteria | Base |
|---|---|---|---|---|---|---|---|---|---|
| PLT-064 | Shell executor over the AI-drafted lexer and parser: pipes, redirection, ;, &&, variables, quoting, expansion order | SYS-02, SHL-05 | [shell-and-terminal §3.5–§3.7](../07-shell/shell-and-terminal.md) | R3 / R4 | W5 (P2) | 3 | PLT-016 | `SHL-05 single quotes keep $HOME literal, double quotes expand it, and unquoted expansions split into fields`; parser property tests green | ai-draft |
| PLT-081 | Line discipline in kernel/core/tty: canonical and raw modes, echo, ISIG (R4 on loan; R1 reviews) | SYS-02, ABI-09 | [shell-and-terminal SHL-01, SHL-02](../07-shell/shell-and-terminal.md) | R4 / R1 | W6 (P2) | 1.5 | PLT-071 | Ctrl-C sends SIGINT and Ctrl-Z sends SIGTSTP to the foreground group | ai-draft |
| PLT-082 | history, help and man; man-page front matter is the single source of flags; echo builtin (R4 on loan; R3 reviews) | SYS-02, SHL-12 | [shell-and-terminal §3.8, §3.12](../07-shell/shell-and-terminal.md) | R4 / R3 | W6 (P2) | 2 | PLT-064 | `SHL-12 every /bin manifest has a man page and every front-matter flag appears in OPTIONS` [U] | ai-draft |
| PLT-100 | complete service on dsa/trie (cmd, path, flag, hist) and complete --bench (R4 on loan; R3 reviews) | SYS-03 | [shell-and-terminal §3.10](../07-shell/shell-and-terminal.md) | R4 / R3 | W7 (P2) | 3 | PLT-055, PLT-090, PLT-082 | `SYS-03 complete p95 is at most 1 ms at 10^4 and 10^5 entries in every namespace` [P]; completion never lists an unlistable directory | new |
| PLT-101 | SYS-02 scripted terminal session for the P2 file group and shell features (R4 on loan; R3 reviews) | SYS-02 | [shell-and-terminal §8](../07-shell/shell-and-terminal.md) | R4 / R3 | W7 (P2) | 1.5 | PLT-092, PLT-082 | `SYS-02 scripted terminal session covers the required commands, pipes, redirection, sequencing, background jobs, variables and history` [E] (file group) | new |
| PLT-140 | Job control in the shell: &, Ctrl-Z, jobs, bg, fg, wait and %n | PROC-08, SYS-02 | [shell-and-terminal SHL-08](../07-shell/shell-and-terminal.md) | R3 / R1 | W10 (P3) | 2 | PLT-113 | `PROC-08` jobs, bg and fg golden output; done and stopped notices before the prompt | ai-draft |
| PLT-141 | su grants through the secure prompt with a 15-minute expiry | SYS-02, AGT-04 | [security-model §3.6](../12-security/security-model.md) | R5 / R2 | W10 (P3) | 2 | PLT-083 | `SEC-01 a su grant expires after 15 minutes, elevated processes receive SIGHUP, and later root ops are held` [I] | ai-draft |
| PLT-151 | SYS-02 scripted session for the P3 process, memory and system groups | SYS-02 | [shell-and-terminal §8](../07-shell/shell-and-terminal.md) | R3 / R1 | W11 (P3) | 1.5 | PLT-127, PLT-129, PLT-140, PLT-135 | `SYS-02` scripted session green for ps, top, kill, nice, renice, jobs, bg, fg, free, vmstat, pmap, su, bootlog, fsck, lsof, shutdown and reboot | new |

### E14 Server API, auth and security (5 issues, 11 h)

| ID | Title | Requirement IDs | Spec | Owner / rev. | Week (gate) | Est. h | Depends on | Acceptance criteria | Base |
|---|---|---|---|---|---|---|---|---|---|
| PLT-065 | SECURITY.md draft: threat model, permission model, secrets, data at rest (R4 drafts; R2 owns SECURITY.md) | PLT-DOC-09 | [security-model §3](../12-security/security-model.md) | R4 / R2 | W5 (P2) | 2 | — | Sections for §15.2 present; data-at-rest statement (SEC-15) published | ai-draft |
| PLT-083 | Auth sessions: login, logout, me, Argon2id, cookies, seeded users, guest and demo accounts, revocation (R5 second subsystem) | BOOT-14, OFF-03, SYS-02 | [backend-api §3.6](../11-server/backend-api.md) | R5 / R2 | W6 (P2) | 3.5 | PLT-075, PLT-064 | `SEC-05 revocation under 1 s: logout in one context closes the other context's socket of that session with 4401 within 1 s`; `SEC-03` cookie attributes; Golden output for alice, bob, guest and root | ai-draft |
| PLT-102 | Server hardening for the first public deploy: CSRF and Origin checks, error bodies, config guards, self-tests (R4 on loan; R2 reviews) | SRV-02, SRV-04, SRV-06, SRV-07 | [backend-api §3.4–§3.7](../11-server/backend-api.md) | R4 / R2 | W7 (P2) | 2 | PLT-093 | `SRV-02 startup refuses production with FAULT_INJECTION=1, a missing secret, a secret shorter than 32 bytes or a known development value`; `SRV-07 a WebSocket upgrade with a foreign or missing Origin is refused before the upgrade` | ai-draft |
| PLT-125 | /api/blobs on the FsBlobStore (R1 second subsystem) | SRV-10, MEM-04 | [backend-api §3.11](../11-server/backend-api.md) | R1 / R2 | W9 (P3) | 2 | PLT-093 | `SRV-10 a blob upload with a wrong digest leaves no file and returns 422 EIO checksum`; `SRV-10 HEAD of a blob the principal cannot read returns 404 even though the blob exists` | ai-draft |
| PLT-184 | SECURITY.md: agent trust boundary, injection defences and the incident log | PLT-DOC-09, AIS-02 | [security-model §3.9–§3.11](../12-security/security-model.md) | R2 / R4 | W14 (P4) | 1.5 | PLT-185 | Leaked-key runbook and the drill result recorded | new |

### E15 AI A: RAG semantic search (9 issues, 27 h)

| ID | Title | Requirement IDs | Spec | Owner / rev. | Week (gate) | Est. h | Depends on | Acceptance criteria | Base |
|---|---|---|---|---|---|---|---|---|---|
| PLT-142 | ai.embed worker with self-hosted weights, declared as one evictable page | RAG-05, AIN-A3, CPL-A-MEM, KMM-12 | [rag-semantic-search §3.7](../10-ai/rag-semantic-search.md) | R4 / R1 | W10 (P3) | 3 | PLT-030, PLT-114 | `MEM-06 ai.embed is declared as one page and evicting it terminates the worker` | ai-draft |
| PLT-152 | RAG corpus of at least 200 documents and 30 queries (queries by non-authors), licences recorded; 300/50 by W13 | AIS-04, RAG-04 | [ai-safety-and-evaluation §3.6](../10-ai/ai-safety-and-evaluation.md) | R4 / R5 | W11 (P3) | 4 | PLT-012 | `AIS-04 the RAG corpus has at least 200 documents and 30 queries, each with a licence entry and a non-author query writer` | new |
| PLT-153 | Indexer process: vfs events, PRI 32 NI 10, duty cycle under typing, writes only through ai.index.put | RAG-01, RAG-02, AIN-A1, AIN-A2 | [rag-semantic-search §3.2–§3.3, §3.10](../10-ai/rag-semantic-search.md) | R4 / R1 | W11 (P3) | 4 | PLT-142, PLT-112 | `RAG-01 ai.indexer appears in ps with PRI 32 NI 10 and state BLOCKED on ai:embed while indexing` [B]; `AIN-A2 the indexer writes the index only through ai.index.put and never opens IndexedDB` | ai-draft |
| PLT-160 | file_chunks, index put, pull and search with the readable-set CTE; /api/search/verify (R2 second subsystem) | RAG-03, SRV-12 | [backend-api §3.14](../11-server/backend-api.md) | R2 / R4 | W12 (P4) | 3 | PLT-061 | `RAG-03 server verify returns readable=false for a file chmodded after indexing` [I] | ai-draft |
| PLT-161 | Vector search (Float32 segments, heap top-k, Bloom fast path) and the semsearch command | RAG-05, RAG-06, AIN-A4 | [rag-semantic-search §3.5, §3.9](../10-ai/rag-semantic-search.md) | R4 / R3 | W12 (P4) | 3 | PLT-153, PLT-111 | `RAG-06 semsearch prints path:line citations, scores and snippets as plain text` [B]; `AIN-A4 a semsearch warms the top-3 result files and moves pending files near hits to the hit class` | ai-draft |
| PLT-162 | BM25 keyword index, snippets and citations; keyword fallback with the notice (R3 second subsystem) | RAG-06, AIS-02 | [rag-semantic-search §3.12](../10-ai/rag-semantic-search.md) | R3 / R4 | W12 (P4) | 3 | PLT-153 | `RAG-06 with the model unavailable semsearch returns keyword results and the notice "Semantic search unavailable — showing keyword matches"` [B] | new |
| PLT-163 | AI scheduling hooks: indexer throttle and duty cycle, pause on search focus (R1 AI coupling) | RAG-01, AIN-A3 | [rag-semantic-search §3.10](../10-ai/rag-semantic-search.md) | R1 / R4 | W12 (P4) | 2 | PLT-153 | `RAG-01 indexer duty cycle drops to about 50 % while the typing simulator runs and returns to 100 % after 1 s idle` [B] | new |
| PLT-173 | rag-leak suite: 3 users × modes × directories × 30 queries give zero unreadable results; chmod while offline | RAG-03 | [rag-semantic-search §5.2](../10-ai/rag-semantic-search.md) | R2 / R4 | W13 (P4) | 2 | PLT-160, PLT-161 | `RAG-03 rag-leak: 3 users × modes 600/640/644 × directories 700/711/755 × 30 queries return zero unreadable results` [I]; `RAG-03 chmod while bob is offline: bob's offline search shows no foreign result at all` [B] | new |
| PLT-174 | RAG evaluation and latency: Recall@5 ≥ 0.80 with MRR; retrieval p95 ≤ 500 ms at 10,000 chunks warm; RAG-02 within 30 s | RAG-04, RAG-05, RAG-02 | [rag-semantic-search §5.5, §7](../10-ai/rag-semantic-search.md) | R4 / R5 | W13 (P4) | 3 | PLT-161, PLT-152 | `RAG-04 Recall@5 on the team evaluation set is at least 0.80 and MRR is reported` [A]; `RAG-05 retrieval p95 at 10,000 chunks with a warm model is at most 500 ms` [P]; `RAG-02 a created 50 KB markdown file is findable by semsearch within 30 s under the typing simulator` [B] | new |

### E16 AI B: agentic shell (9 issues, 24.5 h)

| ID | Title | Requirement IDs | Spec | Owner / rev. | Week (gate) | Est. h | Depends on | Acceptance criteria | Base |
|---|---|---|---|---|---|---|---|---|---|
| PLT-154 | Tool catalogue in protocol (one syscall schema per tool); model output parsed with Valibot, never eval | AGT-01, AIN-B2 | [agentic-shell §3.3, §4](../10-ai/agentic-shell.md) | R4 / R2 | W11 (P3) | 2 | PLT-047 | `AGT-01 every tool maps to exactly one syscall schema in protocol` [U]; `AGT-01 model tool input is parsed with Valibot and never reaches eval, Function or the shell parser` [U] | ai-draft |
| PLT-164 | Planner client with the observation loop: read-only tools run immediately and return datamarked results | AGT-07, AIN-B1, AGT-06 | [agentic-shell §3.4](../10-ai/agentic-shell.md) | R4 / R2 | W12 (P4) | 3 | PLT-154, PLT-143 | `AIN-B1 every observation the model receives is the datamarked result of exactly one read-only syscall made by the agent's pid`; `AGT-06 the planner never receives file contents in any turn` [A] | ai-draft |
| PLT-165 | Validator and intent binding: invalid plans rejected with the reason before anything runs | AGT-02, AGT-06 | [agentic-shell §5](../10-ai/agentic-shell.md) | R4 / R2 | W12 (P4) | 3 | PLT-154 | `AGT-02 a plan with a missing source path is rejected with ENOENT and nothing runs` [B]; `AGT-06 a destructive step whose span lacks a licensing verb is rejected with EPERM not-requested` [U]; `AGT-02 a model refusal returns EAIREFUSED, runs nothing and is audited` | ai-draft |
| PLT-175 | Dry run and the kernel confirmation predicate (delete, overwrite, chmod, chown, &gt; 20 inodes); TTY takeover; HMAC token | AGT-03 | [agentic-shell §5](../10-ai/agentic-shell.md) | R4 / R1 | W13 (P4) | 3 | PLT-165 | `AGT-03 the predicate requires confirmation above 20 affected inodes and not at exactly 20` [U]; `AGT-03 piped yes into ai cannot confirm a destructive plan` [B]; `AGT-03 a destructive plan with no controlling TTY is refused with ENOTTY` [B] | ai-draft |
| PLT-176 | sys.batch server executor in one vfsTxn with fingerprint re-check; audit_log and ai log; pg_cancel_backend on kill (R2 second subsystem) | AGT-05, AGT-08, AGT-09, AIN-B4 | [database §3.18](../09-database/database.md) | R2 / R4 | W13 (P4) | 4.5 | PLT-115, PLT-165 | `AGT-05 a server fault injected during a batch rolls back both sides with EIO and fsck is clean` [I]; `AGT-05 a change between dry run and commit returns EAGAIN stale-plan and nothing changes` [I]; `AGT-08 ai log shows prompt, plan, confirmation and result, and works offline` [B]; `AIN-B4 files touched by a committed plan enter the indexer hot class` | ai-draft |
| PLT-177 | Agent identity: the real login uid from a su root shell; /system writes need a per-plan elevation | AGT-04 | [agentic-shell §3.2](../10-ai/agentic-shell.md) | R5 / R4 | W13 (P4) | 1.5 | PLT-175, PLT-141 | `AGT-04 an agent started from a su root shell runs as the real login uid` [B]; `AGT-04 a plan touching /system is refused with EPERM without a live su grant and secure-prompt password` [B] | new |
| PLT-178 | ai.agent as a real process (PRI 20, BLOCKED on net:llm); kill mid-plan via AbortSignal and the audited debug delay | AGT-09, AIN-B3 | [agentic-shell §3.6](../10-ai/agentic-shell.md) | R1 / R4 | W13 (P4) | 2 | PLT-176 | `AGT-09 ai.agent appears in ps with PRI 20 and state BLOCKED on net:llm` [B]; `AGT-09 kill during a stretched server transaction rolls back and audits killed_rolled_back` [I] | new |
| PLT-185 | Agent evaluation and safety: AGT-40 over 3 live runs; INJ-20 with zero executed-unrequested steps | AGT-07, AGT-06, AIS-03 | [ai-safety-and-evaluation §3.5–§3.7](../10-ai/ai-safety-and-evaluation.md) | R4 / R5 | W14 (P4) | 3 | PLT-164, PLT-175, PLT-176 | `AGT-07 AGT-40 median is at least 36 of 40 over 3 live runs` [A]; `AGT-06 INJ-20 executed-unrequested steps are zero with an informed user` [A]; `AIS-03 every INJ-20 case is stopped by at least two defence layers`; `REPORT:agent-eval`, `REPORT:agent-safety` | new |
| PLT-186 | ai undo &lt;txn&gt; (MAY; decided at the W12 checkpoint; cut-list item 7) | AGT-10 | [agentic-shell §3.8](../10-ai/agentic-shell.md) | R2 / R4 | W14 (P4) | 2.5 | PLT-176 | `AGT-10 ai undo restores the tree to its pre-plan checksum` [B] | new |

### E17 AI C: predictive pre-fetch (6 issues, 14 h)

| ID | Title | Requirement IDs | Spec | Owner / rev. | Week (gate) | Est. h | Depends on | Acceptance criteria | Base |
|---|---|---|---|---|---|---|---|---|---|
| PLT-109 | Witten-Bell Markov-2 predictor as pure code with the MFU cold start | PRE-01, PRE-02 | [predictive-prefetch §3.3, §5](../10-ai/predictive-prefetch.md) | R4 / R1 | W8 (P3) | 2.5 | — | `PRE-01 the incremental model equals a model rebuilt in batch from the same events` [U]; `PRE-01 with fewer than 50 launches the ranking is time-bucketed MFU with confidence 0` | new |
| PLT-155 | Telemetry ring on dsa/ringbuffer: local by default, viewable, clearable; opt-in sync | PRE-05, AIN-C1 | [predictive-prefetch §3.2](../10-ai/predictive-prefetch.md) | R4 / R3 | W11 (P3) | 2 | PLT-109, PLT-049 | `PRE-05 with sync off no request is made to /api/telemetry` [B]; `PRE-05 telemetry events contain no file names, paths or content`; `AIN-C1 the predictor receives launches only through ai.telemetry.read and never reads the telemetry store directly` | new |
| PLT-166 | prefetch:* jobs at priority 39, idle ≥ 2 s, speculative pages evicted first, live residency hint (R1 AI coupling) | PRE-04, AIN-C2, AIN-C3, AIN-C4, KMM-13 | [predictive-prefetch §3.4](../10-ai/predictive-prefetch.md) | R1 / R4 | W12 (P4) | 3 | PLT-109, PLT-128 | `PRE-04 no prefetch job starts within 2 s of user input` [B]; `PRE-04 speculative pages are evicted before any non-speculative page` [U]; `AIN-C4 a live residency hint makes reclaim skip the predicted app's pages once per pass` | new |
| PLT-179 | predict command with confidence and a reason; prefetch jobs visible in ps | PRE-06 | [predictive-prefetch §3.5](../10-ai/predictive-prefetch.md) | R3 / R4 | W13 (P4) | 1.5 | PLT-166 | `PRE-06 predict prints the top 3 with confidence and a reason` [B]; `PRE-06 prefetch:app appears in ps while it runs` [B] | new |
| PLT-180 | Pre-fetch evaluation: at least 500 launch events split chronologically; top-1 and top-3 against MFU and MRU (R5 runs the harness; R4 reviews) | PRE-02, PRE-01, AIS-04 | [predictive-prefetch §5](../10-ai/predictive-prefetch.md) | R5 / R4 | W13 (P4) | 2.5 | PLT-109 | `PRE-02 top-3 accuracy beats the better of MFU and MRU on the chronological held-out 30 %` [A]; `PRE-01 one prediction takes at most 5 ms p95 in an executor worker with 32 apps and 5,000 events of history` [P]; `REPORT:pre-eval` | new |
| PLT-187 | PRE-03 launch-latency cut and the PRE-04 frame trace during pre-fetch on the lab machine | PRE-03, PRE-04 | [predictive-prefetch §7](../10-ai/predictive-prefetch.md) | R1 / R4 | W14 (P4) | 2.5 | PLT-166 | `PRE-03 median launch latency of correctly predicted launches drops by at least 30 % with pre-fetch` [P]; `PRE-04 frame p95 stays at or under 16.7 ms with no LoAF over 50 ms from our scripts while a prefetch job runs with 10 windows` [P] | new |

### E18 AI safety, evaluation and AI.md (6 issues, 17.5 h)

| ID | Title | Requirement IDs | Spec | Owner / rev. | Week (gate) | Est. h | Depends on | Acceptance criteria | Base |
|---|---|---|---|---|---|---|---|---|---|
| PLT-143 | LLM gateway: key only on the server, budget reserve and settle, per-user token bucket, cassette record and replay with scrubber (R4 second subsystem) | AIS-06, AIS-07, AIS-08, AIS-09 | [backend-api §3.15](../11-server/backend-api.md) | R4 / R2 | W10 (P3) | 4 | PLT-083 | `AIS-06 /api/llm/plan rejects a request without a session and takes the uid only from the session`; `AIS-09 every provider call writes exactly one llm_requests row, including aborted calls charged at the reservation`; `AIS-08 cassettes contain no credential or auth header` | ai-draft |
| PLT-167 | ai-eval CI project replaying cassettes with no key; the litmus AI-off build as a CI job and side by side on port 4718 | AIS-07, TST-15, ARC-06, AIS-01 | [testing-and-performance §3.10](../13-quality/testing-and-performance.md) | R5 / R4 | W12 (P4) | 4.5 | PLT-143, PLT-053 | `AIS-07 CI runs every LLM-dependent test with LLM_MODE=replay and no key`; a cassette miss fails without touching the network; `ARC-06 litmus build with __AI__=false and AI=0 passes every non-AI e2e test and ai, semsearch and predict report command not found`; `AIS-01 the AI-off bundle contains no Transformers.js, ORT or model asset and makes no AI request` | new |
| PLT-168 | Commit the descoping rule in AI.md before W12, then run the Week-12 checkpoint (A answers semsearch, B reaches a dry run, C pre-fetches) | AIS-10, PLT-DOC-06 | [ai-safety-and-evaluation §3.13](../10-ai/ai-safety-and-evaluation.md) | R4 / R5 | W12 (P4) | 2 | PLT-161, PLT-165, PLT-166 | Checkpoint record in AI.md with date and signatures; cuts applied if a skeleton is missing; AI.md section dated before W12 with the ordered cut list and the depth bar | new |
| PLT-181 | Trust-boundary mapping with named tests; graceful absence offline | AIS-02, OFF-04 | [ai-safety-and-evaluation §3.4](../10-ai/ai-safety-and-evaluation.md) | R1 / R4 | W13 (P4) | 1.5 | PLT-175, PLT-162 | `OFF-04 offline ai prints the unavailable message, runs nothing, and ai log still works` | new |
| PLT-188 | AI.md complete: 12 AI-native cells and the 18-cell coupling map, each with a named passing test; evaluations; safety; models | PLT-DOC-06, AIS-12, AIN-A1, AIN-A2, AIN-A3, AIN-A4, AIN-B1, AIN-B2, AIN-B3, AIN-B4, AIN-C1, AIN-C2, AIN-C3, AIN-C4, CPL-A-SCHED, CPL-A-MEM, CPL-A-VFS, CPL-A-SHELL, CPL-A-DB, CPL-A-SEC, CPL-B-SCHED, CPL-B-MEM, CPL-B-VFS, CPL-B-SHELL, CPL-B-DB, CPL-B-SEC, CPL-C-SCHED, CPL-C-MEM, CPL-C-VFS, CPL-C-SHELL, CPL-C-DB, CPL-C-SEC | [ai-safety-and-evaluation §3.1–§3.2, §3.15](../10-ai/ai-safety-and-evaluation.md) | R4 / R2 | W14 (P4) | 3 | PLT-174, PLT-185, PLT-180 | Every cell links its test and the test passes on v0.4.0; `AIS-12` document review at P4 | new |
| PLT-189 | Cost report from llm_requests; leaked-key drill before the P4 gate | AIS-09, AIS-06, AIS-08 | [ai-safety-and-evaluation §3.12](../10-ai/ai-safety-and-evaluation.md) | R4 / R5 | W14 (P4) | 2.5 | PLT-143 | `REPORT:llm-cost`; `AIS-09 a call that would exceed a cap is refused with EAIUNAVAIL budget before the provider is called`; `SEC-18 leaked-key drill: a dummy key is revoked, replaced and recorded within the runbook targets` [M] | new |

### E19 Deployment and operations (13 issues, 31.5 h)

| ID | Title | Requirement IDs | Spec | Owner / rev. | Week (gate) | Est. h | Depends on | Acceptance criteria | Base |
|---|---|---|---|---|---|---|---|---|---|
| PLT-024 | S8 clean bring-up timing (lab PC, home broadband, fresh runner) and region RTT from the LGU lab | PLT-DEL-02, §17.1 | [deployment-and-ci §3.6, §3.13](../14-devops/deployment-and-ci.md) | R2 / R5 | W2 (G0) | 3 | PLT-025 | Every bring-up ≤ 240 s; WebSocket RTT p50/p95 over 1,000 echoes per region; region decision recorded in D12 | new |
| PLT-025 | Buy the VPS (Hetzner CX33 retry loop, OVH VPS-2 after 72 h), the Student Pack domain and DNS | PLT-DEL-02, OPS-12, OPS-13 | [deployment-and-ci §3.12–§3.13](../14-devops/deployment-and-ci.md) | R5 / R2 | W2 (G0) | 1.5 | PLT-002 | Server ordered within 72 h of the start of the loop; purchase log and cost row committed; A and AAAA records resolve | new |
| PLT-051 | Provision the VPS from ops/cloud-init.yaml: deploy user, key-only SSH, Docker, cloud firewall, secrets directory | OPS-12, PLT-DEL-02 | [deployment-and-ci §3.12](../14-devops/deployment-and-ci.md) | R5 / R2 | W4 (P1) | 1.5 | PLT-025 | Provisioning checklist ticked; a rebuild from cloud-init takes under 1 h | ai-draft |
| PLT-066 | Compose stack with Caddy on the VPS; walking skeleton deployed (staging project if RAM allows) | OPS-01, OPS-02, OPS-22, PLT-DEL-02, MEM-01, SEC-02 | [deployment-and-ci §3.1–§3.2](../14-devops/deployment-and-ci.md) | R5 / R2 | W5 (P2) | 3.5 | PLT-051 | Only 80 and 443 published; `db` on the internal network; boot → kernel → stub login → desktop on the deployed URL; `SEC-02 every response class carries COOP, COEP, CORP and the CSP`; crossOriginIsolated true in the window and a worker | ai-draft |
| PLT-084 | Multi-arch images on public GHCR pinned by digest; timed clean bring-up job (≤ 240 s, no docker login) | OPS-04, OPS-05, §17.1 | [deployment-and-ci §3.4](../14-devops/deployment-and-ci.md) | R5 / R1 | W6 (P2) | 3 | PLT-066 | Anonymous pull works; every reference in the release is a digest; Weekly and per-tag runs green; timing trend in the job summary | ai-draft |
| PLT-085 | release.yml → deploy.yml with approval by a member other than the tagger; ops/deploy.sh with automatic rollback | OPS-07, OPS-08, PLT-ID-04, PLT-ID-15 | [deployment-and-ci §3.7.5, §3.11](../14-devops/deployment-and-ci.md) | R5 / R2 | W6 (P2) | 3 | PLT-084 | `PLT-ID-04 release workflow accepts only v0.2.0, v0.3.0, v0.4.0, v1.0.0, their patches and v1.0.0-rc.N`; `PLT-ID-04 release workflow rejects a tag whose version differs from package.json` | ai-draft |
| PLT-103 | Tag v0.2.0 and the first public production deploy; README live URL; UptimeRobot; CHANGELOG by requirement ID | PLT-ID-04, PLT-DEL-02, PLT-DOC-01, PLT-DOC-12, OPS-15, OPS-08 | [deployment-and-ci §3.10](../14-devops/deployment-and-ci.md) | R5 / R1 | W7 (P2) | 2.5 | PLT-085, PLT-106 | The production URL boots over HTTPS at the gate; `/version.json` shows 0.2.0; UptimeRobot alerts reach all five; Drill log in `docs/evidence/deploy/` | new |
| PLT-156 | Nightly backups to Cloudflare R2 and the first restore drill (weekly after) | DB-01, OPS-14 | [deployment-and-ci §3.14.3](../14-devops/deployment-and-ci.md) | R5 / R2 | W11 (P3) | 3.5 | PLT-103 | `DB-01 the restore drill rebuilds a fresh stack from pg_dump and blobs and fsck --server is clean` [I]; `REPORT:restore-drill`; Backup timer green for 7 nights; manifest per snapshot | new |
| PLT-157 | Tag v0.3.0, deploy; OFF-05 hash-only patch v0.3.1 deployed during the gate | OFF-05, OPS-16, PLT-ID-04 | [deployment-and-ci §3.10–§3.11.4](../14-devops/deployment-and-ci.md) | R5 / R1 | W11 (P3) | 2 | PLT-158, PLT-122 | The P3 gate shows "Restart to update" and `uname` shows the new build after reboot | new |
| PLT-182 | Self-hosted models and ORT on production with sha256 pins (web/models.lock.json) | RAG-05, OPS-19 | [deployment-and-ci §3.5](../14-devops/deployment-and-ci.md) | R5 / R4 | W13 (P4) | 1.5 | PLT-142 | Model files served `immutable` from `/models/<lock-id>/`; COEP intact; first query after load measured | new |
| PLT-190 | Tag v0.4.0 and deploy; litmus build shown side by side | PLT-ID-04, ARC-06 | [deployment-and-ci §3.10](../14-devops/deployment-and-ci.md) | R5 / R1 | W14 (P4) | 1.5 | PLT-191, PLT-167 | Production at 0.4.0; the AI-off build runs on port 4718 locally | new |
| PLT-202 | Tag v1.0.0-rc.1 (feature freeze); deploy-under-load rehearsal and the second rollback drill | PLT-DEL-01, PLT-DEL-03, §13.2, OPS-08, SRV-16 | [deployment-and-ci §3.10](../14-devops/deployment-and-ci.md) | R5 / R1 | W16 (FRZ) | 3 | PLT-203, PLT-190 | After rc.1 only `freeze-fix` PRs with two approvals merge; release assets carry JUnit, coverage and traceability; `SRV-16 clients reconnect after a deploy with 0 lost ops and 0 lost leases` [E]; WebSocket resume p95 under 3 s | new |
| PLT-215 | Tag v1.0.0 early in W18; final production deploy; .env frozen; examiner credentials on paper; v1.0.1 built but not deployed | PLT-DEL-01, PLT-DEL-02, PLT-DEL-03 | [deployment-and-ci §3.10, §3.11.4](../14-devops/deployment-and-ci.md) | R5 / R2 | W18 (P5) | 2 | PLT-202, PLT-207 | `/version.json` shows 1.0.0; UptimeRobot green for 7 days; restore drill passed in the T-7 window | new |

### E20 Quality: tests, performance, accessibility (10 issues, 25 h)

| ID | Title | Requirement IDs | Spec | Owner / rev. | Week (gate) | Est. h | Depends on | Acceptance criteria | Base |
|---|---|---|---|---|---|---|---|---|---|
| PLT-026 | Lab-spec runner (schedule and workflow_dispatch only) and the CPU calibration of hosted runners | TST-07, OPS-11, TST-21, PROC-05 | [testing-and-performance §3.12](../13-quality/testing-and-performance.md) | R1 / R5 | W2 (G0) | 2.5 | — | Workflow lint rejects pull_request triggers on the self-hosted runner; the runner holds no secrets; `tests/performance/calibration.json` committed with rate = max(1, t_lab / t_runner) from median wall times of 5 runs | new |
| PLT-086 | axe in CI for both themes; keyboard-only flow tests (R4 on loan; R5 reviews) | TST-14, WM-07 | [testing-and-performance §3.9](../13-quality/testing-and-performance.md) | R4 / R5 | W6 (P2) | 1.5 | PLT-053 | A seeded contrast violation fails the a11y project | new |
| PLT-104 | Performance harness (budgets.json, trace parser, check-budgets, nightly lab job) and TESTING.md with the agreed frame method | TST-04, TST-05, TST-06, WM-03, PLT-DOC-08 | [testing-and-performance §3.11](../13-quality/testing-and-performance.md) | R1 / R5 | W7 (P2) | 4 | PLT-053, PLT-026 | `TST-05` the parser reproduces a recorded trace's p95 within 0.1 ms; results carry machine, Chrome version and commit; Instructor agreement on the frame metric recorded | ai-draft |
| PLT-105 | e2e boot → login → terminal → file operations → reboot → session restored (R4 on loan; R5 reviews) | §15.3, WM-06, SYS-02 | [testing-and-performance §3.8](../13-quality/testing-and-performance.md) | R4 / R5 | W7 (P2) | 2.5 | PLT-095, PLT-079, PLT-092 | Green on main on Chrome stable; `tests/e2e/boot-to-session-restore.spec.ts` adopted from the scaffold | ai-draft |
| PLT-106 | P2 dry run 3 days before the gate; Appendix A lines A2, A3, A13–A15, A17, A19, A30, A31 | TRC-04, §13.2 | [implementation-plan §3.7.3](./implementation-plan.md) | R5 / R1 | W7 (P2) | 1.5 | PLT-091, PLT-098, PLT-101, PLT-105 | `TRC-04 the Appendix A checklist for the gate is committed and signed by R5 and one other member` [M] | new |
| PLT-126 | Fault-injection oracle on both sides and the property-suite seeds (fixed on PRs, deep nightly) (R4 on loan; R5 reviews) | TST-09, DB-02, TST-10, DSA-GEN-06, VFS-11 | [testing-and-performance §3.6.5](../13-quality/testing-and-performance.md) | R4 / R5 | W9 (P3) | 3.5 | — | Probe unit tests on corrupted fixtures; one oracle call shared by the client and server suites; a failing seed is pinned as a regression case; the fsck property run is enabled when fsck lands (W10) | ai-draft |
| PLT-144 | k6 lock soak (50 clients) and rate-limit values tuned from the measured replay burst (R4 on loan; R5 reviews) | VFS-09, OFF-02, SRV-09 | [offline-and-sync §7](../06-sync/offline-and-sync.md) | R4 / R5 | W10 (P3) | 3.5 | PLT-108, PLT-119 | `PERF:VFS-09` lab file committed; `SRV-09 the token bucket never allows more than capacity plus rate times T calls in any window of length T`; replay throttled, never disconnected | new |
| PLT-158 | P3 dry run; Appendix A lines A4–A12, A16, A18, A20, A21 | TRC-04, §13.2, PLT-DOC-08 | [implementation-plan §3.7.4](./implementation-plan.md) | R5 / R1 | W11 (P3) | 2.5 | PLT-145, PLT-146, PLT-148, PLT-116, PLT-133, PLT-149 | Signed checklist `docs/evidence/gates/p3/appendix-a.md`; Document review at P3 | new |
| PLT-191 | P4 dry run; Appendix A lines A22–A24, A26–A29 | TRC-04, §13.2 | [implementation-plan §3.7.5](./implementation-plan.md) | R5 / R1 | W14 (P4) | 1.5 | PLT-174, PLT-185, PLT-187, PLT-167 | Signed checklist `docs/evidence/gates/p4/appendix-a.md` | new |
| PLT-193 | Lab-machine re-run of every PERF budget for the final evidence | BOOT-10, WM-03, PROC-05, MEM-05, SYS-03, DB-05, RAG-05, PRE-01, PRE-03 | [testing-and-performance §7.1](../13-quality/testing-and-performance.md) | R1 / R5 | W15 (FRZ) | 2 | PLT-191 | Every `docs/evidence/perf/<ID>/` has a lab-spec file dated in W15 | new |

### E21 Hardening, freeze, final deliverables and defence (21 issues, 72 h)

| ID | Title | Requirement IDs | Spec | Owner / rev. | Week (gate) | Est. h | Depends on | Acceptance criteria | Base |
|---|---|---|---|---|---|---|---|---|---|
| PLT-194 | Hardening (R1): fix bug-bash findings and flaky tests in own subsystems | PROC-05, MEM-06 | [testing-and-performance §3.14](../13-quality/testing-and-performance.md) | R1 / R5 | W15 (FRZ) | 5 | PLT-199 | Every severity-1 and severity-2 bug in own area closed; no gate-relevant test in quarantine | new |
| PLT-195 | Hardening (R2): fix bug-bash findings and flaky tests in own subsystems | DB-02, VFS-09 | [testing-and-performance §3.14](../13-quality/testing-and-performance.md) | R2 / R5 | W15 (FRZ) | 5 | PLT-199 | Every severity-1 and severity-2 bug in own area closed; no gate-relevant test in quarantine | new |
| PLT-196 | Hardening (R3): fix bug-bash findings and flaky tests in own subsystems | WM-03, WM-07 | [testing-and-performance §3.14](../13-quality/testing-and-performance.md) | R3 / R1 | W15 (FRZ) | 5 | PLT-199 | Every severity-1 and severity-2 bug in own area closed; no gate-relevant test in quarantine | new |
| PLT-197 | Hardening (R4): fix bug-bash findings and flaky tests in own subsystems | AGT-06, RAG-03 | [testing-and-performance §3.14](../13-quality/testing-and-performance.md) | R4 / R2 | W15 (FRZ) | 5 | PLT-199 | Every severity-1 and severity-2 bug in own area closed; no gate-relevant test in quarantine | new |
| PLT-198 | Hardening (R5): fix bug-bash findings and flaky tests in own subsystems | OFF-02, BOOT-10 | [testing-and-performance §3.14](../13-quality/testing-and-performance.md) | R5 / R1 | W15 (FRZ) | 5 | PLT-199 | Every severity-1 and severity-2 bug in own area closed; no gate-relevant test in quarantine | new |
| PLT-199 | Bug bash: every member tests another member's subsystem; bugs sorted by severity | §13.1, PLT-TEAM-05 | [implementation-plan §3.3](./implementation-plan.md) | R5 / R1 | W15 (FRZ) | 2 | PLT-191 | Bug list with severity and owner; every member files findings outside their own area | new |
| PLT-200 | First full 30-minute rehearsal on a lab PC with 2 unannounced drills | TST-18, PLT-TEAM-06 | [testing-and-performance §3.16.1](../13-quality/testing-and-performance.md) | R5 / R3 | W15 (FRZ) | 2 | PLT-191 | `docs/evidence/defence/rehearsal-1.md` with stopwatch times per segment and drills | new |
| PLT-201 | ARCHITECTURE.md: the two decisions we would reverse with hindsight | PLT-DOC-02 | [architecture §9](../01-architecture/architecture.md) | R1 / R5 | W15 (FRZ) | 1.5 | — | Section reviewed by all five | new |
| PLT-203 | All §15.2 documents complete and consistent with the specs; CHANGELOG by ID; THIRD_PARTY; BOOT.md measured critical path | PLT-DOC-07, PLT-DOC-08, PLT-DOC-12, PLT-DOC-13, PLT-DEL-01 | [README §3.8](../README.md) | R5 / R1 | W16 (FRZ) | 3 | PLT-201, PLT-184, PLT-188 | Document review checklist PLT-DOC-01..14 ticked by each document's reviewer | new |
| PLT-204 | Freeze-gate rehearsal on a machine the team does not control (v1.0.0-rc.1) | TST-18, §13.1 | [testing-and-performance §3.16.1](../13-quality/testing-and-performance.md) | R5 / R1 | W16 (FRZ) | 1.5 | PLT-202 | `docs/evidence/defence/rehearsal-2.md`; every §17.1 item shown | new |
| PLT-205 | Mock vivas W15–W18: every member questioned on every subsystem; question bank; each member's viva preparation tracked | PLT-TEAM-06 | [implementation-plan §3.15.3](./implementation-plan.md) | R1 / R5 | W16 (FRZ) | 3 | — | `docs/viva-bank.md` (about 120 questions); each member scored at least twice on own, shadowed and random subsystems; every member explains every PR they authored | new |
| PLT-206 | README complete: tagline, live URL, three-command bring-up, what works, known limitations | PLT-DOC-01, PLT-ID-11 | [identity-and-branding §3.10](../00-product/identity-and-branding.md) | R3 / R5 | W16 (FRZ) | 1.5 | — | No credentials; limitations stated honestly; bring-up verified by the bring-up job | new |
| PLT-207 | Two W17 rehearsals: lab PC on the campus network, and macOS or Windows on the 4G hotspot | TST-18 | [testing-and-performance §3.16.1](../13-quality/testing-and-performance.md) | R5 / R3 | W17 (P5) | 2 | PLT-204 | `rehearsal-3.md` and `rehearsal-4.md`; drills that failed became issues | new |
| PLT-208 | Technical report 20–30 pages (Typst, built in CI): editing and page-count check | PLT-DEL-06 | [requirements-traceability §3.10](../00-product/requirements-traceability.md) | R1 / R5 | W17 (P5) | 2.5 | — | The CI build of `docs/report/` passes the page-count check | new |
| PLT-209 | Report chapters 1 (introduction), 4 (boot, offline and sync), 8 (testing) and 10 (signed contribution statement) | PLT-DEL-07, PLT-DEL-10, PLT-DEL-14, PLT-DEL-16, PLT-TEAM-05 | [requirements-traceability §3.10](../00-product/requirements-traceability.md) | R5 / R1 | W17 (P5) | 5 | PLT-067 | Chapters merged into `docs/report/`; figures from lab evidence only | new |
| PLT-210 | Report chapters 2 (identity and distinctive idea) and 4 (window manager) | PLT-DEL-08, PLT-DEL-10 | [requirements-traceability §3.10](../00-product/requirements-traceability.md) | R3 / R5 | W17 (P5) | 3 | — | Chapters merged into `docs/report/`; figures from lab evidence only | new |
| PLT-211 | Report chapters 3 (architecture), 4 (processes, scheduling, memory), 5 (DSA analysis, with each structure owner) and 9 (limitations) | PLT-DEL-09, PLT-DEL-10, PLT-DEL-11, PLT-DEL-15 | [requirements-traceability §3.10](../00-product/requirements-traceability.md) | R1 / R5 | W17 (P5) | 6 | PLT-192 | Chapters merged into `docs/report/`; figures from lab evidence only | new |
| PLT-212 | Report chapters 4 (VFS) and 6 (database design, integrity and indexing) | PLT-DEL-10, PLT-DEL-12 | [requirements-traceability §3.10](../00-product/requirements-traceability.md) | R2 / R1 | W17 (P5) | 3 | — | Chapters merged into `docs/report/`; figures from lab evidence only | new |
| PLT-213 | Report chapter 7: AI subsystems with evaluation and safety | PLT-DEL-13 | [requirements-traceability §3.10](../00-product/requirements-traceability.md) | R4 / R2 | W17 (P5) | 2.5 | — | Chapter merged | new |
| PLT-214 | Demonstration video (5–7 minutes, no narration needed) and the Demo Day slides | PLT-DEL-04, PLT-ID-11, PLT-DEL-05 | [requirements-traceability §3.10](../00-product/requirements-traceability.md) | R3 / R5 | W17 (P5) | 6 | PLT-202 | `docs/evidence/defence/video.md` with link, duration and title "Plotinium v1.0.0 — …"; `docs/slides/` builds in CI; every member has a section | new |
| PLT-216 | T-7, T-1 and T-1-hour checklists; final defence on Demo Day with every Appendix A line live and the hidden agent benchmark | TRC-04, AGT-07, PLT-TEAM-06, TST-18, AIS-11, PLT-DEL-02 | [requirements-traceability §3.8, §3.10](../00-product/requirements-traceability.md) | R5 / R1 | W18 (P5) | 2.5 | PLT-215 | `AGT-07 hidden examiner benchmark completes at least 16 of 20` [M]; `docs/evidence/gates/p5/appendix-a.md` signed; Checklists signed in `docs/evidence/defence/` | new |


### 3.4 Requirement index

Every requirement ID of the traceability matrix, with the issues that implement or verify it (checked by `PLN-05`, §8). Design IDs that appear only in the owning specs (SVC, KPS, KMM, PVFS, WMD, DSN, SYN, SHL, DBD, SRV, SEC, OPS and others) are listed on the issues above where the issue implements them.

| Requirement ID | Issues |
|---|---|
| BOOT-01 | PLT-050 |
| BOOT-02 | PLT-062 |
| BOOT-03 | PLT-036, PLT-043, PLT-062 |
| BOOT-04 | PLT-036, PLT-062, PLT-089, PLT-135 |
| BOOT-05 | PLT-135, PLT-137 |
| BOOT-06 | PLT-123, PLT-134, PLT-137 |
| BOOT-07 | PLT-134, PLT-149 |
| BOOT-08 | PLT-134, PLT-137 |
| BOOT-09 | PLT-121, PLT-149 |
| BOOT-10 | PLT-020, PLT-022, PLT-043, PLT-149, PLT-193, PLT-198 |
| BOOT-11 | PLT-135 |
| BOOT-12 | PLT-095, PLT-136 |
| BOOT-13 | PLT-050, PLT-099, PLT-150 |
| BOOT-14 | PLT-079, PLT-083 |
| PROC-01 | PLT-056, PLT-069 |
| PROC-02 | PLT-035, PLT-070 |
| PROC-03 | PLT-070, PLT-112 |
| PROC-04 | PLT-107, PLT-112, PLT-145 |
| PROC-05 | PLT-026, PLT-069, PLT-112, PLT-145, PLT-193, PLT-194 |
| PROC-06 | PLT-069 |
| PROC-07 | PLT-069, PLT-113, PLT-127 |
| PROC-08 | PLT-014, PLT-015, PLT-016, PLT-017, PLT-018, PLT-123, PLT-127, PLT-140 |
| PROC-09 | PLT-145 |
| MEM-01 | PLT-010, PLT-066, PLT-114, PLT-123, PLT-146 |
| MEM-02 | PLT-110, PLT-128, PLT-131 |
| MEM-03 | PLT-028, PLT-128 |
| MEM-04 | PLT-125, PLT-130 |
| MEM-05 | PLT-028, PLT-146, PLT-193 |
| MEM-06 | PLT-114, PLT-146, PLT-194 |
| MEM-07 | PLT-123, PLT-129 |
| MEM-08 | PLT-170 |
| VFS-01 | PLT-048, PLT-059, PLT-091 |
| VFS-02 | PLT-059, PLT-075 |
| VFS-03 | PLT-059 |
| VFS-04 | PLT-072, PLT-092, PLT-093 |
| VFS-05 | PLT-072 |
| VFS-06 | PLT-073, PLT-076, PLT-092 |
| VFS-07 | PLT-074, PLT-090, PLT-091, PLT-092, PLT-097 |
| VFS-08 | PLT-059, PLT-091 |
| VFS-09 | PLT-002, PLT-031, PLT-108, PLT-119, PLT-124, PLT-133, PLT-144, PLT-195 |
| VFS-10 | PLT-117, PLT-124 |
| VFS-11 | PLT-126, PLT-132 |
| WM-01 | PLT-056, PLT-063 |
| WM-02 | PLT-037, PLT-063 |
| WM-03 | PLT-007, PLT-022, PLT-041, PLT-063, PLT-098, PLT-104, PLT-193, PLT-196 |
| WM-04 | PLT-077 |
| WM-05 | PLT-071, PLT-096, PLT-127, PLT-138 |
| WM-06 | PLT-095, PLT-096, PLT-105 |
| WM-07 | PLT-077, PLT-078, PLT-086, PLT-099, PLT-150, PLT-183, PLT-196 |
| OFF-01 | PLT-121, PLT-124, PLT-131, PLT-148 |
| OFF-02 | PLT-031, PLT-093, PLT-094, PLT-118, PLT-144, PLT-148, PLT-198 |
| OFF-03 | PLT-083, PLT-120 |
| OFF-04 | PLT-139, PLT-181 |
| OFF-05 | PLT-002, PLT-122, PLT-139, PLT-157 |
| SYS-01 | PLT-047, PLT-058, PLT-073, PLT-087 |
| SYS-02 | PLT-064, PLT-071, PLT-074, PLT-080, PLT-081, PLT-082, PLT-083, PLT-092, PLT-101, PLT-105, PLT-127, PLT-132, PLT-140, PLT-141, PLT-151 |
| SYS-03 | PLT-055, PLT-090, PLT-100, PLT-193 |
| DB-01 | PLT-011, PLT-040, PLT-045, PLT-061, PLT-075, PLT-147, PLT-156 |
| DB-02 | PLT-027, PLT-029, PLT-060, PLT-090, PLT-115, PLT-116, PLT-118, PLT-126, PLT-195 |
| DB-03 | PLT-027, PLT-076, PLT-115 |
| DB-04 | PLT-015, PLT-045, PLT-075, PLT-115 |
| DB-05 | PLT-006, PLT-011, PLT-027, PLT-147, PLT-193 |
| RAG-01 | PLT-153, PLT-163 |
| RAG-02 | PLT-153, PLT-174 |
| RAG-03 | PLT-160, PLT-173, PLT-197 |
| RAG-04 | PLT-030, PLT-152, PLT-174 |
| RAG-05 | PLT-030, PLT-142, PLT-161, PLT-174, PLT-182, PLT-193 |
| RAG-06 | PLT-159, PLT-161, PLT-162 |
| AGT-01 | PLT-154 |
| AGT-02 | PLT-165 |
| AGT-03 | PLT-172, PLT-175 |
| AGT-04 | PLT-141, PLT-177 |
| AGT-05 | PLT-176 |
| AGT-06 | PLT-012, PLT-023, PLT-164, PLT-165, PLT-185, PLT-197 |
| AGT-07 | PLT-012, PLT-023, PLT-164, PLT-185, PLT-216 |
| AGT-08 | PLT-176 |
| AGT-09 | PLT-176, PLT-178 |
| AGT-10 | PLT-186 |
| PRE-01 | PLT-109, PLT-180, PLT-193 |
| PRE-02 | PLT-109, PLT-180 |
| PRE-03 | PLT-187, PLT-193 |
| PRE-04 | PLT-166, PLT-187 |
| PRE-05 | PLT-155, PLT-159 |
| PRE-06 | PLT-159, PLT-179 |
| ABI-03 | PLT-047, PLT-058 |
| ABI-09 | PLT-081, PLT-113 |
| ABI-15 | PLT-047, PLT-058, PLT-071 |
| AIN-A1 | PLT-153, PLT-188 |
| AIN-A2 | PLT-153, PLT-188 |
| AIN-A3 | PLT-142, PLT-163, PLT-188 |
| AIN-A4 | PLT-161, PLT-188 |
| AIN-B1 | PLT-164, PLT-188 |
| AIN-B2 | PLT-154, PLT-188 |
| AIN-B3 | PLT-178, PLT-188 |
| AIN-B4 | PLT-176, PLT-188 |
| AIN-C1 | PLT-155, PLT-188 |
| AIN-C2 | PLT-166, PLT-188 |
| AIN-C3 | PLT-166, PLT-188 |
| AIN-C4 | PLT-166, PLT-171, PLT-188 |
| AIS-01 | PLT-167 |
| AIS-02 | PLT-162, PLT-181, PLT-184 |
| AIS-03 | PLT-185 |
| AIS-04 | PLT-012, PLT-152, PLT-180 |
| AIS-05 | PLT-008, PLT-023, PLT-030, PLT-042 |
| AIS-06 | PLT-020, PLT-143, PLT-189 |
| AIS-07 | PLT-002, PLT-023, PLT-143, PLT-167 |
| AIS-08 | PLT-017, PLT-143, PLT-189 |
| AIS-09 | PLT-143, PLT-189 |
| AIS-10 | PLT-168 |
| AIS-11 | PLT-216 |
| AIS-12 | PLT-042, PLT-188 |
| ARC-01 | PLT-014, PLT-044, PLT-087 |
| ARC-02 | PLT-010, PLT-044, PLT-057 |
| ARC-04 | PLT-044, PLT-098 |
| ARC-06 | PLT-167, PLT-190 |
| ARC-08 | PLT-149 |
| CPL-A-MEM | PLT-142, PLT-188 |
| DSA-BLOOM-01 | PLT-111 |
| DSA-DAG-01 | PLT-036 |
| DSA-DAG-02 | PLT-036 |
| DSA-DAG-03 | PLT-036, PLT-089 |
| DSA-DB-01 | PLT-045, PLT-147 |
| DSA-GEN-01 | PLT-020 |
| DSA-GEN-02 | PLT-035, PLT-036, PLT-048 |
| DSA-GEN-03 | PLT-035, PLT-055, PLT-192 |
| DSA-GEN-04 | PLT-034, PLT-192 |
| DSA-GEN-05 | PLT-056 |
| DSA-GEN-06 | PLT-035, PLT-126 |
| DSA-GEN-07 | PLT-053 |
| DSA-GEN-08 | PLT-020, PLT-053 |
| DSA-GEN-09 | PLT-192 |
| DSA-HASH-01 | PLT-056 |
| DSA-HEAP-01 | PLT-035 |
| DSA-HEAP-02 | PLT-035 |
| DSA-IVT-01 | PLT-169 |
| DSA-LRU-01 | PLT-110 |
| DSA-LRU-02 | PLT-110 |
| DSA-MAP-01 | PLT-034, PLT-073 |
| DSA-RING-01 | PLT-049 |
| DSA-TREE-01 | PLT-048 |
| DSA-TREE-02 | PLT-048 |
| DSA-TREE-03 | PLT-048 |
| DSA-TRIE-01 | PLT-055 |
| DSA-TRIE-02 | PLT-055 |
| DSA-TRIE-03 | PLT-055 |
| DSA-ZORD-01 | PLT-037 |
| PLT-DEL-01 | PLT-202, PLT-203, PLT-215 |
| PLT-DEL-02 | PLT-024, PLT-025, PLT-051, PLT-066, PLT-103, PLT-215, PLT-216 |
| PLT-DEL-03 | PLT-202, PLT-215 |
| PLT-DEL-04 | PLT-214 |
| PLT-DEL-05 | PLT-214 |
| PLT-DEL-06 | PLT-208 |
| PLT-DEL-07 | PLT-209 |
| PLT-DEL-08 | PLT-210 |
| PLT-DEL-09 | PLT-211 |
| PLT-DEL-10 | PLT-209, PLT-210, PLT-211, PLT-212 |
| PLT-DEL-11 | PLT-211 |
| PLT-DEL-12 | PLT-212 |
| PLT-DEL-13 | PLT-213 |
| PLT-DEL-14 | PLT-209 |
| PLT-DEL-15 | PLT-211 |
| PLT-DEL-16 | PLT-209 |
| PLT-DOC-01 | PLT-103, PLT-206 |
| PLT-DOC-02 | PLT-044, PLT-201 |
| PLT-DOC-03 | PLT-005, PLT-006, PLT-007, PLT-008, PLT-009, PLT-014, PLT-015, PLT-016, PLT-017, PLT-018, PLT-032, PLT-039, PLT-040, PLT-041, PLT-042, PLT-043 |
| PLT-DOC-04 | PLT-034, PLT-192 |
| PLT-DOC-05 | PLT-045, PLT-147 |
| PLT-DOC-06 | PLT-042, PLT-168, PLT-188 |
| PLT-DOC-07 | PLT-043, PLT-203 |
| PLT-DOC-08 | PLT-104, PLT-158, PLT-203 |
| PLT-DOC-09 | PLT-065, PLT-184 |
| PLT-DOC-10 | PLT-014, PLT-015, PLT-016, PLT-017, PLT-018, PLT-019 |
| PLT-DOC-11 | PLT-013 |
| PLT-DOC-12 | PLT-103, PLT-203 |
| PLT-DOC-13 | PLT-068, PLT-203 |
| PLT-DOC-14 | PLT-001 |
| PLT-ID-01 | PLT-001 |
| PLT-ID-02 | PLT-001, PLT-038 |
| PLT-ID-03 | PLT-038, PLT-097 |
| PLT-ID-04 | PLT-085, PLT-103, PLT-157, PLT-190 |
| PLT-ID-05 | PLT-001 |
| PLT-ID-06 | PLT-016, PLT-078 |
| PLT-ID-07 | PLT-088 |
| PLT-ID-08 | PLT-050, PLT-079, PLT-137 |
| PLT-ID-09 | PLT-097 |
| PLT-ID-10 | PLT-097 |
| PLT-ID-11 | PLT-003, PLT-206, PLT-214 |
| PLT-ID-12 | PLT-038 |
| PLT-ID-13 | PLT-088 |
| PLT-ID-14 | PLT-088 |
| PLT-ID-15 | PLT-085 |
| PLT-ID-16 | PLT-038 |
| PLT-TEAM-01 | PLT-001 |
| PLT-TEAM-02 | PLT-001 |
| PLT-TEAM-03 | PLT-003, PLT-004 |
| PLT-TEAM-04 | PLT-004 |
| PLT-TEAM-05 | PLT-067, PLT-199, PLT-209 |
| PLT-TEAM-06 | PLT-046, PLT-200, PLT-205, PLT-216 |
| PLT-TEAM-07 | PLT-013 |
| PLT-TEAM-08 | PLT-013 |
| PLT-TEAM-09 | PLT-013 |
| PLT-TEAM-10 | PLT-013 |
| PLT-TEAM-11 | PLT-013 |
| PLT-TEAM-12 | PLT-013 |
| PLT-TEAM-13 | PLT-020, PLT-021, PLT-032 |
| PLT-TEAM-14 | PLT-004, PLT-067 |
| PVFS-09 | PLT-088 |
| SHL-05 | PLT-016, PLT-064 |
| SHL-12 | PLT-082 |
| TRC-01 | PLT-021, PLT-052 |
| TRC-02 | PLT-020 |
| TRC-03 | PLT-054 |
| TRC-04 | PLT-054, PLT-106, PLT-158, PLT-191, PLT-216 |
| TRC-05 | PLT-004, PLT-052 |
| TRC-06 | PLT-054 |
| TRC-07 | PLT-052 |
| TRC-08 | PLT-002 |
| TST-02 | PLT-018, PLT-020, PLT-053 |

### 3.5 Week index

Issues by week and owner, with the owner's planned hours that week. Weeks above about 11.5 h for one member are surge weeks and are watched at Monday planning.

| Week | Gate | R1 | R2 | R3 | R4 | R5 |
|---|---|---|---|---|---|---|
| W1 | G0 | PLT-005, PLT-010 (5 h) | PLT-006, PLT-011 (5.5 h) | PLT-001, PLT-007 (5 h) | PLT-008, PLT-012 (6.5 h) | PLT-002, PLT-003, PLT-004, PLT-009 (7.5 h) |
| W2 | G0 | PLT-014, PLT-026 (7.5 h) | PLT-015, PLT-021, PLT-024 (10 h) | PLT-016, PLT-022 (8.5 h) | PLT-017, PLT-019, PLT-023 (12 h) | PLT-013, PLT-018, PLT-020, PLT-025 (11.5 h) |
| W3 | P1 | PLT-028, PLT-034, PLT-035 (10 h) | PLT-027, PLT-029, PLT-031 (10 h) | PLT-033, PLT-037, PLT-038 (10 h) | PLT-030 (5 h) | PLT-032, PLT-036 (8 h) |
| W4 | P1 | PLT-039, PLT-044, PLT-047 (10 h) | PLT-040, PLT-045, PLT-048 (11.5 h) | PLT-041, PLT-046, PLT-050 (9.5 h) | PLT-042 (4.5 h) | PLT-043, PLT-049, PLT-051 (8.5 h) |
| W5 | P2 | PLT-056, PLT-057, PLT-058 (11 h) | PLT-059, PLT-060, PLT-061 (8 h) | PLT-055, PLT-063, PLT-064 (13 h) | PLT-052, PLT-054, PLT-065 (8 h) | PLT-053, PLT-062, PLT-066 (12.5 h) |
| W6 | P2 | PLT-069, PLT-070, PLT-071 (10 h) | PLT-072, PLT-073, PLT-074, PLT-075, PLT-076 (11.5 h) | PLT-077, PLT-078, PLT-079, PLT-080 (11.5 h) | PLT-067, PLT-068, PLT-081, PLT-082, PLT-086 (9 h) | PLT-083, PLT-084, PLT-085 (9.5 h) |
| W7 | P2 | PLT-087, PLT-088, PLT-089, PLT-104 (11 h) | PLT-090, PLT-091, PLT-092, PLT-093 (13 h) | PLT-096, PLT-098, PLT-099 (8.5 h) | PLT-097, PLT-100, PLT-101, PLT-102, PLT-105 (14.5 h) | PLT-094, PLT-095, PLT-103, PLT-106 (9 h) |
| W8 | P3 | PLT-107 (2.5 h) | PLT-108 (4 h) | — | PLT-109 (2.5 h) | — |
| W9 | P3 | PLT-110, PLT-112, PLT-114, PLT-125 (13.5 h) | PLT-115, PLT-116, PLT-117 (12 h) | PLT-113, PLT-122, PLT-123 (10 h) | PLT-111, PLT-124, PLT-126 (9.5 h) | PLT-118, PLT-119, PLT-120, PLT-121 (13 h) |
| W10 | P3 | PLT-127, PLT-128, PLT-130 (10.5 h) | PLT-131, PLT-132, PLT-133 (8 h) | PLT-129, PLT-137, PLT-138, PLT-139, PLT-140 (12 h) | PLT-142, PLT-143, PLT-144 (10.5 h) | PLT-134, PLT-135, PLT-136, PLT-141 (12.5 h) |
| W11 | P3 | PLT-145, PLT-146 (8.5 h) | PLT-147 (4.5 h) | PLT-148, PLT-149, PLT-150, PLT-151 (10 h) | PLT-152, PLT-153, PLT-154, PLT-155 (12 h) | PLT-156, PLT-157, PLT-158 (8 h) |
| W12 | P4 | PLT-163, PLT-166 (5 h) | PLT-160 (3 h) | PLT-159, PLT-162 (6 h) | PLT-161, PLT-164, PLT-165, PLT-168 (11 h) | PLT-167 (4.5 h) |
| W13 | P4 | PLT-170, PLT-178, PLT-181 (6.5 h) | PLT-173, PLT-176 (6.5 h) | PLT-169, PLT-172, PLT-179 (7 h) | PLT-174, PLT-175 (6 h) | PLT-171, PLT-177, PLT-180, PLT-182 (7 h) |
| W14 | P4 | PLT-187 (2.5 h) | PLT-184, PLT-186 (4 h) | PLT-183 (1.5 h) | PLT-185, PLT-188, PLT-189 (8.5 h) | PLT-190, PLT-191 (3 h) |
| W15 | FRZ | PLT-192, PLT-193, PLT-194, PLT-201 (10.5 h) | PLT-195 (5 h) | PLT-196 (5 h) | PLT-197 (5 h) | PLT-198, PLT-199, PLT-200 (9 h) |
| W16 | FRZ | PLT-205 (3 h) | — | PLT-206 (1.5 h) | — | PLT-202, PLT-203, PLT-204 (7.5 h) |
| W17 | P5 | PLT-208, PLT-211 (8.5 h) | PLT-212 (3 h) | PLT-210, PLT-214 (9 h) | PLT-213 (2.5 h) | PLT-207, PLT-209 (7 h) |
| W18 | P5 | — | — | — | — | PLT-215, PLT-216 (4.5 h) |

## 4. Interfaces and data shapes

### 4.1 `backlog.csv`

| Column | Type | Example |
|---|---|---|
| `id` | `PLT-###` | `PLT-061` |
| `title` | string | `Implement dsa/tree (n-ary tree, …) and flip IMPLEMENTED` |
| `epic`, `epic_name` | `E00`–`E21`, string | `E05`, `Data structures (dsa/, team-written)` |
| `requirement_ids` | `;`-separated IDs | `VFS-01;DSA-TREE-01;DSA-TREE-02` |
| `spec` | repo path and section | `specs/08-dsa/data-structures.md §3.5 S1` |
| `owner`, `reviewer` | `R1`…`R5`, different | `R2`, `R1` |
| `week` | 1–18 | `4` |
| `gate` | `G0`, `P1`, `P2`, `P3`, `P4`, `FRZ`, `P5` | `P1` |
| `estimate_h` | number, ≤ 6 | `5` |
| `dependencies` | `;`-separated `PLT-###` | `PLT-012;PLT-020` |
| `acceptance_criteria` | test titles or evidence files | `VFS-01 resolving a depth-8 path performs exactly 8 child lookups; …` |
| `baseline` | `new`, `scaffold`, `ai-draft` | `scaffold` |

### 4.2 GitHub mapping

| Backlog field | GitHub |
|---|---|
| `id` + `title` | issue title `PLT-061 Implement dsa/tree …` |
| `requirement_ids` | labels `req:<ID>` (one per ID) |
| `owner`, `reviewer` | assignee = the member holding the owner role; the reviewer is named in the body and requested on the PR by CODEOWNERS |
| `gate` | milestone `G0` … `P5` |
| `week`, `estimate_h`, `baseline`, `epic` | Projects fields Week, Estimate, Baseline, Epic |
| `dependencies` | task list "Depends on #n" in the body |
| `acceptance_criteria` | checklist in the body; each item is a test title or an evidence path |

Labels also include `role:R1`…`role:R5`, `kw:Must|Should|May` for the primary ID, and `loan` for PLN-14 issues.

## 5. Algorithms and invariants

- **Coverage (PLN-05).** Collect every token of the traceability file that matches the ID grammar of [traceability §4.1](../00-product/requirements-traceability.md); expand ranges written as `X-01..14` or `AIN-A1..C4`; collect the IDs listed in this file; report the difference. O(size of both files). The check in §8, run on `backlog.csv` (issue rows only) and on this file, found **no missing ID** on this revision: all 218 IDs are on at least one issue, and no row of the §3.4 index reads MISSING.
- **Dependencies (PLN-06).** Kahn's algorithm over the `dependencies` column must visit every issue (acyclic), and for every edge `d → i`, `week(d) ≤ week(i)`. An edge with `week(d) = week(i)` makes `d` a zero-slack issue; zero-slack issues are listed at Monday planning ([implementation-plan §3.4](./implementation-plan.md)).
- **Load.** For each role r and phase p, the sum of estimates is compared with the member's focus capacity for p; above 100% the phase needs the surge allowance or a re-assignment, above 115% after surge the scope-cut list applies.
- **Invariants.** B-1: owner ≠ reviewer on every row. B-2: every issue has at least one requirement ID or `§` obligation. B-3: no `dsa/` issue has baseline `ai-draft`. B-4: every gate Must of [traceability §3.4](../00-product/requirements-traceability.md) has an issue whose gate is no later than the gate at which the ID is due.

## 6. Errors and edge cases

| Case | Rule |
|---|---|
| An issue grows beyond 6 h | Split it at planning; the parts keep the requirement IDs and the original acceptance criteria are distributed |
| An `ai-draft` baseline does not exist when the issue starts | Re-estimate (typically ×2), tell the Monday planning, apply the scope-cut list if the phase goes above 115% |
| A spec amendment adds or changes a requirement | TRC-08: the traceability file changes within 2 working days; a new issue is added here the same week and `PLN-05` is re-run |
| An owner is unavailable for more than a week | The secondary reviewer takes the issue (TEAM_CONTRACT §5); the swap is recorded on the board, not by editing history |
| A dependency slips past the dependent issue's week | The dependent issue moves or is split so that a mockable part (for example against protocol schemas, as for the lock manager) proceeds |
| A May item is not built | Its issue is closed as "cut" with a link to the scope-cut decision; the traceability row stays `stretch-not-built` |
| A requirement is verified only live | Its issue's acceptance criteria name the `GATE:` evidence file; a second member reviews that file |

## 7. Performance budgets

No runtime budgets. Planning budgets (Plotinium design): an issue ≤ 6 h of owner time; WIP ≤ 2 issues in progress per member; a PR ≤ 400 changed lines excluding tests, fixtures and generated files; review within 24 h on weekdays (4 h in gate weeks). The runtime budgets that acceptance criteria cite are the ones of [requirements-traceability §7](../00-product/requirements-traceability.md).

## 8. Test plan

| Test title | Level | Runs |
|---|---|---|
| `PLN-05 every requirement ID of the traceability matrix appears in backlog.md` | docs check | every PR touching `specs/00-product/requirements-traceability.md` or `specs/16-delivery/**` |
| `PLN-06 every backlog row has owner different from reviewer, an estimate of at most 6 h and dependencies scheduled no later than the row` | docs check | every PR touching `specs/16-delivery/**` |
| `PLN-06 the backlog dependency graph is acyclic` | docs check | every PR touching `specs/16-delivery/**` |
| `PLN-14 every loan issue is reviewed by the primary owner of its area` | review | each loan PR |
| `TRC-01 every one of the 84 spec IDs appears exactly once in the master matrix with every column filled` | docs check | owned by the traceability spec |

At this revision the `PLN-05` check was run with the script below: 218 IDs expected (ranges expanded), 218 found, none missing. It is kept here so the team can port it to `tools/check-backlog.ts` in the docs checks of the lint job (team TODO, with PLT-052). Run it against the issue rows, `python3 check_ids.py specs/00-product/requirements-traceability.md specs/16-delivery/backlog.csv`, and against this file; only the CSV run proves that every ID sits on an issue, because the index of §3.4 lists every traceability ID by construction (an ID without an issue would read **MISSING** there).

```python
"""Verify that every requirement ID of the traceability matrix appears in backlog.md.

Usage: python3 check_ids.py <traceability.md> <backlog.md>
IDs are taken from the ID grammar of requirements-traceability §4.1; ranges written as
X-01..14, AIN-A1..C4 and similar are expanded. Exit code 1 if any ID is missing.
"""
import re, sys

GRAMMAR = re.compile(
    r'(?<![A-Za-z0-9-])('
    r'BOOT-(?:0[1-9]|1[0-4])|PROC-0[1-9]|MEM-0[1-8]|VFS-(?:0[1-9]|1[01])|WM-0[1-7]|OFF-0[1-5]|SYS-0[1-3]'
    r'|DB-0[1-5]|RAG-0[1-6]|AGT-(?:0[1-9]|10)|PRE-0[1-6]'
    r'|PLT-(?:ID|DOC|DEL|TEAM)-\d{2}'
    r'|(?:TRC|GLO|SPX|ARC|ABI|SVC|KPS|KMM|PVFS|WMD|DSN|SYN|SHL|DBD|SRV|TST|AIS)-\d{2}'
    r'|INV-ABI-\d{1,2}'
    r'|DSA-(?:GEN|TREE|TRIE|HEAP|DAG|LRU|HASH|RING|BLOOM|ZORD|IVT|DB|MAP)-\d{2}'
    r'|AIN-[ABC][1-4]'
    r'|CPL-[ABC]-(?:SCHED|MEM|VFS|SHELL|DB|SEC)'
    r')(?![A-Za-z0-9])')
RANGE = re.compile(r'(?<![A-Za-z0-9-])((?:[A-Z]+-)+)([A-Z]?)(\d{1,2})\s*(?:\.\.|…)\s*([A-Z]?)(\d{1,2})(?![0-9])')


def expand_ranges(text):
    out = set()
    for m in RANGE.finditer(text):
        prefix, l1, n1, l2, n2 = m.groups()
        width = len(n1)
        letters = [l1] if not l1 else [chr(c) for c in range(ord(l1), ord(l2 or l1) + 1)]
        for L in letters:
            for n in range(int(n1), int(n2) + 1):
                cand = f'{prefix}{L}{n:0{width}d}'
                if GRAMMAR.fullmatch(cand):
                    out.add(cand)
    return out


def ids_in(text):
    return set(GRAMMAR.findall(text)) | expand_ranges(text)


def main():
    trace = open(sys.argv[1], encoding='utf-8').read()
    backlog = open(sys.argv[2], encoding='utf-8').read()
    want = ids_in(trace)
    have = set(GRAMMAR.findall(backlog))  # the backlog lists IDs explicitly, never as ranges
    missing = sorted(want - have)
    spec84 = {i for i in want if re.fullmatch(r'(BOOT|PROC|MEM|VFS|WM|OFF|SYS|DB|RAG|AGT|PRE)-\d{2}', i)}
    print(f'traceability IDs (ranges expanded): {len(want)}; of which spec IDs: {len(spec84)}')
    print(f'IDs present in backlog: {len(have & want)}; extra design IDs only in backlog: {len(have - want)}')
    print('missing:', ', '.join(missing) if missing else 'none')
    return 1 if missing else 0


if __name__ == '__main__':
    sys.exit(main())
```

## 9. Open questions and cross-spec requests

**Open questions**
- Q1 (R5, W2): GitHub Projects or plain milestones and labels? The plan assumes Projects (fields Week, Estimate, Baseline, Epic).
- Q2 (team, W2): are estimates re-planned in hours or in S/M/L at Monday planning? This file uses hours because the capacity model does; TEAM_CONTRACT's definition of ready says S/M/L and should say hours (≤ 6 h).

**Cross-spec requests**
- To [requirements-traceability](../00-product/requirements-traceability.md): register the prefix `PLN-nn` (implementation plan and backlog rules) in §3.13; state that issue keys `PLT-###` (three digits, no middle segment) are not requirement IDs so the SPX-05 ID check ignores them; §3.7 names R5 as owner of the Puter and daedalOS analysis, while this backlog gives it to R3 (R5 reviews) to balance Weeks 1–3.
- To [deployment-and-ci](../14-devops/deployment-and-ci.md): the ownership matrix from which `tools/codeowners.ts` regenerates CODEOWNERS is [implementation-plan §3.12](./implementation-plan.md); loans (PLN-14) never change it.
- To [data-structures](../08-dsa/data-structures.md): the implement-by weeks change as follows (the plan is canonical when it differs): S4 DAG and S9 z-order W3; S1 tree and S7 ring buffer W4; S2 trie and S6 hash table W5; S5 LRU and S8 Bloom filter W9. The CODEOWNERS dsa reviewer lines currently differ from your §3.3 (heap, hash table, LRU, trie, DAG, ring buffer, Bloom filter); issue PLT-004 aligns CODEOWNERS with §3.3.
- To [testing-and-performance](../13-quality/testing-and-performance.md): adopt the `PLN-05` and `PLN-06` titles in the docs checks of the lint job.
