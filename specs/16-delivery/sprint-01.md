# Sprint 01

| Field | Value |
|---|---|
| Title | Plotinium Sprint 01 (Weeks 1–2): registration, team contract, repository and CI, pre-registration, the first time-boxed spikes, and the review of the AI-generated code |
| Status | Draft v0.1, 2026-09-25 |
| Primary owner | R5 QA/DevOps & Integration Engineer (secretary; runs the sprint and the W2 exit checklist) |
| Secondary reviewer | R1 Kernel / Systems Architect (all five members approve the sprint plan at the kickoff) |
| Must be demonstrable at | **G0 Registration (end of W2):** every line of the W2 exit checklist (§3.4) ticked, signed by all five and committed to `docs/evidence/gates/g0/exit-checklist.md`. |
| Requirement IDs covered | Spec §4.1–§4.4, §5 (registration), §13.1 (Registration phase), §14.1 item 3 (criteria before scoring), §15.4, §18; PLT-ID-01, PLT-ID-02, PLT-ID-05, PLT-ID-17, PLT-DOC-03, PLT-DOC-10, PLT-DOC-11, PLT-DOC-14, PLT-TEAM-01, PLT-TEAM-02, PLT-TEAM-03, PLT-TEAM-04, PLT-TEAM-07 … PLT-TEAM-14, TRC-01, TRC-02, TRC-05, AIS-05, AIS-06, AIS-07, DSA-GEN-01, DSA-GEN-08, TST-02, TST-21; Plotinium design IDs PLN-15 and SPR-01 … SPR-06 (§2) |
| Related specs | [Implementation plan](./implementation-plan.md) · [Backlog](./backlog.md) · [Identity and branding](../00-product/identity-and-branding.md) · [Requirements traceability](../00-product/requirements-traceability.md) · [Stack decisions](../15-decisions/stack-decisions.md) · [Deployment and CI](../14-devops/deployment-and-ci.md) · [Testing and performance](../13-quality/testing-and-performance.md) · [AI safety and evaluation](../10-ai/ai-safety-and-evaluation.md) |

---

## 1. Purpose and scope

**Sprint goal.** By Friday of Week 2 the team is registered under the name **Plotinium** (coined from plutonium, element 94; alternative **Tabium**), has signed its contract, works in a protected repository whose CI runs on every pull request, has pre-registered the criteria of all 14 decision records before any measurement, has run the first time-boxed spikes (S0, S1 and the S1b kata, the S4 setup, S7, S10 measurements, S11) and has reviewed and adopted the AI-generated code, each member in their own area. That is the G0 gate ([implementation-plan §3.7.1](./implementation-plan.md)).

**Dates.** Days are counted from the Monday of Week 1 (D1) to the Friday of Week 2 (D10); the calendar of [implementation-plan §3.2](./implementation-plan.md) turns them into dates. Nothing is planned for weekends.

**Capacity.** 13 h per member per week; after about 2 h of rituals and 0.5 h of reviewing, about 10.5 h of focus a week. The backlog issues of the sprint total 79 h: W1 5 h, 5.5 h, 5 h, 6.5 h, 7.5 h and W2 7.5 h, 10 h, 8.5 h, 12 h, 11.5 h by member (R1, R2, R3, R4, R5). R4 and R5 are slightly over in W2: the S7 runs execute unattended, and part of R5's CI work lands in W1 when the first pull requests arrive.

**Out of scope** (Sprint 02, W3): the S4 core runs, S5 M1/M2, S6, S3-lite, the evidence freeze and the risk register, the first `dsa/` implementations (heap, DAG, z-order) and the identity kit.

## 2. Requirements table

