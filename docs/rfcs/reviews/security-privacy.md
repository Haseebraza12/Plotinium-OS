# Security and privacy review of RFCs 0001 to 0006

| Field    | Value                                                                                                                                                                                                                                                 |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reviewer | critic-security (Wave 3 design track; AI-assisted, to be disclosed in `AI_USAGE.md` by the lead)                                                                                                                                                      |
| Date     | 2026-09-30                                                                                                                                                                                                                                            |
| Scope    | [RFC 0001](../0001-google-drive-volume.md) to [RFC 0006](../0006-leases-fencing-and-glass-legibility.md) and [docs/research/google-drive-integration.md](../../research/google-drive-integration.md)                                                  |
| Baseline | `specs/12-security/security-model.md`, `specs/10-ai/ai-safety-and-evaluation.md`, `specs/11-server/backend-api.md`, the capstone spec (§12.6 "Keys stay on the server", §18 "Secrets never go in the repository", "Third-party code needs a licence") |
| Method   | Every claim below was checked in the working tree (file:line) or on an official page fetched on 2026-09-30. RFC text was not trusted. Nothing in the RFCs was edited: the ARB applies the changes.                                                    |

Severity scale:

- **MUST-FIX**: the design is unsafe, breaks a stated promise to the user, or breaks a capstone rule. The RFC cannot be approved until the change is in the text.
- **SHOULD-FIX**: a real weakness with a cheap fix. Approve only with the change, or with a written reason in the review log.
- **NIT**: wording, test coverage or hardening. The builder can take it without an RFC change.

## 1. Verdicts

| RFC      | Verdict                                                                                        | MUST-FIX | SHOULD-FIX | NIT |
| -------- | ---------------------------------------------------------------------------------------------- | -------: | ---------: | --: |
| 0001     | **Not approvable as written.** Approve after S-0001-01 to S-0001-05 are in the text.           |        5 |          9 |  10 |
| 0002     | Approve with changes                                                                           |        0 |          2 |   2 |
| 0003     | Approve with changes                                                                           |        0 |          1 |   2 |
| 0004     | Approve with changes                                                                           |        0 |          3 |   2 |
| 0005     | Approve P0. P1 snapshot/restore only with S-0005-01. P2 stays gated on its own privacy review. |        0 |          1 |   4 |
| 0006     | Approve (security-neutral)                                                                     |        0 |          0 |   2 |
| Research | Accurate on every [F] item I re-checked; one material gap feeds S-0001-01                      |        0 |          1 |   2 |

No RFC adds a third-party dependency, so there is no licence or supply-chain finding. The RFCs reuse `dsa/tree`, `dsa/lru`, `dsa/heap`, `dsa/hashtable` and `dsa/ringbuffer` and never replace them with a library (spec §10.2).

The single most important cross-cutting change is **S-0001-14**: one owner-assigned inventory of every place Drive-derived data can land, with a purge hook for each, because today four RFCs each hold a piece and none of them purges on disconnect.

## 2. RFC 0001: Google Drive as a mounted volume

The core of this design is strong and I verified most of it: server-side authorization code flow, tokens never in the browser, a session-bound single-use `state` stored as a hash, completion only by a same-origin `POST` (the `SameSite=Strict` reasoning is correct), `drive.file` + `openid` only, AES-256-GCM sealing with a KEK from a `*_FILE` secret, a per-uid namespace, trash instead of delete, no Google script or frame in the OS document, and a hermetic fake Google. The findings below are about the places where the text and the code disagree.

### S-0001-01 · MUST-FIX · The Service Worker serves the OS shell for the OAuth redirect

**Finding.** When the user's OS window is open, a Service Worker controls the origin. The Google redirect `/oauth/drive/callback.html?state=…&code=…&prompt=consent` is a navigation, and the Service Worker's `NavigationRoute` answers it with the precached `/index.html`. The callback script never runs, the popup boots a **second OS instance** (the kernel-lock contention of threat T-35), and the authorization code sits in the URL of a page that was not built to scrub it. The RFC's claim in §2.4 that "the Service Worker never serves the shell for a path that looks like a file" is false for any URL with a query string.

**Evidence.**

- `web/src/sw.ts:74-78` registers `new NavigationRoute(createHandlerBoundToURL('/index.html'), { denylist: NAVIGATION_DENYLIST })`.
- `web/src/sw/routes.ts:15`: the file rule is `/\/[^/?]+\.[a-z0-9]+$/i`, anchored at the **end of the string**.
- `node_modules/.pnpm/workbox-routing@7.4.1/node_modules/workbox-routing/NavigationRoute.js`, `_match`: the denylist is tested against `url.pathname + url.search`.
- The precache route does not match either: `PRECACHE_GLOBS` includes `**/*.html` (`routes.ts:48-50`), but Workbox only strips `utm_*` and `fbclid` (`generateURLVariations.js:20`), so `?code=…&state=…` never matches the precached URL.
- I ran the five URL shapes through the real denylist. `/oauth/drive/callback.html` alone is denylisted; the Google-shaped redirect, the `?error=access_denied&state=…` redirect and spike S2's `/version.json?code=fake-code&state=fake-state` are **not** denylisted, so the Service Worker serves the shell. Only a redirect whose query happens to end in `…/drive.file` escapes, by accident of parameter order.
- Spike S2 did not exercise this: its opener only visited `/version.json` in a fresh Playwright context and never booted the OS, so no Service Worker was registered (`docs/design/wave3/design-gdrive/spike-s2-callback.mjs:35-51`).

**Required change.**

