# ai/eval/rag: RAG-04 evaluation set and harness

The team evaluation set for semantic file search (RAG-04: Recall@5 ≥ 0.80, MRR reported), the RAG-03 permission-leak fixture, and the harness that measures both through the real `ai/src` pipeline with a pluggable embedder.

- **Primary owner:** R4 AI. **Secondary reviewer:** R5 QA/DevOps.
- **Specs:** [rag-semantic-search.md](../../../specs/10-ai/rag-semantic-search.md) §5.5 and §8, [ai-safety-and-evaluation.md](../../../specs/10-ai/ai-safety-and-evaluation.md) §3.6, §3.7, §4.1 and §5.1.
- **Requirement IDs:** RAG-04, RAG-03, RAG-06, AIS-04.
- **Latest result:** [REPORT.md](REPORT.md): the real pinned model MongoDB/mdbr-leaf-ir, Recall@5 0.938 [0.850, 1.000], MRR 0.846 (RAG-04 pass), with the hybrid, bge-small and BM25 runs compared. The BM25 baseline alone: [REPORT-bm25-baseline.md](REPORT-bm25-baseline.md).

## Layout

| Path                                 | What                                                                                                                                                        |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `corpus/home/<user>/…/<name>.corpus` | 223 documents, stored verbatim; the VFS path is the stored path without `.corpus`, under `/` (for example `/home/alice/notes/os/deadlock.md`)               |
| `corpus/MANIFEST.jsonl`              | one row per document: path, stored file, owner, group, mode, format, category, bytes, SHA-256, source, licence, author, near-duplicate and distractor notes |
| `queries.json`                       | 40 queries with graded relevance, run as `alice`                                                                                                            |
| `permissions.json`                   | users, groups and directory modes of the tree, and 13 leak probes                                                                                           |
| `schema.ts`                          | the formats above and their run-time validation                                                                                                             |
| `corpus.ts`                          | loads and verifies the set (size and SHA-256 of every file), builds the fixture tree, and an independent readability oracle                                 |
| `pipeline.ts`                        | the §3.5 query path assembled from `ai/src`: extraction, chunker-v1, per-uid BM25, vector index, readable set, RRF, result assembly and verification        |
| `embedders.ts`                       | the `EvalEmbedder` interface, the recorded-vector embedder and a lexical hashing stand-in for plumbing tests                                                |
| `metrics.ts`                         | Recall@5, MRR, graded nDCG@10, bootstrap intervals, lexical overlap, gates                                                                                  |
| `evaluate.ts`                        | one run: the RAG-04 queries, then the RAG-03 leak check for every user                                                                                      |
| `report.ts`                          | the `EvalReport` JSON (ai-safety-and-evaluation.md §4.1) and REPORT.md                                                                                      |
| `run.ts`                             | the command line (`pnpm eval:rag` once the root script exists)                                                                                              |
| `host.ts`                            | Node file access without Node type declarations (ai/ type-checks with `types: []`)                                                                          |
| `*.test.ts`                          | tests for the metrics, the data set and the pipeline                                                                                                        |
| `REPORT.md`, `baseline-bm25.json`    | the recorded BM25 baseline                                                                                                                                  |

## The corpus

223 documents by three users of one fictional capstone team: `alice` (207, the query user), `bob` (9) and `carol` (7).

- **Course notes** on operating systems, data structures, databases and AI, in Markdown and plain text, including rough drafts, quiz corrections and a lecture transcript.
- **Capstone material:** design notes, 15 meeting notes, 16 reports (bug write-ups, decision records, a post-mortem, performance and accessibility reports).
- **Code:** 37 files (17 TypeScript, 10 C, 9 Python, 1 SQL): lab programs, project utilities and tests.
- **Everyday text:** recipes, shopping lists, car service notes, plant care, budgets, travel plans, a reading list, household notes.
- **Private and shared-with-a-group files:** 11 files with mode 600 (alice 7, bob 3, carol 1) and one 640 file for group `team`.

It is built so that meaning matters beyond keywords:

- **Paraphrase distance.** Documents describe things in their own words (Nani’s _masoor daal_, a _workshop visit_ for a car service, _detached nodes and listeners that were never removed_ for a memory leak), and paraphrase queries avoid the target’s distinctive words and file name. `lexicalOverlap` measures this per query; the tests keep paraphrase overlap below 0.30.
- **Near-duplicates** (15, marked `nearDuplicateOf`): a draft and a final note, a meeting and its chat recap, two versions of a script, last year’s list, a teammate’s summary of the same lecture.
- **Distractors** (31, marked `distractorFor` with the query ids they target): documents that share a query’s keywords but not its meaning, such as a plumber’s visit about a _leaking_ pipe, a traffic _gridlock_ rant, railway _semaphore_ signals, a _heap_ of laundry, popcorn _kernels_, a _tree_ whose branch _split_, and course notes on a neighbouring topic.

### Stored with a `.corpus` suffix

The documents include `.ts` files and Markdown. Without the suffix, `tsc`, ESLint and Vitest would treat `lru-cache.test.ts` in the corpus as project code and tests, and Prettier would reformat the Markdown notes, which would change their bytes, their line numbers in citations and the keys of recorded embeddings. The loader strips the suffix to get the VFS path. The files are kept verbatim: `loadCorpus` refuses a file whose size or SHA-256 differs from its manifest row.

To add a document, store it as `corpus/<vfs path>.corpus` and add a manifest row with `bytes` (`wc -c`) and `sha256` (`sha256sum`), then write its queries.

### Licence and provenance