| ID | Summary | Spec § | How verified |
|---|---|---|---|
| §13.1 (Registration) | Spec: MUST. Five members confirmed; name approved as unique and appropriate; repository reachable; CI runs on a pull request | §13.1 | W2 exit checklist (§3.4) |
| PLT-ID-01 | Spec: MUST. A decent, original name registered on the Appendix D form by the end of W2; signed scan in `docs/registration.pdf` | §5, App. D | `PLT-ID-01 registration.pdf exists, carries five signatures and registers Plotinium` [M] |
| PLT-DOC-11 | Spec: MUST. `TEAM_CONTRACT.md` with the six §4.4 items, merged through a PR | §4.4 | Merged PR approved by all five |
| PLT-TEAM-04 | Spec: MUST. Every PR approved by another member; no direct pushes to `main` | §4.2, §15.4 | `docs/evidence/gates/g0/ruleset-main.json` |
| PLT-DOC-03, DEC-02 | Spec: MUST (§14.1 item 3). Criteria and weights declared before scoring; Plotinium design: pre-registration PRs merged before any evidence commit | §14.1 | Git-timestamp check of [stack-decisions §5.4](../15-decisions/stack-decisions.md) |
| PLT-DOC-10 | Spec: MUST (§18). AI assistance disclosed: tools, what was asked, accepted, rejected and why | §18 | `AI_USAGE.md` row 1 completed |
| PLN-15 | Plotinium design. The W2 exit checklist is the G0 gate check | §13.1 | Signed checklist |
| SPR-01 | Plotinium design. The scaffold import is one labelled commit, excluded from contribution statistics | §16.4, §18 | Commit message; equity exclusion list |
| SPR-02 | Plotinium design. No file under `docs/evidence/<decision>/` is committed before that decision's pre-registration PR is merged | §14.1 | Git-timestamp check |
| SPR-03 | Plotinium design. Every AI-generated package is reviewed by its owner and one other member in an explain-your-code session before any feature work on it | §18, §16.4 | Session notes on the onboarding issue |
| SPR-04 | Plotinium design. Spikes are time-boxed: each has an hour budget and a stop rule; a spike that cannot finish in its box reports what it has and the record uses cited benchmarks | §14.1 item 4 | Spike table (§3.6) |
| SPR-05 | Plotinium design. The VPS is ordered within 72 hours of starting the purchase loop, otherwise the fallback provider is ordered | §14.2 | Purchase log |
| SPR-06 | Plotinium design. No secret is committed: API keys live in the provider console, the members' password manager and later the server's secret files | §18, §12.6 | gitleaks on every PR |

## 3. Design (normative)

### 3.1 Sprint backlog

| Issue | Title | Owner / rev. | Week | Est. h |
|---|---|---|---|---|
| PLT-001 | Vote the tagline, commit docs/identity/identity.json and submit the Appendix D form in Week 1 (Plotinium; alternative Tabium) | R3 / R5 | W1 | 3 |
| PLT-002 | Send the Week-1 instructor questions and log the written answers | R5 / R1 | W1 | 1 |
| PLT-003 | Create the GitHub organisation, one-member teams r1–r5 and the plotinium repository; add the instructor | R5 / R1 | W1 | 2 |
| PLT-004 | Main-branch ruleset, tag ruleset and CODEOWNERS with real team handles | R5 / R1 | W1 | 2 |
| PLT-005 | Pre-register D2a and D2b: criteria, weights, anchored scales, spike rules | R1 / R5 | W1 | 2 |
| PLT-006 | Pre-register D5, D6 and D7 | R2 / R5 | W1 | 2.5 |
| PLT-007 | Pre-register D1 (UI framework) including the S1b kata rule | R3 / R1 | W1 | 2 |
| PLT-008 | Pre-register D8, D9, D10 and D11 with the single LLM selection rule | R4 / R2 | W1 | 2.5 |
| PLT-009 | Pre-register D3, D4, D12, D13 and D14 | R5 / R1 | W1 | 2.5 |
| PLT-010 | S0 capability probe on Chrome stable and beta (nested module workers, SAB in executors, OPFS sync handles, isolation, Web Locks, memory API) | R1 / R5 | W1 | 3 |
| PLT-011 | S4 setup: compose PostgreSQL 18 + pgvector; seed at least 50 users with 10k and 100k inodes (depth histogram) | R2 / R5 | W1 | 3 |
| PLT-012 | Write AGT-40 v0 and INJ-20 v0 with the fixture VFS (about 300 files, 3 users, frozen clock) | R4 / R2 | W1 | 4 |
| PLT-013 | Complete, sign and merge TEAM_CONTRACT.md (the six §4.4 items) | R5 / R1 | W2 | 2 |
| PLT-014 | Onboarding (R1): review and adopt the AI-generated protocol/, kernel stubs and package-boundary lint rules; do the S1b Task-Manager kata | R1 / R5 | W2 | 5 |
| PLT-015 | Onboarding (R2): review and adopt the AI-generated db/, server/src/{vfs,db} and vfs/src modules; do the S1b Task-Manager kata | R2 / R5 | W2 | 5 |
| PLT-016 | Onboarding (R3): review and adopt the AI-generated ui/ tokens and icons, apps/shell lexer and parser, and the Stitch screens; do the S1b Task-Manager kata | R3 / R1 | W2 | 5.5 |
| PLT-017 | Onboarding (R4): review and adopt the AI-generated ai/ indexer modules and server/src/llm stubs; do the S1b Task-Manager kata | R4 / R2 | W2 | 5 |
| PLT-018 | Onboarding (R5): review and adopt the AI-generated CI workflows, tools/, tests/ support, compose files, Dockerfile and ops/; do the S1b Task-Manager kata | R5 / R1 | W2 | 4 |
| PLT-019 | Complete AI_USAGE.md row 1: what each member accepted and rejected from the AI-assisted work, and why | R4 / R5 | W2 | 2 |
| PLT-020 | CI green on the first PR (format, lint, typecheck, traceability --strict, Vitest with coverage, gitleaks, commitlint) and S11 toolchain timing | R5 / R1 | W2 | 4 |
| PLT-021 | Seed the GitHub board from backlog.csv and docs/requirements.csv (gh CLI script) | R2 / R5 | W2 | 2 |
| PLT-022 | S1 framework benchmark: the 10-window desktop in Solid, React, Svelte and vanilla on the lab machine | R3 / R5 | W2 | 3 |
| PLT-023 | S7 reduced LLM bake-off: AGT-40 and INJ-20, 3 runs per configuration, within USD 25 | R4 / R5 | W2 | 5 |
| PLT-024 | S8 clean bring-up timing (lab PC, home broadband, fresh runner) and region RTT from the LGU lab | R2 / R5 | W2 | 3 |
| PLT-025 | Buy the VPS (Hetzner CX33 retry loop, OVH VPS-2 after 72 h), the Student Pack domain and DNS | R5 / R2 | W2 | 1.5 |
| PLT-026 | Lab-spec runner (schedule and workflow_dispatch only) and the CPU calibration of hosted runners | R1 / R5 | W2 | 2.5 |

