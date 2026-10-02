# Demo Day rehearsal runbook

| Field            | Value                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What             | The minute-by-minute plan for the 30-minute final defence (spec §17.1): who does what, the commands we suggest, what must be on screen, how to handle each failure, and the checklists                                                                                                                                                                                                        |
| Normative source | [specs/13-quality/testing-and-performance.md §3.16](../../specs/13-quality/testing-and-performance.md) (TST-18); [ai-safety-and-evaluation.md §3.14](../../specs/10-ai/ai-safety-and-evaluation.md) (AI ordering, AIS-11); [deployment-and-ci.md §3.6](../../specs/14-devops/deployment-and-ci.md) (bring-up). If this runbook and a spec disagree, the spec wins and this file is corrected. |
| Owner            | R5 (rehearsal lead and drill lead). Reviewer: R3 (boot narrator). Each item's narrator owns their rows.                                                                                                                                                                                                                                                                                       |
| Scripts          | [tests/e2e/demo-day/](../../tests/e2e/demo-day/README.md) automates every check below. The printable card for the examiner is [EXAMINER-CARD.md](EXAMINER-CARD.md).                                                                                                                                                                                                                           |
| Status           | Draft for the W15 rehearsal. Update after every rehearsal.                                                                                                                                                                                                                                                                                                                                    |

## 1. Principles

1. **The examiner drives; we narrate.** Nobody on the team touches the examiner's keyboard or mouse unless asked. We suggest commands out loud, exactly as they appear on the command sheet.
2. **Everything runs on the tag `v1.0.0`.** Production is deployed by image digest, and the local stack is the examiner's own clone of the tag.
3. **Nothing is faked.** When something fails, the system degrades honestly ("unavailable, nothing was run", BM25 results labelled as such, the lease expiring by TTL), and we say what happened and why. We never change a setting to hide a number.
4. **Every command is a real program** in `/bin` with a `man` page. If an examiner asks "is that real?", the answer is `man <command>` and the source file.
5. **Measured claims cite lab evidence.** Numbers on the examiner's machine are shown, not claimed. Gate numbers come from the lab-spec runner (`docs/evidence/`).
6. **Talk about the name the right way.** Say "coined from plutonium, element 94: dense and energetic". Never use weapons or hazard vocabulary ([identity-and-branding.md §3.1](../../specs/00-product/identity-and-branding.md)).

## 2. Roles on the day

Names go in [TEAM_CONTRACT.md](../../TEAM_CONTRACT.md). Roles:

| Role           | Who                                                                | Job                                                                                                               |
| -------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| **Lead**       | R5                                                                 | opens, keeps to the plan, calls the next item, decides when a drill response has used its time                    |
| **Timekeeper** | R5 at 0:05–0:08 and during the viva; R3 at 0:00–0:05 and 0:08–0:18 | stopwatch; one quiet hand signal 60 s before each segment ends; writes the actual split times on the log sheet    |
| **Prompter**   | the narrator of the current item                                   | reads the next command from the command sheet to the examiner, word for word                                      |
| **Narrator**   | per item, below                                                    | explains what is on screen: requirement → design → data structure and complexity → measured number → failure mode |
| **Responder**  | the owner of the failing area                                      | runs the drill response in §5; nobody else speaks until they finish or the lead moves on                          |
| **Note-taker** | whoever is not narrating                                           | writes examiner questions and anything that went wrong, for the log                                               |

Narrators by item: bring-up R5; boot R3 (owner R5); items 1–3 R4; item 4 R3; item 5 R1; items 6–7 R2; optional item 8 R4; optional item 9 R5.

## 3. Minute by minute

Times are offsets from the examiner's "start". Each row shows what the examiner does (the command we suggest), what must be visible, who narrates, and the first fallback. Full fallbacks are in §5.

### 0:00–0:05 Clean bring-up (scored before we speak)

