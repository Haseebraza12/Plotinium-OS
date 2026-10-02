
# Engineering process

## 1. Branching and merging

- **Trunk-based.** `main` is the only long-lived branch. It is protected: no force pushes, no direct pushes, the required checks must pass, and a member other than the author must approve.
- **Short-lived branches:** `<type>/<REQ-ID>-<slug>`, for example `feat/VFS-06-quota-in-txn` or `fix/PROC-07-leak-leases`. A branch should last 3 days or less.
- **Small PRs.** A PR changes 400 lines or fewer, not counting tests, fixtures and generated files. Larger work goes behind a feature flag in Settings > Developer or is split into stacked PRs.
- **Merge with rebase-and-merge.** This keeps the small, focused commits the spec values and keeps the per-author history that the Code Quality & Equity criterion (10%) depends on. Squashing would hide authorship.
- **Releases.** Tag from `main`: `v0.2.0` (P2), `v0.3.0` (P3), `v0.4.0` (P4), `v1.0.0-rc.N` (W16–17) and `v1.0.0` (W18). A bug found after a gate tag is fixed as a patch release, for example `v0.3.1`.
- **After the freeze (W16).** Only `fix:` PRs are merged. Each carries the `freeze-fix` label and needs 2 approvals. Features merged after the freeze are reverted before judging.

## 2. Commit convention

```
<type>(<scope>): <imperative summary> (<REQ-IDs>)

<why, not what; link issue #123>

Co-authored-by: Name <email>          # pairing credit (spec s15.4)
```

- **Types:** `feat fix test docs perf refactor chore ci build`.
- **Scopes:** package names (`kernel vfs wm apps ai server db services dsa protocol web ops`).
- **Example:** `feat(vfs): enforce inode quota inside the rm -r transaction (VFS-06, DB-02)`.
- **Enforcement:** commitlint runs on every commit in the PR, and a requirement ID is required for `feat` and `fix`.
- **AI assistance** is disclosed in the PR template, and each merged PR adds an entry to AI_USAGE.md (see §8). It is not recorded in commit trailers.

## 3. Pull request rules

The PR template has these parts:
- requirement IDs;
- what changed and why;
- test evidence (test names, and a screenshot or trace for UI and performance changes);
- performance impact (a budget diff);
- a docs checklist;
- an AI-assistant disclosure: tool, what was asked, and what was accepted, rejected and why;
- the checkbox "I can explain every line in this PR".

Review rules:
- The CODEOWNERS secondary reviewer is requested automatically.
- Reviews are due within 24 h on weekdays.
- Reviewers use a checklist (§7).
- The author merges once CI is green and the PR is approved.
- Review comments are kept, because they count as process evidence.

## 4. CI gates (GitHub Actions)

| Pipeline | Jobs | Required to merge? | Target time |
|---|---|---|---|
| **PR** (`ci.yml`, cancels in-progress runs) | ESLint 10 (`--max-warnings 0`, plus local rules `no-yieldless-loop-in-generator`, `no-await-in-idb-builder`, `no-html-sinks`, and the app boundary rules); Prettier check; TypeScript 7 `tsc -b --noEmit`; commitlint; gitleaks; Vitest **unit** (Node, loopback kernel), **browser** (real Chrome: IndexedDB, OPFS, workers, compositor) and **integration** (`docker compose up -d --wait db`: syscalls against the DB, fault injection for every bulk op, concurrent moves, leases, outbox replay, the auth suite), with merged v8 coverage and a job-summary table; **coverage thresholds**; **bundle budgets**; **migration round-trip** (dbmate up, then rollback ×N, then up, then diff `schema.sql`); `kysely-codegen --verify`; built-chunk boundary scan; licence scan (lockfile against THIRD_PARTY.md, failing on unknown, AGPL or GPL code in the bundle); `pnpm audit --prod` (high severity) | yes | under 10 min |
| **main** | Everything above, plus Playwright **e2e** on Chrome stable: boot → login → terminal → file ops → reboot → session restored; offline boot with the server killed; `crossOriginIsolated` checked online and offline; axe in both themes | yes, before the next tag | under 15 min |
| **nightly** (`30 21 * * *` UTC, which is 02:30 PKT) | Performance suite on the **self-hosted lab-spec runner** (median of 5 p95s); Chrome beta capability probe; full-history gitleaks; DSA complexity curves; k6 WebSocket and lock soak; weekly restore drill; weekly timed clean bring-up | A failure opens an issue automatically and blocks the next tag | – |
| **tag `v*`** (`release.yml`) | Full suite, plus ai-eval (replayed cassettes: Recall@5, MRR, AGT-40, INJ-20, prediction accuracy), the litmus AI-off build, multi-arch images pushed to public GHCR, and a timed clean bring-up with no `docker login` and Docker Hub blocked (fails above 240 s). Then a GitHub Release with coverage and performance reports, and an SSH deploy after approval by a member other than the tagger | yes | – |

