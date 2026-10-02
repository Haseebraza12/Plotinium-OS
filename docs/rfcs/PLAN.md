# Wave 3 build plan (Workflow B)

| Field  | Value                                                                                                                                                                                                                                                                                                                                        |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status | **Approved** by the Architecture Review Board (ARB), 2026-09-30, acting for the tech lead                                                                                                                                                                                                                                                    |
| Inputs | RFCs [0001](0001-google-drive-volume.md) to [0006](0006-leases-fencing-and-glass-legibility.md); reviews [security-privacy](reviews/security-privacy.md) and [architecture](reviews/architecture.md); [docs/research/google-drive-integration.md](../research/google-drive-integration.md); `specs/`; `CLAUDE.md`; the code as of 2026-09-30 |
| Scope  | What Workflow B builds, who owns every file, the contracts between builders, how the work is verified, and the final gate                                                                                                                                                                                                                    |
| Rule   | A builder builds exactly the scope and paths below. Any other change is a handoff (§2.3). Where this plan and an RFC differ, **this plan wins**, and the RFC's §17 says why.                                                                                                                                                                 |

## 0. Summary

**Priority order** (the lead's): Google Drive > agent safety > semantic FS > predictive cache > LLM runtime > platform.

- **Six RFCs, all approved with cuts.** The review changes are applied in each RFC's text, and every finding has a written decision in that RFC's §17:
  - **Google Drive** (RFC 0001) is built as **P1-thin**. P1b needs its own approval, P2 is blocked on a follow-up design, and P3 is deferred.
  - **Agent safety** (0002) is built at P0.
  - **Semantic FS** (0003) is built at P0, without the sidebar; `/mnt/smart` is rejected.
  - **Predictive cache** (0004) is built at P0, with pseudonymised export added and the hoard advisor cut.
  - **LLM runtime** (0005) is built at P0.
  - **Platform** (0006) is cut to the fence plumbing of part (a); parts (b) and (c) are deferred.
- **Eight builders.** `platform` becomes the wave's **integrator**: it owns every shared registry and lands one step-0 contract PR before anyone integrates. The other seven builders own disjoint paths.
- **About half of the roster verifies** (§7): 8 reviewers, a red team, 3 QA agents, 3 verifiers, fixers and a final gate. The red team writes the evaluation datasets **before** the builders who are scored on them start.
- **Google Drive is tested end to end on the QA copy** (:4718) against the hermetic fake Google (§7.3). Nothing in Workflow B calls Google.
- **No new dependencies** (§11).

## 1. Verdicts

| RFC                   | Verdict                | Built in Workflow B                                                                                                                                                                                                                                                                                                                                                                   | Cut, deferred or blocked                                                                                                                                                                                                                    |
| --------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0001 Google Drive     | **APPROVED-WITH-CUTS** | P1-thin (RFC 0001 §13.0): connect and disconnect; per-uid namespace; `readdir`, `stat`, whole-file `open(r)`/`read` ≤ 8 MiB; `writeFile` ≤ 5 MiB with conflicted copies; `mkdir`, rename, trash; EXDEV and `mv` fallback; single-file `copy` across the boundary; `df`; walkers stay on one fs; Settings › Internet Accounts; the Files Drive row; the callback page; the fake Google | P1b: descriptor writes (committed at `close`, with a device-local failure store), Eject, exports, `.Trash`, ranged reads, the changes feed, content caching. P2 (agent access): blocked on an observation-confirmation design. P3: deferred |
| 0002 Agent safety     | **APPROVED-WITH-CUTS** | P0: provenance labels (whole-token `U`), the policy table, reader sets, effect classes, narrowed `fsScope`, fail-closed EINVAL, harness fidelity, and the AgentDojo-style runner over red-team cases                                                                                                                                                                                  | Live model runs (need an evaluation rate class); P1 (typed confirmation, undo coverage); P2 (`ai undo`). The product path waits for R1's kernel TTY                                                                                         |
| 0003 Semantic FS      | **APPROVED-WITH-CUTS** | P0 items 1 to 6: relation graph, `ai.related`, the cooperative context stage, the evaluation over a frozen dataset, the Inspector's Related group, and Smart Folder definitions with the `smart` command                                                                                                                                                                              | Files sidebar section (P1); `/mnt/smart` **rejected** for Wave 3                                                                                                                                                                            |
| 0004 Predictive cache | **APPROVED-WITH-CUTS** | P0: the access stream (`fs: 'root'` only; demo and guest paused by default), `ai.access.export` with pseudonymisation, the LRU content cache with the no-fetch pre-fetch, `mem.prefetch({ino})`, the file model, shadow-mode pre-fetch, the simulator, `predict --files/--cache/--export-files`                                                                                       | The hoard advisor (to RFC 0001 P3); ring persistence, Settings and Task Manager UI (P1). The enable gate is decided on real traces before the P3 gate                                                                                       |
| 0005 LLM runtime      | **APPROVED-WITH-CUTS** | P0: the kernel LLM arbiter (deadline- and offline-aware), `llm.stat` (caller-only gate rows), `llmq`, `llm.context`, and a bench with an integration arm against the real gateway                                                                                                                                                                                                     | P1 (Task Manager card, fake provider, context notice, snapshot and restore); P2 (memory). The in-product demo waits for R1's kernel TTY                                                                                                     |
| 0006 Leases and glass | **APPROVED-WITH-CUTS** | Part (a): fence plumbing through `LockdEngine`, the `sync.fenceWrites` sysctl and the SYN-19 tests (all in step 0); the SYN-21 zombie tests as a stretch goal                                                                                                                                                                                                                         | SYN-20 (ε suspect), the frozen-holder E2E, lock metrics; parts (b) adaptive glass and (c) Dock motion **deferred** (design accepted with the review changes)                                                                                |

**Decisions that span RFCs** (architecture review §8; security review S-0001-14):

| Id  | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| X1  | **`platform` is the integrator.** It lands one step-0 contract PR (§3) of about 4 hours, with a green gate, and owns every shared registry for the whole wave (§2.2).                                                                                                                                                                                                                                                                                                      |
| X2  | **The agent pipeline does not run in the product.** The shipped Terminal uses its view-side host, which cannot spawn `ai-agent`, and a view cannot call `ai.agent.plan`. The fix is R1's kernel TTY and process path (the Terminal's "normative path", `apps/terminal/session.ts:1-13`). It is **not in Workflow B** (open question Q2). RFCs 0002 and 0005 are evaluated and demonstrated in the harness and in composed-kernel tests, and their evidence is labelled so. |
| X3  | **One kernel content cache.** Drive uses RFC 0004's `ContentCache` in P1b; P1-thin has no Drive content cache at all.                                                                                                                                                                                                                                                                                                                                                      |
| X4  | **`FsAccess` in `kernel/src/core/hooks/index.ts` is the only access-tap contract.** In Wave 3 only `fs: 'root'` events are recorded, so no Drive-derived data reaches any AI structure. The purge seam `hooks.volumePurge(uid, fs)` is a precondition for admitting remote events later (RFC 0001 §7.3).                                                                                                                                                                   |
| X5  | **Ownership instead of generic extension points.** In Wave 3 only `gdrive-ui` edits the Files sidebar, the Settings pane list and `apps/src/descriptor.ts`. The one cross-builder Files hook, the Inspector's Related group, is plumbed in step 0.                                                                                                                                                                                                                         |
| X6  | **Every test row names a real command** (§5). The projects `ai-eval`, `bench`, `litmus` and `browser` do not exist; `*.bench.ts` files run with `pnpm bench`, and AI-off checks are composed-kernel tests.                                                                                                                                                                                                                                                                 |
| X7  | **No kernel-worker task may run longer than 8 ms.** Chunk the work and yield (RFC 0001 listings, the RFC 0003 context stage).                                                                                                                                                                                                                                                                                                                                              |
| X8  | **The QA listener records `e.disposition`**, and the gate counts only violations with disposition `enforce`. The report-only Trusted Types sink (`Caddyfile:21`) is tracked by the stabilize track.                                                                                                                                                                                                                                                                        |
| X9  | **One migration in Wave 3**, and every spec edit goes through `platform`, which owns `specs/**` (§2.2).                                                                                                                                                                                                                                                                                                                                                                    |
| X10 | **Every builder's first step is to re-verify its RFC's §2 citations** against the post-close-out tree, citing symbols as well as lines.                                                                                                                                                                                                                                                                                                                                    |

## 2. Wave-wide rules

### 2.1 Before Workflow B starts (lead tasks)

| Id  | Task                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Blocks                                     |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| L-1 | The stabilize track's close-out is finished and green. Workflow B starts from that tree.                                                                                                                                                                                                                                                                                                                                                                                                                                                  | everything                                 |
| L-2 | **QA override for the fake Google.** Add to the `app` service in `qa-override.yaml`, outside the repository: `GDRIVE=auto`, `GOOGLE_OAUTH_CLIENT_ID=fake-client-qa`, `GOOGLE_OAUTH_CLIENT_SECRET_FILE` and `DRIVE_TOKEN_KEK_FILE`, both mounted read-only from `~/.config/plotinium/secrets/qa/` (0600 files; the KEK from `openssl rand -base64 32`), `GDRIVE_GOOGLE_BASE_URL=http://127.0.0.1:4799`, `GDRIVE_FAKE_LISTEN=0.0.0.0:4799`, and publish `127.0.0.1:4799:4799`. The variables are inert until `gdrive-server`'s code exists. | the Drive E2E (Q-GD-*)                     |
| L-3 | **ADRs.** Write `docs/adr/0001-google-drive-volume.md` from RFC 0001, and one ADR for the Wave-3 ABI additions (13 calls, `ABI_VERSION` 2) and the AI RFCs. If the specs are Frozen, request the instructor's approval (Q1).                                                                                                                                                                                                                                                                                                              | step 0's spec rows and `platform`'s doc PR |
| L-4 | Confirm whether the specs are Frozen (`specs/README.md` §3.6; every header says "Draft v0.1").                                                                                                                                                                                                                                                                                                                                                                                                                                            | L-3                                        |
| L-5 | Take a fresh **Workflow-B baseline snapshot** of the tree, so the ownership audit can diff against it.                                                                                                                                                                                                                                                                                                                                                                                                                                    | the gate                                   |
| L-6 | Update the QA README's CSP listener to record `disposition` (X8).                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | QA                                         |
| L-7 | Do not add dependencies (§11).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | –                                          |

### 2.2 The shared registries and their one owner

| Shared registry            | Files                                                                                                                                                                                                                                                                               | Owner for all of Workflow B                                              | How others change it                     |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------- |
| Protocol syscall tables    | `protocol/src/sys/registry.ts`, `protocol/src/sys/names.ts`, `protocol/src/index.ts`, `protocol/src/events.ts`, `protocol/src/errno.ts`, `protocol/src/abi.ts`, `protocol/src/sys/{common,fs}.ts`, `protocol/src/ai/{agent,rag}.ts`, the five new schema files, `protocol/tests/**` | `platform`                                                               | handoff                                  |
| Syscall spec rows (ABI-11) | `specs/01-architecture/syscall-abi.md`                                                                                                                                                                                                                                              | `platform` (same change as the registry)                                 | handoff                                  |
| Kernel service wiring      | `kernel/src/core/kernel.ts`, `kernel/src/core/io/{index,vfs,mm}.ts`, `kernel/src/core/hooks/index.ts`, `kernel/src/core/fs/kfs.ts`, `kernel/src/core/proc/{system,pcb}.ts`, `kernel/src/core/events/bus.ts`, `kernel/src/core/net/{engines,factory}.ts`                             | `platform`                                                               | handoff                                  |
| AI install and composition | `ai/src/hooks.ts`, `ai/src/kernel/{install,types,index,link}.ts`, `ai/src/programs/index.ts`, `web/src/kernel/ai-link.ts`                                                                                                                                                           | `platform`                                                               | handoff                                  |
| Coreutils command registry | `apps/coreutils/index.ts`; the generated `apps/coreutils/lib/argspec.gen.ts` (only `platform` runs `node apps/coreutils/scripts/gen-argspec.mjs`)                                                                                                                                   | `platform`                                                               | handoff ("regenerate argspec")           |
| Server route registration  | `server/src/app.ts` (and `server/src/config.ts`, `server/src/ratelimit/classes.ts`, `server/src/obs/*`)                                                                                                                                                                             | `gdrive-server` (the only Wave-3 route author)                           | handoff                                  |
| DB migrations              | `db/migrations/**`, `db/schema.sql`, `server/src/db/types.gen.ts`                                                                                                                                                                                                                   | `gdrive-server` (the only Wave-3 migration)                              | handoff                                  |
| Settings pane list         | `ui/src/apps/settings/{sections.ts,models.ts,SettingsView.tsx}`                                                                                                                                                                                                                     | `gdrive-ui` (the only Wave-3 Settings author)                            | handoff                                  |
| Files sidebar              | `ui/src/apps/files/{FilesSidebar.tsx,types.ts,FilesView.tsx}`, `ui/src/primitives/sidebar/SidebarList.tsx`, `apps/files/lib/{controller,model}.ts`, `apps/files/view.tsx`                                                                                                           | `gdrive-ui` (after step 0 plumbs the Related hook)                       | handoff                                  |
| specs                      | `specs/**`                                                                                                                                                                                                                                                                          | `platform`: step 0 for the ABI rows; the end-of-wave doc PR for the rest | handoff (each builder supplies text, §5) |
| CHANGELOG                  | `CHANGELOG.md`                                                                                                                                                                                                                                                                      | `platform` (the ABI entry in step 0, the Wave-3 entries at the end)      | handoff                                  |
| Other shared docs          | `AI_USAGE.md`, `SECURITY.md`, `tools/traceability/ids.ts`                                                                                                                                                                                                                           | `platform`                                                               | handoff                                  |

The architecture review's ownership map (§8.3) differs from this table in two ways, both deliberate:

- **`specs/**`, `CHANGELOG.md`, `AI_USAGE.md` and `SECURITY.md`** go to `platform`, not the lead. Every shared registry then has one Workflow-B owner, the doc work is part of the wave's gate, and the lead keeps only the ADRs (`docs/adr/**`).
- **The Files app's `controller.ts` and `model.ts`** go to `gdrive-ui`, not `semantic-fs`. The Drive row needs them in this wave, the Smart Folders sidebar is P1, and step 0 plumbs the one hook that `semantic-fs` needs.

### 2.3 Ownership and handoffs

1. **One owner per file** for the whole of Workflow B. The owned-path lists in §5 are disjoint. The verifier checks this against the L-5 snapshot.
2. **Step-0 exception.** `platform`'s step-0 PR may create or edit the files listed in §3.3, which pass to their named owner once step 0 lands. After that, only the owner edits them.
3. **A handoff** is a line in the requester's report, and a message in `docs/design/wave3/<requester>/handoffs.md`, of the form: `file · exact change · why · blocking? (yes/no)`. `platform` applies registry and wiring handoffs within its session and logs them in `docs/design/wave3/platform/handoffs.md`. A blocking handoff that is not applied within about 30 minutes goes to the lead.
4. **No builder edits a protocol, spec, wiring or registry file**, even "just one line". Tests may import freely within the package boundaries.
5. **Fixers** (§7.5) inherit a builder's owned paths once that builder has reported. They never write outside them.

### 2.4 Engineering rules for every builder

- **Hard rules:** never touch :4717; use QA only through `qa-compose.sh`; never run `pnpm install`, `pnpm add` or `pnpm update`, and never edit a lockfile; never commit a secret; write only inside your ownership.
- **Code:** strict TypeScript with no `any`; test titles start with the requirement ID; package boundaries hold (`tools/eslint-rules/boundaries.js`); strict CSP, so no static `style={{…}}` and no runtime `<style>`; WCAG 2.2 AA; animate only `transform` and `opacity`; honour reduced motion; `dsa/` structures only, never a library in their place; no kernel-worker task over 8 ms (X7).
- **Checks before reporting:**
  - `pnpm exec tsc -p <pkg>/tsconfig.json --noEmit`;
  - `pnpm exec vitest run --project <pkg> <files>`, kept scoped, because up to 10 agents share 12 CPUs;
  - `pnpm exec eslint <paths> --max-warnings 0`;
  - `pnpm exec prettier --check <paths>`.
- **UI work** is verified on :4718 with 0 enforced CSP violations. Screenshots go under `docs/design/wave3/<key>/` and are read.
- **Evidence files:** `docs/evidence/ai-eval/wave3/{agentdojo,ctx,cache,llmq}.json`, one per builder, in the `EvalReport` shape.
- **Honest reports:** exact commands and outcomes, what was **not** finished, the handoffs, and the spec text supplied.

## 3. Step 0: the contract PR (`platform`)

`platform` lands step 0 on the post-close-out tree before any builder integrates. The RFCs contain the exact schemas; this is mostly careful transcription with the ARB's trims.

### 3.1 Step 0a (at most 45 minutes; unblocks new-file work)

New protocol files, verbatim from the RFCs as the ARB trimmed them, exported from `protocol/src/index.ts`, with `protocol/tests/wave3-schemas.test.ts` (round trips and strictness):

| File                        | Contents (source)                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `protocol/src/drive-api.ts` | RFC 0001 §5.5, **P1-thin subset**: `DRIVE_CONSENT_VERSION`, `ConsentVersion`, `DriveId`, `PageToken`, `AttemptId`, `LaunchUrl`, `DriveReason`, `DriveScope` (`openid`, `drive.file`), `DriveStatus`, `DriveStartReq/Res`, `DriveCompleteReq/Res`, `DriveDisconnectRes`, `RemoteKind`, `RemoteEntry`, `ChildrenPage`, `PutResult`, `StaleDetail`, `CreateReq`, `PatchReq`, `DriveConnectMessage`. No `ChangesPage`, `ChangesCursor` or `DriveOptinReq`. |
| `protocol/src/sys/mnt.ts`   | RFC 0001 §5.4: `MountFs`, `MountState` (without `ejected`), `MountInfo`, `MountListArgs/Ret`, `DriveStatusArgs/Ret`, `DriveConnectArgs/Ret`, `DriveDisconnectArgs/Ret`; the `mount.state` and `mount.change` payload schemas.                                                                                                                                                                                                                          |
| `protocol/src/ai/access.ts` | RFC 0004 §5.1.2 to §5.4: `FileAccessEvent`, `ExportedAccessEvent` (ARB), `AccessReadArgs/Ret`, `AccessStatusArgs/Ret`, `AccessClearArgs/Ret`, `AccessPauseArgs/Ret`, `AccessExportArgs/Ret`, `FilePrediction`, `PredictFilesPublishArgs/Ret`, `PredictFilesArgs/Ret`.                                                                                                                                                                                  |
| `protocol/src/ai/semfs.ts`  | RFC 0003 §5.4: `RelatedArgs`, `RelatedRet`.                                                                                                                                                                                                                                                                                                                                                                                                            |
| `protocol/src/sys/llm.ts`   | RFC 0005 §5.7: `LlmStatArgs`, `LlmStatRet`, plus `fallbacks: Count` (ARB, S-0005-02); gate rows are the caller's only.                                                                                                                                                                                                                                                                                                                                 |

`platform` announces "0a landed". Builders may then start on the new files they own.

### 3.2 Step 0b (about 3 hours), then the green gate

**Protocol and ABI**

1. `names.ts` and `registry.ts`: add the 13 calls of C-02 and the call groups `mnt` and `llm`. The catalogue count goes from 119 to **132**.
2. `events.ts`: add the `mount.state` and `mount.change` topics.
3. `errno.ts`: register the reasons.
   - P1-thin Drive: RFC 0001 §5.7 minus the P1b and P2 reasons.
   - Agent safety: `untrusted-target`, `untrusted-flow`, `text-not-in-request` and `policy-error`.
4. `sys/common.ts`: `Stat.fs` gains `'gdrive'`. `sys/fs.ts`: `StatFs.fsId` becomes `['plotinium', 'gdrive']`.
5. `ai/agent.ts`: `ConfirmReason` gains `untrusted-target`, `widens-readers` and `irreversible`, and `dryRun.marks` is added as optional.
6. `ai/rag.ts`: `SemsearchArgs.context?`, `via?` and `relatedTo?` on each result, and `timings.contextMs?`.
7. **Errno lists and ABI version:**
   - add EAGAIN, EIO and ETIMEDOUT to the lists of the path calls the mount router serves;
   - add EXDEV to `copy` and `batch`;
   - set `ABI_VERSION` to 2 and update `protocol/tests/abi-mode-audit.test.ts`;
   - add a CHANGELOG "ABI" entry that lists every errno addition and the new calls.
8. `specs/01-architecture/syscall-abi.md`:
   - rows in §4.4.10 for the 8 `ai.*` calls;
   - new §4.4.13 "Mounts and cloud accounts" (4 calls);
   - new §4.4.14 "LLM arbiter" (1 call);
   - §4.3.1 reasons, §4.6 topics, and the ABI version.

   §4.4.12 already exists, so the draft's numbering is wrong. ABI-11 must pass.

**Kernel seams**

9. `kernel/src/core/hooks/index.ts` (C-03): `FsAccess`, `FsAccessSink`, `AiStructure` and `AiMemoryReport`, with no-op defaults. `KernelHooks` gains `fsAccess` and `aiMemory`.
10. `kernel/src/core/fs/kfs.ts` (C-04):
    - `KernelFsDeps` gains `onAccess?`, `fenceOf?` and `cachePolicy?`;
    - the `prepareCommit` fence argument;
    - `warmFile` and `cacheState`, delegating to the stub `kernel/src/core/fs/warm.ts`;
    - the `ContentCache` constructor option `policy` (C-06; a stub in `content.ts`), plus a stub `stats()` that returns zeros.
11. `kernel/src/core/io/vfs.ts`:
    - the `onAccess` wiring with a never-throw guard;
    - the sysctl `vfs.cache.policy`;
    - `installMountRouter(k.handlers, deps)` right after `registerFsSyscalls`, calling the stub in `kernel/src/core/fs/mounts/index.ts` (C-08).
12. `kernel/src/core/io/index.ts`:
    - `fenceOf`, gated by the new sysctl `sync.fenceWrites` (C-19);
    - `kernel.proc.fileWarm` in `mounted`;
    - the deps for the mount router.
13. `kernel/src/core/io/mm.ts`: the kernel-structures registry (C-13), feeding `startMemory({kernelStructures})`. It registers three sources: `content.stats()`, the router's `structures()`, and `hooks.aiMemory.structures()`.
14. `kernel/src/core/proc/pcb.ts`: `WaitReason` gains `'llm:queue'` and `'net:gdrive'`.
15. `kernel/src/core/proc/system.ts`:
    - `fileWarm?`;
    - `fsScope = agentScope(cwd, home)` for class `agent` in `spawnProcess` (C-07; RFC 0002 §5.6).
16. `kernel/src/core/events/bus.ts`: add `'mount'` to `GUARDED_GROUPS`.
17. `kernel/src/core/kernel.ts`: `k.llm = createLlmArbiter(deps)`, calling the stub in `kernel/src/core/llm/index.ts` (C-12).
18. **RFC 0006 part (a1)** (C-05):
    - `LockEngine.fenceFor?` and `leaseState?` in `net/engines.ts`;
    - the `LockdEngine` delegations in `net/factory.ts`;
    - the tests `kernel/src/core/fs/tests/kfs-fence.test.ts` and `kernel/src/core/net/tests/factory-fence.test.ts`, and the `vfs/src/sync/tests/units.test.ts` extension (SYN-19, three titles).

**AI seams and composition**

19. `ai/src/hooks.ts`: sources for `fsAccess` and `aiMemory`.
20. `ai/src/kernel/types.ts`: `AiKernel.sysctl?` and `LlmArbiterLike`.
21. `ai/src/kernel/install.ts`:
    - RFC 0002 seam S2 (`modelFactory`, `keepAlive`, `agentPolicy`);
    - calls to the stubs `installFileActivity` (C-10) and `installSemanticFs` (C-11);
    - `SearchService.rerank` and `warm` routing;
    - the new options `appOf`, `accountKind` and `cacheState`;
    - `spawnPrefetch` widened to `(job: {app: string} | {files: true}, uid, inos)`.
22. `ai/src/kernel/agent-service.ts`: RFC 0002 seam S1 only, for compile closure with S2. The file belongs to `agent-safety` afterwards.
23. `ai/src/kernel/search-service.ts`: the `rerank?` field type only. The file belongs to `semantic-fs` afterwards.
24. `ai/src/kernel/{index,link}.ts`: exports, and `KernelFsLike.cacheState?`. `ai/src/programs/index.ts`: `prefetchArgv(app, inos, {noApp?})`.
25. `web/src/kernel/ai-link.ts`: the complete composition.
    - It passes `memory` (from `MemoryManager.summary()`), `declaredBytes`, `appOf`, `accountKind` (from the login session), `cacheState`, `sysctl`, `spawnPrefetch` for both job kinds, `modelFactory` (`scheduledModelFactory` from the stub `ai/src/kernel/llm-fetch.ts` when `llm.sched` is `on`), `keepAlive` and `agentPolicy`.
    - It defines the sysctls `ai.agent.policy` and `llm.sched`.

**Apps, UI and traceability**

26. `apps/coreutils/index.ts`: register `mount`, `smart` and `llmq`, with stub command files.
    - Write the man-page front matter, with complete flags, for `mount`, `smart`, `llmq`, `semsearch` and `predict` (C-23).
    - Regenerate `argspec.gen.ts`.
27. **The Files Related plumbing (C-14):**
    - the stub `apps/files/lib/related.ts`;
    - in `apps/files/lib/controller.ts`, a call on single-selection change, debounced by 150 ms, with a sequence guard;
    - pass-through in `apps/files/view.tsx` and `ui/src/apps/files/FilesView.tsx`;
    - the optional `related` prop on `ui/src/apps/files/Inspector.tsx` (its type only; the group renders nothing yet);
    - `RelatedView` in `ui/src/apps/files/types.ts`.
28. `tools/traceability/ids.ts` and `specs/00-product/requirements-traceability.md` §3.13: register `GDRV`, `AGS`, `LRT`, `SFS`, `CTX`, `FAC`, `PFC` and `HRD`.

**Green gate for step 0.** All of these must pass, and the outcomes go in `platform`'s report:

- `pnpm typecheck`;
- `pnpm exec vitest run --project protocol` (ABI-11, 132 calls, the errno table, the audit test);
- `pnpm exec vitest run --project kernel`;
- `pnpm exec vitest run --project ai`;
- `pnpm exec vitest run --project apps`;
- `pnpm exec vitest run --project ui`;
- `pnpm exec vitest run --project web`;
- `pnpm lint`;
- `pnpm format:check`;
- `pnpm traceability`.

With every stub in place, **behaviour is unchanged**: the router is transparent, the seams are no-ops, the arbiter stub is the direct path, and fences go only to engines that implement `fenceFor`.

### 3.3 Files step 0 creates or edits, and who owns them afterwards

