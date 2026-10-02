# stab-followups: owned paths (Workflow B)

Builder `stab-followups` (polish follow-ups UI-037, UI-101, UI-112, UI-121, UI-127, UI-162).
Written first, before any code change. Anything outside this list is a handoff
(`docs/design/wave3/stab-followups/handoffs.md`).

| Path                                             | Notes                                                          |
| ------------------------------------------------ | -------------------------------------------------------------- |
| `apps/editor/**`                                 | Editor app (UI-037, UI-101, UI-112)                            |
| `ui/src/apps/editor/**`                          | Editor presentational components (UI-101 search panel)         |
| `apps/terminal/**`                               | EXCEPT `apps/terminal/plan.ts` (agent-safety) (UI-121, UI-127) |
| `ui/src/apps/terminal/**`                        | Terminal presentational components (UI-127)                    |
| `apps/taskmgr/**`                                | EXCEPT `apps/taskmgr/model.ts` (llm-runtime) (UI-162)          |
| `ui/src/apps/taskmgr/**`                         | Task Manager presentational components (UI-162)                |
| `wm/src/shell/menus.ts`                          | the menu API (UI-162: dynamic item state)                      |
| `wm/tests/shell/menus-dynamic.test.ts`           | new test file for the menu API (UI-162)                        |
| `kernel/src/core/io/session.ts`                  | only if UI-112 needs it                                        |
| `kernel/src/core/io/tests/session-ui112.test.ts` | new test file, only if session.ts changes                      |
| `docs/design/wave3/stab-followups/**`            | status, handoffs, notes, screenshots                           |

Not owned (handoffs if needed): `wm/src/shell/{Desktop.tsx,views.ts,env.ts,ui.ts,layout.ts}`,
`apps/src/**` (registry, descriptor: gdrive-ui owns `apps/src/descriptor.ts`, C-15),
`ui/src/primitives/**` (including `internal/csp-styles.ts`, used read-only), `kernel/**` other than
`session.ts`, `protocol/**`, `specs/**`, `AI_USAGE.md`, `CHANGELOG.md`.
