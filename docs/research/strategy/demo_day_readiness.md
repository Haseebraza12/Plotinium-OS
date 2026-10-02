
# Demo Day readiness: rehearsing the s17.1 protocol

**Principles.**
- The examiner drives the demo. The team narrates and answers questions.
- Everything runs on the **tagged v1.0.0** build.
- When something goes wrong, the team shows how the system degrades honestly. Nothing is ever faked.
- Every command used below is a real program in `/bin` and has a `man` page.

## 0. Before the day

| When | Owner | Checklist |
|---|---|---|
| W15, W16, W17 (×2) | R5 runs, all attend | A full 30-minute rehearsal on a **machine the team does not control**: a lab PC, a friend's laptop, a fresh Windows or macOS account. Use a stopwatch and follow the script below. R5 acts as "chaos master" and injects at least 2 unannounced failure drills per rehearsal. |
| T-7 days | R5 | `v1.0.0` tagged. Production redeployed from GHCR by digest. Restore drill passed. UptimeRobot green for 7 days. Clean bring-up CI job green 3 nights in a row. Chrome stable re-verified within 48 h. LLM budget ≥ USD 20 remaining (preflight). Examiner accounts reset. |
| T-1 day | all | Production `.env`: `FAULT_INJECTION=1` (root-only, audited) and lease TTL set to the demo profile (15 s). Record the value and the approval in SECURITY.md and in the defence notes. Budgets reset. Demo fixtures verified with `demo verify`: the tree1000 checksum, `/home/shared/plan.md`, the eval corpus with precomputed vectors, the demo telemetry trace. Printed one-page cheat sheet of commands. 4G hotspot charged. Everyone has a charged laptop for notes only (not for the demo). |
| T-1 hour | R5 + R3 | Open the production URL on a phone as a smoke test. Check `/readyz`. Check that `version.json` = v1.0.0. Confirm the instructor's answer on which instance the system-under-test segment uses (asked in W15). |

**Seeded demo data** (from `db/seed/demo.ts`, which is idempotent):

| Item | Contents |
|---|---|
| Users | `demo`, `alice`, `bob` (group `team`), `guest`, and a root password for examiners printed in the README (demo only) |
| Files | `~/fixtures/tree1000` (1,000 nodes); `/home/shared/plan.md` (mode 664, gid team); a 300-document corpus with vectors; the AGT fixture folders (PDFs with mtimes relative to the frozen clock) |
| Telemetry | The demo account has opted in to telemetry sync, with a 600-launch trace in `telemetry_events`, so a fresh browser gets a trained predictor after login. The Settings → Privacy explanation says this. |

## 1. 0:00–0:05 Clean bring-up (scored before we speak)

**Script (from the README):**
```
git clone https://github.com/<org>/plotinium
cd plotinium
docker compose up -d --wait
# open http://localhost:4717  (never a LAN IP: not a secure context)
# then open the production URL: https://<domain>
```

**Facts the setup relies on:**
- Every image is public on GHCR, pinned by digest and multi-arch (amd64 and arm64), so Docker Hub is never involved.
- The app entrypoint runs `dbmate --wait up`, then the demo seed, then the server. `/readyz` turns green only after migrations have run, which is what `--wait` watches.
- Model weights are baked into the web image, so there is no Hugging Face fetch.
- Target time is ≤ 240 s. It is measured nightly in CI and rehearsed on the campus network.

**Failure drills:**

