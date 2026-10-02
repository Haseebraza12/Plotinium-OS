# @plotinium/ai

Plotinium's three AI subsystems, each built as ordinary OS processes: A, RAG semantic search (deep); B, the agentic shell (deep); C, predictive pre-fetch (lean but complete). Each subsystem MUST show all four AI-native properties: it sees through the kernel, acts through typed syscalls, is scheduled as a process, and informs the OS (spec §3.2, C12). The litmus build (`__AI__=false`, server `AI=0`) removes this package and everything else must still pass.

| Field              | Value                                                                                                                                                                                                                                                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Primary owner      | R4 AI Pipeline Specialist                                                                                                                                                                                                                                                                                                 |
| Secondary reviewer | R2 VFS/DB (`indexer`, `agent`); R1 Kernel (`embed`, `predictor`); R3 WM/UI co-owns `search` (BM25, citations)                                                                                                                                                                                                             |
| Implements         | [specs/10-ai/rag-semantic-search.md](../specs/10-ai/rag-semantic-search.md)<br>[specs/10-ai/agentic-shell.md](../specs/10-ai/agentic-shell.md)<br>[specs/10-ai/predictive-prefetch.md](../specs/10-ai/predictive-prefetch.md)<br>[specs/10-ai/ai-safety-and-evaluation.md](../specs/10-ai/ai-safety-and-evaluation.md)    |
| Requirement IDs    | RAG-01..06, AGT-01..10, PRE-01..06                                                                                                                                                                                                                                                                                        |
| May import         | `@plotinium/protocol`, `@plotinium/dsa`, `@plotinium/kernel/hooks`. Never `vfs`, `wm`, `apps`, `server`, `db` or the kernel internals.                                                                                                                                                                                    |
| Status             | Wired: kernel link (`createAiLink`), the four AI services, the `ai.*` syscalls and seams, the `ai.indexer` / `ai.predictor` / `ai-agent` / `prefetch:<app>` programs, the real `ai.embed` worker (Transformers.js 4.3, verified in Chrome under the production CSP). RAG-04 on the real model: Recall@5 0.938, MRR 0.846. |

## Layout

| Folder           | Contents                                                                      |
| ---------------- | ----------------------------------------------------------------------------- |
| `src/embed/`     | `ai.embed` worker: Transformers.js over ORT WASM, batch 1, at most 512 tokens |
| `src/kernel/`    | the runtime INSIDE the kernel worker: `createAiLink`, `installAi`, services   |
| `src/programs/`  | the AI processes (generators): indexer, predictor, agent, prefetch; registry  |
| `src/indexer/`   | chunker, extraction, hashing, bookkeeping, work queue                         |
| `src/search/`    | exact vector index (Float32Array segments), BM25, RRF, citations and snippets |
| `src/agent/`     | observation loop, plan buffer, validate, dry run, confirm, execute, undo      |
| `src/predictor/` | telemetry schema, Witten-Bell Markov-2, baselines, pre-fetch policy           |
| `eval/`          | RAG, AGT-40, INJ-20 and prediction evaluation sets, cassettes, reports        |
| `scripts/`       | `fetch-models.ts` (pinned weights + ORT files), `vite-ort.ts` (bundler fix)   |

## What is implemented

