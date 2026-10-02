# Team contract

**Status:** TEMPLATE, to be completed, signed and committed in Week 2 (spec §4.4). Secretary: R5 QA/DevOps.

Spec §4.4 requires this contract to state: the role and secondary-review assignments; the team's definition of done; the meeting and communication schedule and how quickly each member commits to reply; how the team decides when members disagree; what the team does, and by when, if a member stops contributing; and a signed acknowledgement that marks are moderated individually (spec §16.4). Each is a numbered section below.

## 1. Members, roles and secondary reviewers

Each member holds one primary role (spec §4.1) and writes meaningful code in at least one other subsystem (spec §4.2). Roles follow the rebalanced assignment (C15).

| Role                                  | Member    | Roll number | Primary subsystem                                                                                                                                      | Second subsystem (writes code)                                                                                                                                                       | DSA owned                                   |
| ------------------------------------- | --------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------- |
| R1 Kernel / Systems Architect         | _to fill_ | _to fill_   | process table, scheduler, executors, watchdog, syscall dispatcher and IPC, memory manager, LRU pager, swap                                             | server swap and blob store (`/api/swap`); `ps top kill nice renice jobs bg fg free vmstat pmap`; AI scheduling hooks                                                                 | heap, `PidTable` hash table, LRU            |
| R2 VFS / Database Engineer            | _to fill_ | _to fill_   | VFS, IndexedDB store, schema, `vfsTxn`, lock protocol, sync engine, lock manager                                                                       | file coreutils (`ls cd pwd mkdir rmdir touch cat cp mv rm ln find tree stat chmod chown du df quota grep`); AI backend (`file_chunks`, index API, agent `sys.batch` executor, audit) | n-ary tree                                  |
| R3 WM / UI Subsystem Lead             | _to fill_ | _to fill_   | boot-ui, login, desktop, compositor, taskbar, Terminal UI, app views, accessibility, frame rate                                                        | shell lexer, parser and executor; BM25 keyword search and citations for RAG                                                                                                          | trie, z-order list                          |
| R4 AI Pipeline Specialist             | _to fill_ | _to fill_   | embedding pipeline, indexer, vector search, agent, predictor, evaluation sets, AI safety                                                               | LLM gateway                                                                                                                                                                          | Bloom filter; vector index; telemetry model |
| R5 QA / DevOps & Integration Engineer | _to fill_ | _to fill_   | service manager and boot orchestration, Service Worker and updates, CI/CD, performance and fault-injection harness, deployment, backups, observability | `syncd` client (outbox replay); auth sessions and the offline verifier                                                                                                               | DAG with topological sort, ring buffer      |

**Secondary reviewers.** Every path has a primary owner and a named secondary reviewer; `.github/CODEOWNERS` encodes the table below and requests the reviewer automatically.

| Subsystem                                                           | Primary               | Secondary reviewer                                              |
| ------------------------------------------------------------------- | --------------------- | --------------------------------------------------------------- |
| `kernel/` proc, sched, ipc, runtime                                 | R1                    | R5                                                              |
| `kernel/` mm, blkio; `server/src/storage`, `server/src/swap`        | R1                    | R2                                                              |
| `vfs/` (except `src/sync`); `db/`; `server/src/{sync,locks,vfs,db}` | R2                    | R5 (vfs core: R1)                                               |
| `vfs/src/sync`                                                      | R5                    | R2                                                              |
| `server/src/gateway` (auth sessions)                                | R5                    | R2                                                              |
| `server/src/index`                                                  | R2                    | R4                                                              |
| `server/src/llm`                                                    | R4                    | R2                                                              |
| `wm/`, `apps/` views, `apps/shell`                                  | R3                    | R1 (shell: R4)                                                  |
| `wm/src/boot-ui`, `services/`                                       | R5 and R3             | each reviews the other                                          |
| `apps/coreutils`                                                    | R2 and R1             | R3                                                              |
| `ai/`                                                               | R4                    | R2 (indexer, agent), R1 (embed, predictor), R3 co-owns `search` |
| `protocol/`                                                         | R1                    | R2 and R4 (two approvals)                                       |
| `dsa/*`                                                             | the structure's owner | a member who does not own it (rotating)                         |
| `.github/`, `ops/`, `tools/`, `tests/`, `web/`                      | R5                    | R1 (`web/`: R3)                                                 |

## 2. Definition of done

A task is done when all of these hold:

