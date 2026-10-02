# docs/rfcs: design proposals (RFCs)

An RFC is how a Plotinium feature is designed, reviewed and approved **before** anyone writes product code. It is the design-review step of Wave 3 and later waves: design documents and reviews come before code, every file has one owner, features ship behind flags, and status is reported honestly.

- **Primary owner:** the tech lead (keeps this index and runs the Architecture Review Board)
- **Secondary reviewer:** R5 QA/DevOps (checks formatting, links and the spec-change list)
- **Related:** [../adr/README.md](../adr/README.md) (decision records after the stack freeze), [../../specs/README.md](../../specs/README.md) (the normative specs and their change process)

## 1. When you need an RFC

Write an RFC when a change does any of these:

- adds a user-visible feature, a syscall, an event topic, an HTTP route, a table, a capability or an environment variable;
- crosses package boundaries (for example kernel and server and UI);
- touches security, privacy, a third party (a Google or Anthropic API, a new dependency) or a performance budget;
- needs more than one builder, or more than about 3 to 5 hours for one builder.

Bug fixes, refactors inside one package and editorial spec changes do not need an RFC.

## 2. Lifecycle

```text
Draft ──► In review ──► Approved ──► Implemented
            │               │
            ▼               ▼
         Rejected       Superseded (by RFC NNNN)
```

| Status      | Meaning                                                                                   | Who sets it               |
| ----------- | ----------------------------------------------------------------------------------------- | ------------------------- |
| Draft       | The author is writing it; it may change freely                                            | author                    |
| In review   | Frozen for the critics; changes only answer review comments, each noted in the review log | author                    |
| Approved    | The ARB approved a build plan (possibly with cuts); builders may start                    | ARB                       |
| Rejected    | Not built; the review log says why                                                        | ARB                       |
| Implemented | Shipped behind its flag and verified; the spec changes merged                             | lead, after the verifiers |
| Superseded  | Replaced by a later RFC                                                                   | ARB                       |

**Relation to ADRs and specs.** The specs in `specs/` are normative. After the Week-4 stack freeze, a **normative** spec change needs a decision record in `docs/adr/NNNN-<slug>.md` in the §14.1 format plus the instructor's written approval (`specs/README.md` §3.6). An approved RFC is the evidence for that record: the lead writes the ADR from the RFC's decision, alternatives and risks, gets the approval, and only then merges the spec changes listed in the RFC's §16. An RFC never edits a spec by itself.

## 3. Roles

| Role              | Does                                                                                                                                 | Must not                                                                                                |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| Author (designer) | Writes the RFC; grounds every claim about today's system in the code with `file:line`; runs spikes; answers review comments          | Write product code; edit files outside `docs/rfcs/` and its evidence folder `docs/design/<wave>/<key>/` |
| Critics (two)     | Review independently for correctness, security, feasibility, scope and grading; write findings with a severity and a required change | Rewrite the RFC themselves                                                                              |
| ARB               | Decides: approve (with cuts and order), send back, or reject; fixes builder ownership                                                | Approve without a cut line and a flag                                                                   |
| Builders          | Build exactly the approved scope and paths; report honestly what they did not finish                                                 | Write outside their ownership; widen scope                                                              |

## 4. Numbering and files

- One file per RFC: `docs/rfcs/NNNN-short-title.md`, four digits, lower-case kebab title.
- Take the next free number. If two authors collide during a wave, the ARB renumbers the later one and fixes links.
- Evidence (screenshots, spike scripts and results, measurements) lives in `docs/design/<wave>/<author-key>/` and is linked from the RFC. Screenshots are read, not only taken.
- Markdown must pass Prettier: run `pnpm exec prettier --write docs/rfcs/<file>.md` before asking for review.
- Requirement IDs proposed by an RFC use a new prefix per feature (for example `GDRV-`, `AGS-`, `LRT-`). Test titles start with the ID.

## 5. The template

Every RFC has this header table and these sections, in this order. Extra sections go inside the numbered ones or in appendices.

Header: **Title; Status (Draft, In review, Approved or Rejected); Authors; Reviewers; Date.** Add Builders, Research input, Evidence and Related rows when they exist.