1. Add `/^\/oauth\//` to `NAVIGATION_DENYLIST` in `web/src/sw/routes.ts` and `oauth/**` to `NEVER_PRECACHE_GLOBS`, so the callback always reaches Caddy (whose `handle /oauth/*` the RFC already specifies without `try_files`). Add `web/src/sw/routes.ts` to gdrive-ui's touch points ([R5]).
2. Add a unit test next to the routes tests: `GDRV-14 the Service Worker never routes /oauth/* navigations to the shell, with or without a query string`.
3. Change the GDRV-01 and GDRV-14 E2E so the OS is **booted in the same browser context first** (Service Worker active and controlling) before the popup flow runs, and assert the popup's document is the callback page, not the shell.
4. Correct §2.4 and T-D16's mitigation text.

### S-0001-02 · MUST-FIX · The runbook puts the client secret and the KEK inside the repository tree

**Finding.** Runbook step 6 (§11.1) saves the Google client secret and the token KEK to `ops/secrets/…` and calls the folder "git-ignored". It is not ignored, it enters the Docker build context, and no scanner rule would catch a random base64 KEK. This breaks capstone §18 ("Secrets never go in the repository"), SEC-08 and SEC-09.

**Evidence.**

- `.gitignore:17-20` ignores only `.env`, `.env.*`. There is no `ops/secrets` rule.
- `.dockerignore:14-18` excludes only `.env*` and `compose.override.yaml`, and `Dockerfile:42` runs `COPY . .` in the `buildid` stage, so an in-tree secret is baked into a build-stage layer on every `qa-compose.sh up --build`.
- There is no `.gitleaks.toml` in the repository, so the promised "gitleaks rule for `GOCSPX-`" does not exist yet, and a 44-character base64 KEK matches no rule at all.
- The established pattern keeps secrets outside the checkout: `compose.prod.yaml:49-51` mounts `/srv/plotinium/secrets/…` through compose `secrets:`.

**Required change.**

1. Runbook: secrets live **outside the repository checkout** (production `/srv/plotinium/secrets/`, local and QA a path such as `~/.config/plotinium/secrets/`, mode 0600) and reach `app` through compose `secrets:` or a read-only bind mount. Remove every `ops/secrets` example.
2. If the ARB still wants an in-tree folder, add it to **both** `.gitignore` and `.dockerignore`, with a CI check that `git check-ignore` and the Docker context listing both exclude it.
3. Add `.gitleaks.toml` (owner R5) with rules for `GOCSPX-[A-Za-z0-9_-]{28}`, Google access tokens (`ya29\.`), Google refresh tokens (`1//0[A-Za-z0-9_-]{20,}`) and JWTs (`eyJ[A-Za-z0-9_-]+\.eyJ`), and run it over the repository, the built bundle and the Drive fixtures (SEC-10).

### S-0001-03 · MUST-FIX · Live-recorded contract fixtures can commit real tokens and personal data

**Finding.** §10.1 says an opt-in `GDRIVE_LIVE=1` run against a real test account "refreshes the fixtures" in `server/src/drive/fake/fixtures/*.json`, which are committed. The only safeguard stated is the word "scrubbed". A token-endpoint response contains `access_token`, `refresh_token` and an `id_token` JWT with `sub` and `email`; `about.get` contains `emailAddress`, `displayName` and `photoLink`; file listings contain real names and ids. The LLM cassettes already have a precedent for exactly this risk and a test for it.

**Evidence.** `specs/10-ai/ai-safety-and-evaluation.md:37` (AIS-08, "cassettes carry no credential"), `:457`; `specs/12-security/security-model.md:69` (SEC-10) and `:722` (the cassette recorder refuses a request that contains the key).

**Required change.**

1. Specify the recorder in §10.1: an **allow-list** of fields per endpoint; tokens replaced by fixed fakes of the same shape and length; the `id_token` re-minted by the fake with fixed claims; emails rewritten to `@example.com`; names, ids and `photoLink` replaced by deterministic placeholders.
2. The recorder **refuses to write** a fixture that still matches `ya29.`, `1//`, `GOCSPX-`, `eyJ…\.eyJ` or a real email domain.
3. Add `GDRV-03 the fixture recorder refuses a response that contains a token or a real address` and run the S-0001-02 gitleaks rules over `fixtures/`.

### S-0001-04 · MUST-FIX · Revocation is per Google account per Cloud project, and the RFC revokes on paths that kill other links

**Finding.** Google revokes the whole grant of a Google account for the **project**, not one token. The RFC calls `/revoke` in places where that destroys a link it does not own, and the runbook shares one Cloud project between the user's instance and QA.

