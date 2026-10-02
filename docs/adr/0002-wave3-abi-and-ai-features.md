# ADR 0002: Wave 3 system-call ABI v2 and research-backed AI features

| Field    | Value                                                                                                                                                                                                                                                                                                                                                              |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Status   | **Proposed**. Needs the instructor's written approval (spec §14.4). Every behaviour below sits behind a sysctl or env flag. With every flag off, today's behaviour is unchanged, and that setting is also the baseline arm of each evaluation                                                                                                                      |
| Date     | 2026-09-30                                                                                                                                                                                                                                                                                                                                                         |
| Deciders | The team (R1–R5). Drafted by the Wave 3 lead agent from the ARB-approved RFCs. AI-generated, disclosed in `AI_USAGE.md`                                                                                                                                                                                                                                            |
| Design   | [RFC 0002](../rfcs/0002-agent-provenance-undo-and-isolation.md), [RFC 0003](../rfcs/0003-semantic-smart-folders-and-context-search.md), [RFC 0004](../rfcs/0004-predictive-file-cache-and-hoarding.md), [RFC 0005](../rfcs/0005-llm-as-a-scheduled-resource.md), [RFC 0006](../rfcs/0006-leases-fencing-and-glass-legibility.md), [build plan](../rfcs/PLAN.md) §4 |

## Context

The capstone grades AI integration depth: the four AI-native properties and the coupling map in `specs/10-ai/ai-safety-and-evaluation.md`. Recent research points to OS-level ways to deepen the three AI subsystems we already have:

- **Agentic shell:** CaMeL, GoEX, IsolateGPT, AgentDojo.
- **Semantic search:** Semantic File Systems, LSFS, Connections.
- **Predictive pre-fetch:** Kroeger & Long, FALCON, Coda.

It also points to treating LLM calls as a scheduled kernel resource (AIOS, MemGPT). Every one of these adds kernel calls, so the syscall ABI (ABI-11) changes.

## Decision

1. **ABI version 2.** `ABI_VERSION` goes from 1 to 2 once, in step 0 of Workflow B, and the registry grows from 119 to 132 calls. The 13 new calls are listed in PLAN §C-02:
   - Drive and mounts ([ADR 0001](0001-google-drive-volume.md)): `mount.list`, `drive.status`, `drive.connect`, `drive.disconnect`;
   - file access: `ai.access.read`, `ai.access.status`, `ai.access.clear`, `ai.access.pause`, `ai.access.export`;
   - file prediction: `ai.predict.files.publish`, `ai.predict.files`;
   - `ai.related`;
   - `llm.stat`.

   The `ai.*` calls answer ENOSYS in the AI-off build. No new capability is added. `hello{abi,digest}` refuses mixed peers.

2. **Agent provenance and policy (RFC 0002, P0).**
   - Every value the agent sees carries a provenance label: U (user), K, O (observation) or M.
   - An observation-derived target on a destructive operation is rejected.
   - The policy fails closed with EINVAL `policy-error`.
   - An agent started in `/`, `/home` or `/mnt` gets a narrower scope.
   - The policy mode (`ai.agent.policy`: `enforce`, `shadow` or `off`) is shown whenever it is not `enforce`.
   - An AgentDojo-style benchmark measures utility and attack success, on cases the red team froze before the build.
3. **Context search (RFC 0003, P0).**
   - A Connections-style relation graph built from file-access events;
   - the `ai.related` call;
   - a context re-rank bounded to 8 ms (`ai.fs.context`, default `off`);
   - Smart Folder definitions and the `smart` command.
4. **File access log and predictive cache (RFC 0004, P0).**
   - One per-user, inode-only access stream. Demo and guest accounts start paused, and the log can be viewed, cleared and exported pseudonymised.
   - A file-level Witten-Bell/PPM predictor.
   - An LRU content cache on `dsa/lru` where pre-fetch never fetches from the network.
   - A trace-driven evaluation against LRU.
5. **LLM arbiter (RFC 0005, P0).**
   - A kernel queue on `dsa/heap` with aging and 2 slots, a per-uid token-bucket gate, reserve-and-settle budgets, deadline and offline refusal, and kill semantics.
   - Shown through `llm.stat` and `llmq`.
6. **Lease fencing (RFC 0006 (a)).** Client commits carry the lease's fence token (`sync.fenceWrites`, root-only), so a client whose lease expired can never overwrite newer data.

## Consequences

**Evidence.** Evaluation numbers go to `docs/evidence/ai-eval/wave3/*.json` and are labelled synthetic, harness or kernel harness. Real traces are collected only after the wave, with consent.

**Agent evidence is harness-only for now.** The agent pipeline cannot yet run from the Terminal: X2, the kernel TTY path. That path is scheduled as its own RFC (0007) for Wave 4. Until then, evidence for RFCs 0002 and 0005 comes from the harness and from composed-kernel tests.

**Deferred:**

- RFC 0002 P1/P2 (typed confirmation, `ai undo`);
- RFC 0003 P1 (the sidebar section; `/mnt/smart` was rejected);
- RFC 0004 hoarding;
- RFC 0005 P1/P2 (snapshot/restore, archival memory);
- RFC 0006 (b)/(c): adaptive glass and Dock motion, now scheduled as their own builder in Workflow B.

## Alternatives considered

- **Shipping the features without an ABI bump, through reserved calls.** It would hide an interface change from the traceability checks, so it was rejected.
- **Enabling the features by default.** It was rejected: approval is pending, and an `off` arm is needed for the evaluations.

## Approval

| Role       | Name | Date | Decision |
| ---------- | ---- | ---- | -------- |
| Instructor |      |      |          |
| Team lead  |      |      |          |
