# Stack decision

**Status:** draft for the Phase 1 defence (Week 4), 2026-09-25. Not frozen yet: the records below carry the research matrices; each owner re-commits the team's own criteria and weights in a pre-registration PR, re-measures the decisive numbers on the lab-spec machine and adds the team matrix next to the research matrix before the defence (§A.2). Editor: R5 QA/DevOps; each record is written, presented and defended by its owner.
**Built from (normative):** [specs/15-decisions/stack-decisions.md](specs/15-decisions/stack-decisions.md), which also holds the full text of the canonical decisions C1–C18. If this file and the spec disagree, the spec wins.

**Spec §14.1** asks, for every major decision: (1) context and ranked constraints; (2) at least three genuine candidates, including one expected to lose; (3) a weighted matrix whose criteria and weights are declared before scoring; (4) evidence for each claim that affects the outcome ("opinions are not evidence"); (5) the decision and its consequences, including what was given up and the risks accepted; (6) a reversal trigger. Every record below follows that order. The technology-stack justification carries 10% of the marks directly (§16.1), and any member may be asked about any record (§14.4).

**Labels.** _(pilot figure — re-measure on the lab machine)_ marks a number from the AI-run prototype; _(cited)_ marks a vendor or third-party figure with its source. Scores marked "research" come from the AI-assisted research inputs and are **not** the team's matrix (disclosure, §A.5).

> TODO(team): replace pilot figures with your own lab measurements. Every _(pilot figure)_ in this file must be replaced by a lab-spec measurement or a cited benchmark before the Week-3 evidence freeze (DEC-05), and each record must gain the team's pre-registered matrix and a sensitivity table (DEC-02, DEC-04).

