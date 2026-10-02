
# Boot, service DAG and shutdown (BOOT-01..14)

## 1. Stages

| Stage | Thread | What happens | On screen | If it fails |
|---|---|---|---|---|
| 1 POST | main (inlined boot-ui) | Detect Workers, module workers, IndexedDB, OPFS (`getDirectory`), `crypto.subtle`, Service Worker, `isSecureContext`, `crossOriginIsolated`, SharedArrayBuffer. Read `storage.estimate()` and call `storage.persist()`. Check that `version.json` carries our identity, so another team's app on the same localhost port is caught. | Logo, name, version, build hash, "checking system" | "Unsupported browser" screen listing each missing capability. Missing isolation or OPFS only downgrades the boot (message pre-emption, IndexedDB swap), and `bootlog` says so |
| 2 Bootloader | main | Read boot flags from the URL and from IndexedDB `meta`. Holding Esc opens the **boot menu** (Normal / Safe / Recovery / Verbose; ↑↓ Enter; the auto-boot countdown shows only while the menu is open). After 2 consecutive failed boots, the menu opens with Safe preselected. | Boot menu | Fall back to safe mode |
| 3 Kernel init | kernel worker | The kernel bundle is fetched with a streaming `fetch()`, so its bytes drive the asset share of the progress bar, then instantiated from cache. Acquire the Web Lock. Create PidTable with PID 1 `init`, start the scheduler and executor #1, arm mm, open the IPC bus and the klog ring. Do a **boot-volume read**: a read-only fetch of the `/system/services/*.json` manifests from IndexedDB, falling back to built-in copies with a note in `bootlog`. | Progress and verbose lines | Kernel-panic screen with diagnostics |
| 4 Service start | kernel | Validate the manifests, build the DAG, run Kahn's algorithm, reject cycles, then start services level by level. | Current service and "n of m" | Critical: recovery screen. Non-critical: degraded, retried with back-off |
| 5 Login | kernel + login view | Use a cached session, an online server login, the offline PBKDF2 verifier, or guest. Time spent waiting for the user is recorded and **excluded** from boot time. | Login screen with the user list | Offer guest or offline mode |
| 6 Session restore | kernel + main | Restore the `os_session` layout (WM-06). Window frames paint at once and app chunks load after `desktop-interactive`. Record the timings. | Desktop | Start a clean session and keep the old one for recovery |

## 2. Service manifests (`services/manifests/*.json`, mirrored into `/system/services/`)

| name | requires | critical | weight | timeoutMs | priority | safeMode | runs in | "started" means |
|---|---|---|---|---|---|---|---|---|
| kernel | – | true | 3 | 1000 | 0 | true | kernel | PID 1, PidTable, IPC bus, klog |
| sched | kernel | true | 1 | 500 | 0 | true | kernel | ready heap and timer heap armed, executor #1 alive |
| storage | kernel | true | 4 | 3000 | 2 | true | kernel | IndexedDB `plotinium` open, migrations applied, fencing epoch bumped, persist result recorded |
| wm | kernel | true | 2 | 1000 | 2 | true | main + kernel | compositor attached, kernel port handshake done |
| mm | sched, storage | true | 2 | 2000 | 2 | true | kernel + blkio | budget loaded, LRU ready, swap device probed (OPFS or IndexedDB fallback), `*.tmp` sweep |
| vfs | storage | true | 5 | 3000 | 4 | true | kernel | `/`, `/home/<last user>` and cwd loaded lazily; quick invariants checked; `/tmp` cleared |
| login | vfs, wm | true | 2 | – (user wait excluded) | 8 | true | kernel + view | uid established |
| session | login, mm | true | 3 | 2000 | 10 | true (layout only, no app autostart) | kernel | layout restored; "restoring" states queued |
| desktop | session, wm | true | 3 | 3000 | 10 | true | main | shell mounted; first input-ready frame gives the `desktop-interactive` mark |
| auth | login | false | 1 | 4000 | 15 | true | kernel | server session validated or refreshed; verifier refresh scheduled |
| sync (`syncd`) | auth, vfs | false | 2 | 4000 | 20 | true | kernel | WebSocket LIVE (otherwise DEGRADED, "offline, n queued") |
| lockd | sync | false | 1 | 2000 | 20 | true | kernel | lease table ready, heartbeat armed (otherwise local advisory locks only) |
| ai.runtime | sched, mm | false | 1 | 4000 | 32 | false | kernel + executor | registry and `ai.search` spawned (under 50 ms); weights load later |
| ai.indexer | ai.runtime, vfs, session | false | 3 | 4000 | 32 | false | executor | cursor reconciled; pending count reported |
| ai.predictor | sched, storage, login | false | 1 | 2000 | 32 | false | executor | Markov counts loaded from the telemetry ring |
| ai.agent | vfs, sched, sync | false | 1 | 2000 | 20 | false | kernel registry | registered; health probe runs after interactive (no network during boot) |
| complete | vfs, desktop | false | 1 | 10000 | 36 | true | executor | trie over PATH and visited directories built incrementally (≥ 10k entries) |
| update | desktop | false | 1 | 10000 | 38 | true | main + SW | Service Worker registered after interactive plus idle; `update.available` wired |