### 3.2 Before D1 (every member)

- A GitHub account with two-factor authentication; apply for the GitHub Student Developer Pack (it takes days to approve).
- Chrome stable, Docker Engine or Desktop with Compose ≥ 2.24.4, Node.js 24 (`.node-version`), pnpm via `corepack enable`.
- A copy of the current project folder from R5. It is **not yet a git repository**; R5 imports it on D1 (§3.8).
- Read [specs/README.md](../README.md), the [glossary](../00-product/glossary.md) and [architecture §3](../01-architecture/architecture.md); skim your own role's specs ([implementation-plan §3.12](./implementation-plan.md)).

### 3.3 Day by day

Hours in brackets are focus hours for backlog issues; meetings are ritual time. "Prereg" means a pre-registration PR ([stack-decisions §3.2](../15-decisions/stack-decisions.md)).

**Week 1**

| Day | Team | R1 Kernel | R2 VFS/DB | R3 WM/UI | R4 AI | R5 QA/DevOps |
|---|---|---|---|---|---|---|
| D1 Mon | Kickoff (90 min): who holds R1–R5; meeting times and reply times; tagline shortlist from [identity §3.4](../00-product/identity-and-branding.md); the plan and the backlog walked through; `pnpm install && pnpm run ci` on every laptop | Draft prereg D2a and D2b (PLT-005) [1.5] | Draft prereg D5, D6, D7 (PLT-006) [1.5] | Fill the registration form draft: names, roll numbers, roles (PLT-001) [1]; draft prereg D1 with the S1b rule (PLT-007) [1] | Draft prereg D8–D11 (PLT-008) [1.5]; open the Anthropic account, request the academic programme, create a bake-off key with a US$25 spend cap (never in the repository) | Send questions Q1–Q15 to the instructor (PLT-002) [1]; create the organisation, teams `r1`–`r5` and repository `plotinium`; import the scaffold (§3.8) (PLT-003) [2] |
| D2 Tue | Tagline vote (20 min, majority; R3 breaks a tie) | Open prereg PRs; prepare the S0 probe page (no results committed) [1] | Open prereg PRs; bring up the compose database locally; prepare the S4 seed run [1] | Commit `docs/identity/identity.json`; complete the form with the voted tagline and print it [1] | Open prereg PRs [1]; start AGT-40 v0 and the fixture VFS (PLT-012) [1] | Rulesets on `main` and on tags; CODEOWNERS with the team handles (PLT-004) [2]; open prereg D3, D4 (with R2), D12, D13, D14 (PLT-009) [1.5]; create the Hetzner account (card verification) |
| D3 Wed | All five sign the form (10 min); prereg reviews (§3.5 pairs, two approvals each, never the author) | Review prereg PRs (pairs in §3.5) | Review prereg PRs (pairs in §3.5) | **Submit the registration form** (Plotinium; alternative Tabium) with Q4; review prereg PRs [0.5] | Review prereg PRs; INJ-20 v0 cases [1.5] | Make CI green on the first PRs (the prereg PRs), fix any red job (start of PLT-020) [1]; review prereg PRs |
| D4 Thu | **All 14 prereg PRs merged** (hard deadline Friday) | **S0** on Chrome stable and beta; results to `docs/evidence/D2b/` (PLT-010) [2.5] | **S4 setup**: seed ≥ 50 users with 10k and 100k inodes; manifest and depth histogram to `docs/evidence/D5/` (PLT-011) [2.5] | Prepare the S1 run on the lab machine (the pilot harness re-run as team evidence) [0.5] | Datasets v0 committed under `ai/eval/` [1.5] | Start the VPS purchase loop `ops/buy-server.sh` (72 h rule, §3.9); board columns and fields |
| D5 Fri | **M0 checkpoint** (15 min demo): prereg merged before any evidence, repository, ruleset and CI, S0 result, form submitted; W2 plan | S0 write-up in the D2b record draft [0.5] | Seed checks; S8 plan [0.5] | Start reading `ui/`, `apps/shell` and the Stitch screens for the review | Start reading `ai/` for the review | Monday-note template; onboarding pairs for W2 |