| File                                                                                                | Step 0 does                                                           | Owner afterwards                                                                     |
| --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `kernel/src/core/fs/mounts/index.ts`                                                                | stub `installMountRouter`, returning a transparent handle             | `gdrive-kernel`                                                                      |
| `kernel/src/core/fs/warm.ts`                                                                        | stub `warmFile` (ENOSYS) and `cacheState` (`'miss'`)                  | `predictive-cache`                                                                   |
| `kernel/src/core/fs/content.ts`                                                                     | adds the constructor option `policy` and a stub `stats()`             | `predictive-cache`                                                                   |
| `kernel/src/core/llm/index.ts`                                                                      | stub `createLlmArbiter`: an idle arbiter; `llm.stat` returns empty    | `llm-runtime`                                                                        |
| `ai/src/kernel/files/index.ts`                                                                      | stub `installFileActivity`: a no-op sink and an empty log             | `predictive-cache`                                                                   |
| `ai/src/kernel/semfs/index.ts`                                                                      | stub `installSemanticFs`: no `rerank`                                 | `semantic-fs`                                                                        |
| `ai/src/kernel/llm-fetch.ts`                                                                        | stub `scheduledModelFactory`, returning `undefined` (the direct path) | `llm-runtime`                                                                        |
| `ai/src/kernel/agent-service.ts`                                                                    | seam S1 (RFC 0002 §5.9)                                               | `agent-safety`                                                                       |
| `ai/src/kernel/search-service.ts`                                                                   | the `rerank?` field type                                              | `semantic-fs`                                                                        |
| `apps/coreutils/cmd/{mount,smart,llmq}.ts`                                                          | stubs that print "not built yet" and exit 2                           | `gdrive-kernel`, `semantic-fs`, `llm-runtime`                                        |
| `apps/coreutils/man/{mount,smart,llmq}.md`                                                          | front matter with full flags, one-line prose                          | same owners as the commands (the front matter is frozen; flag changes are a handoff) |
| `apps/coreutils/man/semsearch.md`, `apps/coreutils/man/predict.md`                                  | the new flags in the front matter                                     | `semantic-fs`, `predictive-cache` (the same rule)                                    |
| `apps/files/lib/related.ts`                                                                         | stub `relatedFor`, returning `null`                                   | `semantic-fs`                                                                        |
| `ui/src/apps/files/Inspector.tsx`                                                                   | the optional `related` prop                                           | `semantic-fs`                                                                        |
| `apps/files/lib/controller.ts`, `apps/files/view.tsx`, `ui/src/apps/files/{FilesView.tsx,types.ts}` | the Related plumbing                                                  | `gdrive-ui`                                                                          |

## 4. Interface contracts

### C-01 Protocol schemas

As step 0a (§3.1). The exact Valibot text is in the RFC sections cited there. Schemas are frozen at 0a; a change is a handoff to `platform`.

### C-02 The 13 new system calls (step 0b)

| Call                       | Group | Cls (clsAlt) | Origin | Caps           | Audit    | Errnos                  | Args / Ret schemas                                                           | Owner of the handler |
| -------------------------- | ----- | ------------ | ------ | -------------- | -------- | ----------------------- | ---------------------------------------------------------------------------- | -------------------- |
| `mount.list`               | mnt   | F (B)        | EV     | `fs.read`      | trace    | EAGAIN                  | `MountListArgs` / `MountListRet` (`sys/mnt.ts`)                              | gdrive-kernel        |
| `drive.status`             | mnt   | F (B)        | EV     | –              | trace    | EAGAIN, EIO             | `DriveStatusArgs` / `DriveStatusRet`                                         | gdrive-kernel        |
| `drive.connect`            | mnt   | B            | EV     | `privacy`      | security | EPERM, EAGAIN, EIO      | `DriveConnectArgs` / `DriveConnectRet`                                       | gdrive-kernel        |
| `drive.disconnect`         | mnt   | B            | EV     | `privacy`      | security | EAGAIN, EIO             | `DriveDisconnectArgs` / `DriveDisconnectRet`                                 | gdrive-kernel        |
| `ai.access.read`           | ai    | F            | E      | `ai.telemetry` | trace    | –                       | `AccessReadArgs` / `AccessReadRet` (`ai/access.ts`)                          | predictive-cache     |
| `ai.access.status`         | ai    | F            | EV     | –              | trace    | –                       | `AccessStatusArgs` / `AccessStatusRet`                                       | predictive-cache     |
| `ai.access.clear`          | ai    | T            | EV     | `privacy`      | security | –                       | `AccessClearArgs` / `AccessClearRet`                                         | predictive-cache     |
| `ai.access.pause`          | ai    | T            | EV     | `privacy`      | security | –                       | `AccessPauseArgs` / `AccessPauseRet`                                         | predictive-cache     |
| `ai.access.export`         | ai    | F            | EV     | `privacy`      | security | –                       | `AccessExportArgs` / `AccessExportRet` (JSON Lines of `ExportedAccessEvent`) | predictive-cache     |
| `ai.predict.files.publish` | ai    | F            | E      | `ai.predict`   | trace    | –                       | `PredictFilesPublishArgs` / `PredictFilesPublishRet`                         | predictive-cache     |
| `ai.predict.files`         | ai    | F            | EV     | –              | trace    | –                       | `PredictFilesArgs` / `PredictFilesRet`                                       | predictive-cache     |
| `ai.related`               | ai    | F            | EV     | `fs.read`      | trace    | ENOENT, ENOTDIR, EACCES | `RelatedArgs` / `RelatedRet` (`ai/semfs.ts`)                                 | semantic-fs          |
| `llm.stat`                 | llm   | F            | EV     | –              | trace    | –                       | `LlmStatArgs` / `LlmStatRet` (`sys/llm.ts`)                                  | llm-runtime          |

The `ai.*` calls are absent from the AI-off build (they answer ENOSYS); `llm.stat` exists there, idle. No new capability is added.

### C-03 Kernel hooks (`kernel/src/core/hooks/index.ts`)

```ts
export interface FsAccess {
  readonly uid: number; // effective uid
  readonly pid: number;
  readonly cls: 'user' | 'agent' | 'system';
  readonly ino: string;
  readonly fs: string; // 'root' | 'tmp' | 'gdrive' | …
  readonly path: string; // eligibility only; never stored
  readonly op: 'read' | 'write';
  readonly bytes: number;
  readonly t: number; // kernel monotonic ms
}
export interface FsAccessSink {
  onAccess(a: FsAccess): void; // O(1), never throws
}
export interface AiStructure {
  readonly name: string;
  readonly entries: number;
  readonly bytes: number;
}
export interface AiMemoryReport {
  structures(): readonly AiStructure[];
}
export const NOOP_FS_ACCESS: FsAccessSink;
export const NOOP_AI_MEMORY: AiMemoryReport;
// KernelHooks gains: readonly fsAccess: FsAccessSink; readonly aiMemory: AiMemoryReport;
```

### C-04 `KernelFsDeps` and `KernelFs` additions (`kernel/src/core/fs/kfs.ts`)

```ts
// KernelFsDeps gains
readonly onAccess?: (a: FsAccess) => void; // called by the two handler call sites (predictive-cache)
readonly fenceOf?: (ino: Uuid, pid: number) => number | undefined; // server fences only (RFC 0006)
readonly cachePolicy?: () => 'lru' | 'fifo'; // vfs.cache.policy
// KernelFs gains (delegating to kernel/src/core/fs/warm.ts)
warmFile(pcb: PCB, ino: Uuid, offset: number, len: number): Promise<{ bytes: number; pages: number }>;
cacheState(ino: Uuid): 'miss' | 'hit' | 'speculative';
```

### C-05 Lock engine (`kernel/src/core/net/engines.ts`, `factory.ts`)

`LockEngine.fenceFor?(pid: number, ino: string): number | undefined` and `LockEngine.leaseState?(ino: string): 'held' | 'suspect' | 'lost' | 'none'`. `LockdEngine` delegates both to `Lockd`. The sysctl `sync.fenceWrites` gates `fenceOf` at each commit.

### C-06 `ContentCache` (`kernel/src/core/fs/content.ts`, owner predictive-cache)

The constructor becomes `(store, capBytes?, fetchBlob?, opts?: { policy?: () => 'lru' | 'fifo' })`. The public API `load`, `bytesOf`, `remember` and `rememberBytes` is unchanged; `fetchOnce`'s single-flight download and hash check are kept for demand reads. New members:

- `prefetch(sha, maxBytes): Promise<number>`: refuses hash-only blobs with EAGAIN `content-not-cached`, never fetches, and inserts with `putAtLru` only;
- `state(sha)`;
- `stats(): {bytes, capBytes, specBytes, entries, hits, misses, adopted, wasted, policy}`.

### C-07 Process system (`kernel/src/core/proc`)

```ts
// system.ts
fileWarm?: (pcb: PCB, ino: string, offset: number, len: number) => Promise<{ bytes: number; pages: number }>;
/** {home} ∪ ({cwd} unless cwd ∈ {'/', '/home', '/mnt'} or cwd is a strict ancestor of home). */
export function agentScope(cwd: string, home: string): readonly string[];
// pcb.ts: WaitReason gains 'llm:queue' | 'net:gdrive'
```

### C-08 Mount router (`kernel/src/core/fs/mounts/index.ts`, owner gdrive-kernel)

```ts
export interface MountRouterDeps {
  readonly fs: KernelFs;
  readonly bus: EventBus;
  readonly procHooks: ProcHooks; // chains inheritFds and resolveDir
  readonly onTerminate: (hook: (pcb: PCB) => void) => () => void;
  readonly fetch: FetchLike | undefined; // undefined: no server, never mounts
  readonly timers: KernelTimers; // from @plotinium/services, as kernel/src/core/kernel.ts:27 imports it
  readonly mm: () => Pick<MemoryManager, 'declare' | 'undeclare'> | undefined;
  readonly notify: (
    uid: number,
    title: string,
    body: string,
    level: 'info' | 'warn' | 'error',
  ) => void;
  readonly hooks: () => KernelHooks; // fsAccess
  readonly annotate: (pcb: PCB, reason: WaitReason) => void; // 'net:gdrive'
  readonly now: () => number;
}
export interface MountRouterHandle {
  structures(): readonly KernelStructure[];
  dispose(): void;
}
export function installMountRouter(reg: HandlerRegistry, deps: MountRouterDeps): MountRouterHandle;
```

Everything else about the router is RFC 0001 §5.3: `MountProvider`, `MountVolume`, `RemoteDesc`, `RemoteFdTable`, `Route`, `MountTable`, `DriveApi`.

### C-09 Access log (`ai/src/kernel/files/access-log.ts`, owner predictive-cache)

The interfaces are those of RFC 0004 §5.1.2: `AccessRecord`, `AccessListener { name; onEvent(r); onClear(uid); stats(uid) }`, and `AccessLogApi { subscribe; recent; recentForApp; read; status; clear; pause; exportTrace(uid): Uint8Array }`. `semantic-fs` imports only these types and calls `subscribe`, `recent` and `status`.

### C-10 `installFileActivity` (`ai/src/kernel/files/index.ts`, owner predictive-cache)

```ts
export interface FileActivityContext {
  readonly register: <C extends CallName>(name: C, impl: AiCallImpl<C>) => void;
  readonly kernel: AiKernel; // includes sysctl?
  readonly fs: AiFsView | undefined;
  readonly appOf: (pid: number) => string;
  readonly accountKind: (
    uid: number,
  ) => 'root' | 'user' | 'guest' | 'demo' | 'examiner' | undefined;
  readonly cacheState?: (ino: string) => 'miss' | 'hit' | 'speculative';
  readonly spawnPrefetch?: (
    job: { app: string } | { files: true },
    uid: number,
    inos: readonly string[],
  ) => Promise<{ wasted: boolean }>;
  readonly now: () => number;
}
export interface FileActivity {
  readonly sink: FsAccessSink; // registered as hooks.fsAccess
  readonly memory: AiMemoryReport; // registered as hooks.aiMemory (ring + listeners' stats)
  readonly accessLog: AccessLogApi; // handed to installSemanticFs
  warm(inos: readonly string[], uid: number): void; // SearchService.warm (AIN-A4)
  stop(): void;
}
export function installFileActivity(ctx: FileActivityContext): FileActivity;
```

### C-11 `installSemanticFs` (`ai/src/kernel/semfs/index.ts`, owner semantic-fs)

Specified in RFC 0003 §5.8: `SemfsContext` (with `accessLog: AccessLogApi` from C-10 and `sysctl?`), `SemanticFs { rerank?(input: RerankInput): RerankOutput; stop(): void }`, `RerankInput` and `RerankOutput`. `SemanticIndex.chunksOf(ino)` is added in `ai/src/kernel/index-store.ts` by `semantic-fs`.

### C-12 The LLM arbiter (`kernel/src/core/llm/index.ts`, owner llm-runtime)

```ts
export interface LlmArbiterDeps {
  readonly reg: HandlerRegistry; // registers llm.stat
  readonly procs: ProcessSystem; // PCB lookups, annotate, onTerminate
  readonly mm: () => Pick<MemoryManager, 'declare' | 'undeclare'> | undefined;
  readonly sysctl: SysctlTable; // defines llm.slots, llm.tAge, llm.proc.tokens
  readonly timers: KernelTimers; // from @plotinium/services, as kernel/src/core/kernel.ts:27 imports it
  readonly now: () => number;
  readonly online: () => boolean; // refuse at enqueue when offline
  readonly log: (level: 'info' | 'warn', msg: string) => void;
}
export function createLlmArbiter(deps: LlmArbiterDeps): LlmArbiter;
// LlmArbiter as RFC 0005 §5.2, with acquire(req, { signal?, resumeOf?, deadlineAt? })
// ai side (ai/src/kernel/types.ts): LlmArbiterLike { acquire(...); isHolding(pid) } (structural)
// ai/src/kernel/llm-fetch.ts: scheduledFetch(fetch, arbiter, who): HostFetch;
//   scheduledModelFactory({ fetch, arbiter, osSessionId }): (requestId, caller) => ModelClient | undefined
```

Agent seam (RFC 0002 §5.9, landed in step 0): `AgentServiceDeps.model?(requestId, caller)`, `keepAlive?(pid)`, and `AiInstallOptions.modelFactory?`, `keepAlive?` and `agentPolicy?`.

### C-13 Kernel-structures registry (`kernel/src/core/io/mm.ts`, owner platform)