**Flaky tests.** A flaky test is quarantined within 24 h, with an issue and an owner. At most 2 tests may be in quarantine at once, and a gate cannot be tagged while any gate-relevant test is quarantined.

## 5. Performance budgets in CI from Week 5

`tests/performance/budgets.json` is read by the tests themselves. Before a metric's hard gate starts, it is tracked on a ratchet: a regression of more than 10% against the last baseline fails the build.

| Metric (requirement) | Budget | Where it runs | Tracked from, then hard gate from |
|---|---|---|---|
| Boot-critical main-thread JS | ≤ 60 KB gz | PR | W5 hard |
| Kernel worker bundle | ≤ 100 KB gz (re-baselined at W7 with a record) | PR | W5 hard |
| Warm / cold boot (BOOT-10) | ≤ 1.5 s / ≤ 3.0 s | nightly, lab runner | W5, then W7 |
| Drag with 10 windows, p95 (WM-03) | ≤ 16.7 ms, and 0 LoAF > 50 ms from our code | nightly | W6, then W7 |
| Frame under CPU load (PROC-05) | same as WM-03 | nightly | W9, then W11 |
| Syscall round trip under load | p95 ≤ 1 ms | nightly | W6 |
| Trie prefix lookup (SYS-03) | p95 ≤ 1 ms at 10^4 and 10^5 | PR (bench project) | W5, then W7 |
| DSA complexity | flat or log curves from 10^3 to 10^5; ≤ 32 MB at 10^5 | nightly | W5 |
| Q1–Q5 (DB-05) | p95 ≤ 10 ms at 100k (10k on PRs that touch `db/`) | nightly + PR | W9, then W11 |
| Client bulk op, 1,000 nodes | p95 ≤ 500 ms | nightly | W9 |
| Local / remote 5 MB page-in (MEM-05) | ≤ 300 ms / ≤ 2 s | nightly | W10, then W11 |
| Lock grant (server, 50 clients); crash expiry | p95 ≤ 50 ms; ≤ TTL + 0.5 s | nightly (k6) | W10, then W11 |
| Retrieval over ≥ 10k chunks (RAG-05) | p95 ≤ 500 ms | nightly | W12, then W14 |
| One prediction (PRE-01) | ≤ 5 ms | PR | W11, then W14 |
| Agent time-to-plan | p95 ≤ 15 s (measured from the VPS) | release | W13 |
| Clean bring-up | ≤ 240 s | weekly + release | W5 |

**CPU throttle calibration (W2).** Run a fixed CPU micro-benchmark on the GitHub runner and on the lab machine, then set `rate = runner score / lab score`. Hosted-runner performance jobs apply this with CDP `setCPUThrottlingRate`. Authoritative numbers always come from the lab-spec runner.

## 6. Definition of done (identical in TEAM_CONTRACT.md)