| Time     | Examiner does                                                     | Must be visible                                               | Narrator                                                                                                                                                                                | If it fails                                                              |
| -------- | ----------------------------------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 0:00:00  | `git clone https://github.com/<org>/plotinium.git`                | clone completes                                               | silent (R5 only if the examiners invite talk)                                                                                                                                           | B5 (network)                                                             |
| 0:00:30  | `cd plotinium` then `docker compose up -d --wait`                 | images pull from GHCR; `db`, `app` and `web` turn healthy     | R5, only if invited: one origin, three containers, images pinned by digest, the `app` entrypoint runs migrations and the seed before `/readyz` turns healthy, and `--wait` watches that | B1 port busy, B2 Compose missing or old, B4 arm64, B6 `--wait` times out |
| ≈0:03:00 | (the command returns)                                             | prompt back, exit 0. CI budget: 240 s from clone to desktop.  | R5                                                                                                                                                                                      | B6                                                                       |
| 0:03:30  | `docker compose logs app \| grep -A 12 "FIRST-START CREDENTIALS"` | one block with `root`, `demo`, `alice`, `bob`, `examiner1..3` | R5: generated at first start, stored only as Argon2id hashes, printed once, never in the repository (C10)                                                                               | B7                                                                       |
| 0:04:00  | opens the production URL `https://<domain>` in Chrome profile A   | the Plotinium boot screen, then login                         | R5: the same build identity everywhere (`/version.json`)                                                                                                                                | S1 (VPS down): the local stack for everything                            |
| 0:04:45  | (closes the production tab; keeps it for items 1–3)               | –                                                             | Lead: "Next, the boot."                                                                                                                                                                 | –                                                                        |

### 0:05–0:08 Boot

| Time    | Examiner does                                                                                                                                                      | Must be visible                                                                                                          | Narrator                                                                                                                                 | If it fails                                                              |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 0:05:00 | opens **http://localhost:4717** (the first load is a real `cold-first` boot) and **holds V** (or Esc → Verbose boot)                                               | the timestamped log `[ssss.mmm] subsystem: message`: firmware, loader, kernel, svc, every service; truthful progress bar | R3: boot stages, POST, the DAG, Kahn levels, completion-driven start, why progress uses real byte and service weights (BOOT-02, BOOT-05) | T4 (V missed)                                                            |
| 0:05:40 | logs in as `demo` (local password from the logs)                                                                                                                   | desktop; `desktop-interactive`                                                                                           | R3: login, session restore                                                                                                               | –                                                                        |
| 0:05:55 | Terminal: `bootlog`                                                                                                                                                | stage table and per-service timings                                                                                      | R3                                                                                                                                       | –                                                                        |
| 0:06:10 | `bootlog --critical-path`                                                                                                                                          | the chain `kernel → storage → vfs → login → session → desktop` with "gated by" and slack; the total equals the boot time | R3: walking back from `desktop` along the latest-finishing dependency is the longest path (BOOT-11)                                      | –                                                                        |
| 0:06:35 | points at the taskbar badge **Offline-ready**                                                                                                                      | badge shown                                                                                                              | R3: the Service Worker registers only after desktop-interactive plus idle, which protects BOOT-10 (C11)                                  | T1 (cut before badge)                                                    |
| 0:06:45 | cuts the network. On the local stack: `docker compose stop app web` (cutting Wi-Fi does not stop localhost), or DevTools → Offline. Then `reboot` in the Terminal. | the desktop boots from the Service Worker; the login shows "signing in offline" if needed; taskbar "Offline"             | R3: SW-cached shell, IndexedDB VFS, offline verifier (PBKDF2), no critical service waits on the network (BOOT-09)                        | T2, T3                                                                   |
| 0:07:10 | `ls -la ~`, `echo hi > ~/offline.txt`, `cat ~/offline.txt`; opens Files, Editor (edit and save), Task Manager, Settings                                            | everything works; taskbar "Offline · 1 queued"                                                                           | R3 then R5: outbox, op ids, exactly-once replay (OFF-01)                                                                                 | –                                                                        |
| 0:07:40 | reconnects: `docker compose start app web`, or DevTools → No throttling                                                                                            | taskbar "Syncing 1 op", then "Online"; `cat` still shows the file                                                        | R5: replay, idempotent op ids, 0 lost and 0 duplicated (OFF-02, OFF-04)                                                                  | the drill "reconnect slow": wait for the dead-man timer, then explain it |

### 0:08–0:18 System under test (examiner-driven, Appendix A)

Setup, done while the examiner reads: two Chrome profiles side by side (**A = alice**, **B = bob**), laptop on AC power. **Order:** the hidden semantic query comes **before** the memory test (AIS-11).