**Week 2**

| Day | Team | R1 Kernel | R2 VFS/DB | R3 WM/UI | R4 AI | R5 QA/DevOps |
|---|---|---|---|---|---|---|
| D6 Mon | Monday planning (60 min): board, risks, contract sections; **S1b kata briefing** by R3 | Onboarding review of `protocol/`, kernel stubs and the boundary lint rules (PLT-014) [2]; ask the department for the lab machine (Q11) (PLT-026) [0.5] | Onboarding review of `db/`, `server/src/{vfs,db}`, `vfs/src` (PLT-015) [2]; **S8** bring-up timing on a lab PC (PLT-024) [1] | **S1** framework runs on the lab machine (PLT-022) [2] | **S7** runs start: AGT-40 and INJ-20, 3 runs per configuration, requested and served model logged (PLT-023) [2] | Fill `TEAM_CONTRACT.md` (PLT-013) [1.5]; S11 timing on PRs (PLT-020) [1] |
| D7 Tue | **Kata** (2.5 h each, any time D7–D9); explain-your-code sessions (§3.5); **S10** measurement session (1 h each, §3.6) | Kata [2.5]; S10: Puter memory with 1, 5 and 10 apps | S10: daedalOS memory with 1, 5 and 10 apps; seed the board from `backlog.csv` (PLT-021) [2] | Onboarding review of `ui/`, `apps/shell`, Stitch (PLT-016) [2]; S10: offline reload behaviour of both | Onboarding review of `ai/` and `server/src/llm` (PLT-017) [2]; S10: file-operation timings of both | Onboarding review of CI, `tools/`, `tests/`, compose, Dockerfile, `ops/` (PLT-018) [1.5]; S10: screenshots and Chrome Task Manager captures |
| D8 Wed | Contract PR reviewed by all five | CPU calibration on the lab machine and a hosted runner (PLT-026) [2] | Kata [2.5]; S8 home broadband and fresh runner [1] | Kata facilitation and own kata [3] | Kata [2.5]; S7 runs continue, spend checked against US$25 [2] | **VPS ordered** (or OVH after 72 h); Student Pack domain registered (PLT-025) [1.5]; kata [2.5] |
| D9 Thu | **Contract merged and signed** | Finish onboarding review, notes for AI_USAGE [1] | Finish onboarding review [0.5]; S8 region RTT from the LGU lab [1] | Kata results collected in `docs/evidence/D1/s1b.csv`; **S1b rule applied**: keep Solid, or switch to React before W4 [1] | Collate **AI_USAGE.md row 1** from the five reviews (PLT-019) [2]; S7 selection prepared for the W3 freeze [1] | S11: PR wall time and 20 reruns; CODEOWNERS `dsa/` lines aligned with [data-structures §3.3](../08-dsa/data-structures.md) [2] |
| D10 Fri | **G0 check**: the W2 exit checklist (§3.4) run by R5, signed by all five; Friday demo; retrospective (15 min); Sprint 02 planning | — | — | — | — | Commit `docs/evidence/gates/g0/exit-checklist.md`; record the instructor's answers and the registration approval |

### 3.4 W2 exit checklist (G0, PLN-15)

