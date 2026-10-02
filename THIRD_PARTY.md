# Third-party software

| Field        | Value                                                                                                                                                                                                                                                                    |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Owner        | R5 QA/DevOps (a new dependency needs a row here in the same pull request and R5's approval)                                                                                                                                                                              |
| Required by  | Capstone specification §18 ("Any third-party code or library must have a compatible licence and be listed in THIRD_PARTY.md. It may never stand in for a mandatory DSA structure (§10.2)"); SEC licence rule in [security-model.md](specs/12-security/security-model.md) |
| This version | 2026-09-25, drafted by Claude Code (see [AI_USAGE.md](AI_USAGE.md) row 9). R5 re-checks it with the commands in §9 before each gate.                                                                                                                                     |

## 1. Rules and how this list was checked

- **Mandatory data structures.** No package in this list provides the n-ary tree, trie, binary heap, DAG with Kahn's algorithm or LRU, or the extra-credit hash table, ring buffer, Bloom filter and z-order list, for those roles. They live in `dsa/`, which may import only relative modules and `@plotinium/protocol` types; the `dsa` scopes of `tools/eslint-rules/boundaries.js` fail the lint otherwise, including in tests and benchmarks (fixture `dsa-test-imports-npm-structure.ts`). The `dsa/` implementations are not third-party code, but they were written by an AI assistant: that is disclosed in [AI_USAGE.md §5](AI_USAGE.md), not here.
- **Transitive packages of the same kind.** The install tree contains `lru-cache` 11.5.3 (BlueOak-1.0.0, via `path-scurry`) and 5.1.1 (ISC, via Babel's `@babel/helper-compilation-targets`), `bintrees` 1.0.2 (MIT, via `tdigest`, which `prom-client` uses for summaries) and `yocto-queue` 0.1.0 (MIT, via `p-limit`). No workspace package imports any of them, and none is used for a graded role.
- **Versions** are pinned exactly in the `catalog:` of `pnpm-workspace.yaml` and in `pnpm-lock.yaml`; packages depend on `catalog:` or `workspace:*`.
- **Licences** were read on 2026-09-25 from the `license` field of each installed package (`node_modules/.pnpm/<name>@<version>/node_modules/<name>/package.json`). The packages already listed in the previous version of this file had been checked against the npm registry on 2026-09-24 (`npm view <package>@<version> license`), and the installed licences agree.
- **Compatibility.** Every licence below is permissive (MIT, ISC, Apache-2.0, BSD, 0BSD, BlueOak, PostgreSQL), a font licence (OFL-1.1), a data licence (CC-BY-4.0, for build-time browser data) or file-level copyleft (MPL-2.0, test and build tools only, unmodified). Nothing is GPL or AGPL in the application code or the shipped browser bundle. GPL-licensed system software exists only inside the base container images (§3) and the CI-only emulator image, as separate programs.

## 2. Installed packages (direct dependencies)

Every package named in a workspace `package.json`. "Declared in" is the workspace package (dev = `devDependencies`).

### 2.1 Runtime: browser

| Package                       | Version | Licence | Declared in       | Purpose                                                                                                          |
| ----------------------------- | ------- | ------- | ----------------- | ---------------------------------------------------------------------------------------------------------------- |
| `valibot`                     | 1.5.0   | MIT     | protocol, server  | Schemas for syscalls, errno, events, WebSocket protocol v1, op log and agent tools (shared by client and server) |
| `idb`                         | 8.0.3   | ISC     | vfs               | Promise helpers for read-only IndexedDB access; writes use our own synchronous `tx()` builder                    |
| `solid-js`                    | 1.9.15  | MIT     | ui, wm, apps, web | UI framework for the desktop shell, window chrome, login and app views                                           |
| `lucide-solid`                | 1.47.0  | ISC     | ui, wm, apps      | UI glyph icons (Lucide icon set)                                                                                 |
| `@xterm/xterm`                | 6.0.0   | MIT     | ui, wm, apps      | Terminal renderer, used as the TTY device only                                                                   |
| `@xterm/addon-fit`            | 0.11.0  | MIT     | ui, wm, apps      | Fits the terminal to its window                                                                                  |
| `@codemirror/view`            | 6.43.13 | MIT     | ui, wm, apps      | Text Editor view (lazy-loaded)                                                                                   |
| `@codemirror/state`           | 6.7.6   | MIT     | ui, wm, apps      | Text Editor state                                                                                                |
| `@codemirror/commands`        | 6.11.1  | MIT     | ui, wm, apps      | Text Editor key bindings and commands                                                                            |
| `@codemirror/language`        | 6.12.4  | MIT     | ui, wm, apps      | Text Editor language support                                                                                     |
| `@codemirror/lang-markdown`   | 6.5.2   | MIT     | ui, wm, apps      | Markdown highlighting                                                                                            |
| `@codemirror/lang-javascript` | 6.2.5   | MIT     | ui, wm, apps      | JavaScript and TypeScript highlighting                                                                           |
| `@codemirror/search`          | 6.7.2   | MIT     | ui, wm, apps      | Text Editor find and replace (Ctrl+F, UI-101)                                                                    |
| `workbox-precaching`          | 7.4.1   | MIT     | web               | Versioned shell cache in the hand-written Service Worker                                                         |
| `workbox-routing`             | 7.4.1   | MIT     | web               | Service Worker routing (`/api/*` and `/ws` network-only)                                                         |
| `workbox-window`              | 7.4.1   | MIT     | web               | Service Worker registration and the "restart to update" flow                                                     |

### 2.2 Fonts (self-hosted, no third-party font request)

Decision D15 ([docs/design/fonts/DECISION.md](docs/design/fonts/DECISION.md)). Only the two faces marked **shipped** reach the browser bundle: `ui/src/tokens/fonts.css` declares their Latin and Latin Extended files. The other font packages are still declared in `ui/package.json` because the D15 specimen page (`docs/design/fonts/specimen/`) reads them from `ui/node_modules`; they are candidates, not shipped, and can be removed from `ui/package.json` (with the lockfile) once the team no longer needs the specimen. Every one is under the SIL Open Font License 1.1.

| Package                                 | Version | Licence | Declared in | Shipped | Copyright (from the package `LICENSE`)    | Purpose                                                                                                                                                 |
| --------------------------------------- | ------- | ------- | ----------- | ------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@fontsource-variable/inter`            | 5.3.0   | OFL-1.1 | ui          | **yes** | 2016 The Inter Project Authors            | Inter 4 variable, opsz 14–32 + wght 100–900, Latin and Latin Extended: the UI typeface (`--pl-font-ui`)                                                 |
| `@fontsource-variable/jetbrains-mono`   | 5.3.0   | OFL-1.1 | ui          | **yes** | 2020 The JetBrains Mono Project Authors   | JetBrains Mono variable, wght 100–800, Latin and Latin Extended: the Terminal, Editor, paths and pids (`--pl-font-mono`; UI-004 replaced Geist Mono)    |
| `@fontsource-variable/geist-mono`       | 5.3.0   | OFL-1.1 | ui          | no      | 2024 The Geist Project Authors            | D15's first mono choice (shipped 2026-09-27 to 2026-09-30); dropped because it draws `r` like `ɪ` at 12–14 px on 1x screens (UI-004). Specimen only now |
| `@fontsource/jetbrains-mono`            | 5.3.0   | OFL-1.1 | ui          | no      | 2020 The JetBrains Mono Project Authors   | Static JetBrains Mono 400/500/700, shipped before D15; superseded by the variable package                                                               |
| `@fontsource-variable/geist`            | 5.3.0   | OFL-1.1 | ui          | no      | 2024 The Geist Project Authors            | D15 UI candidate (specimen only)                                                                                                                        |
| `@fontsource-variable/inter-tight`      | 5.3.0   | OFL-1.1 | ui          | no      | 2022 The Inter Project Authors            | D15 UI candidate (specimen only)                                                                                                                        |
| `@fontsource-variable/google-sans-flex` | 5.3.1   | OFL-1.1 | ui          | no      | 2015 Google LLC                           | D15 UI candidate (specimen only)                                                                                                                        |
| `@fontsource-variable/google-sans-code` | 5.3.1   | OFL-1.1 | ui          | no      | 2025 The Google Sans Code Project Authors | D15 mono candidate (specimen only)                                                                                                                      |

The SIL Open Font License 1.1 allows the fonts to be bundled with software as long as they are not sold on their own and the licence travels with them. The font files are used unmodified. Each package's `LICENSE` file must be shipped with the built web assets (for example as `/licenses/`), which is an open task for `web/` (§8).

### 2.3 Runtime: server

| Package                   | Version | Licence    | Declared in | Purpose                                                                                                       |
| ------------------------- | ------- | ---------- | ----------- | ------------------------------------------------------------------------------------------------------------- |
| `fastify`                 | 5.12.5  | MIT        | server      | HTTP API under `/api/*`                                                                                       |
| `@fastify/websocket`      | 11.3.1  | MIT        | server      | WebSocket route `/ws`                                                                                         |
| `@fastify/cookie`         | 11.1.2  | MIT        | server      | Session cookies                                                                                               |
| `ws`                      | 8.21.3  | MIT        | server      | WebSocket server implementation                                                                               |
| `pg`                      | 8.23.0  | MIT        | server      | PostgreSQL driver and pool                                                                                    |
| `kysely`                  | 0.29.6  | MIT        | server      | Type-safe SQL query builder (no ORM)                                                                          |
| `pgvector`                | 0.3.0   | MIT        | server      | Vector parameter serialisation for pgvector                                                                   |
| `pino`                    | 10.3.1  | MIT        | server      | Structured JSON logs                                                                                          |
| `prom-client`             | 15.1.3  | Apache-2.0 | server      | Internal `/metrics` endpoint                                                                                  |
| `@valibot/to-json-schema` | 1.8.0   | MIT        | server      | Strict JSON Schemas for the LLM tools, generated from the Valibot schemas                                     |
| `@anthropic-ai/sdk`       | 0.128.0 | MIT        | server      | Claude API client inside the server-side LLM gateway (`server/src/engine/llm/`)                               |
| `dbmate`                  | 2.36.0  | MIT        | server      | SQL migrations with up and down, run by the app container's entrypoint; ships the `@dbmate/<platform>` binary |

### 2.4 Build and development

| Package                                           | Version | Licence    | Declared in         | Purpose                                                                               |
| ------------------------------------------------- | ------- | ---------- | ------------------- | ------------------------------------------------------------------------------------- |
| `vite`                                            | 8.3.0   | MIT        | root, ui, web (dev) | Build tool and dev server (`web/`, the `ui/` gallery); also the Vitest runtime        |
| `vite-plugin-solid`                               | 2.11.14 | MIT        | ui, web (dev)       | Solid JSX compilation                                                                 |
| `vite-plugin-pwa`                                 | 1.3.0   | MIT        | web (dev)           | `injectManifest` precache list and web app manifest                                   |
| `kysely-codegen`                                  | 0.20.0  | MIT        | server (dev)        | Generates database table types; `--verify` in CI                                      |
| `@types/pg`                                       | 8.23.1  | MIT        | server (dev)        | Types for `pg`                                                                        |
| `@types/ws`                                       | 8.18.1  | MIT        | server (dev)        | Types for `ws`                                                                        |
| `typescript` (alias of `@typescript/typescript6`) | 6.0.2   | Apache-2.0 | root (dev)          | TypeScript 6 API for typescript-eslint and editors (`tsc6`)                           |
| `@typescript/native` (alias of `typescript`)      | 7.0.2   | Apache-2.0 | root (dev)          | TypeScript 7, the type-check gate (`tsc`)                                             |
| `@types/node`                                     | 24.13.6 | MIT        | root (dev)          | Node.js 24 types (server, db, tools, tests)                                           |
| `@types/estree`                                   | 1.0.9   | MIT        | root (dev)          | AST types for the JSDoc-typed local ESLint rules                                      |
| `eslint`                                          | 10.11.0 | MIT        | root (dev)          | Linter                                                                                |
| `@eslint/js`                                      | 10.0.1  | MIT        | root (dev)          | ESLint recommended rules                                                              |
| `typescript-eslint`                               | 8.70.1  | MIT        | root (dev)          | TypeScript parser and rules, including `no-restricted-imports` with type-only imports |
| `eslint-plugin-solid`                             | 0.18.0  | MIT        | root (dev)          | Solid reactivity rules (all raised to errors)                                         |
| `globals`                                         | 17.12.0 | MIT        | root (dev)          | Global-variable sets for the Node scripts in the ESLint config                        |
| `prettier`                                        | 3.9.9   | MIT        | root (dev)          | Code formatter                                                                        |
| `pnpm` (package manager, `packageManager` field)  | 12.5.1  | MIT        | root                | Workspace package manager; also installed in the image build stage                    |

### 2.5 Testing

| Package                    | Version | Licence    | Declared in | Purpose                                                                                          |
| -------------------------- | ------- | ---------- | ----------- | ------------------------------------------------------------------------------------------------ |
| `vitest`                   | 5.0.1   | MIT        | root (dev)  | Unit, integration and benchmark runner (bundles Tinybench)                                       |
| `@vitest/coverage-v8`      | 5.0.1   | MIT        | root (dev)  | V8 coverage with per-package thresholds                                                          |
| `fast-check`               | 4.10.2  | MIT        | root (dev)  | Property-based and model-based tests                                                             |
| `@playwright/test`         | 1.63.0  | Apache-2.0 | root (dev)  | End-to-end tests on Chrome stable (brings `playwright` and `playwright-core` 1.63.0, Apache-2.0) |
| `@solidjs/testing-library` | 0.8.10  | MIT        | ui (dev)    | Component tests of the `ui/` library (brings `@testing-library/dom` 10.4.2, MIT)                 |
| `happy-dom`                | 20.14.5 | MIT        | ui (dev)    | DOM implementation for the `ui/` component tests in Vitest                                       |
| `@axe-core/playwright`     | 4.13.0  | MPL-2.0    | root (dev)  | Accessibility checks in both themes (`tests/a11y`); brings `axe-core` 4.13.0, MPL-2.0            |

**MPL-2.0 note.** `@axe-core/playwright` and `axe-core` are file-level copyleft. They run only in the test suite, are used unmodified and are never shipped in the product. If a file of either is ever modified, that file's source must be published under MPL-2.0. (`lightningcss` 1.33.0, a build-time CSS tool used by Vite, is also MPL-2.0 and transitive; the same note applies.)

## 3. Container images and binaries

The three shipped images (`ghcr.io/plotinium-org/plotinium-{web,app,db}`) are built by the one multi-stage `Dockerfile` from the base images below, pinned by digest (resolved 2026-09-24). Each base image also carries the packages of its Linux distribution (Debian trixie or Alpine) under their own licences, some of them GPL. They are separate programs in the image, not linked into our code; the release workflow's SBOMs (`release.yml`, attached to each GitHub Release) list them.

| Image or binary                                            | Tag and digest                                                                              | Licence                                                                                | Where                                                        | Purpose                                                                                   |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| Node.js (`docker.io/library/node`)                         | `24-trixie-slim@sha256:8ec5d7557396cfe32d21c3f9c13072355ceab22b584578ca4bb28af31120cffe`    | MIT (Node.js; bundled OpenSSL 3.5.x is Apache-2.0); Debian packages                    | `Dockerfile` stages `deps`, `app-deps`, `app`, `build`       | Server runtime (one process: migrations, seed, Fastify) and the build stage               |
| Caddy (`docker.io/library/caddy`)                          | `2.11.4-alpine@sha256:6aeddd44c3078b0f9a35206472a11420648a79c184603ef95957d0a20044cb2b`     | Apache-2.0; Alpine packages                                                            | `Dockerfile` stage `web`, `Caddyfile`                        | Static shell, reverse proxy to `/api` and `/ws`, every security header, TLS in production |
| PostgreSQL with pgvector (`docker.io/pgvector/pgvector`)   | `0.8.6-pg18-trixie@sha256:78bf48b801e792f99e3ac62b5036fd3876e9be48afda16c1e331af1c75ceb2ff` | PostgreSQL Licence (PostgreSQL 18.6 and the pgvector 0.8.6 extension); Debian packages | `Dockerfile` stage `db`, `ops/db/entrypoint.sh`              | Database, vectors, first-start password generation                                        |
| dbmate binary (`@dbmate/linux-x64`, `@dbmate/linux-arm64`) | 2.36.0 (from the `dbmate` npm package, §2.3)                                                | MIT                                                                                    | inside the `app` image, run by `server/docker-entrypoint.sh` | Applies `db/migrations` before the server starts. No separate dbmate image is used.       |
| BuildKit (`moby/buildkit`)                                 | `v0.32.2@sha256:28a898719c18a33f4e8000685287fa36fd0dd9560c6440227d3a732d79bb41d8`           | Apache-2.0                                                                             | CI only (`release.yml`)                                      | Multi-architecture image builds                                                           |
| binfmt (`docker.io/tonistiigi/binfmt`)                     | `qemu-v10.2.3@sha256:400a4873b838d1b89194d982c45e5fb3cda4593fbfd7e08a02e76b03b21166f0`      | MIT (the tool); it installs QEMU user-mode emulators, GPL-2.0                          | CI only (`release.yml`)                                      | arm64 emulation for the multi-architecture build; never shipped                           |

## 4. GitHub Actions (CI only, never shipped)

Pinned by commit SHA in `.github/workflows/`.

| Action                       | Version | Licence    | Purpose                                        |
| ---------------------------- | ------- | ---------- | ---------------------------------------------- |
| `actions/checkout`           | v7.0.1  | MIT        | Check out the repository                       |
| `actions/setup-node`         | v7.0.0  | MIT        | Node.js from `.node-version` (and Node 26 job) |
| `actions/upload-artifact`    | v7.0.1  | MIT        | Upload reports, traces and evidence            |
| `actions/download-artifact`  | v8.0.1  | MIT        | Pass artifacts between jobs                    |
| `pnpm/action-setup`          | v6.1.0  | MIT        | Install pnpm                                   |
| `docker/setup-buildx-action` | v4.4.1  | Apache-2.0 | Buildx builder                                 |
| `docker/setup-qemu-action`   | v4.4.0  | Apache-2.0 | QEMU for the arm64 build                       |
| `docker/build-push-action`   | v7.4.0  | Apache-2.0 | Build and push the images by digest            |

## 5. Code adapted from third parties

| Source                                                                                      | Licence                                                                                                                                 | Where in Plotinium                                                                                           | What was taken                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lucia, single-file session reference `code/auth_session.ts` (the Lucia project, lucia-auth) | 0BSD (the file-level licence in the Lucia repository's `code/LICENSE`); no attribution is legally required, and it is given here anyway | `server/src/gateway/tokens.ts`; the session flow in `server/src/gateway/sessions.ts` follows the same design | The opaque `<id>.<secret>` token design: a random id and secret, only `SHA-256(secret)` stored, constant-time comparison, sliding expiry. Adapted, not copied: Node's `Buffer` base64url instead of `Uint8Array.fromBase64`, lowercase base32 ids, Kysely storage, our cookie and CSRF rules ([backend-api §3.8.1](specs/11-server/backend-api.md)). |

**Published algorithms implemented from their descriptions** (no third-party code; cited so the provenance is clear): SHA-256 from FIPS 180-4 (`protocol/src/sha256.ts`, checked against `node:crypto`); the mulberry32 PRNG, a public-domain algorithm by Tommy Ettinger (`dsa/src/_shared/prng.ts`, tests and benchmarks only); Fibonacci hashing and linear-probing analysis (Knuth, TAOCP vol. 3 §6.4, `dsa/src/hashtable/`); double hashing for Bloom filters (Kirsch and Mitzenmacher, ESA 2006, `dsa/src/bloom/`); Kahn's topological sort (1962, `dsa/src/dag/`); BM25 ranking (Robertson and Zaragoza, `ai/src/search/bm25.ts`); Witten-Bell smoothing for the Markov predictor (`ai/src/predictor/`). The `dsa/` code itself was written by an AI assistant: see [AI_USAGE.md §5](AI_USAGE.md).

## 6. Design sources and brand assets

- **Google Stitch** (Google Labs), project `12849137298552292712`: the two design systems Plotinium Glass Dark (`assets/10121591451242352758`) and Plotinium Glass Light (`assets/3690503530025860907`) were generated in Stitch on 2026-09-24 and used under Google's terms of service for Stitch. **No Stitch-generated screen or code is in the repository or the product**: every screen request timed out or returned only a session id (`docs/design/stitch/*/screen.json`). The `reference.html` and `reference.png` files in `docs/design/stitch/` are hand-built renders written by Claude Code, and the colours, radii and blur values in `ui/src/tokens/tokens.css` were taken from them and from the two design systems ([AI_USAGE.md](AI_USAGE.md) rows 3 and 6).
- **Icons.** UI glyphs come from Lucide through `lucide-solid` (ISC, §2.1). The Plotinium logo, the "Bohr P" (`ui/src/icons/atom-logo.ts`, `ui/src/boot/logo.ts`, `docs/identity/`; record: [docs/design/logo/DECISION.md](docs/design/logo/DECISION.md)), and the app icons (`ui/src/icons/app-icons.ts`) are original SVG written for this project (AI-drafted, [AI_USAGE.md](AI_USAGE.md)); they are not derived from any third-party mark.
- **macOS-inspired, not Apple's.** Plotinium borrows a design language, not a brand ([visual-language-macos §3.2](specs/05-wm/visual-language-macos.md), DSN-22): no Apple logo, no SF Pro, SF Mono or New York fonts, no SF Symbols, no Apple wallpapers or icon replicas, and no Apple product names in UI strings. "macOS" and "Liquid Glass" appear only descriptively in documents. Wallpapers are generated CSS gradients.
- **Typefaces**: Inter and JetBrains Mono (§2.2).

## 7. Third-party files kept as evidence (`docs/evidence/pilot/`; never built, installed or shipped)

The pilot prototypes (AI-written, [AI_USAGE.md](AI_USAGE.md) row 1) are excluded from the workspace, the build, lint and coverage, and an ESLint rule rejects imports of them. They contain these third-party files:

| Files                                                                                | Origin and licence                                                                                                                                                      | Why they are there                                                                             |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `embbench/models/MongoDB/mdbr-leaf-ir/` (tokenizer and config JSON)                  | MongoDB/mdbr-leaf-ir, Apache-2.0                                                                                                                                        | Embedding-model benchmark (the primary model chosen for Phase 4)                               |
| `embbench/models/Snowflake/snowflake-arctic-embed-xs/` (tokenizer and config JSON)   | Snowflake/snowflake-arctic-embed-xs, Apache-2.0                                                                                                                         | Embedding-model benchmark (a compared option)                                                  |
| `embbench/models/Xenova/bge-small-en-v1.5/` (tokenizer and config JSON)              | Xenova/bge-small-en-v1.5 (ONNX export of BAAI/bge-small-en-v1.5), MIT                                                                                                   | Embedding-model benchmark (the fallback model)                                                 |
| `embbench/code50k.txt`                                                               | about 1,600 lines of JavaScript concatenated from installed npm packages; it contains protobufjs source (BSD-3-Clause). The full list of source files was not recorded. | Benchmark input for code-like text. **R4 records the sources or deletes the file.**            |
| `embbench/doc50k.txt`, `prose50k.txt`, `spec.txt`, `spec_plain.txt`, `exam/spec.txt` | Text of the capstone specification (Lahore Garrison University, Department of Computer Science)                                                                         | Benchmark input for prose; the Department's document, not redistributed beyond this repository |
| `exam/kc/package/` (`package.json`, `README.md`, config files)                       | kysely-codegen 0.20.0, MIT, by Robin Blomberg                                                                                                                           | Examiner check of the codegen tool                                                             |
| `exam/dm/package/` (`package.json`, `README.md`)                                     | dbmate 2.36.0, MIT                                                                                                                                                      | Examiner check of the migration tool                                                           |

The pilot folders also have their own `package.json` manifests, which were installed only in the AI-run pilot environment on 2026-09-23 and are **not installed** in this workspace: among others React, Vue, Svelte, Lit, Preact, Automerge, Yjs, Socket.IO, msgpackr, Zod, ArkType, TypeBox, Dexie, SQLite WASM, Drizzle ORM, postgres.js, Monaco Editor, `@huggingface/transformers`, WABT and esbuild (all MIT, Apache-2.0 or BSD at the pinned versions). None of them is a Plotinium dependency.

## 8. Planned (not installed yet)

| Package or asset                                                                       | Version            | Licence    | Purpose                                                                    | When                         |
| -------------------------------------------------------------------------------------- | ------------------ | ---------- | -------------------------------------------------------------------------- | ---------------------------- |
| `@huggingface/transformers`                                                            | 4.3.0              | Apache-2.0 | Tokenizer and ONNX inference for embeddings in the `ai.embed` worker       | Phase 4                      |
| `onnxruntime-web` (transitive, self-hosted under `/ort`)                               | pinned by lockfile | MIT        | WASM inference runtime                                                     | Phase 4                      |
| MongoDB/mdbr-leaf-ir weights (revision 4262131b, q8 ONNX), self-hosted under `/models` | –                  | Apache-2.0 | Primary embedding model                                                    | Phase 4                      |
| Xenova/bge-small-en-v1.5 weights (q8)                                                  | –                  | MIT        | Fallback embedding model                                                   | Phase 4                      |
| `@vitest/browser-playwright`                                                           | 5.0.1              | MIT        | Vitest browser project on real Chrome                                      | with the first browser suite |
| Font and icon licence notices in the web build (`/licenses/`)                          | –                  | –          | Ship the OFL-1.1 texts (§2.2) and the ISC notice of Lucide with the bundle | before `v0.2.0`              |

## 9. Transitive dependencies and how to re-check

On 2026-09-25 the installed store (`node_modules/.pnpm`) held **648 package versions (620 distinct names)**, direct dependencies included, with these licences: MIT 551, Apache-2.0 29, ISC 26, BSD-2-Clause 14, BSD-3-Clause 10, BlueOak-1.0.0 8, MPL-2.0 4 (`axe-core`, `@axe-core/playwright`, `lightningcss` and its Linux binary; test and build tools), OFL-1.1 2 (the fonts), Python-2.0 1 (`argparse`), CC-BY-4.0 1 (`caniuse-lite`, browser data used at build time), Unlicense 1 (`fast-sha256`) and `(MIT OR CC0-1.0)` 1 (`type-fest`). No package was GPL, AGPL or without a licence.

Re-check before each gate (R5):

```sh
pnpm licenses list --json > /tmp/licences.json    # every installed package with its licence
pnpm licenses list --prod                          # the production closure only
pnpm exec eslint dsa --max-warnings 0             # no package stands in for a dsa/ structure
```

CI fails on an unknown, GPL or AGPL licence in the shipped bundle, and on a package in the lockfile that has no row here, once the licence scan of [security-model.md](specs/12-security/security-model.md) lands.