`kernel.structures.register(source: () => readonly KernelStructure[]): () => void`, where `KernelStructure` is the existing `{name, entries, bytesPerEntry}` of `kernel/src/core/mm/mm.ts:150`. Step 0 registers the file cache (`content.stats()`), the mount router (`handle.structures()`) and AI memory (`hooks.aiMemory.structures()`, converted to `bytesPerEntry: 1`). The Kernel line of `free` stays "reported, not charged" (KMM-01).

### C-14 The Files Related hook (step 0; implemented by semantic-fs)

```ts
// ui/src/apps/files/types.ts (owner gdrive-ui after step 0)
export interface RelatedRow {
  readonly path: string;
  readonly name: string;
  readonly folder: string;
  readonly reason: 'edited-after' | 'opened-together' | 'both';
  readonly count: number;
}
export interface RelatedView {
  readonly state: 'ready' | 'learning' | 'paused' | 'off';
  readonly items: readonly RelatedRow[];
  readonly hidden: number;
}
// apps/files/lib/related.ts (owner semantic-fs; the step-0 stub returns null, which hides the group)
export function relatedFor(sys: PromiseSys, path: string): Promise<RelatedView | null>; // PromiseSys: apps/files/lib/sys.ts
// ui/src/apps/files/Inspector.tsx (owner semantic-fs): props gain `related?: RelatedView | null`
```

### C-15 Drive host capability (`apps/src/descriptor.ts`, owner gdrive-ui)

`AppEnv.drive?: DriveHost`, with `DriveHost.openPopup(): DrivePopup | null` and `DrivePopup { go(launchUrl): void; wait(attempt): Promise<'connected' | 'denied' | 'failed' | 'timeout' | 'cancelled'>; cancel(): void }` (RFC 0001 §13.3).

### C-16 Drive HTTP API (gdrive-server ↔ gdrive-kernel; schemas in `protocol/src/drive-api.ts`)

| #   | Method and path                         | Body / query                | Success                                                | Main errors                                                                                                          |
| --- | --------------------------------------- | --------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| 1   | `GET /api/drive/status`                 | –                           | 200 `DriveStatus` (also when disabled)                 | 503 EIO                                                                                                              |
| 2   | `POST /api/drive/oauth/start`           | `DriveStartReq`             | 200 `DriveStartRes`                                    | 403 EPERM `guest`/`root`/`shared-account`/`su`; 404 ENOSYS when off; 429                                             |
| 3   | `GET /api/drive/oauth/launch?l=`        | –                           | 302 to Google's (or the fake's) authorization endpoint | always 302 to `/oauth/drive/callback.html#error=<reason>`                                                            |
| 4   | `POST /api/drive/oauth/complete`        | `DriveCompleteReq`          | 200 `DriveCompleteRes`                                 | 400 EINVAL `state` (incl. a bad nonce); 403 EACCES `state-session`; 409 EEXIST `account-in-use` (never revokes); 503 |
| 5   | `POST /api/drive/disconnect`            | –                           | 200 `DriveDisconnectRes` (`ok`, `already` or `queued`) | idempotent                                                                                                           |
| 6   | `GET /api/drive/fs/children?dir=&page=` | –                           | 200 `ChildrenPage`                                     | 404; 403 EACCES `reconnect`                                                                                          |
| 7   | `GET /api/drive/fs/item?id=`            | –                           | 200 `RemoteEntry`                                      | 404                                                                                                                  |
| 8   | `GET /api/drive/fs/content?id=&rev=`    | –                           | 200 octet-stream (≤ 8 MiB, streamed)                   | 404; 403 EACCES `download-restricted`/`abuse-flagged`; 413 EINVAL `too-large`                                        |
| 9   | `PUT /api/drive/fs/content?id=&base=`   | ≤ 5 MiB octet-stream        | 200 `PutResult`                                        | 409 EAGAIN `stale-version` + `StaleDetail`; 413 EDQUOT `remote-quota` or EINVAL `too-large`                          |
| 10  | `POST /api/drive/fs/create`             | `CreateReq` (UUIDv7 `opId`) | 201 `RemoteEntry` (idempotent by `opId`)               | 409 EEXIST; 413 EDQUOT                                                                                               |
| 11  | `PATCH /api/drive/fs/item`              | `PatchReq`                  | 200 `RemoteEntry`                                      | 404; 409; 403 EACCES `remote-perm`                                                                                   |

The rate classes are `drive` (per uid 10/s, burst 40, plus a global 600/min), `drive-bytes` (per uid 200 MiB/min) and `drive-oauth` (per uid 10 per 10 min). With `GDRIVE=0`, route 1 answers `disabled` and every other route answers 404 ENOSYS.

### C-17 The callback contract (gdrive-ui page ↔ gdrive-server)

- The popup opens synchronously at `/oauth/drive/callback.html#wait`, and the host then navigates it to a `LaunchUrl`.
- Google (or the fake) redirects to `/oauth/drive/callback.html?code&state&iss`.
- The page posts `DriveCompleteReq` to `/api/drive/oauth/complete` (same origin) and broadcasts `DriveConnectMessage` on `BroadcastChannel('plotinium-drive')`. It carries no token and no email.
- Errors come back as `#error=<DriveReason>`.
- Caddy serves `/oauth/*` statically, with `Cache-Control: no-cache` and no `try_files` fallback. The Service Worker denylists `/oauth/` and never precaches `oauth/**`.

### C-18 The access tap from Drive

The router calls `hooks().fsAccess.onAccess({ …, fs: 'gdrive', ino: driveIno(uid, id) })` inside the never-throw guard. `AccessLog` drops the event (FAC-03). No other Drive → AI path exists in Wave 3.

### C-19 Feature flags and defaults

| Flag                                         | Kind                         | Values (default first)                                       | Defined in (owner)                           | Who may set |
| -------------------------------------------- | ---------------------------- | ------------------------------------------------------------ | -------------------------------------------- | ----------- |
| `GDRIVE`                                     | server env                   | `auto` · `0` · `1`                                           | `server/src/drive/config.ts` (gdrive-server) | operator    |
| `sync.fenceWrites`                           | sysctl                       | `on` · `off`                                                 | `kernel/src/core/io/index.ts` (platform)     | root        |
| `vfs.cache.policy`                           | sysctl                       | `lru` · `fifo`                                               | `kernel/src/core/io/vfs.ts` (platform)       | root        |
| `ai.agent.policy`                            | sysctl                       | `enforce` · `shadow` · `off`                                 | `web/src/kernel/ai-link.ts` (platform)       | root        |
| `llm.sched`                                  | sysctl                       | `on` · `off`                                                 | `web/src/kernel/ai-link.ts` (platform)       | root        |
| `llm.slots` / `llm.tAge` / `llm.proc.tokens` | sysctl                       | `2` (1–4) / `1000` (250–5,000) / `150000`                    | `kernel/src/core/llm/**` (llm-runtime)       | root        |
| `ai.access.tap`                              | sysctl                       | `on` · `off`                                                 | `ai/src/kernel/files/**` (predictive-cache)  | root        |
| `ai.cache.prefetch`                          | sysctl                       | `shadow` · `on` · `off`                                      | `ai/src/kernel/files/**` (predictive-cache)  | root        |
| `ai.cache.theta`                             | sysctl                       | `0.1` (0.025–0.5)                                            | `ai/src/kernel/files/**` (predictive-cache)  | root        |
| "Learn from how I use files"                 | per user (`ai.access.pause`) | on for `user` and `examiner`; **off for `demo` and `guest`** | `ai/src/kernel/files/**` (predictive-cache)  | the user    |
| `ai.fs.context`                              | sysctl                       | `off` · `rerank` · `expand`                                  | `ai/src/kernel/semfs/**` (semantic-fs)       | root        |
| `ai.fs.related`                              | sysctl                       | `on` · `off`                                                 | `ai/src/kernel/semfs/**` (semantic-fs)       | root        |

There is no client feature-flag registry in Wave 3 (RFC 0001 Q9). Every `off` value restores today's behaviour and is the baseline arm of its evaluation.

### C-20 Events and audit names

- **Bus topics:**
  - `mount.state {uid, path, fs, state, reason?}`;
  - `mount.change {uid, path, dir, name?, kind, origin}`.

  Both are in the guarded group `mount`, visible only when `cred.uid === data.uid`, root included.

- **The broadcast message:** `DriveConnectMessage` (`v: 1`, `type: 'drive-connect-result'`).
- **Audit syscall names:** `gdrive.connect`, `gdrive.scopes`, `gdrive.invalid_grant`, `gdrive.disconnect`, `gdrive.revoke_retry`, `gdrive.purge`.
- **Kernel audit:** the `drive.*` calls are audited `security`; `ai.access.clear/pause/export` are audited `security`.
- **No new bus topic** for the access stream. It is a seam, by design (RFC 0004 §6 A).

### C-21 Database

- The only migration is `db/migrations/20261001100000_drive_accounts.sql` (owner gdrive-server). It creates the tables `drive_accounts` (`uid … ON DELETE RESTRICT`), `drive_oauth_attempts` and `drive_revocations` (RFC 0001 §5.6).
- The timestamp is after `20260924100500`. The next free timestamp for any later migration is `20261001100100`.
- `db/schema.sql` and `server/src/db/types.gen.ts` are written by hand; `verify-drive` checks them against the migrated QA database.

### C-22 Evaluation datasets (red team → consumers)

| Dataset                                                                                      | Path (owner: red team)                                                                                            | Consumer                 | Frozen before           |
| -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------ | ----------------------- |
| INJ-A (10), INJ-T (12, incl. the `/mnt/share` volume-name case), FP-8 (8), plus benign twins | `ai/eval/agentdojo/cases/*.json` + `MANIFEST.sha256`; the existing INJ-20 case schema plus the benign-twin fields | agent-safety (runner)    | agent-safety item 6     |
| Post-hoc adaptive (≥ 5)                                                                      | `ai/eval/agentdojo/posthoc/*.json`                                                                                | reported separately      | written after the build |
| Context sessions (24) and queries (20: 10 validation, 10 test)                               | `ai/eval/ctx/sessions.json`, `ai/eval/ctx/queries-ctx.json` + `ai/eval/ctx/MANIFEST.sha256`                       | semantic-fs (evaluation) | semantic-fs item 4      |

Consumers refuse to run on a hash mismatch (AGS-11, CTX-05 tests).

### C-23 Command-line flags (man page front matter, frozen at step 0)

| Command     | Flags                                                                                                                   |
| ----------- | ----------------------------------------------------------------------------------------------------------------------- |
| `mount`     | `--json` (lists mounts; P1-thin)                                                                                        |
| `smart`     | subcommands `ls`, `new`, `rm`, `show`; `-l`, `--json`, `--keyword`, `--dir PATH`, `--ext LIST`, `--within SPAN`, `-k N` |
| `llmq`      | `--json`                                                                                                                |
| `semsearch` | existing flags plus `--related PATH`, `--no-context`                                                                    |
| `predict`   | existing flags plus `--files`, `--cache`, `--export-files`, `-n N`, `--json`                                            |

### New requirement IDs (traceable; prefixes registered in step 0)

| Prefix                | IDs                                         | RFC  | Built in Workflow B                            |
| --------------------- | ------------------------------------------- | ---- | ---------------------------------------------- |
| GDRV                  | 01–21 (GDRV-21 new: walkers stay on one fs) | 0001 | P1-thin parts of 01–08 and 10–21; 09 is P1b    |
| AGS                   | 01–15                                       | 0002 | 01–11, 13, 15; 12 is P1; 14 is P2              |
| SFS                   | 01–07                                       | 0003 | 01, 02, 04, 05; 03 and 06 are P1; 07 withdrawn |
| CTX                   | 01–08                                       | 0003 | all                                            |
| FAC                   | 01–09 (FAC-09 new: pseudonymised export)    | 0004 | all                                            |
| PFC                   | 01–08                                       | 0004 | all (the enable gate is later)                 |
| HRD                   | 01–04                                       | 0004 | deferred (prefix registered)                   |
| LRT                   | 01–14                                       | 0005 | 01–10; 11–13 are P1; 14 is P2                  |
| SYN (existing prefix) | 19–21                                       | 0006 | 19 (step 0); 21 stretch; 20 deferred           |
| DSN (existing prefix) | 40–44                                       | 0006 | deferred                                       |

## 5. Builders

Every builder's first step is to re-verify its RFC's §2 citations on the post-close-out tree (X10), then report. The owned paths below are disjoint.

### 5.1 `platform` (integrator; RFC 0006 part (a))

- **Scope, in order:**
  1. Step 0a (§3.1).
  2. Step 0b with the green gate (§3.2), which includes the RFC 0006 a1 fence plumbing and SYN-19.
  3. The handoff desk: apply handoffs to the shared files, regenerate `argspec.gen.ts` on request, and log everything in `docs/design/wave3/platform/handoffs.md`.
  4. Stretch: SYN-21 zombie tests.
  5. At the end of the wave, the doc PR:
     - apply every builder's spec text to `specs/**`, or write `docs/design/wave3/spec-patches/<rfc>.md` if the specs are Frozen and approval is pending (L-3, L-4);
     - the CHANGELOG entries for Wave 3;
     - one `AI_USAGE.md` entry per builder and design agent;
     - the `SECURITY.md` residual risks listed in the RFCs' §17s;
     - regenerate `argspec.gen.ts` once more.