A task is done when all of these hold:
1. The code is merged to `main` through a reviewed PR, with CI green.
2. **Tests** cover the behaviour, including edge cases. Test names start with the requirement ID. Integration tests exist if the change crosses a boundary (syscall to DB, kernel to worker).
3. Coverage on the touched package has not dropped, and stays ≥ 85% on `dsa/`, `vfs/` and `kernel/`.
4. Performance budgets are green, and a UI change passes axe with zero serious or critical issues in both themes.
5. **Docs** are updated: the relevant section of ARCHITECTURE, DSA, DATABASE, AI, BOOT, TESTING or SECURITY, plus `man` pages for new commands, and a CHANGELOG entry if users will notice the change.
6. The feature is **demoable on the deployed staging/production build**. It is not done if it only works on a laptop.
7. The author can explain every line, and the AI_USAGE entry is written.

**Definition of ready (for issues):** the issue has a requirement ID, acceptance criteria written as test names, an owner, a reviewer, an S/M/L estimate and the gate milestone.

## 7. Review checklist (reviewers tick it in the PR)

- [ ] Boundaries: no app touches storage or kernel globals; identity comes from the port; the change goes through syscalls.
- [ ] Main thread: no geometry in reactive state; no work on the main thread that can grow without bound.
- [ ] IndexedDB: one transaction per user-visible operation; no `await` inside a builder; kernel events fire only after `oncomplete`.
- [ ] Server: goes through `vfsTxn` and `lockPlan()`; side effects happen only after commit; errno mapping is correct.
- [ ] Schema changes are dbmate migrations with a working `down`.
- [ ] Security: permission checks go through `vfs/perm.ts`; no HTML sinks; no secrets; AI content is rendered as text.
- [ ] DSA: hand-written, with no library standing in for a mandatory structure; complexity is stated in DSA.md.
- [ ] Tests exercise behaviour rather than inflate coverage (the spec says examiners read the tests).

## 8. Issue board and traceability

**Board.** GitHub Projects with the columns Backlog → Ready → In progress (**WIP limit: 2 per person**) → In review → Done. Fields: requirement ID, gate milestone, owner, reviewer, estimate, linked risk.

**Seeding.** `tools/seed-issues.ts` creates one issue per Must and Should requirement ID (about 90) from `docs/requirements.csv`, plus one issue per document and per spike. Every issue has exactly one owner, which covers the Phase-1 work-breakdown deliverable.

**Traceability.** `tools/traceability.ts` builds the chain requirement ID → issues → PRs → tests → evidence file. It feeds the technical report and the acceptance-checklist run before each gate.

**Cadence.**
- Monday planning, 60 minutes: risks, budgets, board.
- Written async stand-up on Monday, Wednesday and Friday.
- Friday demo on `main`, 15 minutes: each member shows what was merged.
- A retrospective after each gate.
- A gate dry-run 3 days before each gate.

## 9. Coverage targets

| Scope | Target | Enforced |
|---|---|---|
| Overall (lines) | ≥ 70% | Every PR from W5 |
| `dsa/**`, `vfs/**`, `kernel/**` | ≥ 85% | Every PR, **from the first merge into each package** (no "tests later") |
| Mutation score on `dsa/` (StrykerJS, optional) | reported nightly | Evidence that the tests assert behaviour |

`coverage.include` lists every source glob, so files that no test loads still count.

## 10. Dependencies, secrets and AI assistants

**Dependencies.**
- Versions are pinned exactly, and the lockfile is committed.
- A new runtime dependency needs a short note in the PR: the problem it solves, alternatives considered, size and licence. It also needs a THIRD_PARTY.md entry and approval from R5.
- After the freeze, changing a dependency needs a new decision record and the instructor's approval.
- Nothing may replace a mandatory DSA structure.

**Secrets.**
- `.env` is gitignored, and `.env.example` is committed.
- LLM keys exist only in the production server `.env` (mode 0600).
- CI runs `LLM_MODE=replay` without a key, and a test asserts that the key is absent.
- gitleaks runs on every PR, nightly over the full history, and on `dist/`.
- A leaked key is revoked, rotated and redeployed, then logged in SECURITY.md.

**AI coding assistants.**
- They are allowed, with disclosure (s18).
- Mandatory DSA modules are designed and written by their owner. An assistant may review them or suggest tests, and that use is recorded.
- The rejected-suggestions column in AI_USAGE.md carries the most weight, so fill it honestly.