1. The code is merged to `main` through a reviewed pull request, with CI green.
2. Tests cover the behaviour, including edge cases. Test titles begin with the requirement ID. Integration tests exist if the change crosses a boundary (syscall to database, kernel to worker).
3. Coverage on the touched package has not dropped, and stays at or above 85% on `dsa/`, `vfs/` and `kernel/` once that package is gated.
4. Performance budgets are green, and a UI change passes axe with zero serious or critical issues in both themes.
5. Documentation is updated: the relevant section of ARCHITECTURE, DSA, DATABASE, AI, BOOT, TESTING or SECURITY, `man` pages for new commands, and a CHANGELOG entry if users will notice the change.
6. The feature is demonstrable on the deployed build, not only on a laptop.
7. The author can explain every line, and the AI_USAGE entry is written.

**Definition of ready (for issues):** a requirement ID, acceptance criteria written as test names, an owner, a reviewer, an S/M/L estimate and the gate milestone.

## 3. Meetings, communication and reply times

| What                                                    | When                                        | Length |
| ------------------------------------------------------- | ------------------------------------------- | ------ |
| Planning (risks, budgets, board)                        | Monday, _time to fill_                      | 60 min |
| Written stand-up in the team channel                    | Monday, Wednesday, Friday by _time to fill_ | –      |
| Demo of what was merged on `main`                       | Friday, _time to fill_                      | 15 min |
| Teach-back (owner explains a subsystem to their shadow) | weekly, _day to fill_                       | 30 min |
| Gate dry run                                            | 3 days before each gate                     | 60 min |
| Retrospective                                           | after each gate                             | 45 min |

- **Channels:** team chat _to fill_ for day-to-day messages; GitHub issues and pull requests for all technical decisions (review comments are process evidence and are never deleted).
- **Reply times each member commits to:** team-chat messages within 24 hours on weekdays; review requests within 24 hours on weekdays; during gate weeks and on Demo Day, within 4 hours between 09:00 and 21:00 PKT. A member who will be unavailable for more than 48 hours tells the team in advance.
- **Minutes:** the secretary (R5) posts decisions and action items within 24 hours of each meeting.

## 4. How we decide when we disagree

1. Discuss on the pull request or issue, with evidence (measurements, spec citations), for at most 48 hours.
2. If still unresolved, the team votes at the next meeting or asynchronously in the channel: simple majority of the five members.
3. On a tie, the primary owner of the affected subsystem decides.
4. If the disagreement still blocks work after 48 hours, it is escalated to the instructor, whose decision is final.
5. A changed decision after the Week-4 stack freeze needs a new record in `docs/adr/` and the instructor's written approval (spec §14.4).

## 5. If a member stops contributing

**Triggers:** two missed stand-ups or review deadlines in a row without notice; a task more than 3 days past its date without notice; or the weekly equity report (commits, lines by package, PRs authored and reviewed) showing a member outside the 15-25% band of non-generated lines, or under 15% of reviews, for 2 weeks in a row.

| Step                                                                                                                                           | Who                                    | By when                                           |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------- |
| 1. Private conversation: what is blocking, what help is needed; written note in the team log                                                   | two members, one of them the secretary | within 2 days of the trigger                      |
| 2. On the Monday agenda: a written recovery plan with concrete tasks, a pairing partner and a 1-week deadline                                  | whole team                             | the next Monday planning                          |
| 3. If the plan is missed: email the instructor with the evidence (equity report, board, PRs) and reassign work so the next gate is not at risk | secretary, copied to all members       | 1 week after step 2, and never later than Week 12 |
| 4. The instructor decides; peer assessment records the contribution honestly                                                                   | instructor                             | –                                                 |

No member is "carried": contributions are never attributed to someone who did not do the work (spec §18). Pair-programmed work is credited with `Co-authored-by:` trailers.

## 6. Acknowledgement of individual moderation

We understand that the team mark is only the starting point for each member's mark, and that it is moderated individually using three sources of evidence (spec §16.4): viva performance across the whole system; contribution evidence from commits, pull requests and reviews; and confidential peer assessment, collected twice in the semester. A member who cannot explain code they submitted, or the parts of the system they are asked about, receives a reduced mark whatever the team's result. We also understand that fabricated commit history, contributions attributed to the wrong person, or an agreement to carry a non-contributing member are misconduct (spec §18).

| Member    | Roll number | Role                                  | Signature | Date |
| --------- | ----------- | ------------------------------------- | --------- | ---- |
| _to fill_ | _to fill_   | R1 Kernel / Systems Architect         |           |      |
| _to fill_ | _to fill_   | R2 VFS / Database Engineer            |           |      |
| _to fill_ | _to fill_   | R3 WM / UI Subsystem Lead             |           |      |
| _to fill_ | _to fill_   | R4 AI Pipeline Specialist             |           |      |
| _to fill_ | _to fill_   | R5 QA / DevOps & Integration Engineer |           |      |