Totals: **18 manifests, 30 edges, acyclic, 7 levels.**

**Validation rules at DAG build.** Any violation is a kernel panic naming the offending manifest:
- every `requires` name must exist;
- names must be unique;
- a critical service may not require a non-critical one;
- `weight > 0`, and `priority` must be in 0..39;
- no cycles.

## 3. Levels and the expected critical path

```
L0  kernel
L1  sched          storage          wm
L2  mm             vfs
L3  login          ai.runtime
L4  session        auth             ai.predictor
L5  desktop*       sync             ai.indexer
L6  lockd          ai.agent         complete        update
    (* desktop-interactive: boot time is measured here; L5/L6 non-critical services may still be starting)
Expected critical path: kernel -> storage -> vfs -> login -> session -> desktop
```

Degradable services, drawn dashed in BOOT.md: auth, sync, lockd, ai.*, complete, update.

## 4. Start algorithm (Kahn, driven by completion)

- **At build.** Compute in-degrees and run Kahn's algorithm (`dsa/dag`, O(V + E)) to get a topological order and level numbers. If nodes remain, run a DFS on the leftover subgraph to extract one cycle path and panic with it: `KERNEL PANIC: dependency cycle detected: sync → lockd → auth → sync`, followed by `[R] recovery console  [S] safe mode  [D] dump diagnostics`.
- **At runtime.** The same in-degree counters are decremented as services **complete**. A service starts the moment its last dependency finishes. Services in the same level therefore run concurrently (BOOT-03 shows overlapping timestamps), without a barrier between levels.
- **Timeouts.** Each `start()` is raced against `timeoutMs` using the kernel timer heap.
  - A critical timeout or failure halts the boot on the **recovery screen**: retry, safe mode, diagnostics (bootlog JSON download), and, only for `storage`, "reset local cache and re-sync", which exports the outbox first (BOOT-08).
  - A non-critical failure marks the service **DEGRADED** with a taskbar badge and a `svc.degraded` event. It is retried with jittered back-off (0.5, 1, 2, 4 … 60 s). Its dependents wait in a "blocked by dependency" state and start once it recovers (BOOT-07).
- **Safe mode.** Skip services with `safeMode:false` (all of `ai.*`). No app autostart: session restore brings back window frames only. Use the default theme.
- **Recovery mode.** Start kernel, sched, storage, wm and vfs (read-only), then open the **recovery console**: `fsck` (VFS-11), clear local cache (outbox exported first), reset session, restore default manifests, diagnostics.
- **Verbose mode.** Press V during boot, or choose it in the menu. Shows the timestamped kernel-style log (BOOT-05).
- **Examiner cycle test (BOOT-04).** As root, run `svcctl require sync lockd` (or edit `/system/services/sync.json`), then `reboot`: the panic names the cycle. "Restore default manifests" in the recovery console repairs it. CI does the same through a `?bootflags=inject-cycle` test flag.

## 5. Truthful progress (BOOT-02); no timers anywhere in the boot path

```
P = ( Σ_{s ∈ A, done} w_s  +  W_assets · bytesDone / bytesTotal ) / ( Σ_{s ∈ A} w_s + W_assets )
A = ancestor closure of 'desktop' (kernel, sched, storage, wm, mm, vfs, login, session, desktop: Σw = 25)
W_assets = 10; bytesTotal/bytesDone come from the build's boot-manifest (Vite manifest sizes) and from
PerformanceObserver('resource') entries in the document plus the kernel worker's streaming fetch.
```

- The bar moves only on completion events. On a warm boot the Service Worker cache resolves assets immediately. On a cold, throttled network the asset share grows with bytes received.
- Services outside A (lockd, ai.indexer, …) appear in the taskbar tray as "starting (n)" rather than holding the bar back.
- **CI test (BOOT-02):**
  1. Run CDP `Network.emulateNetworkConditions` at 400 kbps.
  2. Progress at t = 500 ms must be lower than on the unthrottled run.
  3. A static check fails the build if `setTimeout` or `setInterval` appears in `wm/boot-ui/**` or `services/**`, except the boot-menu countdown, which is allowlisted.
- **Label:** `vfs: mounting / (12,408 inodes) · Service start · 7 of 9`.