| Time    | #   | Check                               | Instance                                   | Examiner does (we suggest)                                                                                                                                                 | Must be visible                                                                                                                                                                                        | Narrator                                                                                                                             | If it fails                                  |
| ------- | --- | ----------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------- |
| 0:08:00 | 1   | Hidden semantic query               | production                                 | A: `semsearch "<their query>"`, then the same query in the Files search box; B: the same query                                                                             | ranked results, `path:line` citations, scores; B sees none of alice's private files                                                                                                                    | R4: readable set built **before** ranking, exact top-k with the heap, server verification of shared results (RAG-03/04/06)           | S5, S6                                       |
| 0:09:15 | 2   | Agent with destructive confirmation | production                                 | A: `ai "<their instruction>"`, answer **Enter** first (default N), then run it again and answer `y`; `ai log`                                                              | plan, dry run with blast radius, the kernel-owned `Proceed? [y/N/e]` prompt with the secure indicator; Enter declines and nothing changes; `y` gives one transaction and a txn id; `ai log` shows both | R4: the model proposes and the kernel decides; type-ahead is flushed, no `--yes` exists, one `vfsTxn` (AGT-03/05/08)                 | S2, S1                                       |
| 0:10:45 | 3   | Pre-fetch                           | production                                 | `predict`; wait 2 s; launch the top-1 app; `predict --latency`; Task Manager → Predictions                                                                                 | top 3 with confidence and reason; `prefetch:<app>` at PRI 39 in `ps`/`top`; speculative pages; a shorter launch                                                                                        | R4: Witten-Bell Markov-2, idle ≥ 2 s, lowest priority, evicted first (PRE-02/03/06)                                                  | –                                            |
| 0:12:00 | 4   | CPU load + drag                     | either                                     | `burn --ms 120000 &` ×3; `top`; `framemeter on`; drag and resize 10 windows                                                                                                | meter p95 ≤ 16.7 ms and 0 LoAF from our code; `top` shows the three burns                                                                                                                              | R3: the kernel is off the main thread, executors are pre-emptible generators, the compositor writes transforms only (PROC-05, WM-03) | S4                                           |
| 0:13:30 | 5   | 2x memory                           | either                                     | `memhog --total 512M --procs 8`; Task Manager → Memory; `free`; `vmstat 1`; click a minimised window                                                                       | accounted memory never above the budget; faults and bytes out rising; "Restoring… n / m MB", then the page-in time                                                                                     | R1: reservation-based admission, LRU pager, the minimised eviction class, byte-identical page-in (MEM-03/05/06/07)                   | S7                                           |
| 0:15:00 | 6   | Fault-injected `rm -r`              | **local stack only** (C7)                  | `su -c 'debug inject rm 500 --target server'` (the examiner may choose N; root password from the logs); `fsck --checksum ~/fixtures/tree1000`; `rm -r ~/fixtures/tree1000` | `rm: … Input/output error (injected fault at node 500) — rolled back`, printed before the prompt returns; same checksum; `fsck` 0 orphans; `quota` unchanged; `su -c 'fsck --server'` clean            | R2: one `vfsTxn`, lock order L0–L4, the GUC-gated trigger that exists only with `FAULT_INJECTION=1` (DB-02)                          | S9                                           |
| 0:16:15 | 7   | Two users contend                   | production (or local)                      | A and B open `/home/shared/plan.md` in the Editor; B: `lsof /home/shared/plan.md`; end A's renderer in Chrome's Task Manager (Shift+Esc)                                   | B read-only with "Locked by alice"; `lsof` shows the 15 s countdown; B acquires within the TTL                                                                                                         | R2: leases with fencing tokens, heartbeat TTL/3, why a crash cannot keep the lock (VFS-09)                                           | S8                                           |
| 0:17:30 | 8   | (optional) agent kill mid-plan      | local, `FAULT_INJECTION=1`, planner agreed | `su -c 'debug delay 5000'`; run the recorded instruction; `kill` the agent during execution                                                                                | rollback; `ai log` shows `killed_rolled_back`; `fsck` clean                                                                                                                                            | R4 (AGT-09)                                                                                                                          | show the tag's CI result for the AGT-09 test |
| 0:17:30 | 9   | (if agreed) OFF-05                  | production                                 | R5 runs the `deploy` workflow for the pre-built `v1.0.1` (hash-only)                                                                                                       | "Restart to update"; `reboot`; `uname` shows `1.0.1`                                                                                                                                                   | R5                                                                                                                                   | skip; state that it was rehearsed            |
| 0:18:00 | –   | –                                   | –                                          | Lead: "That is the system. The viva."                                                                                                                                      | –                                                                                                                                                                                                      | –                                                                                                                                    | –                                            |

### 0:18–0:26 Individual viva