- **Account in use (T-D02).** Bob, on a shared lab machine, picks Alice's live Google session. The server gets new tokens, finds `(provider, google_sub)` already linked to Alice and answers 409 `account-in-use`. The RFC does not say whether it revokes; if it does, Alice's working link dies.
- **Granular consent on reconnect (§5.9.1).** "If the user unticks Drive access, the server … revokes the token." During a `reconnect` that revokes the grant the existing row still depends on.
- **Shared project.** Runbook step 1 registers `plotinium-dev` for both :4717 (the user's instance) and :4718 (QA). A disconnect, a `drive:revoke-all` or an E2E disconnect test run against real Google on :4718 (rollout stage 3) revokes the same Google account's grant on the user's instance. That breaks hard rule 7 ("never touch the user's instance") by a side door. The research report itself recommends separate projects (§9.2 (a) item 4).

**Evidence.** Research §1.6 quotes the web-server guide: "Revocation removes all OAuth 2.0 scopes previously granted to a project, invalidating any issued access or refresh tokens for all clients registered under that project." The Google developer forum confirms the behaviour ("Tokens are tied to the user's grant for that project, not strictly to the individual client ID", <https://discuss.google.dev/t/multiple-oauth-clients-in-the-same-google-cloud-project-revoking-each-others-token/293608>, checked 2026-09-30). The WebFetch summary of the web-server guide on 2026-09-30 did not surface that sentence, so the lead should re-read it on the page before the ARB.

**Required change.**

1. State the rule in §5.9 and §7.2: **the server calls `/revoke` only for a grant it stores for the requesting uid** (disconnect, grace purge, account deletion, incident). On `account-in-use` and on a narrowed `scope` during `reconnect`, it discards the new tokens without revoking and keeps the existing row unchanged. Add `GDRV-12 account-in-use never revokes the existing link` and `GDRV-02 a narrowed reconnect keeps the previous grant`.
2. Runbook: **one Cloud project per instance** (`plotinium-qa` for :4718, `plotinium-local` for :4717, `plotinium-prod` later), each with its own client and test users. `drive:revoke-all` prints the project id and refuses to run when `APP_ORIGIN` is not the instance it was configured for.

### S-0001-05 · MUST-FIX · The lost+found fallback copies Drive content to the server, its backups, the RAG index and root

**Finding.** A failed commit after `close` writes the bytes to `~/lost+found` on the local VFS (§5.2.4). That folder is an ordinary synced home folder, so Drive-bound content (often content read from Drive, as in `cat /mnt/gdrive/a > /mnt/gdrive/b`) ends up:

- in the server's blob store and the nightly R2 backup;
- in the semantic index, whose vectors and chunk text are server-side, and in the names the agent can list;
- readable by root, which bypasses `r` and `w`.

This contradicts four promises of the RFC itself: §3.2 "No server-side copy of Drive content", §7.3 "Server: no Drive content at rest", goal G6 and the consent text "Google Drive content is never sent to AI features unless you turn that on separately", and §5.2.1 "root must not read it".

**Evidence.** `specs/04-vfs/virtual-file-system.md:99` (PVFS-06, `~/lost+found` in the home); `specs/10-ai/rag-semantic-search.md:133` (anything under `/home/**` outside a dot-directory is indexed); `specs/11-server/backend-api.md:559` (content blobs copied to Cloudflare R2 nightly); `specs/12-security/security-model.md` §3.6 and the capstone spec p. 1623 ("Root (uid 0) bypasses read and write checks").

**Required change.** Pick one and write it into §5.2.4, §7.3 and the disclosure:

- **(a, preferred)** Keep failed Drive commits in a **device-local, per-uid, never-synced** store (a kernel-owned IndexedDB slot outside the synced tree, excluded from the indexer), surfaced as "Couldn't save to Google Drive — Retry / Save a copy in Home…"; nothing enters the synced home without an explicit user action; or
- **(b)** Keep `~/lost+found` but put it under a dot-directory the indexer and the access tap skip (for example `~/.lost+found/gdrive/`), say plainly in the disclosure that a failed save is kept "on this Plotinium server and in its backups", and list it in the disconnect purge (S-0001-14).

Add `GDRV-10 a failed Drive commit is never indexed and never reaches the agent's listings`.

### S-0001-06 · SHOULD-FIX · Code-injection protection rests on a PKCE check Google does not document for web clients

**Finding.** Google's web-server guide does not mention `code_challenge` or `code_verifier` (re-checked 2026-09-30; spike S1 is still open). If Google ignores the verifier for confidential web clients, PKCE gives no protection and the RFC has no second defence against authorization-code injection. RFC 9700 names the alternative for exactly this client type.

**Evidence.** RFC 9700 §2.1.1: "confidential OpenID Connect clients MAY use the `nonce` parameter and the respective Claim in the ID Token instead"; §4.5.3.2: the client "MUST validate the `nonce` in the ID Token … and MUST ensure that, unless and until that check succeeds, all tokens … are disregarded" (<https://www.rfc-editor.org/rfc/rfc9700.html>).

**Required change.** Since `openid` is already requested, add a 256-bit `nonce` to the authorization request, seal it with the attempt (`drive_oauth_attempts.secret_ct`), and reject the exchange unless the `id_token` carries it (discarding all returned tokens). Keep PKCE S256. Add `GDRV-14 complete refuses an id_token with a missing or wrong nonce`. S1 then decides only whether PKCE is extra, not whether the flow is safe.

### S-0001-07 · SHOULD-FIX · Pending revocations are lost on a server restart, and account deletion skips revocation

**Finding.** Disconnect deletes the token row "immediately" and retries a failed `/revoke` from "the server's revoke-retry queue", which §5.2.3 puts in a `dsa/heap` in memory. A restart during a Google 5xx loses the only copy, the grant stays live at Google (production refresh tokens do not expire unless unused for six months), and the disclosure "Disconnecting removes Plotinium's access in your Google Account" becomes false. Separately, `drive_accounts.uid … ON DELETE CASCADE` lets any user deletion drop the sealed token without revoking; §5.6 relies on a cross-spec request to call `disconnect` first.

**Required change.**

1. Persist pending revocations: keep the row in a `revoking` state (or a small `drive_revocations` table with the sealed token and attempt count) until Google answers 200 or 400; the job in `server/src/drive/jobs.ts` retries with backoff; `revoked: 'queued'` is returned honestly until then.
2. Change the foreign key to `ON DELETE RESTRICT`, so no path can delete a user while a Drive link exists; the deletion path must call `DriveService.disconnect(uid)` first. Guests cannot connect, so the nightly guest sweep (`backend-api.md:345`) is unaffected.
3. Test: `GDRV-11 a revoke that fails with 5xx survives a server restart and completes later`.

### S-0001-08 · SHOULD-FIX · `find /`, `du /`, `grep -r` and `tree` do crawl the volume

**Finding.** §5.2.6 says "`find /` and `du /` do not descend into the volume (the local walk never sees the synthetic entry)". In the code the walk is not local to the kernel. The router merges `gdrive` into `readdir("/mnt")` for its owner, and the user-space walker descends into every directory entry it gets. So `find /`, `du -s /`, `grep -r x /`, `tree /` and the Files keyword fallback all list, and for `grep` download, the whole Plotinium folder. Each `files.list` costs 100 quota units and each download 200 (research §4.11), so a single `grep -r` can exhaust the per-user quota and the shared project quota.

**Evidence.** `registerFsSyscalls` (`kernel/src/core/fs/syscalls.ts:77-186`) registers no `find`, `grep` or `du`; coreutils falls back to a `readdir` walk on ENOSYS (`apps/coreutils/lib/fs.ts:93-110`), and `grep -r` and `tree` always use that walk (`:63-91`, comment at `:66`). The Files keyword fallback reads up to 2,000 files (RFC 0004 §5.1.2 item 4, citing `apps/files/lib/ops.ts:658`).

**Required change.** Make walks stay on one file system by default (`find -xdev` semantics): `walkTree` skips an entry whose `Stat.fs` differs from the start directory's, unless the start path is itself inside that volume; readdir-plus already carries `stat`. Add `GDRV-20 find /, du / and grep -r / never list or read /mnt/gdrive` and fix the §5.2.6 text. Bound the Files keyword fallback on a volume to names only.

### S-0001-09 · SHOULD-FIX · Drive names can carry control, bidi and NUL characters past the encoder

**Finding.** The encoder of §5.2.2 maps only `/`, `.`, `..`, length and duplicates. Drive names are external input and may contain ESC and other C0/C1 controls, bidi overrides, zero-width characters, or characters the protocol rejects:

- `Name` rejects NUL and ill-formed strings (`protocol/src/sys/common.ts:74-81`), so one such name would fail reply validation and break the whole listing;
- T-D09 says "terminal escapes control characters", but `escapeName` (`apps/coreutils/lib/format.ts:107-113`) is used by 12 of 46 commands; `mv`, `cp`, `rm`, `cat` and `lib/errors.ts` print paths unescaped, and glob expansion feeds them Drive names.

**Required change.** In `names.ts`, after NFC: replace NUL, C0, DEL, C1, bidi controls (U+202A–U+202E, U+2066–U+2069) and zero-width characters with U+FFFD, and treat the result as a collision (id suffix of step 5), so the mapping stays injective. Validate `RemoteEntry.name` with `isWellFormed()`. Add `GDRV-05 names with ESC, bidi overrides, NUL and lone surrogates list, render and round-trip by id`. Hand the `escapeName` coverage gap in `lib/errors.ts` to the coreutils owner (R2).

### S-0001-10 · SHOULD-FIX · "Root has no Drive" leaks through lsof, events and lost+found

**Finding.** The namespace keeps `/mnt/gdrive` out of root's view, but root still sees Drive names by other routes, so §5.2.1's "the namespace makes that structural" overstates it:

- `mount` joins `GUARDED_GROUPS`, whose default rule is "root sees everything" (`kernel/src/core/events/bus.ts:31-37`); a visibility hook that returns `undefined` for non-owners falls back to that rule, and root receives every user's `mount.change` names;
- `RemoteDesc.path` exists "for lsof", and root's `lsof` lists every process;
- S-0001-05's `~/lost+found`.

**Required change.** The `mount` visibility hook returns `false` (never `undefined`) unless `cred.uid === data.uid`; `lsof` shows a remote description of another uid as `[gdrive]` without its path, root included; test `GDRV-04 a root subscriber receives no mount.* event of another uid`. Reword §5.2.1 to "root gets no Drive namespace; the remaining exposure is listed in SECURITY.md".

### S-0001-11 · SHOULD-FIX · Log redaction as specified both over-redacts and under-covers failures

**Finding.** T-D07 adds `code`, `state` and their `*.` forms to the pino paths. `*.code` also redacts `err.code` (every Node network errno), which removes the diagnosis exactly when the Google client fails. Pino wildcards cover one level only, so a thrown error that keeps the token request in `cause` (a common pattern with `fetch` wrappers) is logged unredacted. GDRV-03's log-capture test covers only the happy path.

**Evidence.** `server/src/obs/logger.ts:14-37`; the request line itself is safe: Fastify request logging is off (`server/src/app.ts:277`) and the `onResponse` line logs the route pattern only (`:334-356`), so the RFC's "Fastify logs the route pattern" claim is correct.

**Required change.** Never attach a `Request`, `Response`, form body or URL with a query to an error in `server/src/drive/google/**`; errors carry only `{op, status, reason}`. Replace the `*.code` and `*.state` wildcards with explicit paths under a `drive` key. Extend GDRV-03 to failure paths: `invalid_grant`, a 5xx with retries, a network error and a failed code exchange.

### S-0001-12 · SHOULD-FIX · The AI opt-in accepts an `su` principal although connect does not

**Finding.** `drive.connect` refuses `su` because "consent must come from the login user in person". `drive.optin` (the consent that lets Drive data reach Anthropic) and `PUT /api/drive/optin` accept "caller's uid", which under `su bob` is bob. The same consent argument applies more strongly here. (`su` itself always needs the target's password, `backend-api.md:341`, so this is consistency, not escalation.)

**Required change.** `drive.optin` and `PUT /api/drive/optin` refuse a principal that differs from the session's login uid with EPERM `su`. Add it to the GDRV-12 test.

### S-0001-13 · SHOULD-FIX · P2 agent access to Drive has no mechanism behind its guarantees

**Finding.** §5.2.1, §7.3 and GDRV-13 promise "every agent read of a Drive path is confirmed per invocation" and "file content only through the tool-less extraction call". Neither exists or is designed:

- the agent's read-only tools "run immediately as that syscall with the agent's credentials" (`protocol/src/ai/tools.ts` header); the only confirmation point is at `ai.agent.submit` (RFC 0002 §5.1), so there is nowhere to confirm a read;
- `extract_list` is not built (`tools.ts` header; RFC 0002 non-goals);
- `fs_grep`, `fs_find` and `fs_du` over the volume would list or download the whole folder, and `grep` counts leak content-derived bits to the provider (RFC 0002 §7 residual risks);
- the IsolateGPT row relies on `fs.scope` excluding `/mnt/gdrive`, which is false when the agent starts in `/` or `/mnt` (see S-0002-01).

The Workspace policy asks apps to "granularly require users to confirm the MCP, tool, skill, or other agentic behavior invocation" (verified on the policy page 2026-09-30; strictly it binds sensitive and restricted scopes, not `drive.file`).

**Required change.** In P1, the router refuses **every** path call from class `agent` under a mount point (including `grep`, `find`, `du`, `wc`) and hides the `gdrive` entry from the agent's `readdir("/mnt")`; the router's class check, not `fs.scope`, is the normative control. Mark P2 agent access as **blocked on an ARB-approved design** for observation-time confirmation (an RFC 0002 follow-up), and remove the "per-invocation confirmation" wording from the P1 disclosure until it exists.

### S-0001-14 · SHOULD-FIX · No inventory of Drive-derived data, so disconnect cannot purge it

**Finding.** Drive-derived data can land in at least eight places across four RFCs, and the disconnect job of §5.9.6 purges only the kernel caches and the P3 index:

| Where                                        | Owner    | Purged on disconnect today? |
| -------------------------------------------- | -------- | --------------------------- |
| Kernel content and metadata caches           | RFC 0001 | yes                         |
| `~/lost+found` (S-0001-05)                   | RFC 0001 | no                          |
| File-access ring, in memory and P1 IndexedDB | RFC 0004 | no (S-0004-01)              |
| Relation graph                               | RFC 0003 | no (S-0003-01)              |
| File model and hoard ranking                 | RFC 0004 | no                          |
| P1 transcript archive (Drive names, P2)      | RFC 0005 | no (S-0005-01)              |
| P2 episodic memory (paths)                   | RFC 0005 | no                          |
| P3 client index                              | RFC 0001 | yes                         |

Research §7.5 step 4 already asked for "prefetch statistics keyed by Drive IDs" to be deleted.

**Required change.** Add this table to §7.3 with an owner and a purge hook per row, and give the kernel one seam, for example `hooks.purgeVolume(uid, fs)`, that the disconnect, grace-purge and account-changed paths call. RFC 0003 and RFC 0004 implement it (their findings below).

### S-0001-15 · NIT · The Drive content cache key omits the uid

`LruCache<"id@rev", Uint8Array>` (§5.2.3) is shared by every volume of one kernel. Key it `uid:id@rev`, so an `su` shell or another uid can never be served bytes another uid's grant fetched, even for a file id both accounts can see.

### S-0001-16 · NIT · The fake-Google guards only fire in production, but every demo instance is `local`

`GDRIVE_GOOGLE_BASE_URL`, `GDRIVE_FAKE_LISTEN` and `GDRIVE_BROWSE=1` are refused only when `PLOTINIUM_ENV=production`; the user's instance and QA both run `local` (`compose.yaml:87`, `server/src/config.ts:167`). A stage-3 QA config that keeps a leftover `GDRIVE_GOOGLE_BASE_URL` would send the real client secret and refresh tokens to that host. Refuse the base URL unless its host is loopback **and** no real client secret is configured, and load `server/src/drive/fake/**` by dynamic import only when it is configured.

### S-0001-17 · NIT · Add a global bucket to the `drive` rate class

Every user shares one project quota (1,000,000 units per minute, research §4.11), while `drive` is per uid only. `RateClass` already supports a `global` bucket (`server/src/ratelimit/classes.ts:18-20`); size it below the project quota so one user cannot starve the rest.

### S-0001-18 · NIT · Make the AES-GCM associated data unambiguous

The AAD `uid|sub|provider|key_id` is `|`-joined while `google_sub` may contain `|` (the CHECK is `^[!-~]{1,255}$`). Use a length-prefixed or canonical-JSON encoding, and state the AAD of `drive_oauth_attempts.secret_ct` too (bind `launch_hash`, `uid` and `auth_session_id`).

### S-0001-19 · NIT · Key the account policy on `users.account_kind`, not on names

The guest, demo and root refusals should test `users.account_kind IN ('guest','demo','root')` (`db/migrations/20260924100100_identity.sql:23-24`) plus uid 65534, never a username such as `demo`.

### S-0001-20 · NIT · Callback-page wording and header test

"The callback page scrubs its URL with `history.replaceState` before any request" is not quite true: the page's own `<script src>` and `<link>` are fetched while the HTML parses, before the script runs. What protects the code there is `Referrer-Policy: no-referrer`, which Caddy sets at site level (`Caddyfile:15-33`, imported at `:36`). Say so, and add `/oauth/drive/callback.html` to the SEC-02 header test so a future `handle /oauth/*` block cannot drop the header set.

### S-0001-21 · NIT · `openExternal` must compare parsed origins

For the P2 `openExternal(url)`, parse with `new URL()` and compare `origin` exactly against `https://drive.google.com`, `https://docs.google.com` and the help origin (never a `startsWith` on the string, which accepts `https://drive.google.com.evil.example`), and open with `noopener,noreferrer`.

### S-0001-22 · NIT · Pin the root-folder fallback query to the owner

The `appProperties.plotiniumRoot` fallback lookup should add `'me' in owners and trashed = false`, so a folder shared into the account can never be taken as the volume root; `root_folder_id` stays the primary key.

### S-0001-23 · NIT · Backups and the shared-machine residual belong in the privacy text

Disconnect deletes rows, but sealed tokens and audit rows stay in the local dumps (7 daily, 4 weekly) and the append-only R2 copy (`ops/backup.sh:1-24`). They are harmless once revoked, which is one more reason for S-0001-07. Say so in `docs/user/google-drive.md`. Also document the T-D02 residual in SECURITY.md next to T-31: on a shared machine, a user can link another person's **live** Google session if that person has not linked it yet; `select_account` and the email in the result reduce but do not remove it.

### S-0001-24 · NIT · Use Google's sample Limited Use sentence verbatim

The disclosure paraphrases the statement. Use the policy's own wording ("…'s use and transfer to any other app of information received from Google APIs will adhere to Google API Services User Data Policy, including the Limited Use requirements", research §3.2) to avoid a reviewer debating the paraphrase.

### Claims in RFC 0001 I verified as correct

- CSRF gate and principal rules: `server/src/gateway/hooks.ts:35-46`, `:111-126`; a forged `X-Plotinium-Principal` without a live `su` grant is refused.
- Secrets as `*_FILE`, production refusal of inline secrets and known development values: `server/src/config.ts:276-296`, `:344-365`.
- Headers and CSP on every response, `frame-ancestors 'none'`, `form-action 'none'`, `connect-src 'self'`: `Caddyfile:15-33`, `web/build/csp.ts:34-47`. The CSP carries only `index.html`'s hashes, so the callback page must have no inline script or style, as the RFC requires.
- `auth_sessions.id` is an identifier with a separate `secret_hash`, so storing it in `drive_oauth_attempts` does not copy a credential (`identity.sql` `auth_sessions`).
- `su` always needs the target's password (`backend-api.md:341`), so "root has no Drive namespace" is not bypassed by `su`.
- The LLM provider is Anthropic (`server/src/engine/llm/anthropic.ts:49`), as §7.3 says.
- `drive.file` is non-sensitive and `drive`, `drive.readonly` and `drive.metadata.readonly` are restricted, with a security assessment for restricted data stored on or passing through servers (<https://developers.google.com/workspace/drive/api/guides/api-specific-auth>).
- `capabilities.canAccessViaGenAi` exists: "Whether the current user can access this file via Gen AI features" (<https://developers.google.com/workspace/drive/api/reference/rest/v3/files>). Honouring it for a third-party model is a conservative reading, which I support.
- The Workspace policy text on agentic confirmation, prompt-injection protection, token encryption at rest and HSM-grade keys, and that Limited Use "appl[ies] to data derived from both Sensitive and Restricted scopes" (<https://developers.google.com/workspace/workspace-api-user-data-developer-policy>).
- Skipping the `id_token` signature check when it comes straight from the token endpoint over TLS is allowed by OpenID Connect Core §3.1.3.7.

## 3. RFC 0002: Agent provenance, damage confinement and injection benchmark

This is a careful, measured design. I confirmed its central code claims: agent processes are created without `fsScope` (`kernel/src/core/proc/system.ts:954-968` passes none; `pcb.ts:208` defaults to `null`), so the scope check returns early (`kernel/src/core/fs/authorize.ts:130-140`); the agent bounding set is `fs.read fs.scope ai.plan mem` (`protocol/src/caps.ts:59`), so it mutates only through `batch`. Rejecting destructive steps on listing-picked targets, the verbatim `write` rule and binding labels into `dryRunHash` are the right calls.

### S-0002-01 · SHOULD-FIX · `fsScope = [cwd, $HOME]` is unconfined when the agent starts in `/`, `/home` or `/mnt`

**Finding.** §5.6 accepts that "an agent started with cwd `/` is therefore not confined". Then every observation may read other users' names in `/tmp`, group directories, `/mnt` and `/system`, and send them to the provider: exactly the leak AGS-09 exists to stop. It also voids RFC 0001's reliance on `fs.scope` (S-0001-13). A narrower scope is still inside the spec's `{cwd, $HOME}` (it is a subset), so this needs no spec amendment.

**Required change.** Compute the observation scope as `{$HOME} ∪ ({cwd} unless cwd ∈ {"/", "/home", "/mnt"} or cwd is a strict ancestor of $HOME)`. When cwd is dropped, the agent prints one line ("ai: reading only your home; cd into a folder to include it"). Add `AGS-09 an ai.agent started in / may read $HOME only`. Mutations keep the spec rule unchanged.

### S-0002-02 · SHOULD-FIX · Say explicitly that there is no read-confirmation point

**Finding.** The policy table is evaluated only at `ai.agent.submit`; observations run before any plan exists. RFC 0001 P2 assumes a per-invocation confirmation of reads that this RFC does not provide (S-0001-13). The `external` effect class is "reserved", which is fine for v1 because `batch` refuses volume paths.

**Required change.** Add to §3 non-goals: "No confirmation of observation calls; any volume that needs one (RFC 0001 P2) needs a follow-up design." Add an INJ-T case: a Drive-sourced name (fixture volume) that tries to steer a local destructive step must be rejected `untrusted-target`.

### S-0002-03 · NIT · Make a disabled policy visible to the user

`ai.agent.policy = off` is root-only and audited, which is right, but the user of that device kernel cannot tell. Print the mode in the dry-run header when it is not `enforce` ("policy: shadow") and in `ai status`.

### S-0002-04 · NIT · Report the reader-probe assumptions in SECURITY.md

The reader-set probe is POSIX-only (no ACLs), and the typed confirmation of P1 only defends against habituated "y". Both are stated in §7 and §14; carry them into SECURITY.md's residual-risk list so the viva answer matches the document.

## 4. RFC 0003: Smart Folders and context search

Evaluation as the viewer at view time, results never stored, the BFS never entering an unreadable node, and definitions as strict data are the right design. The agent has no `semsearch` tool (`protocol/src/ai/tools.ts:130-183` lists only `fs_*` tools), so context ranking cannot leak activity to the provider through the agent.

### S-0003-01 · SHOULD-FIX · The graph holds Drive activity and is not purged on disconnect

**Finding.** RFC 0004's tap records paths under `/mnt/**`, and RFC 0001's router reports Drive opens with `fs: 'gdrive'`, so the relation graph will hold Drive nodes. They cannot leak through `ai.related` (the readable check on the local tree drops them), but they are Drive-derived data that survives a disconnect.

**Required change.** `RelationGraph` implements the purge seam of S-0001-14: `onPurge(uid, fs)` drops every node whose event `fs` matches, before `drive.disconnect` returns. Test: `CTX-01 purging fs gdrive removes every Drive node and edge`.

### S-0003-02 · NIT · The no-AI name fallback walks into the Drive volume

With AI off, a Smart Folder whose `scope` is `/` or `/mnt` runs `find` with `*term*` globs, which crosses into `/mnt/gdrive` until S-0001-08 lands. Limit evaluation to the scope's own file system, as S-0001-08 does.

### S-0003-03 · NIT · Constrain `slugFor` and create definitions exclusively

`slugFor` must emit only `[a-z0-9-]` (at most 40 characters), and `smart new` writes with an exclusive create, so a crafted display name can never produce a path component or overwrite another definition.

## 5. RFC 0004: Predictive file cache and hoarding

The stream design is privacy-aware: no bus topic (correct: the bus would leak opens to directory readers), inode ids only, per-euid rings, agent and system classes excluded, pause and total clear, and a kernel permission check in `mem.prefetch({ino})`.

### S-0004-01 · SHOULD-FIX · Drive accesses are recorded, persisted in P1 and never purged

**Finding.** The eligibility rule accepts `/mnt/**` (§5.1.2 item 3), so Drive opens enter the ring and the file model. P1 persists the ring and model snapshots in the `telemetry` IndexedDB store, and no path removes them when the user disconnects Drive.

**Required change.** `AccessLogApi` gains `purge(uid, fs)`, which empties matching ring entries and calls every listener's `onPurge` (S-0001-14, S-0003-01). The P1 `AiRingStore` does not persist events whose `fs` is a remote volume. Test: `FAC-06 purging fs gdrive removes its events, model contexts and hoard state`.

### S-0004-02 · SHOULD-FIX · Exported traces are not opaque

**Finding.** §10.2 says real traces are safe because "inodes are opaque and paths are never exported", and stores them in `ai/eval/cache/traces/` in the repository. Inode ids are the primary key of the server's `inodes` table (`db/migrations/20260924100200_vfs_core.sql:22-23`), so anyone with database access joins them back to names; they are UUIDv7, so each one also encodes the file's creation time; `osSessionId` links events to devices and sessions. A committed trace is a per-person activity log (who worked when, in which app).

**Required change.** `ai.access.export` pseudonymises at export time: inos and `osSessionId` through an HMAC with a random per-export key that is never stored, timestamps as offsets from the first event, `app` kept. Record each member's written consent in `docs/evidence/`, and commit traces only if the repository is private; otherwise keep them out of Git.

### S-0004-03 · SHOULD-FIX · Default-on learning mixes people on the shared demo account

**Finding.** "Learn from how I use files" defaults to on (Q5). The `demo` account is shared by several examiners (RFC 0001 §7.4 refuses Drive for it for this reason). With the stream on, "Related files", `predict --files` and the P1 "View…" table show one examiner what the previous one opened.

**Required change.** Default the switch to **off** for `users.account_kind IN ('demo', 'guest')` (`identity.sql:23-24`), or clear the uid's stream at logout for those kinds. Test: `FAC-04 the demo account starts with file activity off`.

### S-0004-04 · NIT · Speculative pre-fetch widens the accepted cache-timing channel

§7 accepts the cross-uid timing side channel of a shared content cache. Speculative warming adds files nobody opened yet. Move "partition speculative entries per uid" from P2 to P1, or state the widening in SECURITY.md.

### S-0004-05 · NIT · State the shared-profile exposure next to the Settings switch

The P1 ring persists in the browser profile's IndexedDB, readable by anyone with the machine and DevTools (T-31). Add it to the Settings description ("stored in this browser; anyone using this browser profile can read it").

## 6. RFC 0005: The LLM as a scheduled kernel resource

P0 adds no new data at rest and keeps the server authoritative for money and cross-user fairness. The 429 retry-safety argument is correct: the `llm` rate class runs before validation and the transcript grows only after a successful turn (`server/src/llm/routes.ts:167-170`, `:258-269`).

### S-0005-01 · SHOULD-FIX · The P1 transcript archive inherits an owner-blind store

**Finding.** The archive table is keyed by `request_id` alone. The in-memory store it extends is owner-blind on write: `put` overwrites whatever is stored under a `requestId` (`server/src/llm/transcripts.ts:64-65`), `begin` is global (`:73`, used at `routes.ts:198`), and only `get` checks the uid. Today the window is 10 minutes in memory; the archive makes it 24 hours in PostgreSQL. The transcripts hold the request text and datamarked names from observations, including other users' names under `/tmp` and, with RFC 0001 P2, Drive names. Nightly `pg_dump` copies them to R2 (`ops/backup.sh`), beyond the stated 24-hour retention.

**Required change.** Key the archive by `(uid, request_id)` with `uid … REFERENCES users ON DELETE CASCADE`; make `put` refuse a `requestId` owned by another uid and scope `begin` per uid (a handoff for the existing store, owner R4); exclude the table's data from backups (`pg_dump --exclude-table-data=llm_transcripts`) or state the backup retention in Settings › Privacy; include it in the S-0001-14 purge for P2 Drive names. Test: `LRT-13 another uid can neither read nor overwrite a stored transcript`.

### S-0005-02 · NIT · The arbiter fallback fails open

On an arbiter exception, `ScheduledFetch` "falls back to a direct fetch once". The server's USD caps still hold, so this is safe, but the kernel's per-process budget is skipped. Fall back only for internal errors, never after a `budget` refusal, and count fallbacks in `llm.stat`.

### S-0005-03 · NIT · Limit `llm.stat` gate rows to the caller

`gate[]` shows every uid's bucket state. Show only the caller's row (root sees all), as `procs[]` already limits detail.

### S-0005-04 · NIT · Carry these items into the P2 memory privacy review

`~/Agent Memory/` is an ordinary synced and indexed folder, so its op lines (paths) reach the server and the index; exclude Drive paths from memory entries; the tamper check depends on the kernel's audit mirror surviving a reload, which should be tested.

### S-0005-05 · NIT · Record cross-user contention as a residual risk

`LLM_MAX_INFLIGHT` is one global semaphore (`server/src/config.ts:218`), and the arbiter turns 429s into retries, so a user with several tabs holds more server slots for longer. Per-uid buckets bound it (6 per minute); record the residual in SECURITY.md with A2 (a server fair queue) as the follow-up.

## 7. RFC 0006: Leases, fencing and glass legibility

Security-neutral. I verified the §7 claim that a forged or foreign fence gives `stale-fence` and never access: the server binds each op's `osSessionId` to the authenticated uid and device before any check (`server/src/engine/sync/engine.ts:152-163`), and `checkWriteLeases` matches `(osSessionId, fence)` against a live row (`server/src/engine/locks/fencing.ts:72-77`). The wallpaper id is a picklist and the sampler reads only same-origin assets.

### S-0006-01 · NIT · Prove that fence 0 never reaches the wire

With `g.fence ?? 0`, a 0 that reached `OpSubmit.fences` would be below every `lock_fence` and cause a spurious `stale-fence`. Extend `SYN-19` with a server-scope `lock.acquire` whose grant has no fence and assert that the op carries no `fences` entry.

### S-0006-02 · NIT · Give the `img-src blob:` decision an owner

This RFC defers Drive photo wallpapers' `img-src blob:` to RFC 0001, and RFC 0001 §5.11 declares it out of scope. The ARB should record that neither RFC owns it, so no builder adds `blob:` to the CSP without a security review.

## 8. Research report: `docs/research/google-drive-integration.md`

Every [F] item I re-checked holds: scope classes, the Workspace policy quotes, `canAccessViaGenAi`, RFC 9700's PKCE text, and the absence of PKCE from the web-server guide.

### S-R-01 · SHOULD-FIX · The header analysis omits the Service Worker

§5 analyses COOP, COEP, CSP and cookies but not the Service Worker, whose navigation fallback is what actually breaks the callback (S-0001-01). Add a §5.x on the Service Worker and mark the callback path [S] until the E2E of S-0001-01 passes.

### S-R-02 · NIT · §1.8 recommends callback URIs under `/api/…`

`/api/drive/oauth/callback` conflicts with SRV-03 (the API renders no HTML) and was superseded by RFC 0001's static `/oauth/drive/callback.html`. Annotate it as superseded so no builder registers the old URI.

### S-R-03 · NIT · §7.5's disconnect list does not match the design

It mentions "server blobs and the client IndexedDB mirror", which RFC 0001 does not have, and misses `lost+found`, the access ring and the transcript archive. Point it at the S-0001-14 inventory.

## 9. What I did not do

- I did not run anything against real Google (no credentials) or on the QA copy. S-0001-01 is proven from the Service Worker source, the installed Workbox 7.4.1 code and a regex run over realistic URLs, not from a browser run. An E2E on :4718 with the OS booted would be the definitive check.
- I did not verify line numbers in files the stabilize track is still editing beyond the ones cited above.
- I did not re-read Anthropic's retention pages; the research report's quotes are taken as given.
- The Google web-server guide's revocation sentence (S-0001-04) was not returned by my page fetch; the behaviour is confirmed by the research report's quote and a Google developer-forum answer, and should be re-read on the page by the lead.