| # | Check | IDs | Owner | Evidence |
|---|---|---|---|---|
| 1 | Five members confirmed, each with one primary role (R1–R5) | PLT-TEAM-01, PLT-TEAM-02 | R5 | `TEAM_CONTRACT.md` §1; registration form |
| 2 | Registration form submitted in W1 with **Plotinium**, the alternative **Tabium**, the tagline and the origin line ("coined from plutonium, element 94; not a person's name"); signed scan committed; the instructor's approval recorded or chased | PLT-ID-01, PLT-ID-05, PLT-DOC-14 | R3, R5 | `docs/registration.pdf`; `docs/evidence/gates/g0/` |
| 3 | `docs/identity/identity.json` holds the voted tagline (≤ 90 characters, the three differentiators) | PLT-ID-05, PLT-ID-02 | R3 | the file |
| 4 | `TEAM_CONTRACT.md` merged through a PR approved by all five, with roles, definition of done ([implementation-plan §3.8.2](./implementation-plan.md)), meetings and reply times, disagreement rule, the ladder for a non-contributing member and the signed acknowledgement | PLT-DOC-11, PLT-TEAM-07 … PLT-TEAM-12 | R5 | the PR |
| 5 | Repository `plotinium` reachable; the instructor added as a collaborator | PLT-TEAM-03, PLT-ID-11 | R5 | screenshot |
| 6 | Ruleset on `main` (PR required, code-owner approval, no force push, linear history, rebase-merge only, empty bypass list); tag ruleset; CODEOWNERS with real handles and the `dsa/` reviewers of data-structures §3.3 | PLT-TEAM-03, PLT-TEAM-04, PLT-TEAM-14, TRC-05 | R5 | `ruleset-main.json` |
| 7 | CI runs on every PR and is green: format, lint (including the `dsa/` and pilot-import fixtures), typecheck, `traceability --strict`, tests with coverage, gitleaks, commitlint; PR wall time under 8 minutes and 0 flakes in 20 reruns | PLT-TEAM-13, TRC-02, AIS-06, DSA-GEN-01, DSA-GEN-08, TST-02 | R5 | CI run links; `docs/evidence/D14/` |
| 8 | All 14 pre-registration PRs (D1, D2a, D2b, D3–D14) merged, each with two approvals, **before** any file under `docs/evidence/<decision>/` | PLT-DOC-03, AIS-05 | each record owner | git timestamps |
| 9 | S0 result committed; any red capability has reopened the placement record | ARC-02, ARC-05, MEM-01 | R1 | `docs/evidence/D2b/` |
| 10 | S1 results and the S1b decision (Solid kept, or the switch to React scheduled before W4) | WM-03, BOOT-10, PROC-08 | R3 | `docs/evidence/D1/` |
| 11 | S4 seeds loaded (≥ 50 users, 10k and 100k inodes) | DB-05, DB-01 | R2 | `docs/evidence/D5/` |
| 12 | S7: runs complete for every configuration, requested and served model logged, spend ≤ US$25; selection happens at the W3 freeze | AGT-06, AGT-07, AIS-05, AIS-07 | R4 | `docs/evidence/D10/` |
| 13 | S10: each member measured two scenarios; raw numbers and screenshots committed (the analysis is due in W3) | §7.3 | R3 | `docs/benchmarks/raw/` |
| 14 | S8: bring-up timed on a lab PC, home broadband and a fresh runner; region RTT measured | §17.1, PLT-DEL-02 | R2 | `docs/evidence/D12/` |
| 15 | Every member's onboarding review done: explain-your-code session held, findings filed as `ai-review` issues, notes given to R4 | PLT-DOC-10, SPR-03 | each member | onboarding issues |
| 16 | `AI_USAGE.md` row 1 completed (accepted and rejected, and why, per area) | PLT-DOC-10 | R4 | the file |
| 17 | Board seeded from `backlog.csv`: every issue with owner, reviewer, milestone, estimate and `req:` labels | PLT-TEAM-13, TRC-01 | R2 | board export |
| 18 | VPS ordered (Hetzner CX33, or OVH VPS-2 after 72 h); domain registered; no credential in the repository | PLT-DEL-02, SPR-05, SPR-06 | R5 | purchase log |
| 19 | Instructor questions sent; answers logged (at least Q1–Q5, Q10–Q12 and Q15 answered or chased) | AIS-07, PLT-ID-17 | R5 | `instructor-answers.md` |
| 20 | Lab-machine access arranged or requested; `tests/performance/calibration.json` committed | TST-21, TST-07 | R1 | the file |
| 21 | Sprint 02 planned: S4 core, S5 M1/M2, S6, S3-lite, S10 analysis, evidence freeze on Friday of W3, heap, DAG and z-order, the risk register and the DSA.md draft | PLN-03 | R5 | Monday note of W3 |

### 3.5 Reviewing the AI-generated code (SPR-03)

Each member reviews the AI-generated code in their own area before building on it ([implementation-plan §3.15](./implementation-plan.md)); the reviewer is the area's secondary reviewer.