| Failure | What we do (without touching the examiner's machine unless asked) |
|---|---|
| Port 4717 is busy | README line: `PLOTINIUM_PORT=4718 docker compose up -d --wait` |
| Docker or Compose is missing or older than 2.24 | README prerequisites. We point to the production URL and state that the bring-up was not scored in our favour. |
| Slow network | Images are small and pulls start immediately. We narrate the architecture while the pull runs; we do not stall. |
| An arm64 Mac | Multi-arch images, and a build fallback (`image` + `build` in compose) |
| `--wait` times out | `docker compose logs app` shows which migration step failed. The rehearsal log has the fix. |

## 2. 0:05–0:08 Boot

**Sequence:**
1. **Cold boot in verbose mode.** The first load after bring-up is a real cold boot: empty HTTP and Service Worker cache. Hold **V**, or press Esc and choose Verbose, to show the timestamped log.
2. Log in as `demo`.
3. Run `bootlog` and then `bootlog --critical-path`.
4. **Wait for the taskbar badge "Offline-ready"** before cutting the network. The badge appears when the Service Worker has installed the precache, and the Service Worker registers only after the desktop is interactive plus idle.
5. **Disconnect the network.** The examiner's choice works: OS Wi-Fi off, cable out, or DevTools offline. Then `reboot`.
6. The desktop boots offline. Show the core utilities: `ls -la ~`, `cat`, File Explorer, edit and save in the Editor (taskbar shows "Offline · 1 queued"), Task Manager, Settings.
7. Reconnect. The taskbar shows "Syncing 1 op", then "Online".

**Localhost caveat.** Turning off networking does not stop a server on localhost. So the offline boot runs on the **production URL**. For the local stack we would instead run `docker compose stop app web` and reload; that alternative is rehearsed.

**Failure drills:**

| Failure | What we do |
|---|---|
| The network was cut before "Offline-ready" | Reconnect, wait for the badge, try again, and explain why. The Service Worker registration is deliberately deferred to protect BOOT-10. |
| The examiner corrupts local state (BOOT-08) | The recovery screen appears. Choose "reset local cache and re-sync", which exports the outbox first. |
| The examiner adds a manifest cycle (BOOT-04) | The panic screen names the cycle. Recovery console → restore default manifests. |

## 3. 0:08–0:18 System under test (Appendix A)

Recommended setup: **two Chrome profiles side by side** on the production URL, not background tabs, with the laptop on AC power. Profile A is alice and profile B is bob.

| Check | Examiner action (we suggest the command) | What must be visible | Req |
|---|---|---|---|
| CPU load + drag | `burn --ms 120000 &` ×3, then `top`. Turn on the frame meter (Settings → Developer, or `framemeter on`). Drag and resize 10 windows. | Frame meter p95 ≤ 16.7 ms and a LoAF count of 0 from our code. `top` shows the burn processes and their CPU share. | PROC-05, WM-03 |
| 2× memory | `memhog --total 512M --procs 8`, then Task Manager → Memory, `free`, `vmstat 1`. Click a minimised window. | Accounted memory ≤ budget, faults rising, bytes out. The window shows "Restoring…", then the page-in time. | MEM-06, MEM-03/05/07 |
| Fault-injected `rm -r` | `su` (root password from the README), `debug inject rm 500` (the examiner may pick N), `exit`, `fsck --checksum ~/fixtures/tree1000`, `rm -r ~/fixtures/tree1000` | `rm: … EIO (injected fault at node 500) — rolled back`. The checksum matches, `fsck` reports 0 orphans, and `quota` is unchanged. `fsck --server` (root) shows the server-side probes. | DB-02 |
| Two users contend | Both profiles open `/home/shared/plan.md` in the Editor. | B opens read-only with a "Locked by alice" banner. `lsof` shows a 15 s countdown. End A's renderer from Chrome's Task Manager; B acquires the lock within the TTL. | VFS-09 |
| Hidden semantic query | The examiner types it in `semsearch "…"` and in Files search. | `path:line` citations and scores. Bob cannot see alice's private files. | RAG-03/04/06 |
| Agent with destructive confirmation | `ai "<hidden instruction>"` | Plan, dry run, blast radius, a `[y/N/e]` prompt defaulting to N, and the kernel-owned prompt. After `y`: one transaction, the txn id, `ai log`. Optionally, `kill` during execution rolls back. | AGT-03/05/08/09 |
| Pre-fetch | `predict`, then launch the top-1 app. `predict --latency` shows with and without pre-fetch. Task Manager shows `prefetch:<app>` and speculative pages. | Top 3 with confidence and a reason. A shorter launch time. | PRE-02/03/06 |

**Failure drills for this segment:**

| Failure | Response |
|---|---|
| The VPS is down | Run everything on the examiner's local stack. The agent degrades there because there is no key: show the graceful message (s12.6) and explain that keys never leave the server. Show the uptime history. Rebuilding from R2 takes about 1 h, so do not attempt it during the defence. |
| The LLM is down or rate-limited | "Agent unavailable — nothing was run" is correct behaviour. R4 switches the server env to the warm-standby provider (frozen stack, config only) and retries once. |
| A second Chrome profile is not available | Use an Incognito window. It has a separate storage partition, cookies and kernel instance. |
| The examiner's machine is slower than the lab spec and frame p95 exceeds budget | Show the nightly lab-runner evidence and the LoAF attribution (our scripts vs other). Explain that the executor count adapts to `hardwareConcurrency`. Never change settings to hide it. |
| The embedding model is still loading on first search | BM25 results appear, labelled. Give the model a few seconds; it loads after desktop-interactive, and opening Files search once early warms it. |
| The fault-injection endpoint is disabled | It is enabled on production only with the documented flag. Otherwise run this check on the local stack, where `compose.yaml` enables it. |

## 4. 0:18–0:26 Individual viva (about 1.5 min each; subsystem chosen by the examiners)

- **Preparation from W15:** weekly mock vivas in which every member is questioned on a random subsystem, using the bank of about 120 questions in `docs/viva-bank.md`.
- **Standard answer shape:** requirement, design, the data structure and its complexity, the measured number, the failure mode, the reversal trigger.
- **"Whiteboard in 60 s" drills,** one per subsystem:
  - the scheduler loop and the aging bound;
  - page-out ordering;
  - the canonical lock order L0–L4;
  - the exactly-once argument;
  - the Kahn levels and the cycle path;
  - the agent pipeline, and why the model cannot confirm;
  - the readable set built before ranking;
  - Witten-Bell back-off.
- **Rule:** if you cannot explain a piece of code you wrote, say so, show the test, and explain what it proves. Never bluff.

## 5. 0:26–0:30 Judges' questions

Prepared short answers, one slide each in reserve:
- the two decisions we would reverse, with data (ARCHITECTURE.md);
- known limitations, as stated in the README;
- what we would do differently;
- why not CRDTs;
- why not WASM;
- why Postgres over Mongo or Neo4j;
- cost per AI command and the semester total;
- where the tagline beats Puter and daedalOS.

## 6. After the day

Tag any hotfix as `v1.0.x` only if the instructor allows it. Archive the rehearsal logs, the drill outcomes and the final evidence in `docs/evidence/defence/`.