- About 90 seconds per member. The examiners choose the subsystem, not necessarily our own. The order is theirs.
- **Answer shape:** requirement → design → data structure and complexity → measured number (lab evidence) → failure mode → reversal trigger.
- **60-second whiteboard answers we have practised:** the scheduler loop and the aging bound; page-out ordering; lock order L0–L4; the exactly-once argument; Kahn levels and the cycle path; the agent pipeline and why the model cannot confirm; the readable set built before ranking; Witten-Bell back-off; the frame metric.
- **Rule:** if you cannot explain a line, say so, show the test that covers it and explain what it proves. Never bluff.

### 0:26–0:30 Judges' questions

Reserve slides, one each, in `docs/slides/`: the two decisions we would reverse, with data (ARCHITECTURE.md §9.1); known limitations (README); what we would do differently; why not CRDTs; why not WASM; why PostgreSQL over MongoDB or Neo4j; cost per AI command and the semester total; where Plotinium beats Puter and daedalOS.

## 4. Before the day: pre-flight checklists

### T-7 days (R5)

- [ ] `v1.0.0` tagged; production redeployed by image digest; `/version.json` shows `1.0.0`
- [ ] restore drill passed and logged
- [ ] UptimeRobot green for 7 days
- [ ] the `bringup` job green on 3 consecutive nights (≤ 240 s)
- [ ] Chrome stable re-verified within 48 h (TST-13)
- [ ] LLM budget ≥ USD 20 remaining; the examiner accounts reset with their own budget pool; warm-standby provider tested
- [ ] `v1.0.1` (hash-only) built and pushed, **not deployed**; instructor agreement recorded for item 9
- [ ] the scripted rehearsal green on the lab runner (`tests/e2e/demo-day`, §6)

### T-1 day (all)

- [ ] production `.env` frozen with `FAULT_INJECTION=0` (C7) and the demo lease profile (TTL 15 s, heartbeat 5 s, C6)
- [ ] examiner and root credentials for production printed on paper, sealed in an envelope, and scheduled for rotation after the defence (C10)
- [ ] `demo verify` passes: tree1000 checksum; `/home/shared/plan.md` mode 664, group `team`; corpus with precomputed vectors; demo telemetry trace
- [ ] [EXAMINER-CARD.md](EXAMINER-CARD.md) printed (two copies); the command sheet printed for each narrator
- [ ] 4G hotspot charged; our laptops are for notes only
- [ ] every member has read the §5 drills for their items

### T-1 hour (R5 and R3)

- [ ] production URL opened on a phone; `/api/readyz` green; `/version.json` shows `1.0.0`
      (or run `PLT_DEMO_DAY=1 PLT_DEMO_BRINGUP=1 PLT_PRODUCTION_URL=https://<domain> PLT_EXPECT_VERSION=1.0.0 pnpm exec playwright test -c tests/playwright.config.ts --project e2e demo-day/00 --grep PLT-DEL-02`)
- [ ] the instructor's answers recorded: which instance runs 0:08–0:18; whether the hidden AI prompts run on production (open question 4); whether the hash-only patch deploy is allowed; whether a revocable upstream token may be placed on the local stack after the bring-up is scored (item 8)
- [ ] the Files search box focused once on production, so `ai.embed` is warm (S6)

### T-10 minutes, at the table

- [ ] sealed credential envelope handed to the examiners (never read out loud)
- [ ] stopwatch zeroed; log sheet and pen ready
- [ ] two Chrome profiles available on the examiner's machine (or Incognito for B, S3)
- [ ] phone hotspot on standby
- [ ] no member's laptop is connected to the examiner's machine

### After the defence (R5, same day)

- [ ] rotate the production examiner and root credentials
- [ ] remove the upstream token hash from the production accept list, if item 8 used one
- [ ] write `docs/evidence/defence/final.md` from the log sheet (§7 template)

## 5. Failure drills

Each drill has one **responder**. It has a time box of 60 s in the system-under-test segment and 90 s elsewhere. When the time box ends, the lead moves on and says honestly what was not shown.

### Bring-up (responder R5)