- **Owned paths:**
  - protocol: `protocol/src/sys/registry.ts`, `protocol/src/sys/names.ts`, `protocol/src/index.ts`, `protocol/src/events.ts`, `protocol/src/errno.ts`, `protocol/src/abi.ts`, `protocol/src/sys/common.ts`, `protocol/src/sys/fs.ts`, `protocol/src/ai/agent.ts`, `protocol/src/ai/rag.ts`, `protocol/src/drive-api.ts`, `protocol/src/sys/mnt.ts`, `protocol/src/sys/llm.ts`, `protocol/src/ai/access.ts`, `protocol/src/ai/semfs.ts`, `protocol/tests/**`;
  - kernel: `kernel/src/core/kernel.ts`, `kernel/src/core/hooks/index.ts`, `kernel/src/core/io/index.ts`, `kernel/src/core/io/vfs.ts`, `kernel/src/core/io/mm.ts`, `kernel/src/core/fs/kfs.ts`, `kernel/src/core/proc/system.ts`, `kernel/src/core/proc/pcb.ts`, `kernel/src/core/events/bus.ts`, `kernel/src/core/net/engines.ts`, `kernel/src/core/net/factory.ts`, `kernel/src/core/fs/tests/kfs-fence.test.ts`, `kernel/src/core/net/tests/factory-fence.test.ts`;
  - vfs and server tests: `vfs/src/sync/tests/units.test.ts`, `server/src/engine/locks/zombie.test.ts`, `server/src/engine/locks/zombie.prop.test.ts`, `server/src/engine/locks/README.md`;
  - AI seams: `ai/src/hooks.ts`, `ai/src/kernel/install.ts`, `ai/src/kernel/types.ts`, `ai/src/kernel/index.ts`, `ai/src/kernel/link.ts`, `ai/src/programs/index.ts`, `web/src/kernel/ai-link.ts`;
  - coreutils: `apps/coreutils/index.ts`, `apps/coreutils/lib/argspec.gen.ts`;
  - docs and registries: `specs/**`, `CHANGELOG.md`, `AI_USAGE.md`, `SECURITY.md`, `tools/traceability/ids.ts`, `docs/design/wave3/platform/**`, `docs/design/wave3/spec-patches/**`.
- **Contracts:** C-01 to C-08 and C-12 to C-14 (the step-0 parts), C-19 (its flags), C-20, C-23.
- **Acceptance:**
  - `pnpm exec vitest run --project protocol` green, with ABI-11 at **132 calls** and `ABI_VERSION === 2`;
  - `pnpm typecheck`, `pnpm lint`, `pnpm format:check` and `pnpm test` green at the end of step 0 (report the timings);
  - behaviour unchanged with the stubs: the full existing suite green, and the router transparent;
  - `SYN-19 a write by a process holding server X carries its fence into the outbox record`, `SYN-19 a write through createEngineFactory with a server X lease carries the lockd fence` and `SYN-19 a server-scope grant without a fence leaves the op with no fences entry, so fence 0 never reaches the wire` green (`pnpm exec vitest run --project kernel kernel/src/core/fs/tests/kfs-fence.test.ts kernel/src/core/net/tests/factory-fence.test.ts`; `pnpm exec vitest run --project vfs vfs/src/sync/tests/units.test.ts`);
  - `pnpm traceability` knows all 8 new prefixes;
  - stretch: `SYN-21` with 1,000 property runs and 0 invariant violations (`pnpm exec vitest run --project server server/src/engine/locks/zombie`);
  - every handoff logged and applied or answered; the doc PR or spec patches present.
  - **Numbers:** client ops carrying a fence while their process holds server X: 100 % (SYN-19; baseline 0 %).