| Area         | Modules                                                                                                                                                                                                                                                                                            | Notes                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. RAG       | `indexer/chunker.ts`, `extract.ts`, `hash.ts`, `tokens.ts`, `bookkeeping.ts`, `queue.ts`; `search/vector-index.ts`, `readable.ts`, `bm25.ts`, `hybrid.ts`, `results.ts`, `citations.ts`, `metrics.ts`                                                                                              | chunker-v1 with a documented WordPiece approximation; exact Float32 segment scan with the readable filter before ranking and `(ino, seq)` tie-breaks; own BM25 with the live-tree name field; RRF and keyword fallback with the spec notices; foreign-result verify/hide; citations and snippets                                                                                                                             |
| B. Agent     | `agent/envelope.ts`, `observe.ts`, `catalogue.ts`, `strict-schema.ts`, `intent.ts`, `reltime.ts`, `glob.ts`, `fsview.ts`, `select.ts`, `apply.ts`, `validator.ts`, `confirm.ts`, `token.ts`, `submit.ts`, `undo.ts`, `audit.ts`, `root-drop.ts`, `model.ts`, `decode.ts`, `loop.ts`, `cassette.ts` | datamarked envelope; every tool maps to one syscall; strict-schema post-processor and walker; span + verb-lexicon binding and grounding; overlay validator (checks 1–9) and dry run with trash moves, hashes, grant set and inverse actions; kernel predicate; WebCrypto HMAC tokens with a single-use grant table; audit records; undo builder; root drop; ≤ 6-turn observation loop; cassette record/replay with scrubbing |
| C. Predictor | `predictor/telemetry.ts`, `markov.ts`, `baselines.ts`, `evaluate.ts`, `prefetch.ts`                                                                                                                                                                                                                | strict telemetry events over the injected ring; Witten-Bell Markov-2 with lazy 14-day decay and cold-start MFU; MFU/MRU; chronological prequential evaluator; pre-fetch decision, residency hint, bootlog line                                                                                                                                                                                                               |
| Seams        | `hooks.ts`                                                                                                                                                                                                                                                                                         | the exact `@plotinium/kernel/hooks` shapes (`SchedulerHints`, `ShellNL`, `FsSemanticSearch`); `registerAiHooks(registry, sources)` returns the reset                                                                                                                                                                                                                                                                         |
| Kernel       | `kernel/link.ts`, `install.ts`, `embed-service.ts`, `search-service.ts`, `index-store.ts`, `predict-service.ts`, `agent-service.ts`, `gateway.ts`, `fs-view.ts`                                                                                                                                    | the `IoDeps.ai` factory; the ai.\* handlers; the embed queue (queries first, one job in flight, eviction = `terminate()`, one retry after 30 s); readable-set search; telemetry tap and pre-fetch policy; the agent's plan/submit/confirm/log and the `batch` token gate; the `/api/llm/plan` client matching the server's strict `PlanReq`                                                                                  |
| Programs     | `programs/indexer.ts`, `predictor.ts`, `agent.ts`, `prefetch.ts`, `model.ts`, `index.ts`                                                                                                                                                                                                           | see "The AI processes"                                                                                                                                                                                                                                                                                                                                                                                                       |

Everything the kernel owns is injected: the permission oracle (`vfs/perm.ts`), the live tree and snapshot, quota, leases, the TTY line discipline, the model gateway, and the team-written `dsa/` structures (`BoundedTopK`, `IndexedMinHeap`, `Ring`; local interfaces in `util/deps.ts`, test doubles in `tests/doubles.ts`, C16).

Deviations recorded for the spec owners:

- `modelKey` uses `-` separators (`MongoDB/mdbr-leaf-ir@4262131b-q8-d384-chunker-v1`) because protocol's `ModelKey` pattern has no `:`.
- A destructive plan step whose path argument is ungrounded is rejected (EPERM `not-requested`), not only confirmed, so the INJ-20 blind-yes gate holds.
- Plan steps with `sources` act once per member; `rename`/`copy` treat `to` as the destination directory.
- Agent `symlink` steps use a `link` lexicon class (agentic-shell.md §3.10 has no row for it).
- The HMAC input is the ABI's `pid|planId|planHash|dryRunHash|exp`, plus the grant hash when a grant is bound (agentic-shell.md §3.13).

## Kernel wiring (for the composer: web's kernel-worker entry)

The kernel may not import ai/ (C12, the `__AI__=false` litmus build), so the one module that sees both packages composes them. `@plotinium/ai/kernel` gives the kernel's `IoDeps.ai` factory; every type is structural and was checked against the real kernel types (`AiLink`, `AiLinkContext`, `KernelFs`, `Caller`, `HandlerRegistry`, `EventBus`):

```ts
import { AI_DAEMONS, AI_MANIFESTS, createAiLink, ortThreads, prefetchArgv } from '@plotinium/ai/kernel';
import EmbedWorker from '@plotinium/ai/embed-worker?worker';
import { may } from '@plotinium/vfs/perm';

installIo(kernel, {
  …,
  ai: createAiLink({
    kernel: {
      handlers: kernel.handlers, bus: kernel.bus,
      makeError: (errno, detail, msg) => new KernelError(errno, detail, msg),
      now: () => host.clock.now(), epochMs: () => host.clock.epochMs(),
      log: (level, msg) => kernel.log('ai', level, msg),
    },
    may,                                                   // the kernel's ONE permission function
    timers: { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h) },
    fetch: (url, init) => fetch(url, { ...init, credentials: 'same-origin' }),
    embed: { spawn: () => new EmbedWorker({ name: 'ai.embed' }), threads: ortThreads(self.crossOriginIsolated, navigator.hardwareConcurrency) },
    uidOf: (pid) => kernel.procs.get(pid)?.cred.ruid,
    spawnDaemon: async (name) => {                         // as the SESSION uid, never root
      const d = AI_DAEMONS[name];
      const pcb = await kernel.proc.spawnProcess({ parent: kernel.init, name: d.manifest, argv: d.argv, cred: sessionCred, priority: d.priority, nice: d.nice });
      return { pid: pcb.pid };
    },
    spawnPrefetch: (app, uid) => …spawnProcess({ name: 'prefetch', argv: prefetchArgv(app), … }) resolving at exit…,
    memory: () => …mm facts…, declaredBytes: (app) => …,
  }),
});
// The program registry: AI_MANIFESTS into the kernel's StaticProgramCatalog, and
// AI_PROGRAM_LOADERS (from '@plotinium/ai/programs') into startExecutor({ loaders }).
```