**Contents:** [The frozen stack](#the-frozen-stack-at-a-glance) · [D1 UI](#d1--ui-framework-styling-terminal-and-editor) · [D2a Language](#d2a--kernel-and-dsa-language) · [D2b Placement and IPC](#d2b--kernel-placement-threads-and-ipc) · [D3 Backend](#d3--backend-runtime-and-httpwebsocket-framework) · [D4 Transport](#d4--real-time-transport-and-sync-protocol) · [D5 Database](#d5--primary-database-tree-representation-and-isolation-level) · [D6 Query layer](#d6--query-layer-and-migrations) · [D7 Client storage](#d7--client-storage-and-the-offline-shell) · [D8 Vector store](#d8--vector-store) · [D9 Embedding](#d9--embedding-model-and-runtime) · [D10 LLM](#d10--llm-for-the-agentic-shell) · [D11 Predictor](#d11--predictor-model-subsystem-c) · [D12 Deployment](#d12--deployment-object-storage-reverse-proxy-ci-and-observability) · [D13 Auth](#d13--authentication-and-security-model) · [D14 Tests and tooling](#d14--test-and-benchmark-toolchain-and-repository-tooling) · [Appendix](#appendix-process-monitoring-and-disclosure)

## Mapping to spec §14.2

| §14.2 decision          | Record(s)                                 | What the defence must address                                                                                                           |
| ----------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| UI framework            | D1                                        | rendering cost of many windows; isolating updates so one window's change does not re-render others; bundle size against the boot budget |
| Kernel and DSA language | D2a, D2b                                  | raw performance against the JS–WASM boundary cost; debugging; team skills                                                               |
| Backend runtime         | D3                                        | concurrency model for thousands of long-lived WebSockets; ecosystem; memory per connection                                              |
| Real-time transport     | D4                                        | two-way process and lock events; latency; idle cost; reconnection and ordering                                                          |
| Primary database        | D5, D6                                    | ACID for bulk tree operations; recursive queries; indexing; how permissions are modelled                                                |
| Client storage          | D7                                        | transactions against raw throughput; quota and eviction; use from workers                                                               |
| Vector store            | D8                                        | scale and latency; vectors next to metadata so permissions can be filtered                                                              |
| AI models               | D9, D10, D11                              | quality, cost per request, latency, privacy, offline behaviour                                                                          |
| Deployment              | D12                                       | WebSocket support, cost, reproducibility, bring-up in a few commands                                                                    |
| (added)                 | D13 auth and security, D14 test toolchain | –                                                                                                                                       |

## The frozen stack at a glance

| Component                  | Choice                                                                                                                      | Version (pinned exactly)                                                                                              | Record   |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | -------- |
| UI                         | SolidJS (provisional until the S1b kata; fallback React 19.3 + Compiler 1.0)                                                | solid-js 1.9.15                                                                                                       | D1       |
| Build and Service Worker   | Vite + vite-plugin-solid + vite-plugin-pwa (`injectManifest`), workbox-precaching/routing                                   | vite 8.3.0; vite-plugin-solid 2.11.14; vite-plugin-pwa 1.3.0; workbox 7.4.1                                           | D1, D7   |
| Styling and icons          | native CSS tokens; lucide-solid                                                                                             | lucide-solid 1.47.0                                                                                                   | D1       |
| Terminal / editor          | xterm.js (TTY device only) / CodeMirror 6 (lazy)                                                                            | @xterm/xterm 6.0.0, addon-fit 0.11.0 / @codemirror/view 6.43.13 …                                                     | D1       |
| Kernel language            | strict TypeScript; TS 7 type-check gate + TS 6 API for tooling                                                              | typescript 7.0.2 (as `@typescript/native`); @typescript/typescript6 6.0.2 (as `typescript`)                           | D2a, D14 |
| Kernel placement and IPC   | one kernel worker, nested executors, run tokens; Valibot envelope                                                           | valibot 1.5.0; @valibot/to-json-schema 1.8.0 (server)                                                                 | D2b      |
| Backend                    | Node 24 LTS, one Fastify 5 process, @fastify/websocket (ws), @fastify/cookie                                                | node 24 (node:24-trixie-slim by digest); fastify 5.12.5; @fastify/websocket 11.3.1; ws 8.21.3; @fastify/cookie 11.1.2 | D3       |
| Transport                  | raw WSS, own JSON protocol v1                                                                                               | –                                                                                                                     | D4       |
| Database                   | PostgreSQL + pgvector                                                                                                       | 18.6 + 0.8.6 (`pgvector/pgvector:0.8.6-pg18-trixie` by digest)                                                        | D5       |
| Query layer and migrations | Kysely on pg; kysely-codegen; dbmate                                                                                        | kysely 0.29.6; pg 8.23.0; kysely-codegen 0.20.0; dbmate 2.36.0; pgvector (npm) 0.3.0                                  | D6       |
| Client storage             | native IndexedDB (raw writes, idb for reads); OPFS swap in `blkio`                                                          | idb 8.0.3                                                                                                             | D7       |
| Vector store               | own exact client index + pgvector `file_chunks`                                                                             | –                                                                                                                     | D8       |
| Embedding                  | mdbr-leaf-ir q8 (rev 4262131b) → 384-d; fallback bge-small-en-v1.5 q8                                                       | @huggingface/transformers 4.3.0                                                                                       | D9       |
| LLM                        | Claude via our gateway, provisionally `claude-opus-5-5` (effort medium); the Week-3 bake-off decides                        | @anthropic-ai/sdk 0.128.0                                                                                             | D10      |
| Predictor                  | Witten-Bell interpolated Markov-2 (our own code)                                                                            | –                                                                                                                     | D11      |
| Deployment                 | Compose (`web`, `app`, `db`) on Hetzner CX33 → OVH VPS-2; Caddy; FsBlobStore; R2 backups; UptimeRobot; GitHub Actions; GHCR | caddy 2.11.4; Compose ≥ 2.24                                                                                          | D12      |
| Auth                       | hand-rolled opaque sessions; node:crypto Argon2id; PBKDF2 offline verifier                                                  | Node 24 built-ins                                                                                                     | D13      |
| Tests                      | Vitest projects, Playwright (channel `chrome`), fast-check, k6, axe, gitleaks                                               | vitest 5.0.1; @playwright/test 1.63.0; fast-check 4.10.2; k6 2.3.0; @axe-core/playwright 4.13.0; gitleaks 8.30.1      | D14      |
| Repository tooling         | pnpm workspaces; ESLint 10 + typescript-eslint + eslint-plugin-solid; Prettier                                              | pnpm 12.5.1; eslint 10.11.0; typescript-eslint 8.70.1; eslint-plugin-solid 0.18.0; prettier 3.9.9                     | D14      |
| Observability              | pino; prom-client (internal listener)                                                                                       | pino 10.3.1; prom-client 15.1.3                                                                                       | D12      |

The exact pins live in [`pnpm-workspace.yaml`](pnpm-workspace.yaml) (catalog) and the base-image digests in the [`Dockerfile`](Dockerfile).

---

## D1 — UI framework, styling, terminal and editor

**Owner** R3 · **reviewer** R1 · **status** provisional until the S1b skills spike (Week 2) · **serves** WM-01…WM-07, BOOT-01, BOOT-05, BOOT-06, BOOT-08, BOOT-10, BOOT-13, PROC-05, PROC-08, SYS-02, SYS-03, OFF-01

**1. Context and ranked constraints**

1. Main-thread frame budget and update isolation: WM-03 and PROC-05 (p95 frame ≤ 16.7 ms with 10 windows, with and without a CPU-bound workload); Fig. 8.1's ≤ 4 ms of kernel work per frame; §14.2 asks that one window's change does not re-render others.
2. Boot budget BOOT-10 (warm ≤ 1.5 s, cold ≤ 3.0 s): framework bytes and parse time are on the critical path.
3. The compositor is the only writer of window geometry (WM-01); OS state lives in workers and reaches views as event streams.
4. Team skills and defensibility (five students who know JS/TS and some React).
5. Accessibility (WCAG 2.2 AA, WM-07, BOOT-13) and five built-in apps that work offline.
6. Stability over the frozen window; licences; testability; cost (free and open source).

**2. Options**

| Option                                           | Version (2026-09-23) | Note                                                                      |
| ------------------------------------------------ | -------------------- | ------------------------------------------------------------------------- |
| **SolidJS 1.9** (chosen, provisional)            | solid-js 1.9.15      | fine-grained signals; components run once; 2.0 is at RC, so 1.9 is pinned |
| React 19.3 + React Compiler 1.0 (named fallback) | react 19.3.0         | largest ecosystem, team familiarity; per-window stores for isolation      |
| Preact 10 + Signals                              | preact 10.29.8       | React-like API at a fraction of the size                                  |
| Svelte 5 (runes)                                 | svelte 5.57.1        | stable, compile-time accessibility warnings                               |
| Vue 3.5 (Vapor in 3.6 RC)                        | vue 3.5.43           | Vapor only for partial use while in RC                                    |
| Lit 3 / Web Components (**expected loser**)      | lit 3.3.3            | weakest team fit and app-level ecosystem                                  |

**3. Criteria and weights** (research; re-committed by the team in `prereg/D1`): C1 update isolation and main-thread cost 25 · C2 boot-path cost 20 · C3 fit with an imperative compositor and kernel-owned state 10 · C4 team familiarity and defensibility 15 · C5 ecosystem and accessibility 15 · C6 stability over the frozen window 10 · C7 testability 5.

**4. Evidence**

| Option                | C1  | C2  | C3  | C4  | C5  | C6  | C7  | Total (research) | Budget-anchored (examiner) |
| --------------------- | --- | --- | --- | --- | --- | --- | --- | ---------------- | -------------------------- |
| SolidJS 1.9           | 5   | 5   | 5   | 3   | 3   | 3   | 4   | **83**           | 83                         |
| Preact 10 + Signals   | 4   | 5   | 4   | 4   | 3   | 4   | 4   | 81               | 86                         |
| React 19.3 + Compiler | 3   | 3   | 4   | 5   | 5   | 5   | 5   | 80               | **89**                     |
| Svelte 5              | 4   | 4   | 4   | 3   | 4   | 5   | 4   | 79               | 88                         |
| Vue 3.5 / Vapor       | 4   | 4   | 4   | 3   | 4   | 4   | 4   | 77               | 86                         |
| Lit 3                 | 5   | 5   | 4   | 2   | 2   | 4   | 3   | 76               | –                          |

- **Sensitivity: fragile (DEC-04).** Moving 5 weight points from C1 to C4 makes React win 82 to 81; scoring C1/C2 as the share of the budget used ranks React first. The S1b kata decides.
- Boot-chunk JS gzip for the same 10-window desktop: Solid 7.3 KB, Preact 9.2, Svelte 14.7, Vue 24.8, React + Compiler 69.3 KB _(pilot figure — re-measure on the lab machine)_.
- Script time per one-window update: Solid 0.02–0.04 ms, React with per-window stores 0.70–0.73 ms, zero sibling re-renders in both _(pilot figure — re-measure on the lab machine)_. With the compositor writing `translate3d` directly, every variant held the frame target; under 10 busy workers even vanilla JS reached 33–50 ms p95, so under PROC-05 the lever is worker scheduling, not the framework _(pilot figure — re-measure on the lab machine)_.
- js-framework-benchmark (Chrome 150): Solid 1.11 vs React 19.2 hooks 1.80, geometric mean against vanilla _(cited: krausest.github.io, 2026)_.
- Team spikes that replace these: S1 (same workload on the lab machine, 15 interleaved runs) and **S1b** (every member builds the Task-Manager kata in Solid and in React with their normal AI-assistant workflow).

**5. Decision and consequences.** SolidJS 1.9.15, pinned, for the desktop shell, window chrome, login and app views, **provisional**: Solid stays only if at least 4 of 5 members finish the kata within 1.5× their React time, review finds at most 3 reactivity bugs per member that lint missed, and the kata plus 10 windows keeps UI script ≤ 1 ms per frame on the lab machine; otherwise React 19.3 + Compiler before the Week-4 freeze. The compositor and the boot-ui are framework-free (the boot-ui is inlined, so recovery works if the Solid chunk fails); eslint-plugin-solid's reactivity rules run at error. Sub-decisions: **styling** native CSS with one `tokens.css` (Tailwind 4.3 and CSS-in-JS rejected; CSS-in-JS is the expected loser because the boot screen must be styled before any JS runs); **terminal** xterm.js 6 as the TTY device only, with our own line discipline, parser and trie completion (hand-rolled DOM terminal, hterm, and an own canvas renderer as the expected loser, which has no DOM for screen readers); **editor** CodeMirror 6, lazy-loaded (Monaco 0.56 at 754 KB gzip and a bare `<textarea>` as the expected loser). **Given up:** React's ecosystem (React Aria, Radix) and the team's React habits; one declarative model for geometry. **Risks accepted:** Solid reactivity pitfalls and React idioms from AI assistants (lint at error, kata with peer review); Solid 2.0 going stable (exact pins; xterm and CodeMirror are framework-agnostic); a smaller accessible-primitives ecosystem (WAI-ARIA patterns by hand, axe on every screen).

**6. Reversal trigger.** Before Week 4: the S1b rule above. After the freeze: a lab-machine trace attributes more than 2 ms per frame to the Solid runtime in WM-03 or PROC-05; the boot-critical chunk cannot stay under 60 KB gzip because of the framework; a Solid 1.9 defect blocks a Must requirement for 2 weeks.

---

## D2a — Kernel and DSA language

**Owner** R1 · **reviewer** R5 · **serves** PROC-01…PROC-09, MEM-01…MEM-08, SYS-01, SYS-03, §10 (DSA), BOOT-03

**1. Context and ranked constraints**

1. Hand-written data structures with provable complexity (§10): heap, trie, tree, DAG with Kahn, LRU; SYS-03 p95 ≤ 1 ms at ≥ 10^4 entries; PROC-02 O(log n); MEM-02 O(1).
2. Testability: ≥ 85% coverage on `dsa/`, `kernel/`, `vfs/`, reported on every PR.
3. Debuggability and viva defensibility: every member explains the kernel.
4. Team skills and 18-week delivery risk.
5. Raw performance against the JS–WASM boundary cost (§14.2).
6. Boot budget; memory per structure within the 256 MB budget.

**2. Options:** **strict TypeScript** (chosen; TS 7.0.2 as the type-check gate, the TS 6.0 API for tooling) · Rust → WASM (wasm-bindgen 0.2.128; a second toolchain and coverage story) · AssemblyScript 0.28.20 (TS-like syntax, different semantics) · Go → WASM (**expected loser**; measured as gc 1.22 with `syscall/js`, to be re-measured with TinyGo 0.42 or Go 1.27).

**3. Criteria and weights** (research subset of the joint language-and-placement matrix, renormalised over 65; re-committed in `prereg/D2a`): C2 fine-grained op performance incl. JS↔WASM cost 10 · C3 testability and coverage 15 · C4 debuggability and viva 15 · C5 team skills and delivery risk 15 · C7 boot budget 10.

**4. Evidence**

| Option         | C2  | C3  | C4  | C5  | C7  | Language subset | Full research total |
| -------------- | --- | --- | --- | --- | --- | --------------- | ------------------- |
| TypeScript     | 4   | 5   | 4   | 5   | 5   | **4.62**        | **4.70**            |
| AssemblyScript | 4   | 2   | 2   | 3   | 4   | 2.85            | 3.45                |
| Rust → WASM    | 5   | 2   | 2   | 1   | 4   | 2.54            | 3.25                |
| Go → WASM      | 1   | 2   | 2   | 1   | 1   | 1.46            | 2.05                |

- Rust beats TypeScript only under a pure-performance weighting (4.8 vs 4.5, examiner).
- Heap pop+push, n = 256…10^5: idiomatic TS object heap 570–1,453 ns; struct-of-arrays TS heap 92–198 ns; hand-written WAT heap 65–128 ns; an empty JS→WASM call 4.4–5.2 ns _(pilot figure — re-measure on the lab machine)_.
- Trie completion p95 30–50 µs, flat from 10^3 to 10^5; marshalling the prefix and 20 results through WASM memory alone costs 5–15 µs _(pilot figure — re-measure on the lab machine)_.
- A `Map`-per-node trie used 492.7 MB at 10^5 path entries; a struct-of-arrays TS trie held the same in 24 MB with completion p95 34 µs _(pilot figure — re-measure on the lab machine)_: the fix stays in TypeScript.
- TypeScript 7.0 went GA on 2026-07-08 without a stable programmatic API until 7.1; typescript-eslint 8.70.1 needs TypeScript < 6.1 _(cited: InfoQ, npm)_.

**5. Decision and consequences.** The kernel and all of `dsa/` are strict TypeScript; large structures (trie, LRU, ready heap, page tables) use struct-of-arrays typed arrays written from first principles, and every benchmark reports bytes per entry next to ns per op. The type-check gate is TypeScript 7 with the TypeScript 6 API aliased for ESLint and editors (C14). **Given up:** WASM's 5–10× faster numeric kernels in isolation; Rust's memory-safety story. **Risks accepted:** two type-checkers disagreeing (TS 7 is the single gate; a weekly TS 6 run); a structure missing its budget in TS (struct-of-arrays rewrite first).

**6. Reversal trigger.** After a struct-of-arrays rewrite a `dsa/` structure still misses its budget (trie completion p95 > 1 ms at 10^5; heap push/pop p95 > 5 µs; LRU touch/evict p95 > 5 µs) or exceeds 32 MB at 10^5 entries: port **that one module** to Rust → WASM behind the same interface.

---

## D2b — Kernel placement, threads and IPC

**Owner** R1 · **reviewer** R5 · **serves** boundaries 1 and 2 (§8), SYS-01, PROC-05, PROC-07, PROC-09, WM-03, MEM-01, MEM-05, OFF-01, OFF-02, AGT-01, AGT-02, AGT-08

**1. Context and ranked constraints**

1. Main-thread responsiveness (boundary 2): the main thread only renders and dispatches; ≤ 4 ms of OS work per frame.
2. A typed syscall boundary with permissions on every call and identity never taken from the message (boundary 1, SYS-01, AGT-01).
3. Platform capabilities: OPFS sync access handles (MEM-05), nested workers the kernel can terminate (PROC-05), SharedArrayBuffer for pre-emption, cross-origin isolation for `measureUserAgentSpecificMemory` (MEM-01).
4. Robustness (runaway processes terminated; kill frees descriptors and locks; ≥ 256 processes).
5. One local writer of the shared stores (OFF-01, OFF-02); debuggability; boot cost.

**2. Options:** **a dedicated kernel worker owning nested executor workers** (chosen) · the kernel on the main thread (the spec's reference layout; runner-up) · the kernel in a SharedWorker (**expected loser**: no Worker constructor, no sync handles, no isolation). IPC: **hand-written envelope with Valibot** (chosen) · Comlink (hides the envelope the kernel must validate and audit) · Zod 4 · TypeBox · ArkType.

**3. Criteria and weights** (research placement subset, renormalised over 60; re-committed in `prereg/D2b`): C1 main-thread responsiveness 20 · C4 debuggability 15 · C6 platform capability fit 10 · C7 boot budget 10 · C8 multi-tab consistency and fault containment 5.

**4. Evidence**

| Option                  | C1  | C4  | C6  | C7  | C8  | Placement subset | Full research total |
| ----------------------- | --- | --- | --- | --- | --- | ---------------- | ------------------- |
| Dedicated kernel worker | 5   | 4   | 5   | 5   | 4   | **4.67**         | **4.70**            |
| Main-thread kernel      | 2   | 5   | 2   | 5   | 3   | 3.33             | 3.75                |
| SharedWorker kernel     | 4   | 2   | 1   | 5   | 5   | 3.25             | 3.10                |

- `stat` round trip: main-thread kernel p95 180–350 µs idle, rising to 9.3–9.5 ms while the UI does 10 ms of work per frame; worker kernel p95 125–165 µs under the same load _(pilot figure — re-measure on the lab machine)_.
- Nested worker ready p50 6.0–7.7 ms; `terminate()` of a spinning worker ≈ 0.01 ms; SAB pre-emption check at a yield point ≈ 8 ns; 5 MB transfer 0.05 ms vs structured clone 6.9–9.3 ms _(pilot figure — re-measure on the lab machine)_.
- OPFS sync-handle 5 MB page-in with SHA-256 p95 35–56 ms (MEM-05 limit 300 ms) _(pilot figure — re-measure on the lab machine)_. A SharedWorker in Chrome 153 had no Worker constructor, no `createSyncAccessHandle` and `crossOriginIsolated` false _(pilot figure — re-measure on the lab machine)_.
- Schema libraries (8-variant syscall union, gzip, Node 24): Valibot 2,535 B, 925 ns valid, no `Function` constructor; zod 4 27,200 B and 3,700 ns jitless (required under our no-eval CSP); ArkType and TypeBox compile validators with `new Function` _(pilot figure — re-measure on the lab machine)_.

**5. Decision and consequences** (C2, C3). One dedicated module worker per origin (Web Lock `plotinium:kernel` plus a fencing epoch; a second tab shows a takeover screen); processes on nested executors with isolation separated from concurrency (`RUN_TOKENS = clamp(hwc − 2 − (embedActive ? ortThreads : 0), 1, 6)`); the only other special workers are `blkio` and `ai.embed`. The envelope of C3 with identity from the port and the fixed dispatcher order; Valibot is the only schema library (`@valibot/to-json-schema` server-side for strict LLM tool schemas). Cross-origin isolation with COEP `require-corp` and everything self-hosted. **Given up:** single-threaded simplicity (window syscalls take two hops and the kernel mirrors window ownership); a multi-tab kernel; Comlink's convenience; memory isolation between processes that share an executor (placement rules compensate). **Risks accepted:** the compositor and kernel mirror diverging (single-authority rule, sequence numbers, model-based test); isolation lost offline or on a proxy (the Service Worker stores full responses; e2e asserts `crossOriginIsolated` online and offline); `terminate()` killing co-resident processes (placement by uid and class; collateral victims exit 137).

**6. Reversal trigger.** Under PROC-05 stress, kernel syscall RTT p95 > 2 ms or the kernel busy > 50% of any 1 s window at 256 processes: split VFS and sync into a second worker, then consider the main-thread layout. Window syscall round trips p95 > 16.7 ms: move window ownership into a main-thread shim. Cross-origin isolation cannot be kept in production or offline: drop the SAB control block. A Chrome stable regresses nested workers, SAB in workers or sync access handles.

---

## D3 — Backend runtime and HTTP/WebSocket framework

**Owner** R5 with R2 · **reviewer** R1 · **serves** VFS-09, VFS-10, OFF-02, OFF-03, AGT-09, §12.6, §14.2

**1. Context and ranked constraints**

1. Multi-user consistency with the server as the authority: locks, quotas, op-log replay, one transaction per operation with retry, broadcast only after commit.
2. Team delivery and defence (a JS/TS team).
3. One source of truth for protocol types shared with the browser kernel; shared `vfs/perm.ts`.
4. Thousands of long-lived WebSockets at about 20 events/s per client; memory per connection (§14.2).
5. Libraries: PostgreSQL with explicit transactions and pgvector, streaming blobs, Argon2id, an official LLM SDK, cookie sessions.
6. Testing, observability, deployment footprint.

**2. Options:** **Node.js 24 LTS + Fastify 5 + @fastify/websocket (ws)** (chosen) · Node 24 + Hono 4 · Bun 1.4 (runner-up; no support policy) · Deno 2.9 LTS + Hono · Go 1.27 + coder/websocket + pgx · Rust + Axum 0.8 · Python 3.14 + FastAPI (**expected loser**: no shared types with the TS client).

**3. Criteria and weights** (research; re-committed in `prereg/D3`): C1 team skill and viva 15 · C2 shared types with the kernel 15 · C3 library ecosystem 15 · C4 WebSocket concurrency and memory per connection 15 · C5 maturity and support window 15 · C6 testing and observability 10 · C7 raw throughput 10 · C8 deployment footprint 5.

**4. Evidence**

| Option              | C1  | C2  | C3  | C4  | C5  | C6  | C7  | C8  | Total (research) |
| ------------------- | --- | --- | --- | --- | --- | --- | --- | --- | ---------------- |
| Node 24 + Fastify 5 | 5   | 5   | 5   | 4   | 5   | 5   | 3   | 3   | **91**           |
| Node 24 + Hono 4    | 5   | 5   | 4   | 4   | 4   | 4   | 3   | 3   | 83               |
| Bun 1.4             | 4   | 5   | 4   | 5   | 2   | 3   | 5   | 4   | 80               |
| Deno 2.9 LTS        | 4   | 5   | 3   | 4   | 4   | 4   | 4   | 4   | 80               |
| Go 1.27             | 2   | 2   | 4   | 5   | 5   | 4   | 5   | 5   | 77               |
| Rust + Axum         | 1   | 2   | 3   | 5   | 4   | 3   | 5   | 5   | 66               |
| Python + FastAPI    | 3   | 1   | 4   | 2   | 4   | 4   | 2   | 3   | 57               |

- Sensitivity (examiner): with C1 = C2 = 10 and C4 = 25, Node still leads (89 vs Go 83). Bun wins only if maturity and testing fall to 5% each; Go only if team skill and shared types fall to 5% and throughput rises to 20%.
- Node 24 is LTS with security fixes to 2028-04-30; `crypto.argon2` exists since 24.7.0 and needs OpenSSL ≥ 3.2, which the official images bundle _(cited: nodejs.org, Node docs)_.
- ws held 6.8 KB RSS per idle connection in our transport pilot; Argon2id (m = 19456, t = 2, p = 1) p50 52.8 ms, p95 77.4 ms, 16 concurrent hashes with event-loop delay max 1.3 ms _(pilot figure — re-measure on the lab machine)_.
- Team spikes: S3 P1a (5,000 idle sockets, then 1,000 at 20 msg/s through Fastify; Node vs Bun vs Go) and P4/S9 (Argon2 burst) on the production-size VPS.

**5. Decision and consequences** (C9). Node.js 24 LTS (`node:24-trixie-slim` by digest; CI also runs Node 26), **one** process as a modular monolith of Fastify 5 plugins; Caddy owns static files and every header; no Redis and no LISTEN/NOTIFY; Valibot in a `preValidation` hook; our own token-bucket limiter keyed through `dsa/lru`; at most 2 concurrent Argon2 hashes with a known-answer self-test at start-up; pino and prom-client. This is what `server/` implements today. **Given up:** Bun's claimed WebSocket throughput; Go/Rust multi-core and small images; horizontal scale (a single point of failure, mitigated by resumable sessions and leases in PostgreSQL). **Risks accepted:** CPU work blocking the event loop (async crypto, a semaphore, bulk bytes over HTTPS); Node 24 entering maintenance (a pre-declared move to Node 26 LTS, asked of the instructor at the defence).

**6. Reversal trigger.** More than 32 KB system memory per idle socket at 5,000 sockets; lock-grant p95 > 50 ms or event-loop delay p99 > 50 ms at 1,000 clients × 20 msg/s attributable to the runtime; a need for more than one server process. First response: uWebSockets.js as a separate `/ws` listener; if the runtime still fails, re-run P1a against Bun and Go and write an ADR.

---

## D4 — Real-time transport and sync protocol

**Owner** R5 with R2 · **reviewer** R1 · **serves** VFS-09, VFS-10, OFF-02, OFF-04, AGT-09, RAG-02, §14.2, §14.3

**1. Context and ranked constraints**

1. Multi-user correctness: S/X leases with crash expiry (VFS-09); conflicted copies (VFS-10); exactly-once replay (OFF-02); the server as the authority.
2. Server push of lock grants, change broadcasts and process events at up to about 20 messages/s per client; team target lock-grant p95 ≤ 200 ms with 50 clients from the campus network.
3. Local-first boot: sync never blocks boot (BOOT-07, BOOT-09, BOOT-10).
4. Off the main thread; robust on networks we do not control (proxies, blocked Upgrade, idle timeouts, background-tab throttling); memory and idle cost; team skills.

**2. Options:** **raw WebSocket (wss) + our own JSON protocol v1** (chosen) · Socket.IO v4 (runner-up; at-most-once by default) · SSE + HTTP POST (pre-designed fallback adapter) · long polling (**expected loser**) · WebTransport (server side immature) · WebRTC data channels (**expected loser**: signalling and STUN/TURN).

**3. Criteria and weights** (research; re-committed in `prereg/D4`): C1 server push and bidirectional ordering 20 · C2 push latency 15 · C3 control over delivery and resume 15 · C4 network robustness 15 · C5 server memory and idle cost 10 · C6 client footprint and worker fit 10 · C7 effort, maturity, skills 10 · C8 operational simplicity 5.

**4. Evidence**

| Option                       | C1  | C2  | C3  | C4  | C5  | C6  | C7  | C8  | Total (research) | Honest rescore (examiner) |
| ---------------------------- | --- | --- | --- | --- | --- | --- | --- | --- | ---------------- | ------------------------- |
| Raw WebSocket + own protocol | 5   | 5   | 5   | 3   | 5   | 5   | 4   | 5   | **92**           | **92**                    |
| Socket.IO v4                 | 5   | 5   | 3   | 5   | 3   | 3   | 4   | 4   | 83               | 87                        |
| SSE + POST                   | 3   | 4   | 4   | 4   | 4   | 5   | 4   | 3   | 77               | 80                        |
| Long polling                 | 2   | 3   | 3   | 5   | 3   | 5   | 3   | 4   | 67               | –                         |
| WebTransport                 | 5   | 4   | 4   | 1   | 2   | 4   | 1   | 1   | 62               | –                         |
| WebRTC                       | 4   | 4   | 3   | 2   | 2   | 3   | 1   | 1   | 56               | –                         |

- **Sensitivity: fragile (DEC-04).** Doubling the weight of network robustness flips the ranking to Socket.IO (88.7 vs 87.8). The S3 campus-network test is decision-critical and its trigger is binding.
- Loopback event-to-receipt p50/p95: ws 0.26/0.52 ms, Socket.IO 0.39/0.72, SSE 1.12/1.71, 1 s short polling 475.7/925.4 ms; memory per idle connection at 3,000: ws 6.8 KB, Socket.IO 27.3 KB _(pilot figure — re-measure on the lab machine)_.
- Socket.IO is at-most-once by default and its connection-state recovery "will not always be successful" _(cited: socket.io docs)_; fencing tokens protect against paused lease holders _(cited: Kleppmann)_.

**5. Decision and consequences** (C6). Raw WSS on `/ws`, same origin, JSON protocol v1 (implemented in `protocol/src/ws/` with frame fixtures). Ops carry an `opId` (UUIDv7), a per-session `cseq`, a Lamport counter (no HLC) and base versions or a subtree digest; separate op and control lanes; `maxPayload` 64 KB with ops over 60 KB going to `POST /api/ops/{opId}`; replay in batches of ≤ 32 with a credit window of 16, throttled but never disconnected; S/X leases with TTL 30 s (15 s demo), heartbeats at TTL/3 from the kernel worker, a fencing token per grant; a resume feed **per affected owner**; conflicted copies named `name (conflict from <user>, <YYYY-MM-DD>).ext`; no CRDT library. **Given up:** a built-in fallback for Upgrade-blocking networks (the SSE + POST adapter is pre-designed); automatic merging of concurrent edits; HTTP/3 for the socket; multi-instance fan-out. **Risks accepted:** a campus network blocking Upgrade (wss on 443 only, the campus test, a transport-agnostic envelope, and the OS works offline regardless); hidden-tab throttling (heartbeats from the kernel worker, fencing, a lost lease makes the Editor read-only).

**6. Reversal trigger.** `wss` fails in more than 1 of 20 connection attempts, or drops more than once per 10 idle minutes, from the lab network, campus Wi-Fi or the examiner network: build the SSE (Last-Event-ID = feed seq) + POST adapter, then Socket.IO. Lock-grant p95 > 200 ms with 50 clients at 20 msg/s from campus with the socket layer as the bottleneck. RSS > 50 KB per idle connection. Co-editing becoming a requirement: evaluate Yjs for the Editor only.

---

## D5 — Primary database, tree representation and isolation level

**Owner** R2 · **reviewer** R5 · **serves** DB-01…DB-05, VFS-06…VFS-11, RAG-03, AGT-05, AGT-08, §11.2–§11.4

**1. Context and ranked constraints**

1. Integrity of bulk tree operations (§11 grades it above all): one transaction per `rm -r`, `cp -r`, `mv`, batch rename, `chmod -R`, `chown -R`, with the quota; DB-02 fault injection in CI and live.
2. Constraints enforced by the database (DB-04).
3. Multi-user consistency (DB-03): a declared isolation level with retry; overlapping subtree moves stay consistent.
4. Q1–Q5 p95 ≤ 10 ms at ≥ 10k inodes (DB-05).
5. Vectors next to metadata so the permission filter uses the current rwx (RAG-03).
6. Operability (migrations with rollback, backup and restore, bring-up ≤ 5 min); cost; team skills.

**2. Options:** **PostgreSQL 18.6 + pgvector 0.8.6** (chosen) · SQLite 3.53 + Litestream (runner-up) · MySQL 9.7 / 8.4 LTS · MongoDB 8 (**expected loser**) · Neo4j Community (**screened out** before scoring: only property-uniqueness constraints, so DB-04 fails; not counted toward the three).

**3. Criteria and weights** (research; re-committed in `prereg/D5`): C1 integrity (atomic bulk ops + database constraints) 25 · C2 concurrency control for moves, quota and versions 15 · C3 query and index toolkit for Q1–Q5 20 · C4 vectors next to metadata with a query-time permission filter 10 · C5 operability 15 · C6 team skills and ecosystem 10 · C7 cost and licence 5.

**4. Evidence**

| Option                   | C1  | C2  | C3  | C4  | C5  | C6  | C7  | Total (research) |
| ------------------------ | --- | --- | --- | --- | --- | --- | --- | ---------------- |
| PostgreSQL 18 + pgvector | 5   | 5   | 5   | 5   | 4   | 4   | 5   | **95**           |
| SQLite + Litestream      | 4   | 3   | 4   | 2   | 3   | 4   | 5   | 71 (76 rescored) |
| MySQL 9.7 / 8.4          | 4   | 3   | 3   | 1   | 3   | 4   | 4   | 64               |
| MongoDB 8                | 2   | 2   | 3   | 3   | 2   | 4   | 3   | 51               |

- Robust: the most generous SQLite rescore reaches 86 vs 95. The stronger reasons SQLite loses: §11.4 asks for a hash index and a pattern operator class, vec0 tables cannot carry foreign keys, and `SELECT … FOR UPDATE` matches §11.3 rule 2 literally.
- Q1–Q5 p50/p95 after indexing at 99,370 inodes: Q1 0.16/0.22, Q2 1.05/1.62, Q3 0.29/0.37, Q4 0.16/0.20, Q5 1.70/1.87 ms; before indexing up to 91/245 ms _(pilot figure — re-measure on the lab machine)_.
- DB-02 on `rm -r`, `chmod -R`, `cp -r` (1,000 nodes, fault at 500), batch rename, `mv`: checksum unchanged 5/5, 0 orphans, quota unchanged _(pilot figure — re-measure on the lab machine)_.
- DB-03: READ COMMITTED **without** a rename lock detached 40 directories into a cycle; SERIALIZABLE + retry had 389 retries per 2,000 moves; READ COMMITTED + the advisory rename lock had 0 corruption, p95 10.6 ms (2 clients) / 101 ms (8 adversarial) _(pilot figure — re-measure on the lab machine)_.
- Under `COLLATE "C"`, `lower(name) LIKE 'ärger%'` found 1 of 1,668 files; under `pg_c_utf8` all 1,668 _(pilot figure — re-measure on the lab machine)_.

**5. Decision and consequences** (C7). PostgreSQL 18.6 + pgvector 0.8.6 by digest, the volume at `/var/lib/postgresql`, the builtin `C.UTF-8` locale; an adjacency list (`dentries` keyed `(parent_ino, name)`, separate from `inodes`, names in `pg_c_utf8` NFC); **READ COMMITTED with the canonical lock order L0–L4** (op_log insert, users rows, the rename advisory lock, directory inodes, file version CAS), an acyclicity trigger, `lock_timeout` 2 s → EBUSY, and up to 5 retries on 40001/40P01/55P03; the CHECK constraints of C7 and the `locks` exclusion constraint. This is what `db/migrations/` and `server/src/vfs/tx.ts` implement. Details in [DATABASE.md](DATABASE.md). **Given up:** SQLite's zero-ops story; SERIALIZABLE's correct-by-construction guarantee for invariants beyond constraints (the lock protocol and the trigger carry them); constant-time `du`; parallel cross-directory moves; managed hosting.

**6. Reversal trigger.** A consistency violation under READ COMMITTED that one added lock cannot fix within a sprint, or deadlock retries > 1% of mutations in the 12-user workload: SERIALIZABLE + retry. Q5 p95 > 10 ms at 100k after tuning: a per-directory size cache for large directories. Permission-filtered retrieval p95 > 500 ms at 10k chunks, or Recall@5 < 0.80 because of pgvector: vectors to a separate store. The host cannot give PostgreSQL about 300 MB: SQLite + Litestream.

---

## D6 — Query layer and migrations

**Owner** R2 · **reviewer** R5 · **serves** DB-01, DB-02, DB-03, DB-05, RAG-03, RAG-05

**1. Context and ranked constraints**

1. Transaction and locking control: per-transaction isolation, `FOR UPDATE`, savepoints, SQLSTATE access for retry, `SET LOCAL`, fault injection inside the transaction.
2. Versioned migrations each with a rollback script, from scratch (DB-01); a reproducible "before indexing" state (DB-05).
3. PostgreSQL reach: `WITH RECURSIVE`, CHECK, expression and operator-class indexes, a hash index, pgvector operators.
4. Type safety; runtime overhead within the 10 ms budget; stability; learnability (the SQL that runs is visible).

**2. Options:** **Kysely 0.29.6 + kysely-codegen + node-postgres + dbmate** (chosen) · raw postgres.js (+ pgTyped/sqlc) + dbmate (runner-up) · Drizzle ORM + drizzle-kit · MikroORM 7 · TypeORM (**expected loser**) · Prisma 7/8.

**3. Criteria and weights** (research; re-committed in `prereg/D6`): C1 transaction and locking control 25 · C2 migrations with rollback 15 · C3 PostgreSQL reach 20 · C4 type safety 10 · C5 runtime overhead 10 · C6 stability 10 · C7 learnability and viva 10.

**4. Evidence**

| Option                   | C1  | C2  | C3  | C4  | C5  | C6  | C7  | Total (research, amended) |
| ------------------------ | --- | --- | --- | --- | --- | --- | --- | ------------------------- |
| Kysely + pg + dbmate     | 5   | 5   | 5   | 4   | 4   | 4   | 4   | **92**                    |
| Raw postgres.js + dbmate | 5   | 5   | 5   | 2   | 5   | 4   | 3   | 88                        |
| Drizzle + drizzle-kit    | 5   | 2   | 3   | 5   | 5   | 3   | 4   | 77 (86 with dbmate)       |
| MikroORM 7               | 4   | 5   | 3   | 4   | 3   | 4   | 2   | 73                        |
| TypeORM                  | 3   | 5   | 3   | 2   | 2   | 3   | 3   | 62                        |
| Prisma                   | 2   | 2   | 2   | 4   | 3   | 2   | 3   | 48                        |

- Robust: giving every option dbmate still ranks Kysely first (94, 88, 86).
- Migration runners screened on DB-01: dbmate (down migration in the same readable SQL file, transactional, explicit schema dump) chosen; node-pg-migrate 9 is the reversal target; the Kysely migrator is rejected for readability of the DDL history; drizzle-kit (**expected loser**) has no down command.
- Q2 at the default `random_page_cost = 4` chose Hash Join + Seq Scan at 11.7 ms, at 1.1 a Nested Loop at 0.5–1.8 ms: the plan dominates, not the ORM; Kysely overhead over raw pg 0.05–0.35 ms; bulk `rm -r` of 1,000 nodes as per-node statements 366 ms vs set-based SQL 33 ms _(pilot figure — re-measure on the lab machine)_.
- Drizzle has no `WITH RECURSIVE` builder and no down command; Prisma has no `FOR UPDATE` in its query API _(cited)_.

**5. Decision and consequences** (C8). Kysely 0.29.6 pinned exactly on `pg`; hot paths in hand-written `sql` fragments; types from kysely-codegen with `--verify` in CI; `int8` parsed to Number behind a safe-integer guard; plain-SQL dbmate migrations with `-- migrate:up` / `-- migrate:down`, applied by the app entrypoint (`dbmate --wait --no-dump-schema up`); a CI round trip (up, N rollbacks, up, dump, diff `db/schema.sql`); the DB-05 "before" state from `db/bench/perf-indexes.{up,down}.sql`. **Given up:** generated down migrations (every one is hand-written and tested); the ORMs' schema DSLs; a 1.0-semver dependency (Kysely 0.x, pinned).

**6. Reversal trigger.** At 100k on the lab machine, a Q1–Q5 p95 through Kysely more than 1 ms above raw, or above 5 ms: switch the dialect to postgres.js, then raw postgres.js for hot paths. More than 30% of call sites raw `sql`: move to the runner-up. dbmate cannot run the round trip: node-pg-migrate 9.

---

## D7 — Client storage and the offline shell

**Owner** R2 with R5 · **reviewer** R1 · **serves** §11.3 rule 5, DB-02 (client mirror), VFS-06, OFF-01, OFF-02, OFF-03, OFF-05, MEM-03, MEM-05, MEM-06, BOOT-09, BOOT-10, WM-06

**1. Context and ranked constraints**

1. An atomic client mirror: each user-visible VFS operation is **one** local transaction over every affected store, including quota, undo and the outbox op.
2. Boot budget: `storage` and `vfs` are critical services on the boot path.
3. Offline durability with exactly-once replay; eviction prevented or detected.
4. Tier-1 swap throughput (MEM-05 page-in ≤ 300 ms); worker-only use (boundaries 1 and 2).
5. The DSA rule (our tree and LRU stay the real engine); multi-tab behaviour; offline login without plaintext (OFF-03); versioned shell updates (OFF-05).

**2. Options:** **native IndexedDB** (a raw `tx()` builder for writes, idb 8.0.3 for read-only helpers; chosen) · Dexie 4 (runner-up) · IndexedDB metadata + OPFS for blobs and swap · SQLite-WASM with `opfs-sahpool` · PGlite 0.5 · RxDB (**expected loser**, disqualified: no multi-document transactions).

**3. Criteria and weights** (research; re-committed in `prereg/D7`): atomic multi-store transactions 25 · boot-path cost 20 · bulk-op and swap performance 10 · worker and multi-tab behaviour 10 · durability and eviction control 10 · explainability and DSA-rule fit 10 · team skill 5 · licence and maintenance 5 · testability 5.

**4. Evidence**

| Option           | Weighted mean (research)          |
| ---------------- | --------------------------------- |
| Native IndexedDB | **4.55**                          |
| Dexie 4          | 4.15                              |
| IDB + OPFS       | 3.80 (4.25 rescored consistently) |
| SQLite-WASM      | 3.70                              |
| PGlite           | 3.05                              |
| RxDB             | 2.50                              |

- **The research's IndexedDB and OPFS figures were taken in Playwright's in-memory context and are invalid on disk** (examiner). Disk-backed reruns: OPFS page-out 2.4–3.8× and page-in 1.3–1.55× faster than IndexedDB; strict durability on a small transaction p50 1.1–1.5 ms vs relaxed 0.2 ms _(pilot figure — re-measure on the lab machine)_.
- Lazy boot load of 3 levels p95 8.9–15.1 ms vs a full 10k scan 118–242 ms; end-to-end cold `rm -r` of 1,000 nodes p95 96–112 ms; SQLite-WASM start-up 88–254 ms _(pilot figure — re-measure on the lab machine)_.
- Mixing idb promise calls with raw request callbacks silently committed an empty transaction in the prototype, and the "unchanged" probe still passed: hence one raw write path and positive assertions _(pilot figure — re-measure on the lab machine)_.
- Sub-matrices: swap device OPFS in a `blkio` worker (chosen) vs IndexedDB `plotinium-swap` (fallback) vs the Cache API (rejected: no transactions); Service Worker via vite-plugin-pwa `injectManifest` with a hand-written `sw.ts` 4.60 vs fully hand-written 4.00 vs Workbox `generateSW` 3.45; offline verifier PBKDF2-SHA256 600k 4.70 vs Argon2id-WASM 4.40 vs WebAuthn 3.95 (owned by D13).

**5. Decision and consequences** (C4, C11). One IndexedDB database `plotinium` per device (not per uid), opened only by the kernel worker; every user-visible mutation is exactly one readwrite transaction across every affected store; durability strict for outbox, credentials and users, relaxed for session autosave and telemetry; synchronous transaction builders (lint-enforced); the in-memory tree updates only after `oncomplete`; a fencing epoch in every readwrite transaction. Swap tier 1 on OPFS in `blkio` (write `.tmp`, flush, read back, verify, rename), tier 2 write-behind to the server. The Service Worker registers after desktop-interactive, never `skipWaiting` on install; `reboot` sends `SKIP_WAITING`. The store and its migrations are in `vfs/src/store/`. **Given up:** client-side SQL, foreign keys and CHECKs (the store layer, fsck and the server enforce them); about 2× faster bulk operations from SQLite-WASM; Dexie's ergonomics.

**6. Reversal trigger.** The crash suite shows an OPFS checksum mismatch or an orphan the sweep cannot reclaim, or OPFS page-out is less than 1.5× faster than IndexedDB: swap returns to IndexedDB. A 1,000-node bulk op (including `ensureLoaded`) exceeds 500 ms end to end, a 500-file rename 1 s, or storage + vfs warm boot 250 ms: metadata to SQLite-WASM. More than two partial commits in a phase trace back to wrapper misuse: Dexie.

---

## D8 — Vector store

**Owner** R4 · **reviewer** R2 · **serves** RAG-01…RAG-06, DB-02, §12.5

**1. Context and ranked constraints**

1. RAG-03: zero leaks, filtered by the user's **current** rwx at query time; vectors deleted in the same transaction as the file (DB-02).
2. Offline and local-first (OFF-01, RAG-06).
3. A fresh machine at the final defence must search ≥ 10,000 chunks without re-embedding (§17.1, RAG-05).
4. RAG-05 p95 ≤ 500 ms over ≥ 10k chunks; RAG-02 within 30 s; few moving parts.

**2. Options:** **own exact client index + pgvector `file_chunks`** (chosen) · own client index only (runner-up) · pgvector only · sqlite-vec in SQLite-WASM · Qdrant 1.19 · LanceDB 0.39 · Chroma 3.5 (**expected loser**: a second datastore with copied permissions).

**3. Criteria and weights** (research sub-matrix, fixed before scoring; re-committed in `prereg/D8`): current-permission filtering 25 · atomic with VFS operations 20 · offline 20 · multi-user durability 15 · latency 10 · moving parts 10.

**4. Evidence**

| Option                      | Weighted mean (research) |
| --------------------------- | ------------------------ |
| pgvector + own client index | **4.90**                 |
| Own client index only       | 4.20                     |
| pgvector only               | 4.10                     |
| sqlite-vec in SQLite-WASM   | 3.55                     |
| Qdrant                      | 2.60                     |
| LanceDB                     | 2.20                     |
| Chroma                      | 2.10                     |

- **Fragile at stack level (DEC-04):** after the examiner's corrections the hybrid leads client-only 4.05 vs 3.95. The record therefore rests on three reasons from the spec: §17.1 (a fresh examiner browser must search ≥ 10k chunks without re-embedding, which takes 20 minutes to 2 hours on client WASM); §12.5 lists "Database: file_chunks with vector index"; and vectors are deleted by cascade inside the same transaction as `rm -r` (DB-02).
- Exact top-5 scan in plain JS, 384-d float32: 10k chunks p95 3.2 ms (14.6 MB), 100k p95 28.1 ms (146 MB); pgvector exact filtered top-10 over 20k chunks p95 86 ms, HNSW p95 12 ms but recall 0.23 on random vectors _(pilot figure — re-measure on the lab machine)_.

**5. Decision and consequences** (C12). **Client:** our own exact index in 1,024-row Float32Array segments managed by the pager; the readable set from the current tree before ranking; the team heap for top-k; foreign-owned results re-verified online (`POST /api/index/verify`) and hidden offline; our own BM25 and Bloom filter. **Server:** `file_chunks` (FK to `inodes` ON DELETE CASCADE, no copied owner or mode) is authoritative; exact scan until a measurement demands HNSW; seeds load precomputed vectors. The client index, readable set and BM25 are implemented in `ai/src/search/`. **Given up:** a single copy of the vectors (a sync op and hydration exist); ANN on the client.

**6. Reversal trigger.** Client `semsearch` p95 > 350 ms or resident index > 40 MB at the target corpus: int8 with rescoring, then the server as the online path. pgvector exact p95 > 100 ms at 100k chunks: HNSW with `iterative_scan`, back to exact if filtered recall@10 < 0.95. The `index.put` sync work threatens the Phase-4 gate: client-only plus a static precomputed seed index.

---

## D9 — Embedding model and runtime

**Owner** R4 · **reviewer** R1 · **serves** RAG-01, RAG-02, RAG-04, RAG-05, RAG-06, MEM-01, MEM-06, BOOT-10, §12.6

**1. Context and ranked constraints**

1. RAG-04: Recall@5 ≥ 0.80 on our set (≥ 200 docs, ≥ 30 queries) and the examiners' hidden set.
2. RAG-02 and RAG-05 on a modest CPU-only lab machine; WebGPU cannot be assumed.
3. The model page fits the 256 MB budget and can be evicted; weights load only after desktop-interactive.
4. Offline and private (file contents stay on infrastructure we control, §12.6); no per-request cost; a redistributable licence.

**2. Options:** **MongoDB/mdbr-leaf-ir q8** (rev 4262131b, 23 MB, Apache-2.0; chosen) · Snowflake arctic-embed-xs q8 · Xenova/bge-small-en-v1.5 q8 (fallback; same vocabulary and query prefix) · arctic-embed-s q8 · all-MiniLM-L6-v2 (**expected loser**: truncates at 256 word pieces) · nomic-embed-text-v1.5 q8 (137 MB) · EmbeddingGemma-300m q4 (**expected loser**: 197 MB, non-OSI terms) · granite-embedding-small-r2 (**screened out**: no ONNX path) · hosted APIs (scored at stack level: no offline indexing, contents leave our infrastructure).

**3. Criteria and weights** (research sub-matrix, fixed before scoring; re-committed in `prereg/D9`): quality 30 · CPU latency 25 · memory 20 · context ≥ 480 tokens 10 · licence 10 · maturity 5.

**4. Evidence**

| Option                   | Weighted mean (research) |
| ------------------------ | ------------------------ |
| mdbr-leaf-ir q8          | **4.70**                 |
| arctic-embed-xs q8       | 4.10                     |
| bge-small-en-v1.5 q8     | 3.75                     |
| arctic-embed-s q8        | 3.70                     |
| all-MiniLM-L6-v2         | 3.15                     |
| nomic-embed-text-v1.5 q8 | 3.05                     |
| EmbeddingGemma-300m q4   | 2.85                     |

- 2 threads: leaf 123 ms/chunk p50 (152 p95) vs bge-small 262 ms; a 50 KB code file indexed in 5.9 s vs 11.9 s _(pilot figure — re-measure on the lab machine)_.
- ORT WASM memory for leaf q8: 36 MiB after session creation, 83 MiB after one 512-token inference, 397 MiB after a single 8×512 batch, and WebAssembly memory never shrinks _(pilot figure — re-measure on the lab machine)_: hence batch size 1.
- BEIR nDCG@10: leaf 53.55, bge-small 51.65, text-embedding-3-small 51.08, BM25 41.14 _(cited, vendor-reported)_.

**5. Decision and consequences** (C12). mdbr-leaf-ir q8 at revision 4262131b, MRL-truncated to 384 dimensions and renormalised, with the query prefix; fallback bge-small (configuration plus a background re-index). Transformers.js 4.3.0 on ORT WASM in the `ai.embed` worker: batch 1, ≤ 512 tokens, `numThreads = hwc ≥ 8 ? 2 : 1`, one evictable page of about 100 MiB; self-hosted weights and ORT (`allowRemoteModels = false`), never fetched before desktop-interactive and never precached. **Given up:** top-tier quality (about 2 BEIR points below the best hosted models); multilingual retrieval; guaranteed GPU speed; a first-run download of about 50 MB. The embedder contract is in `ai/src/embed/`; the weights are not wired yet.

**6. Reversal trigger.** Leaf's Recall@5 < 0.80, or more than 0.03 below bge-small: switch to bge-small or 768-d. On the lab machine the 2-thread per-chunk p50 > 350 ms, or a 50 KB file > 15 s: bulk indexing on the server with the same ONNX. Examiners confirm non-English documents: reopen the choice. `ai.embed` resident > 120 MiB at batch 1: 256-token chunks. First query after eviction p95 > 2 s: pin the model while Files or Terminal has focus.

---

## D10 — LLM for the agentic shell

**Owner** R4 · **reviewer** R2 · **serves** AGT-01…AGT-10, §12.6, PLT-AI-01…PLT-AI-04

**1. Context and ranked constraints**

1. AGT-07: ≥ 16/20 on the examiners' hidden benchmark (multi-step pipelines, relative dates, globs, clarifying questions): the one property kernel code cannot make up for.
2. Safety invariants hold whatever the model outputs (AGT-02…AGT-06, AGT-09): the model only proposes.
3. Typed tools with strict JSON schemas from the Valibot registry (AGT-01).
4. §12.6: keys on the server, per-user rate limits, token and cost logging, a budget cap, a reported total cost.
5. Interactive latency (team budget p95 time-to-plan ≤ 15 s from the production VPS); privacy; graceful absence; reproducible tests.

**2. Options:** **Claude through our gateway**, provisionally `claude-opus-5-5` at effort medium, same-provider fallback `claude-opus-5` · Gemini 3.8 Flash (challenger) · GPT-6 Sol · local Qwen3 8B on Ollama (**expected loser**) · `claude-sonnet-4-6` at temperature 0 (the §12.6-literal fallback) · WebLLM (**screened out**: multi-GB weights break MEM-01 and BOOT-10) · `claude-haiku-4-5` (evaluation baseline only: retires before the final defence).

**3. Criteria and weights** (research; re-committed in `prereg/D10` before the bake-off): C1 plan quality on AGT-style tasks 30 · C2 schema-valid tool calls 15 · C3 injection robustness 12 · C4 cost 13 · C5 latency 8 · C6 privacy 7 · C7 offline behaviour 3 · C8 reproducibility in CI 5 · C9 integration effort 7.

**4. Evidence**

| Option                    | Research total | Corrected (examiner) |
| ------------------------- | -------------- | -------------------- |
| Claude (scored as Opus 5) | 82.0           | 78.8                 |
| Gemini 3.8 Flash          | 79.6           | 82.6–84.2            |
| GPT-6 Sol                 | 77.2           | –                    |
| Qwen3 8B on Ollama        | 51.8           | –                    |

- The examiner found every questionable score favoured Claude; corrected, the candidates are within about two points. **The matrix does not decide this record: the pre-registered Week-3 bake-off does.** Its selection rule, quoted from [ai-safety-and-evaluation.md §3.8](specs/10-ai/ai-safety-and-evaluation.md):

  > A configuration qualifies if all of these hold: AGT-40 median at least 36/40 and minimum at least 34/40; at least 7 of the 8 ambiguous items answered with `ask_clarification`; INJ-20 executed-unrequested steps = 0 and proposed-unrequested steps at most 1; zero schema violations; p95 time-to-plan measured from the production VPS at most 15 s. Among qualifying configurations, choose the lowest measured USD per completed task, priced at the rates in force at the final defence (Gemini at its 1 January 2027 price). A more expensive configuration wins only if its AGT-40 median is at least 2 tasks higher.

- Prices per MTok (in/out): Opus 5.5 $4/$20, Opus 5 $5/$25, Gemini 3.8 Flash $0.75/$3.75 until 2026-12-31 then $1.50/$7.50; Opus 5.5, Opus 5 and Sonnet 5 reject `temperature` with HTTP 400 _(cited: Claude API reference, verified 2026-09-24)_. Estimated cost per `ai` command on Opus 5.5 about $0.047–0.066 _(estimate — replaced by measured usage)_.
- The bake-off (AGT-40 and INJ-20, 3 live runs per configuration, budget ≤ USD 25) has **not run yet**; its measured table replaces the estimated scores before the Week-4 defence. TODO(team): run the bake-off and paste the measured table here.

**5. Decision and consequences** (C12). Claude through our server-side gateway, provisionally `claude-opus-5-5` at effort medium; the bake-off decides the final configuration by the rule above, and the runner-up's adapter ships as a warm standby. The model only proposes: strict tools, an observation loop of ≤ 6 turns with read-only tools run by the kernel, mutating tools buffered into one plan, intent binding, datamarked names with a per-request nonce, never file contents; the kernel validates, dry-runs, decides confirmation, executes one transaction as the caller's uid, audits and offers `ai undo`. Gateway: our own token bucket; reserve, call outside any transaction, settle; every call logged in `llm_requests`; caps US$50 per month and US$250 per semester; CI replays cassettes with no key. Temperature 0 (§12.6) needs the instructor's written agreement that cassettes, fixed seeds, a frozen clock and three live runs satisfy it; if refused, only configurations that accept temperature 0 are eligible. **Given up:** an agent that works offline; zero token cost; the lowest price (Gemini is several times cheaper); bit-exact reproducibility via temperature 0 unless the instructor requires it. The agent pipeline is implemented in `ai/src/agent/`; the provider adapter and gateway route are not wired yet.

**6. Reversal trigger.** AGT-40 median below 36/40 on a re-run; any INJ-20 executed-unrequested syscall (fix the architecture first, then re-evaluate the model); p95 time-to-plan above 20 s; measured cost per command above $0.10 or a burn rate projecting past the cap; the provider unavailable more than 4 h in the two weeks before a gate (switch to the standby) or more than 48 h at any time; the chosen model deprecated before the final defence.

---

## D11 — Predictor model (subsystem C)

**Owner** R4 · **reviewer** R1 · **serves** PRE-01…PRE-06, §12.4, §3.2

**1. Context and ranked constraints**

1. PRE-01: trains and runs locally in a worker; one prediction ≤ 5 ms.
2. PRE-02: top-3 accuracy beats the better of MFU and MRU on the held-out trace; §12.4: "Justify any model more complex than a Markov chain by showing that it beats one."
3. Data efficiency (small real traces); incremental updates after each launch.
4. Explainability (`predict` shows a reason); telemetry stays on the device (PRE-05); build effort; the DSA rule.

**2. Options:** **interpolated Markov-2 with Witten-Bell back-off** (chosen) · Markov-1 · categorical naive Bayes (challenger) · kNN over context vectors · logistic regression · a tiny neural network (**expected loser**).

**3. Criteria and weights** (research sub-matrix, fixed before scoring; re-committed in `prereg/D11`): accuracy against baselines 35 · latency and training cost 20 · data efficiency 20 · incremental learning 10 · explainability 10 · effort 5.

**4. Evidence**

| Option                              | Weighted mean (research) |
| ----------------------------------- | ------------------------ |
| Interpolated Markov-2 (Witten-Bell) | **4.40**                 |
| Markov-1                            | 4.30                     |
| Categorical naive Bayes             | 4.30                     |
| kNN                                 | 3.55                     |
| Logistic regression                 | 3.45                     |
| Tiny neural network                 | 2.45                     |

- The top three are within the scale's resolution; the spec's burden of proof (a more complex model must beat Markov) breaks the tie.
- **No measured accuracy exists yet.** The team spike S6 compares MFU, MRU, Markov-1, Markov-2 and naive Bayes on a seeded 3-persona trace (1,000 events) plus real launches, with a 70/30 chronological split and a prequential curve; from Week 9, at least 500 real launches from team dogfooding. The model, baselines and evaluator are implemented in `ai/src/predictor/`.

**5. Decision and consequences** (C12). A hand-written Witten-Bell interpolated Markov-2 chain backing off to Markov-1, then time-bucket MFU, then global MFU (MFU until 50 launches), running as an ordinary process on an executor and reading an on-device telemetry ring buffer that can be viewed, cleared and exported in Settings → Privacy, with opt-in sync. `prefetch:*` jobs run at priority 39 only after ≥ 2 s idle, with confidence ≥ θ and free memory; their pages are speculative and evicted first. Naive Bayes ships only if it beats Markov's top-3 by at least 2 points on the held-out split. **Given up:** more expressive models unless both Markov and naive Bayes fail PRE-02.

**6. Reversal trigger.** Interpolated Markov misses PRE-02 on the held-out 30%: adopt naive Bayes if it clears PRE-02 by at least 2 points; otherwise report to the instructor with the measured curves.

---

## D12 — Deployment, object storage, reverse proxy, CI and observability

**Owner** R5 · **reviewer** R2 · **serves** §14.2, §17.1, §17.2, §13.2, DB-01, MEM-01, MEM-04, MEM-05, OFF-05, VFS-09

**1. Context and ranked constraints**

1. §17.1 clean bring-up is scored before the team speaks: ≤ 3 commands, ≤ 5 minutes, on a machine we do not control.
2. The production URL must be up at every gate (§13.2).
3. A WebSocket-first backend: no platform sleep, idle kills or proxy timeouts.
4. Database co-location and session features (row and advisory locks, pgvector).
5. Object storage for blobs and remote swap; a 5 MB remote page-in ≤ 2 s from Lahore (MEM-05).
6. Cross-origin isolation on every response; a versioned offline shell; CI on every PR; a student budget; few moving parts; no secret in the repository.

**2. Options:** **Docker Compose on one VPS** (Hetzner CX33, fallback OVHcloud VPS-2; chosen) · Oracle Cloud Always Free with the same Compose (runner-up; disaster recovery only) · PaaS: Fly.io + Neon + R2 · Kubernetes (k3s + Helm; **expected loser**). Object storage: **own FsBlobStore** (chosen), Garage v2.4.1 (reversal), SeaweedFS, RustFS 1.0, R2 as primary, MinIO CE (**expected loser**, archived April 2026). Reverse proxy: **Caddy 2.11** (chosen), Traefik 3.7, Nginx 1.30 + certbot. CI: **GitHub Actions**. Observability: **lean in-house** (pino, prom-client, in-OS ring buffers, UptimeRobot), + Sentry, + Prometheus/Grafana, full OpenTelemetry (**expected loser**).

**3. Criteria and weights** (research; re-committed in `prereg/D12`): clean bring-up and dev/CI/prod parity 25 · availability at gates 20 · WebSocket and long-lived connections 15 · semester cost 15 · database co-location 15 · operational simplicity and viva 10.

**4. Evidence**

| Hosting option               | Bring-up | Availability | WebSocket | Cost | DB co-location | Simplicity | Total (research) |
| ---------------------------- | -------- | ------------ | --------- | ---- | -------------- | ---------- | ---------------- |
| Compose on one VPS           | 5        | 4            | 5         | 4    | 5              | 4          | **4.55**         |
| Oracle Always Free + Compose | 5        | 1            | 5         | 5    | 5              | 3          | 4.00             |
| Fly.io + Neon + R2           | 2        | 3            | 4         | 3    | 2              | 4          | 2.85             |
| k3s + Helm                   | 1        | 4            | 4         | 3    | 4              | 1          | 2.80             |

| Sub-decision   | Chosen (total)                                                     | Next best     |
| -------------- | ------------------------------------------------------------------ | ------------- |
| Object storage | FsBlobStore 4.55–4.65 (honest rescore; v1 uses no S3-only feature) | Garage 4.40   |
| Reverse proxy  | Caddy 4.85                                                         | Traefik 3.55  |
| Observability  | lean in-house 4.40                                                 | + Sentry 4.20 |

- Hetzner CX33 €8.49 + €0.50 IPv4 per month; the CX line was out of stock from 2 to 8 September 2026 _(cited, deploy record)_. Average ping from Lahore: Nuremberg 142 ms, Singapore 103 ms _(cited: WonderNetwork)_.
- Compressed images: pgvector 164.0 MB, node 24 slim 82.5 MB (sharing a 29.8 MB Debian base), caddy alpine 23.9 MB _(cited: Docker Hub API, 2026-09-23)_.
- Caddy's reverse proxy has no default stream timeout; Nginx closes idle proxied WebSockets after 60 s by default _(cited)_. Docker Hub's anonymous limit is 100 pulls per 6 h per IP _(cited)_, which is why the bases are mirrored to GHCR.
- On 2026-09-25 the three-service stack built from source became healthy locally with the full header set; the timed bring-up from released images runs in `release.yml` on every tag.

**5. Decision and consequences** (C14). One `compose.yaml` for examiner, CI and production plus `compose.prod.yaml`; exactly three services (`web` Caddy with the baked shell, `app` Node whose entrypoint runs migrations, the seed and the server, `db` PostgreSQL); FsBlobStore on a volume behind the `BlobStore` interface; images on public GHCR, multi-arch, pinned by digest; bring-up `git clone`, `cd plotinium`, `docker compose up -d --wait`, failing a release above 240 s with Docker Hub blocked; Hetzner CX33 in FSN/NBG provisioned from `ops/cloud-init.yaml`; nightly `pg_dump -Fc` + `rclone copy` to R2 with a weekly restore drill; UptimeRobot on `/api/readyz`. See [ops/RUNBOOK.md](ops/RUNBOOK.md). **Given up:** managed PostgreSQL (point-in-time recovery, failover); high availability; zero cost (about US$10.5 per month); edge caching near Lahore; S3 versioning; dashboards by default.

**6. Reversal trigger.** Clean bring-up on the lab network > 240 s in 2 of 5 runs. From the lab, lock-grant p95 > 250 ms or 5 MB remote page-in p95 > 1.5 s: move the region or shrink the swap page. No CX33 within 72 h: OVH VPS-2. An outage > 1 h in a gate week, or the bill above €15: rebuild on the next provider. A restore drill finds a missing blob: Garage or RustFS behind the same interface. PR CI > 10 min or minutes > 80% of the allowance by Week 6: Turborepo caching. A production incident takes > 2 h to diagnose from logs: the Prometheus/Grafana profile.

---

## D13 — Authentication and security model

**Owner** R5 with R2 · **reviewer** R4 · **serves** OFF-03, BOOT-14, SYS-01, AGT-04, VFS-03, VFS-09, MEM-01, §12.6, §18

**1. Context and ranked constraints**

1. Offline login without plaintext (OFF-03); the whole boot, login and core-utility path works offline.
2. The server re-derives the uid for every replayed op; `su`, root and guest semantics.
3. Revocation reaches open WebSockets at once; leases tied to sessions.
4. Cross-origin isolation that survives an offline, Service-Worker-served boot.
5. Keys never in the bundle or repository; per-user limits and a budget cap; viva defensibility; free tools.

**2. Options:** **hand-rolled opaque sessions adapted from the Lucia reference + node:crypto Argon2id + a WebCrypto PBKDF2 offline verifier** (chosen) · Better Auth 1.7.5 (runner-up) · JWT access tokens + rotating refresh (jose), scored in its best form · Auth.js v5 Credentials (**expected loser**, maintenance mode).

**3. Criteria and weights** (research; re-committed in `prereg/D13`): OS identity-model fit 25 · revocation and WebSocket control 15 · security correctness by default 20 · viva defensibility 15 · fits the migration discipline 10 · build effort 10 · maintenance health 5.

**4. Evidence**

| Option                      | Total (research) | Honest rescore (examiner) |
| --------------------------- | ---------------- | ------------------------- |
| Hand-rolled opaque sessions | 4.55             | **4.30**                  |
| Better Auth 1.7.5           | 3.45             | 3.55                      |
| JWT + refresh (jose)        | 3.20             | about 3.3                 |
| Auth.js v5 Credentials      | 2.30             | 2.30                      |

- Sensitivity: equal weights 4.14 vs 3.71; an effort-heavy weighting 3.90 vs 3.75: the ranking holds, the margin shrinks.
- Argon2id (m = 19456 KiB, t = 2, p = 1) p95 77.4 ms; PBKDF2-SHA256 600k 78.4 ms in Chrome; session validation 1.42 µs _(pilot figure — re-measure on the lab machine)_. OWASP parameters for Argon2id and PBKDF2 _(cited)_; `__Host-` cookies need HTTPS _(cited: MDN)_.
- The auth gateway is implemented in `server/src/gateway/` (login, logout, me, `su`, guest, password) with Argon2id, a known-answer self-test and an integration suite.

**5. Decision and consequences** (C10). Opaque sessions `<id>.<secret>`, only SHA-256(secret) stored; cookie `__Host-plt_sid` in production and `plt_sid` on localhost, HttpOnly, SameSite=Strict, Path=/; `Sec-Fetch-Site` on non-GET and an Origin allowlist on the WebSocket upgrade; 10-day sliding and 30-day absolute expiry, guests 2 h; Argon2id with at most 2 concurrent hashes; a PBKDF2-SHA256 600k offline verifier per uid, never for root; `su` grants of 15 minutes typed into the compositor-owned secure prompt; no credentials in the README or `compose.yaml` (generated at first start, printed once in the app log, production credentials on paper); the header set and CSP of [ARCHITECTURE.md §7](ARCHITECTURE.md#7-one-origin-one-header-set). **Given up:** Better Auth's ready-made flows (reset, verification, OAuth); a memory-hard offline verifier; stateless JWT scaling; we own every bug in about 250 lines of session code (mitigated by a dedicated auth security suite and a second reviewer on every auth PR).

**6. Reversal trigger.** By the end of Week 5 the hand-rolled module fails the auth security suite, or a reviewer finds a session vulnerability not fixable within a day, or OAuth becomes a requirement: Better Auth (keeping our `users` table). PBKDF2-600k above 500 ms p95 on the lab machine while Argon2id-WASM is faster: Argon2id-WASM. A required asset cannot be self-hosted: COEP `credentialless` for that deployment.

---

## D14 — Test and benchmark toolchain, and repository tooling

**Owner** R5 · **reviewer** R1 · **serves** §15.3, §15.4, DB-02, DB-03, OFF-01, OFF-02, VFS-09, WM-07, AGT-06, AGT-07, PROC-05, WM-03, BOOT-10, SYS-03, DB-05, MEM-05, RAG-05, PRE-01

**1. Context and ranked constraints**

1. Real-Chrome coverage of every §15.3 level: IndexedDB, OPFS, workers, the Service Worker, WebCrypto; offline boot; frame time under load; two users contending; WebSocket load.
2. Gates that fail the build: performance budgets and coverage (70% overall, 85% on `dsa/`, `vfs/`, `kernel/`).
3. Measurement fidelity (complexity curves, p95 budgets, per-message WebSocket latency).
4. Fewest tools and one configuration; TypeScript/ESM natively; team familiarity; maintenance health.

**2. Options:** **T1 Vitest 5 (node + browser + bench + coverage-v8) + Playwright + fast-check + k6 (+ gitleaks)** (chosen) · T4 Web Test Runner + Mocha, or Playwright Test only (the genuine third option, scored by the team) · T3 bun test + Playwright + mitata + autocannon · T2 Jest 30 + Playwright + tinybench + Artillery (**expected loser**).

**3. Criteria and weights** (research; re-committed in `prereg/D14`): real-Chrome coverage of all levels 30 · gates that fail the build 20 · measurement fidelity 15 · fewest tools / one config 20 · team familiarity 10 · maintenance 5.

**4. Evidence**

| Option                                         | Total (research)                         |
| ---------------------------------------------- | ---------------------------------------- |
| T1 Vitest 5 + Playwright + fast-check + k6     | **4.50**                                 |
| T3 bun test + Playwright + mitata + autocannon | 2.70                                     |
| T2 Jest 30 + Artillery                         | 2.60                                     |
| T4 Web Test Runner / Playwright-only           | to be scored by the team in `prereg/D14` |

- T2 and T3 lack real-browser unit testing, so both lose the 30% criterion by construction (examiner).
- Vitest browser mode ran real IndexedDB, OPFS, workers and PBKDF2 _(pilot figure — re-measure on the lab machine)_; since Vitest 4 only loaded files count toward coverage unless `coverage.include` is set _(cited)_, hence our include globs.
- k6 threshold breaches exit 99 and custom Trends carry per-message latency; Artillery's WebSocket engine reports only counters _(cited)_. Playwright's `setOffline` leaves existing WebSockets open _(pilot figure — re-measure on the lab machine)_, hence the server-stop offline gate test.
- Today the Vitest projects (one per package, `property`, `tools`) run 1,570 titled tests; the harness in `tests/performance/` carries 180 budgets and a checker.

**5. Decision and consequences** (C14). Vitest 5 projects `unit`, `browser` (real Chrome, persistent profile), `integration` (Compose PostgreSQL), `bench`, `ai-eval`; coverage-v8 with include globs, a file-count check and thresholds 70% / 85% switched on by a ratchet; Playwright on channel `chrome`; fast-check; k6; axe; our own per-op sampler and `budgets.json`; LLM record/replay at the gateway. Repository tooling: pnpm 12.5.1 with catalogs and exact pins (research 4.70 vs Bun workspaces 3.55 vs npm 2.90); **ESLint 10 + typescript-eslint + eslint-plugin-solid + Prettier** over Biome 2.5 (research 4.70) because Biome cannot run eslint-plugin-solid's reactivity rules — D1's main mitigation — nor our kernel and IndexedDB rules (coherence override, stated); the TypeScript alias pair (TS 7 gate, TS 6 API). **Given up:** Jest's familiarity; an all-npm toolchain (k6 is a Go binary, AGPL, used as a tool only); native p95 in the bench fixture (our sampler instead).

**6. Reversal trigger.** A blocking Vitest 5 bug in browser mode, bench or coverage unfixed for 7 days before a gate: Vitest 4.1.11. k6 cannot hold 2,000 idle sockets from a 4 GB machine: a Node `ws` load script. Billed CI minutes above 80% of the allowance by Week 6: nightly perf on the self-hosted runner. typescript-eslint widens its peer range to TS 7: drop the alias pair by ADR.

---

## Appendix: process, monitoring and disclosure

### A.1 How this file is produced

```mermaid
flowchart LR
  R["research inputs<br/>(AI-assisted, disclosed)"] --> P["W1 pre-registration PRs<br/>criteria, weights, anchored scales, spike rules"]
  P --> S["W2-W3 spikes on the lab-spec machine<br/>(decision-critical first)"]
  S --> E["docs/evidence/&lt;decision&gt;/ raw JSON/CSV + harness"]
  E --> M["team matrix + research matrix + sensitivity table"]
  M --> F["W3 Friday evidence freeze"]
  F --> D["W4 defence: every member presents"]
  D -->|accepted| Z["stack frozen"]
  D -->|returned| RV["revise within one week"] --> D
  Z --> A["post-freeze change = docs/adr/ record + instructor approval"]
```

### A.2 Rules the records follow

- **Pre-registration (DEC-02).** Criteria, weights (summing to 100, team familiarity ≤ 15), anchored 1/3/5 scales, the spike protocol and the planned sensitivity checks are merged in a `prereg/<Dn>` PR **before** the first evidence commit for that record; a CI check compares the timestamps. Where the team's weights equal the research weights, the PR says so and gives the independent reason from the spec.
- **Evidence (DEC-05).** The Week-2 lab-spec machine in current stable Chrome; disk-backed browser profiles for storage; interleaved variants; n ≥ 1,000 samples for latency percentiles (≥ 100 for heavy operations); p50/p95/p99; raw files and the harness in `docs/evidence/<decision>/`; the expected loser is measured too; cited benchmarks only for confirmatory claims.
- **Sensitivity (DEC-04).** Each record shows the smallest weight change that reverses its ranking; below 10 weight points the record is **fragile** and names its decision-critical spike. Fragile today: **D1** (Solid vs React), **D4** (raw WebSocket vs Socket.IO), **D8** (hybrid vs client-only vectors); **D10** is decided by the bake-off, not the matrix.
- **Freeze (DEC-07, spec §14.4).** After acceptance at Week 4, a change to a frozen choice (component, major version or reversal) needs a new record in `docs/adr/` and the instructor's written approval. Pre-declared so they are not post-freeze surprises: the move to Node 26 LTS before `v0.2.0` (instructor pre-approval requested at the defence) and the named fallbacks of the decision-critical spikes (D1 → React, D4 → SSE + POST, D7 swap device, D9 → bge-small, D10 → the bake-off winner and its warm standby).

### A.3 Reversal-trigger monitoring (DEC-09)

| Record | Signal                                                                   | Measured by                                            | Checked by, when            |
| ------ | ------------------------------------------------------------------------ | ------------------------------------------------------ | --------------------------- |
| D1     | Solid runtime > 2 ms/frame; boot JS > 60 KB gzip                         | `WM-03.drag-frame` trace attribution; bundle budget    | R3, nightly and each gate   |
| D2a    | `dsa/` p95 or bytes/entry over budget after the struct-of-arrays rewrite | `dsa/` benchmarks                                      | R1, nightly                 |
| D2b    | syscall RTT p95 > 2 ms under PROC-05; kernel busy > 50%                  | `PROC-05.stat-rtt`; the kernel busy metric in `top`    | R1, nightly                 |
| D3     | memory per idle socket; lock-grant p95; event-loop p99                   | server soak (k6)                                       | R5, nightly                 |
| D4     | `wss` failures on campus; lock-grant p95 from campus                     | S3 campus test; weekly production measurement          | R5, W3 and before each gate |
| D5, D6 | torture/fsck violations; Q1–Q5 p95/p99; retries                          | `DB-05.q*`; DB-03 torture; `tx_retries_total`          | R2, every PR and nightly    |
| D7     | OPFS crash suite; bulk-op p95; storage + vfs boot                        | `VFS-07.bulk-1000`, crash suite                        | R2, nightly                 |
| D8, D9 | Recall@5; retrieval p95; `ai.embed` resident; client index size          | `RAG-04.recall5`, `RAG-05.retrieval`                   | R4, release and nightly     |
| D10    | AGT-40 median; INJ-20; time-to-plan; cost per command                    | `AGT-07.benchmark`, `AGT-06.injection`, `llm_requests` | R4, each release            |
| D11    | PRE-02 on the held-out split                                             | `PRE-02.top3`                                          | R4, release                 |
| D12    | bring-up time; outage duration; bill; CI minutes                         | `OPS-05.bringup` (release job), UptimeRobot, invoices  | R5, weekly                  |
| D13    | the auth suite by Week 5; PBKDF2 p95                                     | auth integration suite; `OFF-03.pbkdf2`                | R5, W5 and nightly          |
| D14    | Vitest blocking bugs; k6 capacity; CI minutes                            | issue tracker; k6 soak; billing                        | R5, weekly                  |

The running list of candidates for "the two decisions we would reverse" is in [ARCHITECTURE.md §14](ARCHITECTURE.md#14-two-decisions-we-would-reverse).

### A.4 Canonical decisions C1–C18

The records resolve into eighteen canonical decisions that every spec follows; their full text is in [stack-decisions.md §3.23](specs/15-decisions/stack-decisions.md) and a one-line index in [specs/README.md §3.9](specs/README.md). C1 identity · C2 threads · C3 syscall ABI · C4 client storage · C5 UUIDv7 ids · C6 transport · C7 database · C8 query layer · C9 server · C10 auth and security · C11 UI · C12 AI · C13 performance gates · C14 tooling and deployment · C15 roles · C16 the DSA rule · C17 services · C18 test naming.

### A.5 Disclosure (spec §18, DEC-08)

The first round of stack research (the option sets, criteria, weights, scores and much of the evidence above), the adversarial "examiner" reviews of each record, and the pilot prototypes in `docs/evidence/pilot/` were produced with AI assistance; the research inputs are kept in `docs/research/` and disclosed in [AI_USAGE.md](AI_USAGE.md). Because those scores existed before the team's pre-registration, they are **not** the team's decision matrix. Before the defence the team commits its own criteria and weights, re-measures the decisive numbers on the lab machine, and publishes the team matrix, the research matrix and the sensitivity table side by side, so that no criterion is reverse-engineered from a winner (spec §14.1, §18).