## 6. Boot-time budget (BOOT-10: warm ≤ 1.5 s, cold ≤ 3.0 s on the reference machine)

| Segment | Warm target | Cold target | Notes |
|---|---|---|---|
| HTML + inlined boot-ui + tokens | 20 ms | 150 ms | boot-critical main-thread JS ≤ 60 KB gz (PR gate) |
| POST + bootloader | 20 ms | 20 ms | `persist()` does not block the boot |
| Kernel bundle fetch + eval | 40 ms | 350 ms | kernel worker bundle budget starts at 100 KB gz, re-baselined at W7 |
| kernel → storage → vfs | 150 ms | 170 ms | lazy mount measured at p95 ≤ 15 ms; no WASM on the boot path |
| login (cached session) | 20 ms | 20 ms | human wait excluded and reported separately |
| session + desktop mount | 200 ms | 250 ms | Solid is about 7 KB gz; app chunks load later |
| **Total** | **≈ 0.45 s (budget 1.5)** | **≈ 0.95 s (budget 3.0)** | the nightly lab-runner test fails the build over budget |

These are loaded only after `desktop-interactive`: the Service Worker registration, the xterm and CodeMirror chunks, Transformers.js, `/ort` and `/models`, the trie build and the ai.embed weights.

## 7. bootlog and the critical path (BOOT-11)

- **What is recorded.** Every boot stores `{bootId, flags, stages[], services[{name, level, start, end, status, attempts}], userWaitMs, interactiveAt}` in IndexedDB `bootlog` (last 20 boots). It is also exposed as `/system/log/boot.log`.
- **Algorithm.** `--critical-path` walks back from `desktop`. At each step it picks the dependency with the **latest finish time**, then prints the chain with durations. Every other dependency is printed with its slack.

```
$ bootlog --critical-path
boot #37 · normal · 0.73 s to desktop-interactive (user wait 0.00 s excluded)
kernel    0.000 → 0.046   46 ms
storage   0.046 → 0.110   64 ms   gated by kernel
vfs       0.110 → 0.212  102 ms   gated by storage
login     0.212 → 0.341  129 ms   gated by vfs      (wm done 0.061, slack 151 ms)
session   0.341 → 0.402   61 ms   gated by login    (mm done 0.118, slack 223 ms)
desktop   0.402 → 0.731  329 ms   gated by session
```

## 8. Graceful shutdown and restart (BOOT-12)

`shutdown -r now` or `reboot` runs these steps in order:
1. Stop admitting new processes.
2. Send SIGTERM to user processes, with a 2 s grace period, then SIGKILL.
3. Checkpoint the processes that can be checkpointed and **flush dirty pages** to swap.
4. Save the `os_session` layout (window geometry, state, z-order, cwd) locally, and on the server when online.
5. Flush the outbox. When online, wait up to 3 s for acks; either way the outbox is durable.
6. Stop services in **reverse topological order** (reverse levels).
7. `lockd` sends `bye`, which releases leases immediately.
8. Close IndexedDB and release the kernel Web Lock.
9. If a new Service Worker is waiting, post `SKIP_WAITING` and reload on `controllerchange` (OFF-05).

On restart the session returns exactly as saved.

## 9. Accessibility (BOOT-13)

- **Progress bar.** `role="progressbar"` with `aria-valuenow`, and `aria-valuetext` such as "Starting vfs, 5 of 9".
- **Announcements.** A `role="status"` `aria-live="polite"` region announces each stage change (at most one announcement every 750 ms) and every degraded service.
- **Reduced motion.** Under `prefers-reduced-motion` the bar width changes without transition, and the motion tokens are 0 ms.
- **Keyboard.** The boot menu is a keyboard listbox (↑↓, Enter, Esc) with visible focus. The panic and recovery screens have focusable buttons with single-key shortcuts.
- **Automated check.** axe runs on the boot screen, boot menu, panic screen and recovery console in both themes.

## 10. Tests

| Test | IDs covered |
|---|---|
| Kahn, levels and cycle-path unit tests: diamonds, self-loop, 2- and 3-cycles, 500-node random DAGs; property test that the topological order respects every edge | DSA |
| e2e: normal boot | BOOT-01, 03, 11 |
| e2e: throttled progress | BOOT-02 |
| e2e: injected cycle | BOOT-04 |
| e2e: blocked `/api` | BOOT-07 |
| e2e: corrupted `meta.schema` | BOOT-08 |
| e2e: server killed, then offline boot | BOOT-09 |
| e2e: timing budget | BOOT-10 |
| e2e: `shutdown -r now` | BOOT-12 |
| e2e: keyboard-only boot menu | BOOT-13 |