`installIo` calls the factory lazily with `{hooks, fs(), sessionUid(), osSessionId(), online()}`; the file system may still be unmounted then (the runtime starts before `vfs`), so every read goes through a lazy view of the CURRENT tree. The result (`AiInstallation`) is the kernel's `AiLink`: `services`, `verifyPlanToken` (for `registerFsSyscalls(…, { verifyPlanToken })`), `onProcessExit`, `desktopInteractive`, `noteInput`.

| Service        | `start()`                                                                                                                                   |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `ai.runtime`   | registers the `ai.*` calls, the telemetry tap and the three seams; no network, no weights (the model loads after desktop-interactive + 2 s) |
| `ai.indexer`   | `spawnDaemon('ai.indexer')`: the indexer process, PRI 32                                                                                    |
| `ai.predictor` | `spawnDaemon('ai.predictor')`: the predictor process, PRI 32                                                                                |
| `ai.agent`     | registers `ai.agent.plan/submit/confirm/log` and `ShellNL`; DEGRADED without a gateway `fetch`                                              |

## The AI processes

| Manifest       | argv[0] (`ps`)   | Class  | PRI         | Sees / acts through                                                                                                                            |
| -------------- | ---------------- | ------ | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `ai-indexer`   | `ai.indexer`     | system | 22 + NI 10  | `sys.subscribe` vfs.\* under $HOME, `open/read` as the session uid; `ai.index.lookup/embed/put/drop`; 50 % duty cycle while the user is active |
| `ai-predictor` | `ai.predictor`   | system | 22 + NI 10  | `ai.telemetry.read` (own ring), `/bin/*.json`; `ai.predict.publish`, `mem.hint`                                                                |
| `ai-agent`     | `ai`             | agent  | inherits    | envelope + read-only observations as ONE syscall each; `ai.agent.plan/submit/confirm`; `batch` with the plan token only                        |
| `prefetch`     | `prefetch:<app>` | system | 39 (lowest) | `mem.prefetch({app})`, `mem.prefetch({ino})`; exits 0 on EAGAIN (never blocks)                                                                 |

Manifest names have no dots because protocol's `AppManifestSchema` forbids them; argv[0] keeps the spec's names. The coreutils `ai` front end must spawn `/bin/lib/ai-agent.json` (`AGENT_MANIFEST_PATH`).

## The embedding model

| Item        | Value                                                                                                                                                                                        |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Primary     | `MongoDB/mdbr-leaf-ir` @ `4262131b` q8 (`onnx/model_quantized.onnx` + `.onnx_data`, 22.8 MiB), `sentence_embedding` 768-d → MRL 384-d                                                        |
| Fallback    | `Xenova/bge-small-en-v1.5` @ `ea104dac` q8 (33.1 MiB), CLS pooling, 384-d                                                                                                                    |
| Runtime     | onnxruntime-web `1.31.0-dev.20260914-8d85527a0` (`ORT_VERSION`), asyncify SIMD WASM (25.6 MiB) + MJS                                                                                         |
| Served at   | `/models/<lock-id>/<model id>/…` and `/ort/<ORT_VERSION>/…`: versioned paths, so Caddy's one-year `immutable` header is safe                                                                 |
| Environment | `allowRemoteModels = false`, `localModelPath = /models/<lock-id>/`, `wasmPaths` = `{wasm, mjs}` object, `numThreads` = 2 only when cross-origin isolated on ≥ 8 cores, batch 1, ≤ 512 tokens |

**Files: fetched, not committed.** `node ai/scripts/fetch-models.ts` downloads the pinned files from the Hub into `web/public/models` (SHA-256 checked, idempotent: a file with the right digest is never downloaded again; `--check` verifies without network) and copies the ORT files from the onnxruntime-web that pnpm-lock.yaml resolves into `web/public/ort`. The primary set is about 50 MB (with `--all` about 83 MB), too large for the repository, and every byte is reproducible from the pins, so `web/public/models/` and `web/public/ort/` belong in `.gitignore`. The Docker build runs the same script in the `build` stage before `pnpm --filter @plotinium/web build`; when the build context already holds the files (a developer ran the script), nothing is downloaded, and `.dockerignore` must NOT exclude them. Vite copies them into `web/dist`, so Caddy serves them from `/srv`. Nothing is ever fetched from the Hub at run time.