| #   | Drill                                                          | Response (never touch the examiner's machine unless asked)                                                                     |
| --- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| B1  | Port 4717 busy                                                 | README line: `PLOTINIUM_PORT=4718 docker compose up -d --wait`, then open `http://localhost:4718`                              |
| B2  | Docker or Compose missing, or older than 2.24                  | point to the README prerequisites; continue on the production URL; state honestly that the local bring-up was not achieved     |
| B3  | A foreign Service Worker on `localhost:4717` from another team | POST shows "This page is not Plotinium"; open a fresh Chrome profile                                                           |
| B4  | arm64 laptop                                                   | multi-arch images; the `image` + `build` fallback in `compose.yaml` builds if a pull fails                                     |
| B5  | Slow network                                                   | keep narrating; images start pulling at once; the CI and campus timings are in the release notes                               |
| B6  | `--wait` times out                                             | `docker compose logs app` names the failing step (migration, seed, argon2 self-test); the rehearsal log has the fix            |
| B7  | Credentials block not in the logs                              | the stack was started before (volumes exist): `docker compose down -v` deletes local data and re-seeds; ask the examiner first |
| B8  | Not Chrome (Firefox or Safari)                                 | POST shows the "unsupported browser" screen with the reason; ask for Chrome stable                                             |

### Boot (responder R5; narrator R3)

| #   | Drill                                                                                           | Response                                                                                                                 |
| --- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| T1  | Network cut before "Offline-ready"                                                              | reconnect, wait for the badge, retry, and explain the deferred registration that protects BOOT-10                        |
| T2  | Examiner corrupts local state (BOOT-08)                                                         | recovery screen → "reset local cache and re-sync" (the outbox is exported first)                                         |
| T3  | Examiner adds a manifest cycle (BOOT-04), e.g. `su -c 'svcctl require sync lockd'` and `reboot` | on the local stack: the panic screen names the cycle → `[R]` recovery console → `M` restore default manifests            |
| T4  | Verbose key missed (warm boot is fast)                                                          | `reboot --menu` → Verbose boot, or Settings → "show boot menu on next boot"                                              |
| T5  | Reconnect does not turn "Online" quickly                                                        | a silent loss waits for the dead-man timer (≤ 26 s, `OFF-04.offline-indicator-silent`); explain heartbeats while waiting |

### System under test (responder = narrator of the item)

| #   | Drill                                                            | Response                                                                                                                                                               |
| --- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | VPS down                                                         | run items 4–8 on the local stack; the agent degrades with the §12.6 message; show the UptimeRobot history; do not attempt a rebuild during the defence (about 1 h, R2) |
| S2  | LLM down or rate-limited                                         | "Agent unavailable — nothing was run" is correct behaviour; R4 switches the server env to the warm-standby provider (config only) and retries once                     |
| S3  | No second Chrome profile                                         | an Incognito window: separate storage partition, cookies and kernel                                                                                                    |
| S4  | Examiner machine slower than the lab spec; frame p95 over budget | show the nightly lab evidence and the LoAF attribution (ours against others); explain that executors adapt to `hardwareConcurrency`; never change settings to hide it  |
| S5  | Model still loading on the first search                          | BM25 results appear, labelled; focus the Files search once early to page `ai.embed` in                                                                                 |
| S6  | Memory test ran first and evicted `ai.embed`                     | kill `memhog`, focus the Files search box, then type the query; RAG-05 is claimed only on the warm figure                                                              |
| S7  | Campus network blocks WSS                                        | switch items 6–7 to the local stack; the transport record's campus test and reversal trigger cover this                                                                |
| S8  | Lease not released after the renderer kill                       | wait the TTL that `lsof` shows: this is the expiry path VFS-09 requires                                                                                                |
| S9  | Local root password lost                                         | `docker compose exec app node dist/tools/reset-password.js root` prints a new one (local stack only)                                                                   |
| S10 | Paper credentials for production missing                         | use the local stack for the root items; production needs no root for items 1–5 and 7                                                                                   |
| S11 | `su` refuses after wrong passwords ("too many attempts")         | wait for the 5-minute lock-out while showing another item; come back to item 6 last                                                                                    |

### Drill cards for rehearsals (R5 injects at least two, unannounced)

Draw two cards before each rehearsal and keep them hidden from the team:

| Card                       | How R5 injects it                                                                           |
| -------------------------- | ------------------------------------------------------------------------------------------- |
| D1 port busy               | `python3 -m http.server 4717 --bind 127.0.0.1` before the bring-up                          |
| D2 early network cut       | switch the network off before the Offline-ready badge                                       |
| D3 corrupted state         | DevTools → Application → delete the `plotinium` IndexedDB database mid-session, then reload |
| D4 manifest cycle          | `su -c 'svcctl require sync lockd'`, then `reboot`                                          |
| D5 production unreachable  | an `/etc/hosts` entry sending the domain to 127.0.0.2                                       |
| D6 LLM down                | revoke the rehearsal LLM key on the gateway                                                 |
| D7 wrong order             | ask for the memory test before the semantic query                                           |
| D8 one profile             | forbid a second Chrome profile                                                              |
| D9 lost root password      | hide the logs; ask for `su`                                                                 |
| D10 slow machine           | DevTools CPU throttling 4x during item 4                                                    |
| D11 foreign Service Worker | serve another app on 4717 once, then start Plotinium                                        |
| D12 examiner chooses N     | ask for `debug inject rm 999` instead of 500                                                |