| Member | Area to review | Session partner |
|---|---|---|
| R1 | `protocol/` (schemas, errno, ABI version, WebSocket frames and fixtures), kernel stubs, `tools/eslint-rules` boundary rules | R5 |
| R2 | `db/` (migrations, `schema.sql`, seed, bench, probes), `server/src/{vfs,db}`, `vfs/src` | R5 |
| R3 | `ui/` (tokens, motion, icons, components), `apps/shell` (lexer, parser, glob), `docs/design/stitch` | R1 |
| R4 | `ai/src` (indexer modules, utilities), `server/src/llm` | R2 |
| R5 | `.github/` workflows, `tools/` (traceability, bundle budget), `tests/` support and fixtures, compose files, Dockerfile, `ops/` | R1 |

Steps, for each package: (1) read the owning spec section by section and list where the code differs; (2) run `pnpm exec tsc -p <pkg>/tsconfig.json --noEmit`, `pnpm exec vitest run --project <pkg>` and `pnpm exec eslint <pkg> --max-warnings 0`; (3) pick three files at random and explain them line by line to the partner (30–45 minutes); (4) file every defect, doubt or over-engineered part as an issue labelled `ai-review`; (5) write what you accept, change and reject, and why, for `AI_USAGE.md`. Feature work on a package starts only after its review. `dsa/` implementations are not reviewed here: they do not exist and are written by their owners from Week 3.