Every document is **original** and was written for this evaluation, so its licence is the team’s own, the same as the rest of this repository (`"license": "UNLICENSED"` in package.json). The manifest records `source: original` and `licence: LicenseRef-Plotinium-Team` for every row. No third-party text is included, so nothing is added to THIRD_PARTY.md.

- The documents, queries and grades were drafted in September 2026 by an AI coding agent working in R4’s workstream (`author: agent:rag-eval-corpus` in the manifest and in queries.json).
- The people are fictional personas (alice, bob, carol and their teammates); the private files contain invented data. No real person’s private information is included.
- Public facts that appear in course notes (the Mars Pathfinder incident, ARIES, Linux CFS, BM25, Bloom filters) are general knowledge described in our own words.

## Queries and grades

`queries.json` holds 40 queries: 17 paraphrase, 15 question, 6 code and 2 keyword. Each has:

- `relevant`: grade 2, the 1–3 files the query is about. **Recall@5 and MRR use these.** Every grade-2 file is owned by the query user, so the keyword path (which indexes only the caller’s own file bodies, I-A3) can see it.
- `partial`: grade 1, related files that answer part of the query. They count only in nDCG@10.
- `kind` and `author`. The spec’s record `{id, query, relevant, author, kind}` is a subset. The spec names the file `queries.jsonl`; this set uses `queries.json` as assigned.

## Permission fixture (RAG-03)

`permissions.json` gives the users (identical to `fx-agt@v1`: alice 1001, bob 1002, carol 1003; alice and bob are in group `team`), and the modes of the directories that differ from the default 755:

- `/home/alice/private` is 700 with five 600 files;
- `/home/alice/capstone/notes-to-self.md` and `peer-review-draft.md` are 600 in a 755 directory, so the file mode alone must hide them;
- `/home/alice/capstone/team-budget.md` is 640 with group `team`: bob can read it, carol cannot;
- `/home/alice/drop` is 711, a positive control: its 644 file stays findable by name through traverse-only permission;
- bob’s and carol’s 600 files include near-duplicates of RAG-04 targets.

The leak check runs every RAG-04 query and every probe as every user, and checks each returned file against an oracle that walks the path itself (x on each directory, r on the file) instead of reusing `readableSet`. The tests also show that the probes have teeth: with the filter switched off, every forbidden target reaches the results of a user asking for the maximum 50 (and the keyword path’s default top 10).

## Running

```sh
node ai/eval/rag/run.ts                                   # BM25 baseline, summary only
node ai/eval/rag/run.ts --report ai/eval/rag/REPORT.md --json ai/eval/rag/baseline-bm25.json \
  --version 0.1.0-dev --machine dev-workstation --date 2026-09-26
node ai/eval/rag/run.ts --embedder hashing --hybrid        # plumbing check of the vector paths
node ai/eval/rag/run.ts --embedder recorded --model-key <modelKey> \
  --vectors ai/eval/embeddings/<modelKey>/vectors.jsonl --gate
pnpm vitest run --project ai ai/eval/rag/                 # the tests
```

Exit codes: 0 done; 1 a permission leak (always) or a failed gate with `--gate`; 2 bad input. Run `pnpm format` after writing a JSON report inside the repository (Prettier lays out JSON arrays differently from `JSON.stringify`); reports under `docs/evidence/` are not formatted.

### The real model (`--embedder model`) and recorded vectors

`--embedder model` (or `model-fallback`) runs the pinned model in Node with `model-embedder.ts`: the same q8 ONNX files (web/public/models, from `ai/scripts/fetch-models.ts`) and the same `TransformersBackend` as the browser worker, on onnxruntime-node. `--record FILE` writes every vector of the run; `--embedder recorded --vectors FILE --model-key KEY` replays them without the model (CI: ai/tests/eval.rag-recorded.test.ts). `--compare LABEL=FILE` adds other runs' JSON reports to REPORT.md's comparison table.

`ai/eval/embeddings/<modelKey>/vectors.jsonl`, one line per model input:

```json
{ "sha256": "<hex SHA-256 of the UTF-8 model input>", "vector": [0.0123, -0.0456] }
```

The model input is exactly what the `ai.embed` worker receives: `embedInput('doc', header, text)` for a chunk (heading trail, newline, chunk text) and `embedInput('query', '', q)` for a query (the retrieval prefix plus the query). Every vector must have 384 dimensions and unit length (|‖v‖ − 1| < 1e-3). A missing vector fails the run; there is no silent fallback.

## Metrics

As in rag-semantic-search.md §5.5, over distinct files, 10 files returned per query:

- **Recall@5** = mean over queries of |relevant ∩ top 5| / |relevant|; the RAG-04 gate is ≥ 0.80.
- **MRR** = mean of 1 / rank of the first relevant file in the top 10, 0 when there is none.
- **nDCG@10** with gains 2^grade − 1, reported only.
- 95 % intervals: a percentile bootstrap with 1,000 resamples by query and a fixed seed, reported only.

## Before the Week-11 claim

1. **Non-author queries (AIS-04).** The spec requires queries written by members who did not write the target documents. Here one author drafted both, so a member must review or rewrite each query without reading its target documents first, then set `author`. This is the open `it.todo` in corpus.test.ts.
2. **Review the grades** with a second person, especially the grade-1 lists.
3. ~~Record vectors for leaf-ir and bge-small, run vector-only and hybrid, and apply the switch rule.~~ Done 2026-09-26: leaf-ir stays primary, hybrid stays off (REPORT.md).
4. **Wiring** outside this folder: the root `eval:rag` script and the `ai-eval` Vitest project (see integration notes in the PR).