**CSP.** The normative policy (C10) has `script-src 'self' 'wasm-unsafe-eval'` and no `blob:`. Inside a worker, Transformers.js' own `useWasmCache` re-imports the ORT factory from a `blob:` URL, which that policy blocks (verified in Chrome: "no available backend found"). So `useWasmCache` is off and `cachedWasmBinary` keeps the WASM in the Cache API (`plotinium-ort`) and hands it to ORT as `wasmBinary`; the `.mjs` is imported from its same-origin URL. With this, the worker loads and embeds under the exact production CSP, with zero requests outside the origin.

**Bundling (web/vite.config.ts).** Transformers.js imports `onnxruntime-common` without declaring it, which pnpm's strict layout does not expose (`Failed to resolve import "onnxruntime-common"`), and onnxruntime-web's default "bundle" build makes Vite emit a second 27 MB copy of the WASM into `/assets`. `ai/scripts/vite-ort.ts` fixes both without an install:

```ts
import { defaultClientConditions } from 'vite';
import { ORT_EXTERN_WASM_CONDITION, onnxruntimeCommonAlias } from '../ai/scripts/vite-ort.ts';
resolve: { alias: [onnxruntimeCommonAlias()], conditions: [ORT_EXTERN_WASM_CONDITION, ...defaultClientConditions] },
```

**Browser check.** A production `vite build` of the worker, served with the production CSP and COOP/COEP headers, in Chrome: model ready in 1.9 s (first load), 1.0 s after eviction and re-spawn (the WASM from the Cache API: one network fetch in total); query embedding 81–97 ms, document chunk 13–17 ms; vectors identical to 7 digits to the Node run the evaluation uses. Screenshots: `docs/design/integration-shots/ai-embed-worker-*.png`.

## Evaluation (RAG-04)

`node ai/eval/rag/run.ts --embedder model` runs the REAL pinned model in Node (onnxruntime-node, the same q8 files and backend code); `--record` stores every vector under `ai/eval/embeddings/<modelKey>/vectors.jsonl`, and `--embedder recorded` replays them without the model (CI: `ai/tests/eval.rag-recorded.test.ts`).

| Run                                   | Recall@5 (95 % CI)   | MRR   | RAG-04 |
| ------------------------------------- | -------------------- | ----- | ------ |
| leaf-ir, vector only (claimed)        | 0.938 [0.850, 1.000] | 0.846 | pass   |
| leaf-ir + BM25, RRF hybrid            | 0.800 [0.675, 0.912] | 0.640 | pass   |
| bge-small (fallback), vector only     | 0.900 [0.813, 0.975] | 0.773 | pass   |
| BM25 only (model unavailable, RAG-06) | 0.525 [0.375, 0.675] | 0.354 | fail   |

leaf-ir stays primary (switch rule), and hybrid ranking stays OFF (`installAi({ hybrid: false })`): RRF lowers both metrics on this set. Full report: [eval/rag/REPORT.md](eval/rag/REPORT.md); the BM25 baseline: [eval/rag/REPORT-bm25-baseline.md](eval/rag/REPORT-bm25-baseline.md). 0 leaks in all runs (RAG-03).

## Known gaps

- `ai.search` runs in the kernel worker, not as the `ai.search` daemon: the provisional `SearchJob` (`ai.search.serve`) carries the query and the readable bitset but no way to hand the daemon the vector segments (the spec keeps them as store-backed pages of the daemon, which needs `mem.setBacking`). `ai.search.serve/done` stay unregistered (ENOSYS).
- The index lives in kernel memory: after a reload the indexer re-embeds (reconciliation finds nothing indexed). Persisting it in the `ai_*` IndexedDB stores and `/api/index` sync is not wired.
- `spawnProcess` refuses `system`-class programs for uid ≠ 0, but the AI daemons must be `system` class (their caps are only in the system bounding set) AND run as the session uid; the kernel must allow it for kernel-initiated spawns (parent = init).

## Commands

```sh
pnpm --filter @plotinium/ai typecheck   # this package against its own tsconfig.json
pnpm --filter @plotinium/ai test        # the Vitest project named "ai"
```

Test titles MUST begin with the requirement ID, for example `VFS-06 rejects a write beyond quota with EDQUOT and no partial data` (C18).