- **Depends on:** L-1 and L-5.
- **Cut line:** (1) SYN-21; (2) the Files Related plumbing (item 27; `semantic-fs`'s Inspector UI then moves to P1); (3) the doc PR becomes spec patches only. **Never cut:** the registry, ABI and spec-row changes, the seams and stubs every builder needs, the green gate, and the fence plumbing with SYN-19.

### 5.2 `gdrive-server` (RFC 0001, server side of P1-thin)

- **Scope, in order:**
  1. The migration (3 tables), with `db/schema.sql` and `types.gen.ts` written by hand.
  2. `parseDriveConfig`: `*_FILE` secrets only, a loopback-only fake base URL, production refusals, and the fake loaded only by dynamic import.
  3. The vault: AES-256-GCM with canonical AAD and `key_id` rotation.
  4. The fake Google: the P1-thin subset, admin hooks and a request log.
  5. Hand-written fixtures and the contract suites.
  6. The OAuth routes: `state`, `nonce` and PKCE; session binding; `iss`; the account policy by `account_kind`; the revocation rule; `su` refusal.
  7. The fs routes, the error map, retries with jitter, and the host allow-list.
  8. The jobs: attempt expiry, the revocation retry from `drive_revocations`, and the grace purge.
  9. The rate classes (with a global bucket), explicit redaction paths, readiness, `.gitleaks.toml` and the runbook.
- **Owned paths:** `db/migrations/20261001100000_drive_accounts.sql`, `db/schema.sql`, `server/src/db/types.gen.ts`, `server/src/drive/**`, `server/src/config.ts`, `server/src/app.ts`, `server/src/ratelimit/classes.ts`, `server/src/obs/logger.ts`, `server/src/obs/metrics.ts`, `server/src/obs/health.ts`, `server/package.json` (scripts only), `.gitleaks.toml`, `docs/runbooks/google-drive.md`, `docs/design/wave3/gdrive-server/**`.
- **Contracts:** C-01 (`drive-api.ts`), C-16, C-17 (server side), C-19 (`GDRIVE`), C-20 (audit), C-21.
- **Acceptance:**
  - every server test title of RFC 0001 §10.2 green: `pnpm exec vitest run --project server server/src/drive`, plus `DATABASE_URL=… pnpm exec vitest run --project server server/src/drive/*.int.test.ts` where a database is available (report skips honestly);
  - `DB-01 the drive migration round-trips and drops all three tables`;
  - the GDRV-03 scan finds 0 secrets in fixtures and in `web/dist`;
  - the log-capture tests pass on the failure paths;
  - QA scenarios Q-GD-01, 03, 04, 06, 07, 10 and 11 pass.
  - **Numbers:** server-added time ≤ 60 ms for a 1,000-entry listing; content time-to-first-byte overhead ≤ 20 ms; the CSRF matrix of RFC 0001 §10.3 100 % green.
- **Depends on:** `platform` (0a).
- **Cut line:** (1) metrics beyond the three counters; (2) the `drive:fake` npm script (the fake still runs in-process); (3) the grace job (the `needs-reconnect` state stays). **Never cut:** the OAuth security properties, the vault, the persisted revocation and its rule, the 11 routes, the fake Google, redaction and gitleaks.
- **Spec text to supply** (handoff to `platform`):
  - `specs/11-server/backend-api.md`: variables, routes, rate classes, redaction, and "account deletion calls disconnect first";
  - `specs/09-database/database.md`: the three tables;
  - `specs/12-security/security-model.md`: A-13, TB7, T-D01 to T-D23, the account policy;
  - `specs/14-devops/deployment-and-ci.md`: secrets outside the checkout, one Cloud project per instance, the fake Google, gitleaks.

### 5.3 `gdrive-kernel` (RFC 0001, kernel side of P1-thin)

- **Scope, in order:**
  1. The route, the table and router transparency.
  2. `RemoteFdTable`: shared numbering, `dup`/`dup2`, chained `inheritFds`, the `onTerminate` release.
  3. The gdrive volume: names (control, bidi and ill-formed characters), `driveIno`, the per-uid namespace with agent and system classes excluded, paged `readdir` (≤ 200 entries, yield), `stat` with the 15 s term.
  4. Reads and writes: `open(r)`/`read`/`close` with snapshots charged through `MemoryManager.declare`; `writeFile` ≤ 5 MiB with the base check and the conflicted copy; `mkdir`, `utimes`, rename, trash, EXDEV, and cross-boundary `copy`.
  5. The syscall handlers for `mount.list` and `drive.*`; events with the owner-only visibility hook; `net:gdrive` annotation; `DriveApiClient` and `FakeDriveApi`; the `fsAccess` call.
  6. Coreutils: the `df` rows, the `mv` EXDEV fallback, the `touch` fallback, `-xdev` walks in `lib/fs.ts`, `lib/errors.ts` sentences through `escapeName`, and `mount` as a list-only command.
  7. The property test, the bench, and the agent, system and root tests.
- **Owned paths:** `kernel/src/core/fs/mounts/**`, `apps/coreutils/cmd/mount.ts`, `apps/coreutils/man/mount.md`, `apps/coreutils/cmd/df.ts`, `apps/coreutils/cmd/mv.ts`, `apps/coreutils/cmd/touch.ts`, `apps/coreutils/lib/fs.ts`, `apps/coreutils/lib/errors.ts`, `apps/coreutils/tests/gdrive-*.test.ts`, `tests/integration/gdrive-contract.int.test.ts`, `docs/design/wave3/gdrive-kernel/**`.
- **Contracts:** C-02 (the `mnt` handlers), C-07 (`net:gdrive`), C-08, C-16 (client side), C-18, C-20.
- **Acceptance:**
  - every kernel test title of RFC 0001 §10.2 green (`pnpm exec vitest run --project kernel kernel/src/core/fs/mounts`; `pnpm exec vitest run --project apps apps/coreutils/tests/gdrive-*.test.ts`);
  - the existing kernel and apps suites unchanged and green;
  - the consumer-driven contract suite `tests/integration/gdrive-contract.int.test.ts` passes. It runs one scenario list against `FakeDriveApi` and against the real server routes backed by the fake Google, importing both by relative path, as the existing integration tests do (`pnpm exec vitest run --config tests/vitest.config.ts --project integration tests/integration/gdrive-contract.int.test.ts`);
  - QA scenarios Q-GD-01, 05, 06, 08 and 09 pass.
  - **Numbers:** cold `readdir` of 1,000 fake entries p95 ≤ 300 ms end to end, with no kernel-worker task > 8 ms (GDRV-16 bench); warm ≤ 5 ms; `stat` ≤ 1 ms; `writeFile` of 5 MiB ≤ 400 ms on the fake; E2 quota units with the 15 s term vs term 0 ≥ 5× fewer; E5 0 lost `writeFile`s over 500 fault-injected sessions; E9 0 Drive calls from walkers.
- **Depends on:** `platform` (0a for new files, 0b to integrate). End to end with `gdrive-server` through the contract suite.
- **Cut line:** (1) the `mount` command; (2) the `touch` fallback; (3) `copy` out of the volume; (4) the automatic conflicted copy (detection stays). **Never cut:** the per-uid namespace with class exclusion, router transparency, `RemoteFdTable` correctness, charged snapshots, conflict detection, `-xdev` walkers, errno mapping.
- **Spec text to supply:**
  - `specs/04-vfs/google-drive-mount.md` (new: RFC 0001 §5.2 to §5.10 and the GDRV table);
  - `specs/04-vfs/virtual-file-system.md` (§1.2, the `/mnt` row);
  - `specs/01-architecture/syscall-abi.md` (§3.4 note, §4.9 Drive rows);
  - `specs/07-shell/shell-and-terminal.md` (`df`, `mv` EXDEV, the `touch` fallback, `-xdev` walks, `mount`);
  - `specs/06-sync/offline-and-sync.md` (remote volumes are not synced);
  - `specs/10-ai/rag-semantic-search.md` (`/mnt/gdrive` is not eligible);
  - `specs/10-ai/agentic-shell.md` (the agent has no Drive namespace).

### 5.4 `gdrive-ui` (RFC 0001, UI side of P1-thin)

- **Scope, in order:**
  1. Settings › Internet Accounts: the section id, sections entry and view match; `AccountsPane`, `DriveCard`, `DriveConnectSheet` (heading focused first, polite live region) and `DriveDisconnectDialog`; the controller and model over `drive.*` and `mount.state`.
  2. `drive-host.ts`: `window.open` inside the click, the `LaunchUrl` check, the `BroadcastChannel`, a 3 s status poll, a 10-minute timeout; `AppEnv.drive`.
  3. The callback page: `web/oauth/drive/callback.html`, `web/src/oauth/**` (removes the query, allow-listed reasons, both themes); the Vite page input; the Caddy `handle /oauth/*`; the Service Worker denylist and `NEVER_PRECACHE`; build, header and Service Worker tests.
  4. Files:
     - the Drive place under Locations, from `mount.list`;
     - `SidebarList` item `meter` and `status`;
     - the `VolumeNotice` (offline, needs attention);
     - errors in words in `sys.ts`;
     - the EXDEV move fallback;
     - the keyword search that never crosses from a local start and matches names only on volumes;
     - the trash message.
  5. Accessibility, both themes, reduced motion, the gallery page, screenshots on QA, and `docs/user/google-drive.md` (with backup retention and the shared-machine residual).
- **Owned paths:**
  - Settings: `ui/src/apps/settings/sections.ts`, `ui/src/apps/settings/models.ts`, `ui/src/apps/settings/SettingsView.tsx`, `ui/src/apps/settings/panes/AccountsPane.tsx`, `ui/src/apps/settings/panes/AccountsPane.module.css`, `ui/src/apps/settings/accounts/**`, `apps/settings/controller.ts`, `apps/settings/model.ts`, `apps/settings/accounts.ts`;
  - Files: `ui/src/apps/files/FilesSidebar.tsx`, `ui/src/apps/files/types.ts`, `ui/src/apps/files/FilesView.tsx`, `ui/src/apps/files/Files.module.css`, `ui/src/apps/files/VolumeNotice.tsx`, `ui/src/apps/files/VolumeNotice.module.css`, `ui/src/primitives/sidebar/SidebarList.tsx`, `ui/src/primitives/sidebar/Sidebar.module.css`, `apps/files/lib/controller.ts`, `apps/files/lib/model.ts`, `apps/files/lib/ops.ts`, `apps/files/lib/sys.ts`, `apps/files/lib/mounts.ts`, `apps/files/view.tsx`;
  - desktop and web: `apps/src/descriptor.ts`, `web/src/desktop/drive-host.ts`, `web/src/desktop/host.ts`, `web/oauth/drive/callback.html`, `web/src/oauth/**`, `web/vite.config.ts` (the rollup input only; never `compactCss`), `web/src/sw/routes.ts`, `web/tests/sw.test.ts`, `web/tests/build.test.ts`, `web/tests/csp-servers.test.ts`, `Caddyfile`;
  - gallery and docs: `ui/gallery/pages/drive.tsx`, `ui/gallery/registry.ts`, `docs/user/google-drive.md`, `docs/design/wave3/gdrive-ui/**`;
  - the tests next to each of these files.
- **Contracts:** C-14 (it owns the plumbed files and must keep the Related hook working), C-15, C-17 (page side), C-20 (`mount.state` consumer).
- **Acceptance:**
  - every UI test title of RFC 0001 §10.2 green (`pnpm exec vitest run --project ui ui/src/apps/settings ui/src/apps/files ui/src/primitives/sidebar`; `pnpm exec vitest run --project web web/tests`; `pnpm exec vitest run --project apps apps/files apps/settings`);
  - `pnpm --filter @plotinium/web build` passes, `web/dist/boot-budget.json` is unchanged, and `csp.caddy` is unchanged apart from the new page's hashes, if any;
  - QA scenarios Q-GD-01, 02, 03, 05 and 10, Q-A11Y-01 and Q-REG-01 (Files and Settings) pass;
  - 0 enforced CSP violations, and screenshots in both themes at 1440×900 and 1280×800, read.
  - **Numbers:** 0 bytes added to boot-critical JS; `drive-host.ts` ≤ 2 KB gzip; axe with 0 serious or critical issues on every new surface.
- **Depends on:** `platform` (0a and 0b). Live integration with `gdrive-kernel`'s syscalls; unit tests use a fake `AppSys`.
- **Cut line:** (1) the capacity meter (the status text stays); (2) the gallery page; (3) the "Open in Files" button on the result screen. **Never cut:** the popup opened inside the click, the callback page with the Caddy and Service Worker exclusions, completion by same-origin POST, heading-first focus, errors in words, and the Related plumbing that `semantic-fs` relies on.
- **Spec text to supply:** `specs/05-wm/ui-design-system.md` (the Internet Accounts pane; the Files volume row with meter and status; the callback page); a SEC-02 note in `specs/12-security/security-model.md` (the callback page gets the full header set).

### 5.5 `agent-safety` (RFC 0002, P0)

- **Scope, in order:**
  1. Harness fidelity G7 and G8, with the Appendix A cases as failing tests.
  2. Provenance, grounded queries, the glob table, and the whole-token `U` rule.
  3. The policy table, the reasons, fail-closed EINVAL `policy-error`, shadow mode, the mode display, and the renderers.
  4. Reader sets and effect classes.
  5. The AgentDojo-style runner and report over the red team's frozen cases, with the manifest check.
  6. The AGS-09 kernel test for the narrowed `fsScope`, and the scope notice.
- **Owned paths:**
  - agent code: `ai/src/agent/provenance.ts`, `ai/src/agent/policy.ts`, `ai/src/agent/validator.ts`, `ai/src/agent/intent.ts`, `ai/src/agent/confirm.ts`, `ai/src/agent/apply.ts`, `ai/src/agent/observe.ts`, `ai/src/agent/audit.ts`, `ai/src/kernel/agent-service.ts`, `ai/src/programs/agent.ts`;
  - apps: `apps/terminal/plan.ts`, `apps/coreutils/cmd/ai.ts`;
  - evaluation: `ai/eval/harness.ts`, `ai/eval/agentdojo/**` **except** `cases/` and `posthoc/`, `ai/eval/fixtures/fx-agt.ts`;
  - tests: `ai/tests/agent.provenance.test.ts`, `ai/tests/agent.policy.test.ts`, `ai/tests/eval.agentdojo.test.ts`, `ai/tests/eval.fixtures.test.ts` (the existing AGT-40 and INJ-20 gates; expectations may change only where harness fidelity G7 and G8 makes them more accurate, and the change must be explained in the report), `kernel/tests/agent-scope.test.ts`;
  - evidence: `docs/evidence/ai-eval/wave3/agentdojo.json`, `docs/design/wave3/agent-safety/**`.
- **Contracts:** C-02 (reasons), C-07 (`agentScope`), C-12 (seam S1, which it now owns), C-19 (`ai.agent.policy`), C-22 (consumer).
- **Acceptance:**
  - every AGS test title of RFC 0002 §10.1 green (`pnpm exec vitest run --project ai ai/tests/agent.provenance.test.ts ai/tests/agent.policy.test.ts ai/tests/eval.agentdojo.test.ts ai/tests/eval.fixtures.test.ts`; `pnpm exec vitest run --project kernel kernel/tests/agent-scope.test.ts`);
  - the existing AGT-40 reference suite stays at 40/40, and the INJ-20 gates stay green;
  - `docs/evidence/ai-eval/wave3/agentdojo.json` holds both arms (`off` as the baseline, `enforce`), labelled "deterministic, harness".
  - **Numbers** (enforce): AGT-40 40/40; FP-8 ≥ 6/8 (reported); utility under attack ≥ 95 % of twins; targeted ASR 0 for the informed user; 0 destructive and 0 disclosure for blind-yes; confirmation rate ≤ baseline + 0.05; labelling ≤ 2 ms p95; reader checks ≤ 3 ms p95. The post-hoc adaptive round is reported separately.
- **Depends on:** `platform` (0b); the red team's frozen datasets before item 5.
- **Cut line:** (1) reader sets and `widens-readers`; (2) running FP-8 and the INJ-T scope cases in the report. **Never cut:** labels with whole-token U, the O×destructive rule, the narrowed scope, fail-closed EINVAL, harness fidelity, INJ-A, the manifest check.
- **Spec text to supply:**
  - `specs/10-ai/agentic-shell.md`: §3.1 scope, §3.10 to §3.13, §8, §8.2;
  - `specs/10-ai/ai-safety-and-evaluation.md`: L12, L13, the datasets, the metrics, CPL-B-SEC;
  - `specs/12-security/security-model.md`: the threat table and residual risks.

### 5.6 `semantic-fs` (RFC 0003, P0 items 1 to 6)

- **Scope, in order:** the items of RFC 0003 §13.2: `RelationGraph` → `installSemanticFs` and `ai.related` → the cooperative 8 ms context stage → the evaluation over the frozen dataset → the Inspector's Related group, `relatedFor` and the `semsearch` flags → Smart Folders and `smart`.
- **Owned paths:**
  - kernel-side AI: `ai/src/kernel/semfs/**`, `ai/src/kernel/search-service.ts`, `ai/src/kernel/index-store.ts`, `ai/src/search/results.ts` (so `assembleResults` carries `via` and `relatedTo`), `ai/src/search/readable.ts` (only to export the traversal check that `canEnter` reuses);
  - evaluation: `ai/eval/ctx/**` **except** `sessions.json`, `queries-ctx.json` and `MANIFEST.sha256`; `ai/eval/rag/pipeline.ts`; `ai/eval/rag/evaluate.ts`;
  - Smart Folders: `apps/src/smart/**`, `apps/src/index.ts`, `apps/src/tests/smart.test.ts`, `apps/coreutils/cmd/smart.ts`, `apps/coreutils/man/smart.md`, `apps/coreutils/tests/smart.test.ts`, `apps/coreutils/cmd/semsearch.ts`, `apps/coreutils/man/semsearch.md`;
  - Files: `apps/files/lib/related.ts`, `ui/src/apps/files/Inspector.tsx`, `ui/src/apps/files/Inspector.module.css`, `ui/src/apps/files/inspector-related.test.tsx`;
  - tests: `ai/tests/semfs.relgraph.test.ts`, `ai/tests/semfs.related.test.ts`, `ai/tests/semfs.context.test.ts`, `ai/tests/semfs.context.bench.ts`, `ai/tests/eval.ctx.test.ts`;
  - evidence: `docs/evidence/ai-eval/wave3/ctx.json`, `docs/design/wave3/semantic-fs/**`.
- **Contracts:** C-02 (`ai.related`), C-09 (consumer), C-11, C-14 (implementer), C-19 (`ai.fs.*`), C-22 (consumer), C-23.
- **Acceptance:**
  - every CTX and SFS title of RFC 0003 §10.1 marked P0 green, using the commands in that table;
  - `pnpm bench` runs `semfs.context.bench.ts`;
  - on QA (Q-AI-01): `smart new`, `smart ls`, the Inspector's Related group in both themes, and a `chmod` that removes a file from another user's Related list.
  - **Numbers:**
    - CTX-04: Recall@5 with context ≥ content-only − 0.01 and ≥ 0.80, with MRR and nDCG@10 reported;
    - CTX-05: rerank MRR against content-only, recency and directory, by LOSO cross-validation (primary) and on the frozen test half, with paired bootstrap 95 % intervals;
    - CTX-03: 0 leaks;
    - CTX-06: ≤ 8 ms p95;
    - `ai.related` ≤ 5 ms p95; `smart ls` ≤ 350 ms p95 on QA;
    - the name-fallback walk measured on QA, which sets its budget.
- **Depends on:** `platform` (0b); `predictive-cache` (its item 2, for integration; a fake `AccessLogApi` until then); the red team's frozen ctx dataset before item 4.
- **Cut line:** (1) `expand` mode; (2) the directory baseline; (3) the Inspector UI (keep `ai.related` and `semsearch --related`); (4) `smart show` and `smart rm`. **Never cut:** CTX-03 permission rules, the CTX-04 no-harm run, the CTX-02 paper tests, the 8 ms deadline, the frozen-dataset check, `smart ls`.
- **Spec text to supply:**
  - `specs/10-ai/rag-semantic-search.md` (§3.13 to §3.15, §4.1, §7, §8);
  - `specs/07-shell/shell-and-terminal.md` (`smart`, the `semsearch` flags);
  - `specs/04-vfs/virtual-file-system.md` (`~/.config/smart-folders`);
  - `specs/05-wm/ui-design-system.md` (the Inspector's Related group);
  - `specs/10-ai/ai-safety-and-evaluation.md` (AIN-A1, AIN-A4, the CPL-A cells, the ctx dataset, litmus);
  - `specs/08-dsa/data-structures.md`.

### 5.7 `predictive-cache` (RFC 0004, P0)

- **Scope, in order:** the items of RFC 0004 §13.2: the tap call sites → `AccessLog` with filters, the per-account default and pseudonymised export → the LRU `ContentCache` with the kept demand fetch → `mem.prefetch({ino})` without fetching → the file model → the predictor loop and shadow policy → the simulator → `predict` → the composed-kernel tests.
- **Owned paths:**
  - kernel: `kernel/src/core/fs/handlers.ts`, `kernel/src/core/fs/content.ts`, `kernel/src/core/fs/warm.ts`, `kernel/src/core/fs/tests/content-cache.test.ts`, `kernel/src/core/fs/tests/warm.test.ts`, `kernel/src/core/fs/tests/access-tap.test.ts`, `kernel/src/core/proc/mem-syscalls.ts`, `kernel/src/core/io/tests/fac-08-no-ai.test.ts`, `kernel/src/core/io/tests/pfc-02-kernel-line.test.ts` (kernel-only tests; a kernel test may not import `@plotinium/ai`);
  - AI: `ai/src/kernel/files/**`, `ai/src/predictor/files.ts`, `ai/src/predictor/prefetch.ts`, `ai/src/kernel/predict-service.ts`, `ai/src/programs/predictor.ts`, `ai/src/programs/prefetch.ts`;
  - evaluation and command: `ai/eval/cache/**`, `apps/coreutils/cmd/predict.ts`, `apps/coreutils/man/predict.md`;
  - tests: `ai/tests/access-log.test.ts`, `ai/tests/predictor.files.test.ts`, `ai/tests/predictor.files.bench.ts`, `tests/integration/pfc-composed.int.test.ts` (a real kernel with the real AI runtime: FAC-05, PFC-02's AI part, PFC-06, PFC-08, CPL-C-VFS);
  - evidence: `docs/evidence/ai-eval/wave3/cache.json`, `docs/design/wave3/predictive-cache/**`.
- **Contracts:** C-02 (the 7 calls), C-03 (sink and memory implementer), C-04 (`warm.ts`), C-06, C-09, C-10, C-13 (registers), C-19 (`ai.access.*`, `ai.cache.*`), C-23.
- **Acceptance:**
  - every FAC and PFC title of RFC 0004 §10.1 green, using the commands in that table;
  - on QA (Q-AI-02): `free` shows the file cache on the Kernel line; `predict --files`, `--cache` and `--export-files` work; the demo account starts paused; the export contains no ino, path or absolute time.
  - **Numbers:** tap overhead mean ≤ 20 µs and p99 ≤ 100 µs; the `load` hit path ≤ 2 µs per chunk over FIFO; the model update p95 ≤ 50 µs; one prediction ≤ 1 ms p95; a policy decision ≤ 1 ms p95; the synthetic hit ratio for FIFO, LRU and LRU with prediction at 5 cache sizes, and top-1 and top-4 accuracy against MFU and MRU, **labelled "synthetic, not a claim"**; the real-trace collection plan and its start date.
- **Depends on:** `platform` (0b).
- **Cut line:** (1) the MRU-placement ablation; (2) AIN-A4 `warm`; (3) recent files for app jobs; (4) the text forms of `predict`. **Never cut:** the tap, the privacy calls (status, clear, pause, export), the `fs === 'root'` rule, the demo and guest default, the LRU cache with the kept demand fetch, the no-fetch pre-fetch, the simulator.
- **Spec text to supply:**
  - `specs/10-ai/predictive-prefetch.md` (§3.13, §3.14; the hoard advisor deferred);
  - `specs/03-kernel/memory-and-paging.md` (§3.15.3);
  - `specs/04-vfs/virtual-file-system.md` (the LRU cache, the tap);
  - `specs/01-architecture/architecture.md` (§3.10, the seams);
  - `specs/10-ai/ai-safety-and-evaluation.md` (AIN-C1, AIN-C4, AIN-A4, CPL-C-VFS, CPL-C-MEM, the datasets, litmus);
  - `specs/08-dsa/data-structures.md`.

### 5.8 `llm-runtime` (RFC 0005, P0)

- **Scope, in order:** the items of RFC 0005 §13: params, gate, arbiter (deadline and offline rules), invariants and property tests → `llm.stat` (caller-only gate rows, `fallbacks`), `annotate`, `onTerminate`, `llm.context` → `ScheduledFetch`, the factory and the fallback rules → `llmq` → the bench, its integration arm, the scenario test and the report.
- **Owned paths:**
  - kernel and AI: `kernel/src/core/llm/**`, `ai/src/kernel/llm-fetch.ts`, `ai/tests/kernel.llm-fetch.test.ts`;
  - command: `apps/coreutils/cmd/llmq.ts`, `apps/coreutils/man/llmq.md`, `apps/coreutils/tests/llmq.test.ts`, `apps/taskmgr/model.ts`;
  - cross-package tests: `tests/integration/llm-arbiter.int.test.ts`, `tests/integration/llm-scenario.int.test.ts`, `web/src/kernel/llm-composition.test.ts`;
  - evidence: `docs/evidence/ai-eval/wave3/llmq.json`, `docs/design/wave3/llm-runtime/**`.
- **Contracts:** C-02 (`llm.stat`), C-07 (`llm:queue`), C-12, C-19 (`llm.*`), C-23.
- **Acceptance:**
  - every LRT title of RFC 0005 §10.1 green, using the commands in that table;
  - the existing AGT-09 stays green;
  - the scenario test's output (`llmq` and `ps` snapshots) is saved as evidence, labelled "kernel harness".
  - **Numbers** (virtual-clock and integration arms, against the baseline): completion rate (target 100 % whenever the total wait fits the 120 s request cap); p50 and p95 completion time; throughput equal to the gate rate when saturated; Jain's fairness ≥ 0.9; priority separation ≥ 1.5 with no starvation; observed waits never above the INV-L3 bound; 0 leaked slots, reservations or `llm.context` bytes; N = 1 overhead ≤ 1 ms p95. The bench replaces Appendix B's predicted baselines with measured numbers.
- **Depends on:** `platform` (0b).
- **Cut line:** (1) the `llm.context` declaration; (2) the per-uid budget; (3) `llmq` (keep `llm.stat` and WCHAN); (4) the scenario's `pmap` step. **Never cut:** the arbiter with aging and slots, the gate with 429 re-queue, the deadline and offline rules, kill semantics, the bench with its integration arm.
- **Spec text to supply:**
  - `specs/03-kernel/processes-and-scheduling.md` (the LLM arbiter);
  - `specs/03-kernel/memory-and-paging.md` (`llm.context`);
  - `specs/07-shell/shell-and-terminal.md` (`llmq`);
  - `specs/10-ai/ai-safety-and-evaluation.md` (AIN-B3, CPL-B-SCHED and CPL-B-MEM, verbatim from RFC 0005 §16; the LLM bench dataset).

### 5.9 The non-builder paths (verification half)

| Role                             | Owned paths                                                                                                                                                                              |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Red team                         | `ai/eval/agentdojo/cases/**`, `ai/eval/agentdojo/posthoc/**`, `ai/eval/ctx/sessions.json`, `ai/eval/ctx/queries-ctx.json`, `ai/eval/ctx/MANIFEST.sha256`, `docs/design/wave3/redteam/**` |
| QA                               | `tests/e2e/gdrive.spec.ts`, `tests/e2e/wave3-ai.spec.ts`, `tests/e2e/wave3-regression.spec.ts`, `tests/a11y/wave3.spec.ts`, `docs/design/wave3/qa-*/**`                                  |
| Reviewers, verifiers, final gate | their own report files under `docs/design/wave3/<key>/` only                                                                                                                             |
| Fixers                           | the owned paths of the builder whose defects they fix (§7.5)                                                                                                                             |

## 6. Ownership hot spots (the disjointness check)

The verifier diffs the tree against the L-5 snapshot and checks each changed file against the lists in §5. These are the files most at risk of a second writer:

| File                                                        | Owner                                         | Others must                                                                         |
| ----------------------------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------- |
| `kernel/src/core/fs/kfs.ts`                                 | platform                                      | hand off (predictive-cache uses `warm.ts`; the Drive router never touches `kfs.ts`) |
| `kernel/src/core/io/index.ts`, `io/vfs.ts`                  | platform                                      | hand off                                                                            |
| `kernel/src/core/fs/handlers.ts`                            | predictive-cache                              | not touch it: the Drive router wraps the handlers through `HandlerRegistry`         |
| `ai/src/kernel/install.ts`, `web/src/kernel/ai-link.ts`     | platform                                      | hand off                                                                            |
| `ai/src/kernel/agent-service.ts`                            | agent-safety (after the step-0 seam)          | llm-runtime never edits it                                                          |
| `apps/files/lib/controller.ts`, `FilesView.tsx`, `types.ts` | gdrive-ui (after the step-0 Related plumbing) | semantic-fs edits only `related.ts` and `Inspector.tsx`                             |
| `apps/coreutils/index.ts`, `lib/argspec.gen.ts`             | platform                                      | hand off ("regenerate")                                                             |
| `apps/coreutils/lib/fs.ts`, `lib/errors.ts`                 | gdrive-kernel                                 | others use them; changes by handoff                                                 |
| `specs/**`, `CHANGELOG.md`, `AI_USAGE.md`, `SECURITY.md`    | platform                                      | hand off text                                                                       |
| `server/src/app.ts`, `db/migrations/**`                     | gdrive-server                                 | no other Wave-3 builder needs them                                                  |

## 7. The verification half

About half of the roster reviews, red-teams, verifies and fixes:

| Group      | Count        | Agents                                         |
| ---------- | ------------ | ---------------------------------------------- |
| Builders   | 8            | the builders of §5                             |
| Reviewers  | 8            | §7.1                                           |
| Red team   | 1 to 2       | §7.2                                           |
| QA         | 3            | `qa-gdrive`, `qa-ai`, `qa-regression`          |
| Verifiers  | 3            | `verify-drive`, `verify-ai`, `verify-platform` |
| Fixers     | 3            | `fix-drive`, `fix-ai`, `fix-platform`          |
| Final gate | 1            | `gate`                                         |
| **Total**  | **27 to 28** |                                                |

### 7.1 Reviewers: one per feature group, each with a lens

Drive gets two, because it has three builders and the top priority. A cross-cutting UX reviewer covers every UI surface.

| Key                    | Covers                                                    | Focus lens                                                                                                                                                                                                                                                                                                                                |
| ---------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rev-gdrive-sec`       | gdrive-server, gdrive-ui                                  | security and privacy: OAuth and OIDC (`state`, nonce, PKCE, `iss`), CSRF on completion, the Service Worker and Caddy `/oauth` exclusions, sealing and AAD, the revocation rule and its persistence, secrets in the repo, bundle, logs and fixtures, redaction, the account policy, the fake's isolation from production, the consent text |
| `rev-gdrive-vfs`       | gdrive-kernel                                             | VFS and kernel semantics: router transparency (existing suites unchanged), `RemoteFdTable` correctness (numbering, `dup2`, `spawn`, the kill path), namespace isolation (root and other uids, agent and system classes), the errno mapping, charged memory, the 8 ms rule, `-xdev` walkers, conflict detection                            |
| `rev-agent-safety`     | agent-safety                                              | adversarial AI safety and evaluation validity: label soundness, the U whole-token rule, the policy never removing a required confirmation, harness fidelity to the kernel, manifest-frozen cases, honest arms                                                                                                                             |
| `rev-semantic-fs`      | semantic-fs                                               | RAG-03 permission safety (the BFS never enters unreadable nodes), evaluation methodology (fixed α and P, LOSO, the test half used once), the kernel-worker budget, Smart Folder data safety                                                                                                                                               |
| `rev-predictive-cache` | predictive-cache                                          | the stream's privacy invariants I-F1 to I-F8, PRE-04 speculative rules, the no-fetch pre-fetch, memory accounting, the export's pseudonymisation, synthetic-versus-claim honesty                                                                                                                                                          |
| `rev-llm-runtime`      | llm-runtime                                               | concurrency and scheduling invariants INV-L1 to INV-L6, kill and stop ordering, the deadline and offline rules, bench validity (the integration arm is not tautological)                                                                                                                                                                  |
| `rev-platform`         | platform                                                  | ABI and registry conformance (ABI-11, `ABI_VERSION` 2, the errno lists), package boundaries, stub transparency, handoff discipline, fence correctness (server fences only; 0 never on the wire), the CHANGELOG                                                                                                                            |
| `rev-ux-a11y`          | gdrive-ui, semantic-fs (the Inspector), the callback page | WCAG 2.2 AA, keyboard and focus order (heading-first sheet), strict CSP with 0 enforced violations, both themes, reduced motion and transparency, Liquid Glass identity, errors in words                                                                                                                                                  |

Each reviewer reads the builder's diff (against the L-5 snapshot), the RFC and this plan, and writes findings (MUST, SHOULD, NIT) in `docs/design/wave3/<key>/review.md`. A MUST blocks the gate until it is fixed or the lead waives it in writing.

### 7.2 Red-team scope

**Before the build**, in parallel with step 0: author and freeze the datasets of C-22.

- The INJ-A, INJ-T and FP-8 cases, with benign twins, in the INJ-20 schema. INJ-T includes the `/mnt/share` volume-name case.
- The 24 ctx sessions, then the 20 ctx queries.
- A `MANIFEST.sha256` per folder.
- The authors never see the builders' code.

**After the build**, attack the approved scope on :4718 and in tests. Findings go in `docs/design/wave3/redteam/`, each with a reproduction and a severity.

- **Drive:**
  - account-linking CSRF, state replay, cross-session state, `iss` and nonce tampering, a stale or used launch id, open redirect through the launch or callback;
  - the Service Worker serving the shell for `/oauth` once the Service Worker is registered, and a missing callback page;
  - SSRF through Drive ids and `%2F`;
  - a forged `X-Plotinium-Principal`;
  - `su`, guest, demo and root refusals;
  - hostile names (ESC, bidi, NUL, lone surrogates) in the Terminal and in Files;
  - quota exhaustion through walkers and Files search;
  - tokens or codes in logs, the bundle or fixtures;
  - revocation scope: account-in-use, a narrowed reconnect, the `drive:revoke-all` origin check;
  - memory exhaustion through large opens.
- **Agent:** the post-hoc adaptive round of at least 5 cases against the final policy (reported separately); scope escapes when started in `/`, `/home` or `/mnt`; short-basename U-label abuse; payload and `chown` rules; policy-off visibility.
- **AI file features:** leaks through context rerank and expand and `ai.related` (another user's files, `chmod` after use, foreign files); cross-uid read, clear and pause of the access stream; re-identifying an export (join pseudonyms to inos); scan-guard flooding; pre-fetch triggering a network fetch.
- **LLM runtime:** priority abuse (nice below 0 without root), budget-exhaustion DoS across processes, `llm.stat` leaking other uids, kill and stop races that leak slots or reservations.
- **Platform:** a forged or foreign fence must never grant; fence 0 or a local fence on the wire; `sync.fenceWrites` settable by non-root.
- **Out of scope:** real Google; the user's :4717 instance; social engineering; DoS of shared infrastructure; changes to production code (the red team reports, and fixers fix).

### 7.3 QA scenarios (on :4718, rebuilt from the final tree; fake Google from L-2)

Every browser scenario uses the QA README's rules:

- its own session file;
- a `securitypolicyviolation` listener that records `disposition` and gates on `enforce` only;
- console errors and failed requests captured;
- both themes; 1440×900, plus 1280×800 and 1920×1080 where layout matters; reduced motion;
- screenshots read.

**Drive scenarios:**

| Id      | Scenario                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Q-GD-01 | **Drive end to end against the fake Google.** Boot the OS and wait until the Service Worker controls the page (if UI-007 is still open, record that and run without it). Then: Settings › Internet Accounts › Connect Google Drive; read the disclosure (focus lands on the heading); Continue; the popup shows the fake consent; Allow; the callback page shows "Connected as …"; the popup closes; the sheet updates. Files shows Google Drive under Locations with its capacity bar and status. Create the folder `viva`, copy `~/notes.md` in, open it in the Editor, edit and save. In the Terminal: `ls -l /mnt/gdrive/viva`, `cat`, `cp`, `df -h`, `mount`. `rm -r /mnt/gdrive/viva` shows the trash message. Disconnect: the volume disappears, and `ls /mnt/gdrive` gives ENOENT. Throughout: `crossOriginIsolated === true` in both windows; 0 enforced CSP violations; the fake's request log shows the expected calls; `/api/drive/status` carries no token. |
| Q-GD-02 | Popup blocked (a Playwright popup block) → "Your browser blocked the Google window" → the second-click button completes the flow.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Q-GD-03 | Cancel at the fake consent screen gives "Not connected". Unticking Drive access gives the scope-denied sentence, and the fake's log shows **no** `/revoke`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Q-GD-04 | Revoke the grant through the fake's admin hook → the Files row and Settings show "Needs attention" → Reconnect succeeds.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Q-GD-05 | `context.setOffline(true)`: the Offline status and banner appear; loaded folders still list; opening a file gives "This file isn't available offline"; a save fails fast with the offline sentence; back online, everything recovers.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Q-GD-06 | Isolation: alice is connected. Bob's session and a root `su` shell see no `/mnt/gdrive` and no `gdrive` in `ls /mnt`. Bob with a forged `X-Plotinium-Principal: alice` gets 403 on every Drive route. A root subscriber receives no `mount.*` event of alice's.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Q-GD-07 | The account policy: guest and demo cannot connect (the message is in words); examiner1 can.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Q-GD-08 | Walkers: `find / -name x`, `du -s /`, `grep -r needle /` and a Files search at `/` each cause **0** list or download calls at the fake for the Drive folder (E9).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Q-GD-09 | Conflict: edit `hello.txt` through the fake's "another device" hook, then save the stale Editor buffer → "hello (conflict from …).txt" appears, and both versions are intact.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Q-GD-10 | Callback hardening: open `/oauth/drive/callback.html?code=x&state=y` directly with the Service Worker controlling → the callback page, not the shell; the query is removed; COOP, COEP, CSP and `Referrer-Policy: no-referrer` are present; `/oauth/missing.html` gives 404, not the shell.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Q-GD-11 | A persisted revoke: make the fake's `/revoke` answer 5xx, disconnect (the answer is `revoked: queued`), restart `app` through `qa-compose.sh up -d --wait app`, restore the fake → the revoke completes (fake log and audit row).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

**AI, platform and cross-cutting scenarios:**

| Id         | Scenario                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q-AI-01    | Semantic FS: `smart new`, `ls`, `show` and `rm`; `semsearch --related`, and `--no-context` as an A/B; the Files Inspector's Related group with reasons in words; bob's `chmod 600` removes a file from alice's Related list; both themes.                                                                                                                                                |
| Q-AI-02    | Predictive cache: `free` shows the file cache on the Kernel line; open A → B → C a few times, then `predict --files` ranks C after A → B; `predict --cache`; pause and clear; the demo account starts paused; the `predict --export-files` output has no ino, path or absolute time; with root setting `ai.cache.prefetch=on`, `ps` shows `prefetch:filecache` at PRI 39 after 2 s idle. |
| Q-AI-03    | Agent safety: `ai status` shows the policy mode when it is not `enforce`; the `ai` command's honest unavailable message is unchanged (X2); attach the harness and composed-kernel test outputs as evidence.                                                                                                                                                                              |
| Q-AI-04    | LLM runtime: `llmq` on an idle system; `ps -o pid,pri,ni,stat,wchan,comm` unchanged; attach the scenario test's output as evidence.                                                                                                                                                                                                                                                      |
| Q-PLT-01   | Fences: the existing `tests/e2e/lock-contention.spec.ts` passes. If UI-006 is linked on QA, record the WebSocket frames of an Editor save while holding the lock: the op carries a `fences` entry equal to the lease's fence, and after root runs `sysctl -w sync.fenceWrites=off` it carries none.                                                                                      |
| Q-REG-01   | Full desktop regression in both themes, at 3 viewports, with reduced motion and reduced transparency: boot, login, desktop, Files, Editor, Terminal, Settings (including Internet Accounts), Task Manager. 0 enforced CSP violations, 0 console errors, and no layout regressions against the `docs/design/wave3/design-*` baselines.                                                    |
| Q-A11Y-01  | axe on the connect sheet, the callback page, the Files Drive row, the `VolumeNotice`, the Inspector's Related group and Settings › Internet Accounts, in both themes; a keyboard-only connect flow; focus order and live-region announcements.                                                                                                                                           |
| Q-AIOFF-01 | AI off (composed-kernel tests, plus the AI-off build if it is available): Drive works fully with AI surfaces hidden; `smart` works by name with the notice; `ai.related` answers ENOSYS; no access events are recorded; `llm.stat` exists and is idle.                                                                                                                                   |
| Q-SEC-01   | Secret scan: the GDRV-03 scanner (the `.gitleaks.toml` patterns) over the repository, `web/dist` and the fixtures finds 0 hits. `qa-compose.sh logs app` after Q-GD-01 contains no code, state, token or client secret.                                                                                                                                                                  |
| Q-PERF-01  | Budgets: `web/dist/boot-budget.json` unchanged; `tokens.css` ≤ 5,120 B gzip; a cold 1,000-entry fake listing p95 ≤ 300 ms; no kernel long task > 8 ms during a Drive listing or a semsearch (performance trace).                                                                                                                                                                         |

### 7.4 Verifiers

Verifiers independently re-run every acceptance command in §5 for their area from a clean shell, rebuild QA if needed, and compare the numbers with the builders' reports. They also:

- check `db/schema.sql` and `types.gen.ts` against the migrated QA database (`verify-drive`);
- run the ownership audit against the L-5 snapshot (`verify-platform`).

A mismatch is a finding for the fixer.

### 7.5 Fixers

- A fixer inherits the owned paths of the builders in its area only after they have reported: `fix-drive` takes the three gdrive builders, `fix-ai` takes agent-safety, semantic-fs, predictive-cache and llm-runtime, and `fix-platform` takes platform.
- Fixes follow the same checks and rules. A fix that needs another owner's file is a handoff.
- Every fix names the finding id it closes.

## 8. The final gate (`gate`)

All of these must hold, run on the final tree:

1. `pnpm format:check`, `pnpm lint` and `pnpm typecheck` are green.
2. `pnpm test` is green: more tests than today's 3,910, and 0 failures.
3. `pnpm exec vitest run --config tests/vitest.config.ts` passes for the harness and the integration projects. DB-gated suites run only where the lead provides a throwaway database. Skipped suites are counted and reported, and a skip is never counted as verified.
4. `pnpm --filter @plotinium/web build` passes, and the web build tests (boot budget, CSP hashes, the callback page, the Service Worker routes) are green.
5. `pnpm exec vitest run --project protocol` passes: ABI-11 with 132 calls and `ABI_VERSION` 2, and a CHANGELOG ABI entry exists.
6. `pnpm traceability` passes: 0 unregistered IDs, and every Wave-3 requirement built in this wave (§4) has at least one test.
7. Every QA scenario in §7.3 passes on :4718, rebuilt from the final tree, with 0 enforced CSP violations and the screenshots read. A scenario blocked by a stabilize bug (UI-006, UI-007) or by L-2 is recorded as blocked with its reason, never as passed.
8. The evidence files exist (`docs/evidence/ai-eval/wave3/{agentdojo,ctx,cache,llmq}.json`), and each RFC's evaluation table holds measured numbers with labels (synthetic, harness, kernel harness).
9. No reviewer or red-team MUST finding is open, unless the lead has waived it in writing.
10. The ownership audit is clean, and every handoff is applied or answered.
11. The doc PR or spec patches exist, with `AI_USAGE.md`, `CHANGELOG.md` and `SECURITY.md` updated.
12. An honest wave report lists each builder's commands and outcomes, what was not finished, and the deferred items.

## 9. Schedule and critical path

```text
L-1 close-out ─► L-5 snapshot ─► platform 0a (≤ 45 m) ─► platform 0b + gate (≈ 3 h) ─► builders integrate (≈ 5 h)
                                     │                                                          │
                                     ├─► builders start new-file work (their own new files)     │
                                     └─► red team authors and freezes the datasets (≈ 1.5 h)    │
reviews as each builder reports ─► QA and red team on :4718 ─► verifiers ─► fixers ─► platform doc PR ─► final gate
```

- **The critical path is step 0.** `platform` does nothing else until 0b's gate is green.
- **Parallelism after 0b:** all seven builders run at once.
  - `semantic-fs` integrates with `predictive-cache` once the latter's item 2 lands, and uses a fake until then.
  - `gdrive-ui`'s live test needs `gdrive-kernel`'s handlers, and the Drive E2E needs L-2.
- **CPU:** builders run scoped tests only. Full runs belong to `platform`'s step-0 gate and to the final gate.

## 10. Lead tasks after Workflow B (not builders)

- Real-Google spikes S1, S3, S4 and S5 in the `plotinium-qa` Cloud project; examiners' emails as test users.
- R1's kernel TTY and process path (X2).
- The evaluation rate class for live agent runs.
- RFC 0001 P1b.
- RFC 0006 (b) and (c).
- The server semaphore-before-pools change (RFC 0005 §15 Q8).
- The research-report annotations (S-R-01 to S-R-03).
- Real-trace collection for PFC-04 and PFC-05 before the P3 gate.

## 11. Dependency requests

None. Everything uses what the repository already has:

- plain `fetch` for the Google REST API;
- `node:crypto` for AES-256-GCM, SHA-256 and HMAC;
- `node:http` or the existing Fastify for the fake Google;
- the team's `dsa/` structures;
- the existing Valibot, Vitest, fast-check and Playwright.

## 12. Risk register

| #   | Risk                                                                                                  | Likelihood | Impact | Owner                           | Mitigation                                                                                                                                            | Trigger                                                     |
| --- | ----------------------------------------------------------------------------------------------------- | ---------- | ------ | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| R1  | Step 0 is late or cannot go green, and every builder waits                                            | medium     | high   | platform, lead                  | 0a first (45 m) unblocks new-file work; a mechanical checklist; `platform` does nothing else; cut item 27 (the Related plumbing) before anything else | 0b not green 4 h after 0a                                   |
| R2  | The specs are Frozen, and the ABI rows or spec text need ADRs and instructor approval                 | medium     | medium | lead                            | L-3 and L-4 before step 0; every feature is off unless configured, or in shadow; spec patches instead of edits                                        | the instructor has not replied by the start of step 0       |
| R3  | The stabilize close-out leaves shared files moving (`io/index.ts`, `content.ts`, `factory.ts`, Files) | medium     | high   | lead                            | Workflow B starts after the close-out (L-1); every builder re-verifies its citations (X10)                                                            | diffs in owned files that the builder did not make          |
| R4  | UI-006 or UI-007 is not landed on QA, so fences are inert and the Service Worker is not registered    | medium     | low    | lead                            | unit tests prove the behaviour; the QA scenarios record "blocked" honestly; the Service Worker fix holds either way                                   | `svcctl` shows sync degraded; `getRegistrations()` is empty |
| R5  | The QA fake Google (L-2) arrives late                                                                 | low        | medium | lead                            | the Drive E2E is `fixme` with a reason; unit and contract suites still gate                                                                           | L-2 not done when QA starts                                 |
| R6  | The agent pipeline cannot run in the product (X2)                                                     | certain    | medium | lead (R1)                       | harness and composed-kernel evidence, labelled; schedule R1's fix                                                                                     | –                                                           |
| R7  | The handoff desk becomes a bottleneck at `platform`                                                   | medium     | medium | platform, lead                  | builders batch handoffs; blocking ones are applied within 30 minutes or go to the lead; most shared work is front-loaded in step 0                    | more than 5 open blocking handoffs                          |
| R8  | The mount router regresses local fs behaviour                                                         | low        | high   | gdrive-kernel, rev-gdrive-vfs   | a transparent decorator; a same-arguments test; the full kernel suite; the reviewer's lens                                                            | any existing kernel or vfs test fails                       |
| R9  | `RemoteFdTable` bugs around `dup2` or `spawn`                                                         | medium     | medium | gdrive-kernel                   | explicit GDRV-05 fd tests; the reviewer's lens; P1-thin is read-only, so nothing is lost                                                              | fd tests fail or QA sees EBADF                              |
| R10 | The `ABI_VERSION` bump breaks a mixed-cache client                                                    | low        | medium | platform                        | `hello {abi, digest}` refuses mixed peers by design; a full rebuild; the CHANGELOG                                                                    | "peer refused" in QA logs                                   |
| R11 | Secrets leak through logs, fixtures or the bundle                                                     | low        | high   | gdrive-server, rev-gdrive-sec   | secrets outside the checkout; the GDRV-03 tests; Q-SEC-01; `.gitleaks.toml`                                                                           | any scanner hit                                             |
| R12 | The evaluation data is AI-authored and optimistic                                                     | high       | medium | red team, builders              | independent authors, frozen hashes, a post-hoc adaptive round, honest labels, real traces later                                                       | –                                                           |
| R13 | 10 agents contend for 12 CPUs, and the QA copy is rebuilt by several agents                           | high       | low    | all                             | scoped test runs; `qa-compose.sh` serialises rebuilds; retry after outages                                                                            | timeouts                                                    |
| R14 | Scope creep outside owned paths                                                                       | medium     | medium | reviewers, verify-platform      | the ownership audit against L-5; reviewers reject out-of-scope diffs                                                                                  | the audit finds a foreign write                             |
| R15 | Memory pressure from Drive snapshots or AI structures                                                 | low        | medium | gdrive-kernel, predictive-cache | charged snapshots; Kernel-line reporting; caps                                                                                                        | `free` shows unexpected Kernel-line growth                  |

## 13. Open questions for the lead

| #   | Question                                                                                                                                                                                                                                                                                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Q1  | Are the specs Frozen? If they are, the lead needs ADRs for RFC 0001 and for the Wave-3 ABI additions, plus the instructor's approval, **before step 0 merges the ABI-11 rows**. The alternative is to accept that step 0 lands them as a Draft-spec change, reverted if the approval is refused. |
| Q2  | Schedule R1's kernel TTY and process syscalls (X2)? Without them, RFCs 0002 and 0005 stay harness-only, and the Terminal's `ai` never runs the agent.                                                                                                                                            |
| Q3  | Approve the L-2 QA override contents: the fake Google environment, secrets under `~/.config/plotinium/secrets/qa/`, and the port `127.0.0.1:4799`.                                                                                                                                               |
| Q4  | Is the repository private? This decides whether consented, pseudonymised traces may be committed (RFC 0004 §10.2).                                                                                                                                                                               |
| Q5  | After Workflow B, create the `plotinium-qa` Cloud project (later `plotinium-local`), with no billing, and collect the examiners' Google emails for the real-Google stage?                                                                                                                        |
| Q6  | When, and with which rate class and budget, may agent-safety's live evaluation run (RFC 0002 §11)?                                                                                                                                                                                               |
| Q7  | Instructor questions: does AGT-06 count a rejected plan (RFC 0002 Q1)? Does RAG-04 stay claimed on the content-only configuration (RFC 0003 Q2)? May Subsystem C be extended to files (RFC 0004 Q2)? Is a widened reader set "irreversible" (RFC 0002 Q3)?                                       |
| Q8  | Add a 9th builder for RFC 0006 (b) and (c)? The design is accepted and ready, and it would take about 5 hours.                                                                                                                                                                                   |
| Q9  | Schedule RFC 0001 P1b for Wave 4: descriptor writes with the device-local failure store, Eject, exports, `.Trash`, ranged reads, the changes feed, and the shared content cache.                                                                                                                 |
| Q10 | The ARB could not write the `AI_USAGE.md` entry for the design wave (designers, critics, ARB) or annotate the research report (S-R-01 to S-R-03). Either the lead does it now, or `platform` does it in its doc PR.                                                                              |