**Pre-registration review pairs** (two approvals, never the author; the first is the record's secondary reviewer from [stack-decisions](../15-decisions/stack-decisions.md)):

| Record(s) | Author | Approvers |
|---|---|---|
| D1 | R3 | R1, R4 |
| D2a, D2b | R1 | R5, R3 |
| D3, D14 | R5 | R1, R2 |
| D4 | R5 with R2 | R1, R3 |
| D5, D6 | R2 | R5, R4 |
| D7 | R2 with R5 | R1, R3 |
| D8, D10 | R4 | R2, R3 |
| D9, D11 | R4 | R1, R5 |
| D12 | R5 | R2, R4 |
| D13 | R5 with R2 | R4, R3 |

### 3.6 Spikes in this sprint (time-boxed, SPR-04)

Every spike follows the evidence rules of [stack-decisions §3.3](../15-decisions/stack-decisions.md): lab-spec machine and Chrome stable, interleaved variants, warm-up discarded, n ≥ 1,000 samples for latency percentiles, the expected loser measured, raw files and the harness committed. Pilot harnesses under `docs/evidence/pilot/` may be re-run as tools, but their old numbers are never the team's evidence.

| Spike | Question | Owner / rev. | Box | Pass or decision rule | Evidence |
|---|---|---|---|---|---|
| S0 | Does Chrome support what the design assumes (nested module workers, SAB in executors, OPFS sync handles, `crossOriginIsolated` online and offline, Web Locks, memory measurement)? | R1 / R5 | 3 h, D4–D5 | All green on stable, or the D2b placement record reopens before other spikes | `docs/evidence/D2b/` |
| S1 | Solid against React, Svelte and vanilla for 10 windows | R3 / R5 | 3 h, D6–D8 | ≤ 60 KB gzip boot-chunk contribution, ≤ 0.5 ms per update, drag p95 ≤ 16.7 ms | `docs/evidence/D1/` |
| S1b | Can the team build in Solid? Task-Manager kata: 256 rows at 10 Hz over a MessageChannel, sortable, kill and renice, keyboard-operable | all / R3 | 2.5 h each, D7–D9 | Keep Solid only if ≥ 4 of 5 finish within 1.5× their React time, ≤ 3 lint-missed reactivity bugs each, UI script ≤ 1 ms per frame; otherwise React 19 before W4 | `docs/evidence/D1/s1b.csv` |
| S4 (setup) | Seeds for the database spike | R2 / R5 | 3 h, D4 | ≥ 50 users, 10k and 100k inodes, deterministic (seed 42); depth histogram reported | `docs/evidence/D5/` |
| S7 (reduced) | Which LLM under the single pre-registered rule | R4 / R5 | 5 h, D6–D9; ≤ US$25 | Qualifies if AGT-40 median ≥ 36 and minimum ≥ 34, ≥ 7/8 clarifications, INJ-20 executed-unrequested = 0, 0 schema violations, time-to-plan p95 ≤ 15 s; cheapest qualifying wins (decided at the W3 freeze); `claude-sonnet-4-6` included as the fallback that accepts temperature | `docs/evidence/D10/` |
| S10 | Puter and daedalOS measured baseline | all / R3 | 1 h each, D7 | Memory with 1, 5 and 10 apps; offline reload behaviour; basic file-operation timings; screenshots | `docs/benchmarks/raw/` |
| S11 | Does the toolchain work end to end? | R5 / R1 | 3 h, D3–D9 | PR wall time < 8 min; 0 flakes in 20 reruns; `tsc` and `tsc6` bin names verified | `docs/evidence/D14/` |
| S8 | Clean bring-up and region latency | R2 / R5 | 3 h, D6–D9 | Every bring-up ≤ 240 s; WebSocket RTT p50/p95 per candidate region | `docs/evidence/D12/` |

### 3.7 Registration and identity

The form follows [identity-and-branding §3.13](../00-product/identity-and-branding.md), filled by R3 and reviewed by R5:

- **Proposed OS name:** Plotinium. **Alternative:** Tabium ("tab" + "-ium": the whole OS runs in one browser tab).
- **Meaning or origin:** "A coined word from plutonium (Pu, element 94), a dense, energy-rich metal. Plotinium packs a complete multi-user OS into one browser tab and does real work. Pronounced 'ploh-TIN-ee-um'. Not a person's name; no political or religious reference." The line must say "coined" and "element 94", describe only the element's physical character and never its uses.
- **Tagline:** the one voted on D2 (recommended: "A local-first web OS that pages its own memory and lets AI act only through the kernel.").
- **Members and roles:** five rows with the primary role and the reviews column from [implementation-plan §3.12](./implementation-plan.md); five signatures.
- **Intended AI subsystems:** all three (A and B deep, C lean but complete; C12).

The form is submitted on D3 because names are first come, first served; the signed scan goes to `docs/registration.pdf`.

### 3.8 Repository bootstrap

1. **D1, R5:** create the organisation and the one-member teams `r1`–`r5`; create `plotinium` (public if the instructor has agreed, otherwise private with GitHub Pro or a teacher's Team plan so that rulesets work).
2. **D1, R5:** in the project folder, `git init -b main`, check `.gitignore` (no `.env`, no `compose.override.yaml`), run gitleaks over the tree, then make **one import commit** `chore(import): import AI-assisted scaffold, specs and research (see AI_USAGE.md #1)` and push it (SPR-01). This commit is excluded from the equity report and from everyone's line count.
3. **D2, R5:** enable the `main` and tag rulesets ([deployment-and-ci §3.8](../14-devops/deployment-and-ci.md)), replace the CODEOWNERS placeholders with the team handles, and require the checks `checks` and `gitleaks`. From here on everything, including the pre-registration PRs, goes through reviewed PRs.
4. **D3, R5:** make CI green on the first PRs. If the scaffold's CI is red, the fix is the first PR, reviewed by R1.
5. **D7, R2:** seed the board from `backlog.csv` with the `gh` CLI (one issue per row, labels `req:<ID>`, `role:<R>`, milestone = gate).

### 3.9 VPS purchase (SPR-05)

R5 creates the Hetzner account on D2 (card verification can take a day) and starts `ops/buy-server.sh` on D4: an `hcloud server create` retry every 10 s for up to an hour, repeated, for a CX33 in Falkenstein or Nuremberg. If no CX33 is ordered within 72 hours, R5 orders an OVHcloud VPS-2 instead ([deployment-and-ci §3.13](../14-devops/deployment-and-ci.md)); the ceiling is €15 a month. The server is bought early and never recreated. Provisioning from `ops/cloud-init.yaml` happens in W4; nothing is served publicly before the P2 gate. The domain comes from the Student Developer Pack; the paying member and the cost split are recorded in the contract annex.

### 3.10 Questions for the instructor

All fifteen questions of [implementation-plan §3.18](./implementation-plan.md) are sent on D1. The answers needed inside this sprint are Q1 (gate dates, lab machine), Q2 (public repository), Q3 (domain and hosting account), Q4 (the name), Q5 (temperature 0, before W4), Q10 (Node 26), Q11 (lab machine for a runner), Q12 (what the P1 dossier contains) and Q15 (the AI-assisted work under §18). An unanswered question is chased at every class meeting and logged with its date.

## 4. Interfaces and data shapes

- **Import commit:** `chore(import): import AI-assisted scaffold, specs and research (see AI_USAGE.md #1)`; the equity tool excludes messages starting with `chore(import):`.
- **Pre-registration file:** `docs/decisions/prereg/<Dn>.md` in the format of [stack-decisions §4.2](../15-decisions/stack-decisions.md), on branch `prereg/<Dn>`.
- **Kata result (`docs/evidence/D1/s1b.csv`):** `member,role,framework,minutes,bugs_found_in_review,bugs_missed_by_lint,ui_script_ms_p95,finished` — one row per member and framework.
- **S10 raw data (`docs/benchmarks/raw/<system>-<scenario>.json`):** `system,scenario,apps_open,chrome_task_manager_mb,uasm_mb,offline_behaviour,notes,screenshot`.
- **Exit checklist (`docs/evidence/gates/g0/exit-checklist.md`):** the table of §3.4 with a tick, a link to the evidence and five signatures.
- **Board columns:** Backlog → Ready → In progress (WIP ≤ 2 per person) → In review → Done; fields Week, Estimate, Baseline, Epic ([backlog §4.2](./backlog.md)).

## 5. Algorithms and invariants

- **Order of evidence (SPR-02).** For each decision D: `merge_time(prereg/D) < min(commit_time(f))` over files f under `docs/evidence/D/`. Checked by the lint job ([stack-decisions §5.4](../15-decisions/stack-decisions.md)).
- **S1b rule.** Let `f` be the number of members who finished within 1.5 × their React time with ≤ 3 lint-missed reactivity bugs; keep Solid if `f ≥ 4` and the UI script p95 ≤ 1 ms per frame, else switch to React 19 before W4.
- **VPS fallback.** `if now − loop_start ≥ 72 h and no CX33 ordered: order OVH VPS-2`.
- **Invariants.** S-1: nothing merges to `main` except through a reviewed PR after D2. S-2: no key, token or password in any commit (gitleaks). S-3: no `dsa/` structure is implemented in this sprint. S-4: every spike stops at its box and reports what it has.

## 6. Errors and edge cases

| Case | Rule |
|---|---|
| The name is already taken or rejected | Register Tabium on the same form; switch identifiers in one PR ([identity §3.3](../00-product/identity-and-branding.md)) |
| A fifth member is not confirmed by D3 | Tell the instructor at once; the form needs exactly five (§4.1) |
| The scaffold's CI is red on the import | The fix is the first PR (R5, reviewed by R1); prereg PRs wait at most one day, and the Friday deadline holds |
| The instructor has not answered about a public repository | Create it private under GitHub Pro or a teacher's Team plan; switch to public later if allowed |
| No lab-spec machine by D8 | Run spikes on the member laptop closest to the lab spec, label the numbers, and repeat decision-critical ones on the lab machine in W3 |
| S0 shows a red capability on stable | Reopen D2b before S1 and S5; the fallbacks of [architecture](../01-architecture/architecture.md) apply |
| The S1b rule fails | Switch to React 19 before W4; D1 records the result |
| S7 spend approaches US$25 | Stop, report the runs completed, and use cited results for the rest |
| No CX33 within 72 hours | Order OVH VPS-2 (SPR-05) |
| A member cannot explain a reviewed file | File an `ai-review` issue to simplify or rewrite it; the file is not built on until it is understood |

## 7. Performance budgets

Sprint budgets: about 10.5 focus hours per member per week (§1); PR wall time under 8 minutes; review within 24 hours on weekdays; S7 spend ≤ US$25; each spike within its box (§3.6). No product budget is measured in this sprint except as spike evidence.

## 8. Test plan

| Test title | Level | Runs |
|---|---|---|
| `PLT-ID-01 registration.pdf exists, carries five signatures and registers Plotinium` | manual | G0 |
| `TRC-02 traceability fails on a test title whose first token is neither a spec ID nor a registered prefix` | unit | every PR |
| `DSA-GEN-01` and `DSA-GEN-08` lint fixtures (external structure import, pilot import) fail as expected | lint | every PR |
| `PLN-15 the W2 exit checklist is committed and signed by all five` | manual | D10 |
| `SPR-02 no evidence file of a decision predates the merge of its pre-registration PR` | docs check | every PR touching `docs/evidence/**` |
| `SPR-06 gitleaks finds no secret in the repository, including the import commit` | CI | every PR |

## 9. Open questions and cross-spec requests

**Open questions**
- Q1 (team, D1): who holds each role; recorded on D1 and on the form.
- Q2 (team, D2): the funding split for the VPS and the LLM budget (about US$35–45 a month for the team).

**Cross-spec requests**
- To [requirements-traceability](../00-product/requirements-traceability.md): register the prefix `SPR-nn` (sprint rules) with `PLN-nn`.
- To [identity-and-branding](../00-product/identity-and-branding.md): R3 fills and submits the form on D3; R5 commits the scan (your §3.13 names R5 as owner).
- To [stack-decisions](../15-decisions/stack-decisions.md): the pre-registration review pairs of §3.5 are proposed for your §3.2 item 3.