1. **Summary.** What changes and why, in a few paragraphs; the phases and the effort.
2. **Context and problem.** What exists today, verified in the code, with `file:line` references. Spikes and measurements with their method.
3. **Goals and non-goals.** Goals with how each is measured; explicit non-goals.
4. **Research basis.** For each paper: the idea, what we adopt, what we adapt, what we leave out, and the link. Say which references were reviewed and not used.
5. **Design.** Architecture, data flows, interfaces (TypeScript), syscalls and ABI (Valibot schemas), events, HTTP routes (request and response shapes), storage (migration DDL with up and down), configuration (secrets only as `*_FILE`), UI and UX flows, failure modes, and contracts with other RFCs.
6. **Alternatives considered.** At least two, and why not.
7. **Security, privacy and abuse.** Assets, trust boundaries, a STRIDE threat model with mitigations and the test that verifies each, privacy and compliance, account and guest policy.
8. **Performance and budgets**, in numbers, with how they are measured.
9. **Accessibility and UX.** WCAG 2.2 AA, keyboard, both themes, reduced motion and transparency, motion (transform and opacity only), error messages in words.
10. **Testing and evaluation.** Unit, integration, E2E and benchmarks with test titles; fakes and contract tests; the metrics and baselines for the capstone report; the AI-native properties and coupling-map cells the feature touches.
11. **Rollout.** Feature flag and default, stages, migration, rollback, kill switch, runbooks.
12. **Observability.** Metrics (no personal data in labels), audit events, logs, health.
13. **Ownership and work breakdown.** Builders, the exact paths each owns, touch points in other owners' files (each a small, exact edit), interface contracts between builders, order and effort.
14. **Risks and mitigations; the cut line** (what to drop first, and what is never cut).
15. **Open questions**, each with a proposed answer and an owner.
16. **Spec and doc changes.** Which `specs/` files change, the ADR it needs, and the new requirement IDs.
17. **Review log.** Filled in by the critics and the ARB: date, reviewer, verdict, notes.

### 5.1 Rules the ARB checks

- **Grounded.** Every statement about today's system cites the code. Designs that ignore what exists are rejected.
- **Deepen, do not rebuild.** Reuse the syscall ABI, the kernel services, the `dsa/` structures (never a library in their place, spec §10.2), the design tokens, the existing tests and eval harnesses.
- **Buildable.** One builder can finish each work package in about 3 to 5 hours of focused work; otherwise the RFC says what to cut.
- **Demonstrable and measurable.** A viva demonstration and a baseline-versus-new metric.
- **Standing decisions hold** (`CLAUDE.md`): strict CSP with no inline styles or runtime `<style>`, the fonts and logo decisions, package boundaries, no secrets in the repository or the client bundle, never touching the user's running instance.
- **Evidence labels.** Where facts come from outside the repository, label them as the research reports do: [F] verified fact with a link and date, [P] own probe, [I] inference, [S] needs a spike.

## 6. Index

| RFC                                                       | Title                                                                              | Author            | Status                                                                      |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------- | ----------------- | --------------------------------------------------------------------------- |
| [0001](0001-google-drive-volume.md)                       | Google Drive as a mounted volume                                                   | design-gdrive     | Approved with cuts (P1-thin; ARB 2026-09-30)                                |
| [0002](0002-agent-provenance-undo-and-isolation.md)       | Agent provenance, damage confinement and injection benchmark                       | design-ai-runtime | Approved with cuts (P0; ARB 2026-09-30)                                     |
| [0003](0003-semantic-smart-folders-and-context-search.md) | Semantic Smart Folders and context-aware search                                    | design-ai-fs      | Approved with cuts (P0 items 1 to 6; `/mnt/smart` rejected; ARB 2026-09-30) |
| [0004](0004-predictive-file-cache-and-hoarding.md)        | Predictive file cache and hoarding                                                 | design-ai-fs      | Approved with cuts (P0 with export; hoard advisor cut; ARB 2026-09-30)      |
| [0005](0005-llm-as-a-scheduled-resource.md)               | The LLM as a scheduled kernel resource                                             | design-ai-runtime | Approved with cuts (P0; ARB 2026-09-30)                                     |
| [0006](0006-leases-fencing-and-glass-legibility.md)       | Lease fencing end to end, adaptive glass legibility, and Dock expansion and motion | design-platform   | Approved with cuts (part (a) only; (b) and (c) deferred; ARB 2026-09-30)    |

The Wave 3 build plan for Workflow B, which is the ARB's decision document, is [PLAN.md](PLAN.md). The critics' reviews are in [reviews/](reviews/).

Authors update their own row when the status changes; the lead updates it after an ARB decision.