A drill that was not handled cleanly becomes an issue with an owner before the next rehearsal.

## 6. The scripted rehearsal

The scripts in [tests/e2e/demo-day/](../../tests/e2e/demo-day/README.md) run every check above in protocol order and write a rehearsal record. Run them the day before each live rehearsal and nightly on the lab runner from W15:

```sh
# a clean machine: nothing named "plotinium" in `docker compose ls -a`
PLT_DEMO_DAY=1 PLT_DEMO_BRINGUP=1 PLT_E2E_UI=1 \
PLT_BRINGUP_REPO=https://github.com/<org>/plotinium.git PLT_BRINGUP_REF=v1.0.0 \
PLT_DEMO_REHEARSAL=rehearsal-<n> PLT_DEMO_NETWORK="<campus | 4G hotspot | lab LAN>" \
  pnpm exec playwright test -c tests/playwright.config.ts --project e2e demo-day

node tests/e2e/demo-day/report.ts --run rehearsal-<n>     # Markdown for the log (§7)
```

- Items 1–3 against production with a planner: add `PLT_DEMO_AI=1 PLOTINIUM_BASE_URL=https://<domain>` and the account passwords as `PLT_TEST_<USER>_PASSWORD`. Without a planner, the script checks the honest "unavailable, nothing was run" instead.
- R4 sets the examiner-style hidden prompts with `PLT_DEMO_QUERY` and `PLT_DEMO_INSTRUCTION`.
- A red script is a defect with an owner, just like a failed drill. A skipped or `fixme` script means the check was **not** verified (T-3).
- The scripted times are not the stopwatch times. Playwright types faster than an examiner. The scripted times show which checks are slow; the live rehearsal shows whether the 30 minutes hold.

## 7. Rehearsal log template

Copy into `docs/evidence/defence/rehearsal-<n>.md` (TST-18):

```text
# Rehearsal <n> — <date>

Tag: v1.0.0-rc.<k> | Machine: <make, OS, CPU, RAM> (not a team member's: yes/no)
Chrome: <version> | Network: <campus | 4G hotspot | lab LAN> | Examiner stand-in: <name>
Drill lead: R5 | Timekeeper: <role> | Note-taker: <role>

## Segment times
| Segment | Slot | Actual start | Actual end | Over by |
| Clean bring-up | 0:00–0:05 | | | |
| Boot | 0:05–0:08 | | | |
| System under test | 0:08–0:18 | | | |
| Individual viva | 0:18–0:26 | | | |
| Judges' questions | 0:26–0:30 | | | |

## Items shown
[ ] bring-up ≤ 3 commands, ≤ 5 min   [ ] verbose cold boot   [ ] bootlog --critical-path
[ ] offline reboot + core utilities   [ ] 1 semantic query     [ ] 2 agent (N, then y)
[ ] 3 pre-fetch                       [ ] 4 CPU + drag         [ ] 5 2x memory
[ ] 6 fault-injected rm -r            [ ] 7 two users on a lock

## Drills
| Card | When | Responder | Response | Clean? | Issue |

## Defects filed
| Issue | Owner | Due |

## Scripted record
<paste the output of: node tests/e2e/demo-day/report.ts --run rehearsal-<n>>

Signed: R1 ___ R2 ___ R3 ___ R4 ___ R5 ___
```

## 8. Rehearsal schedule (testing §3.16.1)

| When              | Where                                    | Led by  | Pass criterion                                                                              |
| ----------------- | ---------------------------------------- | ------- | ------------------------------------------------------------------------------------------- |
| W15               | a lab PC (not a team member's)           | R5      | full 30 min on the stopwatch; every §17.1 item shown; at least 2 unannounced drills handled |
| W16 (freeze gate) | a friend's laptop or a fresh OS account  | R5      | as above on `v1.0.0-rc.1`; this rehearsal is the freeze gate (§13.1)                        |
| W17 ×2            | a lab PC, and a macOS or Windows machine | R5      | as above; one run on the campus network, one on the 4G hotspot                              |
| T-1               | lab PC                                   | R5 + R3 | smoke run of 0:00–0:08 and the AI segment on production                                     |
