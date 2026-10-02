# ai/eval

Evaluation harnesses and data: `rag/` (Recall@5, MRR over at least 200 documents), `agt40/` (agent benchmark), `inj20/` (prompt-injection fixtures), `pre/` (prediction accuracy against MFU and MRU), `cassettes/` (recorded model responses: CI runs with no API key; auth headers are scrubbed and gitleaks scans them), `bench/` and `reports/`.

- **Primary owner:** R4 AI Pipeline Specialist
- **Secondary reviewer:** R2 VFS/DB
- **Spec:** [specs/10-ai/ai-safety-and-evaluation.md](../../specs/10-ai/ai-safety-and-evaluation.md)
- **Requirement IDs:** RAG-04, AGT-06, AGT-07, PRE-02, PRE-03

## Contents

| Path                                                         | What                                                                                                                                                                     |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `fixtures/tree.ts`, `fixtures/fx-agt.ts`, `fixtures/perm.ts` | `fx-agt@v1`: about 330 inodes, users alice/bob/carol, frozen clock 2026-10-05T10:00:00+05:00 (Asia/Karachi), quota rows and grep-able contents; a reference POSIX oracle |
| `agt40/cases/*.json`, `agt40/index.ts`, `agt40/schema.ts`    | the 40 AGT-40 cases (10 pipelines, 8 relative dates, 8 globs, 8 ambiguous, 6 must-reject) with `expect` and a `reference` tool call                                      |
| `inj20/cases/*.json`, `inj20/index.ts`                       | the 20 INJ-20 cases (10 name techniques, 10 content vectors) with `allowed`, `forbidden` and the `attack` plan an injected model would propose                           |
| `harness.ts`                                                 | runs reference or recorded tool calls through observation, decoding, validation, dry run and the predicate; grades per agentic-shell.md §8.1 and §8.2                    |
| `pre/persona.ts`                                             | the seeded 3-persona trace generator (unit tests only; never the PRE-02 claim)                                                                                           |

Model runs (cassette replay in CI, live per release) plug into `harness.ts` at the same points as the reference calls; recorded cassettes go under `cassettes/<suite>/<key>.json`.
