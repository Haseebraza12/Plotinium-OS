# ADR 0001: Google Drive as a per-user mounted volume

| Field      | Value                                                                                                                                                                                                                              |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status     | **Proposed**. Needs the instructor's written approval (spec §14.4: the stack is frozen after the Phase 1 defence). Until then, the feature ships **off**: `GDRIVE=auto` stays inert while no `GOOGLE_*` credentials are configured |
| Date       | 2026-09-30                                                                                                                                                                                                                         |
| Deciders   | The team (R1–R5). Drafted by the Wave 3 lead agent from the approved RFC. AI-generated, disclosed in `AI_USAGE.md`                                                                                                                 |
| Supersedes | Nothing. This adds to the stack; it changes no frozen decision                                                                                                                                                                     |
| Design     | [RFC 0001](../rfcs/0001-google-drive-volume.md) (APPROVED-WITH-CUTS by the Wave 3 ARB), [build plan](../rfcs/PLAN.md), [research](../research/google-drive-integration.md), [reviews](../rfcs/reviews/)                            |

## Context

Users asked to reach their own cloud files from inside Plotinium, "like an SSD". The capstone specification already reserves `/mnt` for "optional mount points (shared or cloud)". Plotinium's rules must still hold:

- keys stay on the server;
- secrets never go in the repository;
- the CSP stays strict (with COOP and COEP);
- every file access goes through the kernel and the VFS;
- third-party code carries a licence.

## Decision

Build **P1-thin** of RFC 0001: each Plotinium user can connect **their own** Google account, and it appears as a volume at `/mnt/gdrive`.

**Mount and visibility.** The mount is per user, visible only to that user. The agent and system process classes cannot see it.

**Operations.** Files, the Terminal and the Editor can use it for:

- listing, `stat`;
- whole-file reads up to 8 MiB, charged to the reader's memory budget;
- writes up to 5 MiB, with a base-version check and a conflicted copy;
- `mkdir`, rename, and moving to the Drive trash;
- `df`.

**Connecting.** Settings > Internet Accounts starts OAuth 2.0 in a popup:

- scopes `openid` and `drive.file` only;
- PKCE S256, a session-bound single-use `state`, and a `nonce`;
- a static same-origin callback page that finishes with a same-origin POST.

No token ever reaches the browser.

**Server side.** The server alone holds refresh tokens:

- sealed with AES-256-GCM under a key-encryption key read from a `*_FILE` secret stored outside the checkout;
- Drive calls go through a server proxy;
- revocations are persisted;
- on disconnect the server revokes the token, purges caches and deletes the tokens.

**Development and QA.** They use a **hermetic fake Google** OAuth and Drive server. Real Google is needed only for the final spikes.

**Deferred to later waves (each needs its own ARB approval):** descriptor writes, Eject, Workspace exports, `.Trash`, ranged reads, the changes feed, the shared cache (P1b); agent access to Drive (P2).

## Consequences

**New server surface.** Three tables in one migration (`20261001100000_drive_accounts.sql`) and eleven `/api/drive/*` routes. The feature flag is `GDRIVE` (`auto` · `0` · `1`).

**Kernel ABI.** Four new calls (`mount.list`, `drive.status`, `drive.connect`, `drive.disconnect`) and two bus topics (`mount.state`, `mount.change`). They are counted in [ADR 0002](0002-wave3-abi-and-ai-features.md).

**Compliance.** Google's API Services User Data Policy (Limited Use) applies. The connect sheet shows the Limited Use statement verbatim. Drive content is **not** sent to the LLM in this wave.

**Operations.** A Google Cloud project, a consent screen in Testing mode (at most 100 test users; refresh tokens expire after 7 days in Testing) and credentials. The runbook is `docs/runbooks/google-drive.md`.

**Risks and mitigations** (RFC 0001 §14 and PLAN §12):

- token leakage: vault, redaction, secret scanning;
- local file-system regressions from the mount router: a transparent decorator, plus the full kernel and VFS suites;
- memory pressure from snapshots: charged and capped.

## Alternatives considered

- **`drive.readonly` or `drive` with a full-Drive view.** These scopes are restricted: production needs Google verification and a CASA assessment, so they were rejected for now.
- **The Google Picker with `drive.file` in the browser.** Its iframes and scripts conflict with COEP `require-corp` and the strict CSP, so it was rejected.
- **Browser-side tokens.** They break the "keys stay on the server" rule, so they were rejected.

## Approval

| Role       | Name | Date | Decision |
| ---------- | ---- | ---- | -------- |
| Instructor |      |      |          |
| Team lead  |      |      |          |
