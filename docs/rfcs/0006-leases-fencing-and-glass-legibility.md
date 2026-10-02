# RFC 0006: Lease fencing end to end, adaptive glass legibility, and Dock expansion and motion

| Field     | Value                                                                                                                                                                                                                                                                                                                                                  |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Title     | Lease fencing end to end, adaptive glass legibility, and Dock expansion and motion                                                                                                                                                                                                                                                                     |
| Status    | **Approved with cuts** (ARB, 2026-09-30): part (a)'s fence plumbing and SYN-19 are built by `platform` in step 0, with the SYN-21 zombie tests as its stretch goal; SYN-20 and the frozen-holder E2E are deferred; parts (b) and (c) are **deferred** to the next wave (design accepted with the review changes). See §13, §17 and [PLAN.md](PLAN.md). |
| Authors   | design-platform (Wave 3 design track)                                                                                                                                                                                                                                                                                                                  |
| Reviewers | Design critics (2), Architecture Review Board; domain reviewers: R2 (VFS and sync, part a), R3 (UI, parts b and c), R5 (QA and performance)                                                                                                                                                                                                            |
| Date      | 2026-09-30                                                                                                                                                                                                                                                                                                                                             |
| Builder   | `platform` (Workflow B), which is also the wave's step-0 integrator; only part (a) is scheduled                                                                                                                                                                                                                                                        |
| Evidence  | `docs/design/wave3/design-platform/` (baseline screenshots and `baseline-measurements.json`, measured on the QA copy at :4718 on 2026-09-30 with 0 CSP violations)                                                                                                                                                                                     |

## 1. Summary

This RFC bundles three small, research-backed improvements for one builder. Each one deepens code that already exists. None of them adds a subsystem.

- **(a) Lease fencing, end to end.** The server already implements leases with fencing tokens, and the check is written and tested (`server/src/engine/locks/fencing.ts:59`). The audit found that **no client write ever carries a fence**: the kernel builds every commit without one (`kernel/src/core/fs/kfs.ts:512-519`), and `Lockd.fenceFor` has no caller outside its own test. We plumb the fence from the lock engine into the commit, and we add a small client-side validity margin in the style of Gray and Cheriton. We also add the missing deterministic tests for the classic failure: a client pauses, its lease expires, another client takes the lock and writes, and then the first client writes. Correctness today already rests on a version compare-and-swap, so this part turns a dead designed path into a live, tested one. It does not fix data loss, and §2.1 says so plainly.
- **(b) Adaptive glass legibility.** The menu bar, Dock, Control Centre and popovers use fixed glass alphas. Over today's two built-in wallpapers every text role passes WCAG AA with a wide margin (measured: at least 12.7:1 for primary text). Over an arbitrary backdrop they do not: for example, dark-theme menu-bar text drops to 3.19:1 and muted text to 2.41:1 over white. We compute the wallpaper's luminance under each surface **once per wallpaper, theme or viewport change**, from the known wallpaper image and never from live pixels. From that we choose a scheme (light or dark glass, as macOS does for the menu bar) and an alpha **floor**. The floor never goes below the design token, and Reduce transparency always wins. The RFC also adds a small wallpaper choice with one bright bundled wallpaper, so that adaptivity is demonstrable. It fixes a latent DSN-25 gap on the way: glass in `[data-theme]` subtrees stays translucent under Reduce transparency.
- **(c) Dock expansion and motion.** Today magnification starts only when the pointer enters the Dock's box, jumps to full size in one frame, and grows about the Dock's centre, which moves the icon under the pointer by up to 15 px (30 px at 2×). Following McGuffin and Balakrishnan, we start expansion in an approach band above the Dock and anchor growth at the pointer. Following Chang and Ungar, we ramp in (slow-in), follow through on exit with a tuned spring, and add a small "catch" when a minimised window lands. Every claim is measured with a frame-time trace and analytic drift metrics, and all of it switches off under reduced motion.

**ARB outcome (2026-09-30).** The lead's priority order puts this RFC last, and Workflow B has 8 builders. So:

- **Part (a), the fence plumbing**, is carried by `platform`, which already owns every kernel file it touches (`kfs.ts`, `io/index.ts`, `net/engines.ts`, `net/factory.ts`). It lands in step 0 with its SYN-19 tests. The re-baselined design in §5.1 applies the review changes:
  - the product engine is now `LockdEngine`, which needs `fenceFor` and `leaseState` delegations (0006-M1);
  - `sync.fenceWrites` is a runtime sysctl (0006-S4);
  - there is no `vfs/src/index.ts` edit (0006-N2);
  - the draft's step 5 is dropped (0006-S1).
- **The SYN-21 zombie tests** (unit and property) are `platform`'s stretch goal after step 0.
- **SYN-20** (the ε suspect state), **the frozen-holder E2E** and **the server lock metrics** are deferred.
- **Parts (b) and (c) are deferred** to the next wave. Their design is accepted with the review changes recorded in §5.2, §5.3 and §17: the Dock frame budget under 10 windows and CPU load, and `OffscreenCanvas` for sampling.

## 2. Context and problem (verified in the code on 2026-09-30)

### 2.1 Part (a): leases and fencing

**What exists and works (server).**

- The lease manager provides S/X leases with a TTL of 30 s (15 s in the demo profile), FIFO waiters, and an expiry index on `dsa/heap` rebuilt at start (`server/src/engine/locks/manager.ts:1-19`, `server/src/engine/locks/expiry-index.ts:1-27`). `HEAP_IMPLEMENTED` is now true (`dsa/src/heap/index.ts:31`), so the "Map stand-in" remark in `server/src/engine/locks/README.md:3` is stale.
- Every grant carries a fence from `lock_fence_seq`, and an X grant stamps `inodes.lock_fence` (`server/src/engine/locks/types.ts:20`, `server/src/engine/locks/tests/memory-store.ts:111`).
- The write-time check `checkWriteLeases` implements Kleppmann-style fencing (`server/src/engine/locks/fencing.ts:59-89`). A fence below `lock_fence`, or a fence whose own lease is gone or expired, gives `EBUSY stale-fence`.
- It is called by content writes (`server/src/engine/sync/content-write.ts:236-247`), `rename` (`server/src/vfs/ops/rename.ts:135`), attribute ops (`server/src/vfs/ops/attr.ts:118`), `copy` and `unlink`.
- It is tested at unit level (`server/src/engine/locks/fencing.test.ts:68`), at engine level with doubles (`server/src/engine/sync/engine.test.ts:828`: "VFS-09 a write with a stale fence returns conflict EBUSY stale-fence …"), and against PostgreSQL (`server/src/engine/sync/sync.int.test.ts:338`, which skips without `DATABASE_URL`).
- Heartbeats renew leases, and pongs never do (`specs/06-sync/offline-and-sync.md` §3.14.2). A late heartbeat after expiry is reported as `lost` and never resurrects a lease (`manager.ts:281-300`, `store.renew` "that are still live").

**What exists (client).**

- `Lockd` keeps one server lease per inode per OS session. It keeps the fence after a loss so that the next save takes the stale-fence path (`vfs/src/locks/lockd.ts:10-12`, `:575`). It exposes `fenceFor(pid, ino)` (`lockd.ts:158-163`).
- It measures the server time offset from `hb.ack` (`lockd.ts:377-388`) and re-verifies on `visibilitychange` (`lockd.ts:186-188`).
- The outbox record has an optional `fence` (`vfs/src/store/records.ts:137`). `toSubmit` turns it into `OpSubmit.fences` for the op's target inode (`vfs/src/sync/outbox.ts:21-55`), and `prepareCommit` copies `CommitMeta.fence` into the record (`vfs/src/ops/commit.ts:20-21`, `:46`).

**Gaps found.**

| #   | Gap                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Evidence                                                                                |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| G1  | **The kernel never passes a fence.** `mutateLocked` calls `prepareCommit` with `opId, osSessionId, principal, now, awaitSync` and no `fence`. `lockd.fenceFor` has no caller in `kernel/`, `web/` or `vfs/src` outside `vfs/src/locks/tests/lockd.test.ts:98`. So the server's "op carries a fence" rows (`fencing.ts:72-77`) never fire for a real client.                                                                                                                                                                                                                                | `kernel/src/core/fs/kfs.ts:512-519`; `grep -rn fenceFor` → only `lockd.ts` and its test |
| G2  | **ARB re-baseline (0006-S1, architecture review F5):** the stabilize track's UI-006 fix has since added the product engine factory, `kernel/src/core/net/factory.ts`. Its lock engine is the adapter **`LockdEngine`** (`factory.ts:327-383`), which exposes only `acquire`, `release`, `releaseAll`, `onVisible` and `serverEngaged`: no `fenceFor`. Whether the engines are linked on :4718 depends on UI-006's verification in the stabilize close-out.                                                                                                                                 | `kernel/src/core/net/factory.ts:327-402`; `engines.ts:5-9`                              |
| G3  | **Kernel-local fences are not server fences.** When no engine is engaged, `LocalLocks` hands out a per-inode counter starting at 1 (`kernel/src/core/net/locks.ts:57-59`). ARB re-baseline: `lock.acquire` now returns `fence: g.fence ?? lease.fence` (`kernel/src/core/net/syscalls.ts:147`), and the draft's `?? 1` line no longer exists. Neither value may ever reach `OpSubmit.fences`, where the server would compare it with `lock_fence` and produce spurious stale-fence conflicts. The plumbing in G1 takes fences from the lock engine only, and only for server-scope grants. | code                                                                                    |
| G4  | **The client never treats its own lease as expired.** `Lockd` stores `expiresAt` per lease but checks it only for foreign leases and for display (`lockd.ts:169-183`, `:206-207`). After a stall that fires no `visibilitychange` (a long task or GC pause in the kernel worker, or a debugger pause), a holder learns of the loss only at the next heartbeat, up to `HB_MS` later (5 s in the demo profile). Correctness does not depend on this, but the "Your lock expired" UX arrives late.                                                                                            | `lockd.ts:169-177` (`own` ignores `expiresAt`)                                          |
| G5  | **No deterministic test composes the classic failure** (pause, expiry, re-grant, zombie write) across the manager, its expiry path and the write check without PostgreSQL. The only full-stack version is DB-gated (`sync.int.test.ts:338`), and it simulates the zombie with `fence - 1` rather than with a real expiry.                                                                                                                                                                                                                                                                  | test inventory                                                                          |
| G6  | **No metric** counts stale-fence rejections or expiry lateness. `server/src/obs/metrics.ts:11-31` has no lock series.                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | code                                                                                    |

**The honest risk statement.** Today a zombie write **cannot silently overwrite newer data**, because every `write` also carries a base version, and the server's version CAS rejects a stale base as a conflict with a conflicted copy (`content-write.ts:1-20`). A write under someone else's live lease also gets `EBUSY lease`. What the fence adds is:

1. the designed and spec'd layer (§3.14.4, a MUST under VFS-09) actually engaging;
2. rejection of a writer whose lease is gone, even when its base happens to be current (the Gray and Cheriton lease contract);
3. a distinct, explainable outcome (`stale-fence`, "Your lock expired while this tab was in the background") instead of a generic version conflict.

This RFC is sized to that value: about 1.5 hours.

### 2.2 Part (b): glass legibility

- **Materials.** The menu bar uses `rgb(255 255 255 / 0.52)` with `blur(30px) saturate(180%)`. The Dock uses `0.40` with 40 px blur. The HUD (Control Centre) uses `rgb(245 245 250 / 0.72)`, and popovers use `0.84` (`ui/src/tokens/tokens.css:139-159`). The dark equivalents are at `tokens.css:489-504` and `:611-626`. Consumers: `ui/src/shell/menubar/MenuBar.module.css:15-21`, `ui/src/shell/dock/Dock.module.css:25-36`, `ui/src/shell/control-centre/ControlCentre.module.css:11-18`, `ui/src/primitives/internal/Floating.module.css`, and `ui/src/shell/notifications/Notifications.module.css`.
- **Wallpaper.** It is a CSS gradient token, `--pl-wallpaper` (`tokens.css:161-165`, `:505-510`), drawn by `ui/src/shell/wallpaper/Wallpaper.tsx:22-39` with an accent-tinted aurora. There is **no wallpaper choice** anywhere (`grep -i wallpaper apps/src ui/src/apps` finds nothing). SVG twins of the two gradients already ship same-origin at `web/public/wallpapers/wallpaper-{light,dark}.svg`, and no code references them.
- **Contrast tests.** DSN-03 composites translucent colours over `--pl-surface`, **not over the wallpaper** (`ui/src/tokens/tokens.test.ts:134-145`). The only glass pairs tested are `--pl-text` and `--pl-text-muted` on the static window glass (`tokens.test.ts:170-171`). Nothing checks the menu bar, Dock, HUD or popover glass over what is really behind them.
- **Reduce transparency.** Settings writes `data-transparency="reduce"` through `applyAppearance` (`apps/src/descriptor.ts:172-182`, called from `web/src/desktop/host.ts:334`), and `tokens.css:810-846` swaps every glass token to an opaque surface on `:root` only. The `@supports not (backdrop-filter)` block covers `:root, [data-theme]` (`tokens.css:799-800`), but **the two reduce-transparency blocks do not**. So any subtree with its own `data-theme` redeclares translucent glass under Reduce transparency. Today that affects only decorative previews (`ui/src/apps/settings/panes/AppearancePane.tsx:65`, `ui/src/overlays/update/RestartToUpdateDialog.tsx:142`), but it would break the scheme flip proposed here. We fix it in this RFC.
- **Budget pressure.** `tokens.css` minified is about 5,009 B gzip against the 5,120 B DSN-39 limit (`tokens.test.ts:217-225`; measured with a comment-strip and whitespace-collapse approximation). New rules must go in component CSS modules, not in `tokens.css`.

**Baseline measured on the QA copy** (method in §10.4; full data in `baseline-measurements.json`). The table shows the minimum WCAG ratio over the real built-in wallpaper, and the ratio over the worst possible backdrop (pure black or pure white), for the violet accent. The yellow, graphite and pink accents moved the wallpaper numbers by less than 0.01, so the aurora layer is negligible.

| Surface (text role)                 |     Light, over wallpaper | Light, any backdrop | Dark, over wallpaper | Dark, any backdrop |
| ----------------------------------- | ------------------------: | ------------------: | -------------------: | -----------------: |
| Menu bar `--pl-text`                |                     12.74 |                5.03 |                12.73 |           **3.19** |
| Menu bar `--pl-text-muted`          |                      6.12 |            **3.57** |                 7.17 |           **2.41** |
| Dock running dot `--pl-text` (3:1)  |                     12.45 |                3.36 |                12.08 |           **2.17** |
| Control Centre `--pl-text-tertiary` |                      4.63 |            **3.88** |                 5.36 |           **3.09** |
| Control Centre `--pl-accent-text`   | 5.10 (yellow accent 4.64) |            **3.01** |                 6.37 |           **2.72** |
| Popover `--pl-text-muted`           |                      6.39 |                5.72 |                 7.14 |               4.67 |

Two conclusions follow. First, the fixed alphas are tuned to the built-in wallpapers and fail on bright or dark photos (Control Centre's tertiary text is already at 4.63 on the light built-in). Second, raising every alpha to the "any backdrop" level would make the HUD nearly opaque. The alpha AA needs over black, with a 0.2 margin, is **0.96** for the light HUD and **0.88** for the dark one (computed in `alpha.mjs`, §10.4). That erases the glass identity. The alpha therefore has to depend on the backdrop, as Harrison et al. found for legibility generally (§4).

### 2.3 Part (c): Dock magnification and motion

- **Magnification** is a cosine fall-off over ±2.5 icon widths up to `max` (default 1.5, Settings 1 to 2) (`ui/src/shell/dock/magnify.ts:29-33`). Slot centres are measured once at `pointerenter` (`ui/src/shell/dock/Dock.tsx:152-167`), and one rAF batch writes `translate3d` per slot, `scale()` per icon and `scaleX` on the glass (`Dock.tsx:169-186`). It is transform-only, with no layout reads on `pointermove`. This part is good.
- **Late start.** Expansion starts only on `pointerenter` of the toolbar (`Dock.tsx:188-195`, `:326-330`), so the target is at its initial 52 px width until the pointer is already over the Dock.
- **One-frame jump.** While magnifying, `.magnifying` turns transitions off (`Dock.module.css:51-55`), so the first frame after entry jumps straight to the fall-off scale. At an icon's centre that is 1 → 1.5, a 26 px size change in one frame. Chang and Ungar's rule of thumb is that motion over half the object's size per frame reads as disconnected.
- **Centre-anchored growth.** `shifts.push(before + g / 2 - extra / 2)` (`magnify.ts:47-52`) keeps the row centred on the Dock, so the icon under the pointer slides sideways as the pointer moves. Measured by evaluating `magnify.ts` over the QA Dock (5 apps, separator, Trash; icon 52; gap 8): the point under the pointer drifts up to **15.1 px (mean 3.5)** at 1.5× and **30.2 px (mean 7.0)** at 2×. This is exactly the "moving target" problem McGuffin and Balakrishnan describe for Dock-style expansion (§4).
- **Exit** springs back with `--pl-ease-spring-soft` `cubic-bezier(.32, 1.28, .5, 1)` over `--pl-motion-med` 200 ms (`Dock.module.css:35, 41, 48`; `tokens.css:378`).
- **Motion system.** Window transitions run through WAAPI with token durations (`wm/src/shell/motion.ts:1-40`). The genie target is the icon centre minus the window's bottom centre (`wm/src/shell/genie.ts:22-31`). The motion table is normative (`specs/05-wm/visual-language-macos.md:277-278`, DSN-38). The frame meter samples rAF deltas into `dsa` `Float64Ring` (`wm/src/shell/frame-sampler.ts:56-121`). The CDP trace harness exists at `tests/performance/frame/` (parse, capture, runs, and `drag.spec.ts`).
- **Reduced motion** disables magnification entirely (`Dock.tsx:137-140`), and every duration token drops to 0 (`tokens.css:780-794`).

**Baseline Dock sweep** (smoke only: headless Chrome with rAF deltas, not the lab harness). On the first, cold sweep, 23 of 335 frames exceeded 20 ms (p95 33.3 ms, max 50 ms). The two warm sweeps had p95 16.7 ms with 0 frames over 20 ms and 0 CSP violations. Screenshot: `docs/design/wave3/design-platform/baseline-dock-magnified.png`.

## 3. Goals and non-goals

**Goals**

1. (a) Every commit by a process that holds a server X lease carries that lease's fence, taken from the lock engine and never from local advisory locks.
2. (a) The classic paused-holder failure is covered by deterministic unit and property tests (SYN-21, `platform`'s stretch goal). The integration and E2E versions are deferred. A zombie write under an expired lease is never applied.
3. (a) A holder whose lease is past its local deadline minus ε re-verifies at once, instead of waiting for the next heartbeat. (**Deferred** by the ARB with SYN-20.)
4. (b, **deferred**) Text on the menu bar, Control Centre and popovers keeps at least 4.5:1, and the Dock's non-text indicators keep at least 3:1, over every bundled wallpaper in both themes. The values are computed once per wallpaper, theme, accent, transparency or viewport change.
5. (b, **deferred**) Adaptation only raises opacity or flips the scheme. It never makes glass more transparent than the token. Reduce transparency, forced colours and missing `backdrop-filter` support always win, including in `[data-theme]` subtrees.
6. (c, **deferred**) Expansion starts before the pointer reaches the Dock. The icon under the pointer does not drift. Entry is ramped, exit follows through, and the frame budget and reduced motion are respected.
7. Every part sits behind a flag, has a baseline-versus-new metric for the capstone report, and has a viva demo.

**Non-goals**

- Linking the sync and lock engines (UI-006). That is STABILIZE work, and this RFC depends on it for the E2E only.
- Live-pixel sampling of whatever is behind glass (windows, video). Content inside windows is not analysed (see §7 and §14).
- User photo wallpapers from disk or Google Drive. Showing them needs `img-src blob:` in the CSP, which is a security decision for the Drive RFC. The sampler API accepts any `ImageBitmap` source so that it can plug in later.
- A new lock protocol, a new syscall, or a DB migration.
- True mesh-warp genie, Dock drag-reordering, and changing the minimise effect.

## 4. Research basis

| Paper                                                                                                                                                  | Idea                                                                                                                                                                                                                                                                     | What we adopt                                                                                                                                                                                                                                                          | What we adapt                                                                                                                                                                                                                                                                                         | What we leave out                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gray and Cheriton, _Leases_, SOSP 1989. [pdf](https://pages.cs.wisc.edu/~remzi/Classes/739/Fall2015/Papers/leases89.pdf)                               | A lease is a time-bounded grant. The holder must stop relying on it at its term minus a clock-uncertainty allowance ε. A crashed holder costs at most one term; short terms trade renewal traffic for availability.                                                      | Client-side validity check `serverNow() >= expiresAt − ε` (G4). The existing TTL and heartbeat trade-off is kept as specified (TTL/3 heartbeats).                                                                                                                      | ε is computed from the measured `hb.ack` round trip (`ε = max(250 ms, rtt/2 + 1% of TTL)`) rather than a static drift bound. On crossing it the client re-verifies (heartbeat now) but still writes, because Plotinium is offline-first: the outbox must accept the write and the server decides.     | Server-side waiting of term + ε before re-granting: fencing makes it unnecessary, and it would lengthen crash failover (VFS-09 promises TTL + 0.5 s).                                             |
| Kleppmann, fencing tokens (cited in the code at `fencing.ts:17`; not in the lead's list)                                                               | Pauses are unbounded (GC, frozen tabs), so timing alone cannot guarantee exclusion. The storage must reject a token lower than one it has seen.                                                                                                                          | Already implemented server-side. We make the client supply the token (G1).                                                                                                                                                                                             | —                                                                                                                                                                                                                                                                                                     | —                                                                                                                                                                                                 |
| Kistler and Satyanarayanan, _Disconnected Operation in Coda_, TOCS 1992. [pdf](https://courses.cs.washington.edu/courses/cse550/10au/papers/coda.pdf)  | Hoarding, emulation, and reintegration of a logged modification list, where conflicts are detected at reintegration and preserved for the user.                                                                                                                          | The fence is recorded **at commit time** in the outbox record, like Coda's per-operation version stamps, so an offline write made under a lease is judged at reintegration under the lease it assumed.                                                                 | Our conflict handling is already "keep both" (conflicted copy); the fence only changes the reason reported.                                                                                                                                                                                           | Coda's server callbacks and hoard walks; out of scope.                                                                                                                                            |
| Kleppmann et al., _Local-First Software_, Onward! 2019. [link](https://www.inkandswitch.com/local-first/)                                              | The local copy is primary; the network is optional; the user never loses work.                                                                                                                                                                                           | A lease loss never blocks typing or saving locally. The bytes are always kept (conflicted copy).                                                                                                                                                                       | —                                                                                                                                                                                                                                                                                                     | CRDT merging of text; the Editor keeps whole-file versions.                                                                                                                                       |
| Harrison, Ishii, Vicente and Buxton, _Transparent Layered User Interfaces_, CHI 1995. [link](https://www.billbuxton.com/transparency.html)             | In a Stroop-style study of transparency levels (0, 5, 10, 20, 50 and 100 %), interference with reading the foreground depends on the transparency level **and** the background content. They proposed "anti-interference" outlines to separate text from the background. | Opacity is a function of what is behind the surface, not a constant. The glass alpha becomes a per-surface floor computed from the backdrop.                                                                                                                           | We use WCAG 2.x luminance contrast as the operational proxy, because it is testable in CI. Their worst case was text over text, a high-frequency background; our backdrops are low-passed by a 24–40 px blur, which leaves luminance as the dominant factor. That is why luminance alone is analysed. | Anti-interference outlines and halos: they fight the visual language (DSN-21), and the blur already suppresses background detail. They are noted as an option if the solver hits the α cap (§14). |
| McGuffin and Balakrishnan, _Acquisition of Expanding Targets_, CHI 2002. [pdf](https://www.dgp.toronto.edu/~ravin/papers/chi2002_expandingtargets.pdf) | Acquisition time is governed by the target's **final** size, even when expansion starts after 90 % of the movement (P = 0.9, 100 ms expansion). For Dock-like arrays, expanding neighbours pushes the target sideways and makes it harder to acquire.                    | (1) Expand in an **approach band** so that the target is at its final size by the time the pointer crosses the Dock edge. (2) **Anchor growth at the pointer**, so the target does not move under it.                                                                  | The band depth is derived from P = 0.9 of a typical approach amplitude (§5.3). Our hit-testing follows CSS transforms, so the motor-space width grows horizontally too, unlike their first prototype. The ramp is a smoothstep on distance, not a fixed 100 ms timer.                                 | Their second prototype's "max occlusion" overlap, considered in §6 and rejected for identity reasons.                                                                                             |
| Chang and Ungar, _Animation: From Cartoons to the User Interface_, UIST 1993. [pdf](https://bibliography.selflanguage.org/_static/animation.pdf)       | Solidity (objects keep up with the cursor; arrivals and departures are continuous), exaggeration (anticipation precedes system-initiated moves), and reinforcement (slow-in/slow-out, follow-through). Motion over half an object's size per frame looks disconnected.   | Slow-in on entry (the approach ramp replaces the one-frame jump). Follow-through on exit (a tuned under-damped spring). A **catch** on the target icon when a minimised window lands, like their arrow target that "reacts to the contact with a small wiggling jolt". | Pointer tracking stays **unsmoothed**: magnification is direct manipulation and must keep up with the cursor (their solidity rule).                                                                                                                                                                   | Anticipation before restore: it would add latency to a direct command, and they apply anticipation to moves the user does not directly drive. Motion blur: not transform/opacity-only.            |

## 5. Design

### 5.1 Part (a): fences end to end

**Data flow after the change.**

```
process write ──► kfs.mutateLocked(actor.pid)
                   │ plan.wire.op ──► fencedIno(op) (vfs, exported)
                   │ deps.fenceOf(ino, pid) ──► LockEngine.fenceFor(pid, ino) ──► Lockd.fenceFor (server fences only)
                   ▼
            prepareCommit({..., fence}) ──► OutboxRec.fence ──► toSubmit ──► OpSubmit.fences[{ino, fence}]
                                                                                   │
server vfsTxn ──► checkWriteLeases (unchanged) ──► applied | conflict EBUSY stale-fence (bytes kept) | conflict EBUSY lease
```

**Interfaces (exact changes; ARB-revised, landed by `platform` in step 0).**

1. `kernel/src/core/net/engines.ts`, `LockEngine`: add

   ```ts
   /** The server fence `pid` writes `ino` under (server-scope X holders only; kept after a loss). */
   fenceFor?(pid: number, ino: string): number | undefined;
   /** 'held' | 'suspect' (past expiresAt − ε, re-verifying; SYN-20, deferred) | 'lost' | 'none', for lsof and the Editor. */
   leaseState?(ino: string): 'held' | 'suspect' | 'lost' | 'none';
   ```

   The methods are optional, so an older or absent engine keeps today's behaviour.

2. **`kernel/src/core/net/factory.ts`, `LockdEngine`** (ARB, 0006-M1): add the delegations `fenceFor(pid, ino) { return this.lockd.fenceFor(pid, ino); }` and `leaseState(ino) { return this.lockd.leaseState?.(ino) ?? 'none'; }`.
   - The draft said "`Lockd` satisfies both structurally". But the product engine is this adapter, so without the delegations no fence would ever reach the wire, while a fake-engine test still passed.
   - `leaseState` answers `'held'`, `'lost'` or `'none'` until SYN-20 adds `'suspect'`.
3. `kernel/src/core/fs/kfs.ts`, **`KernelFsDeps`** (ARB, 0006-N1: the draft called it `KfsDeps`): add `readonly fenceOf?: (ino: Uuid, pid: number) => number | undefined`. In `mutateLocked` (`prepareCommit`, about `kfs.ts:515`), compute `const target = plan.wire === null ? undefined : fencedIno(plan.wire.op)`. Pass `fence` when `target !== undefined && actor.pid !== undefined` and `fenceOf` returns a number.
4. `fencedIno` is imported from `@plotinium/vfs/sync`, which already re-exports it (`vfs/src/sync/index.ts:12`, `outbox.ts:21`) and which the kernel already imports (`net/factory.ts:17-24`). **No `vfs/src/index.ts` edit** (ARB, 0006-N2).
5. `kernel/src/core/io/index.ts`, next to `busy` (about `:561`): `fenceOf: (ino, pid) => k.sysctl.get('sync.fenceWrites') === 'off' ? undefined : syncIo.lockEngine?.fenceFor?.(pid, ino)`.
   - It never consults `localLocks` (G3).
   - **`sync.fenceWrites` is a root-only sysctl** (`'on' | 'off'`, default `'on'`), defined next to it and read at each commit, so the kill switch needs no rebuild (ARB, 0006-S4).
6. ~~`kernel/src/core/net/syscalls.ts:116`: replace `g.fence ?? 1` with `g.fence ?? 0`.~~ **Dropped** (ARB, 0006-S1): the line no longer exists. The answer to Q2 is no ABI change. `lock.acquire` keeps returning a number, so a local-scope number may reach user space, but it never reaches the wire, because `fenceOf` reads only the lock engine and `Lockd.fenceFor` answers only for server-scope leases.
7. `vfs/src/locks/lockd.ts` (SYN-20, **deferred**):
   - record `lastRttMs` in `onHbAck` (`:377`);
   - add `leaseState(ino)`;
   - in `fenceFor`, when the holder's server lease is past `expiresAt − ε`, call `this.channel.heartbeatNow()` at most once per `ε` (debounced) and still return the fence;
   - `lsof` rows gain `suspect: boolean`.

   Here ε = `max(250, lastRttMs / 2 + 0.01 × ttlMs)` ms, which is 400 ms at a 15 s TTL with a 20 ms RTT.

**Failure modes.**

- The engine is not linked (today): `fenceOf` returns undefined, so behaviour is unchanged.
- The engine is linked but degraded: local grants have `fence: null` (`lockd.ts:478`), so there is no fence. Reconnect replays under version CAS, exactly as specified (§3.14.7 "Degraded mode").
- A fence on a batch or agent op: `fencedIno('batch')` is undefined (`outbox.ts:33-36`), so agent batches are governed by their `expectedVersions` and by foreign-lease `subtree-busy`. This is unchanged and noted for the AI RFCs.
- The heartbeat storm guard: `heartbeatNow` is debounced to one per ε per lockd.

**The classic-failure tests.** These are the core deliverable. Test titles start with the requirement ID.

| Test                                                                                                                                 | Level                                                                  | Scenario                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SYN-21 a paused X holder whose lease expired and was re-granted cannot write: stale-fence`                                          | unit (server), `server/src/engine/locks/zombie.test.ts` (new)          | `LockManager` + `MemoryLockStore` + `ManualClock`. A acquires X (fence f). The clock advances TTL + 1 ms with no heartbeat and the sweeper runs, so A gets `lock.expired`. B acquires X (f + 1) and `checkWriteLeases` for B's write with f + 1 is ok. A "wakes" and writes with f: `stale-fence` (fence < `lock_fence`). Also, A's late `hb` renews nothing (`lost` contains A's lease).                     |
| `SYN-21 a paused X holder whose lease expired with no new holder cannot write under the dead lease`                                  | unit (server), same file                                               | Same as above, but nobody re-acquires. A writes with f: `stale-fence` (own lease gone), even though `lock_fence == f`. This is the Gray and Cheriton contract, not just Kleppmann's ordering.                                                                                                                                                                                                                 |
| `SYN-21 property: no applied write carries a fence whose lease was not live at apply time`                                           | property (fast-check, seed 42), `zombie.prop.test.ts`                  | 2–4 sessions, random interleavings of acquire, heartbeat, pause (clock jumps up to 3×TTL), sweep and write-with-fence. Invariants: (i) every allowed fenced write had a live own lease and `fence == max fence granted on the inode`; (ii) fences are strictly increasing per inode; (iii) at most one session is allowed to write per fence epoch. 1,000 runs on PRs.                                        |
| `SYN-19 a write by a process holding server X carries its fence into the outbox record`                                              | unit (kernel), `kernel/src/core/fs/tests/kfs-fence.test.ts` (new)      | Fake `LockEngine.fenceFor` returns 41 for (pid 7, ino A). A write to A by pid 7 gives `OutboxRec.fence === 41`. A write by pid 8, a create in A's directory, a lock held only via `LocalLocks`, or `sync.fenceWrites = off` gives no fence.                                                                                                                                                                   |
| `SYN-19 a write through createEngineFactory with a server X lease carries the lockd fence` (ARB, 0006-M1)                            | unit (kernel), `kernel/src/core/net/tests/factory-fence.test.ts` (new) | The real `LockdEngine` adapter over a `Lockd` with a fake channel: a server-scope X grant with fence 7, then a write by the holder, gives `OutboxRec.fence === 7`.                                                                                                                                                                                                                                            |
| `SYN-19 a server-scope grant without a fence leaves the op with no fences entry, so fence 0 never reaches the wire` (ARB, S-0006-01) | same file                                                              | `lock.acquire` at server scope whose grant has `fence: null`: the committed op's `OpSubmit.fences` has no entry for the inode.                                                                                                                                                                                                                                                                                |
| `SYN-19 toSubmit sends fences for write, utimes, chmod, chown, unlink, rename and link only`                                         | unit (vfs), extend `vfs/src/sync/tests/units.test.ts`                  | Table over the op kinds (`outbox.ts:21-37`).                                                                                                                                                                                                                                                                                                                                                                  |
| `SYN-20 a lease past expiresAt − ε is suspect and triggers one immediate heartbeat` (**deferred**)                                   | unit (vfs), extend `vfs/src/locks/tests/lockd.test.ts`                 | `ManualClock`. Grant with TTL 15 s. Advance 14.7 s: `leaseState` is `suspect`, `fenceFor` returns the fence, and `heartbeatNow` is called exactly once for two calls within ε. Deliver `hb.ack` with `lost`: state `lost`, `lock.lost` emitted, fence still returned (stale path).                                                                                                                            |
| `VFS-09 a real expiry followed by a re-grant makes the zombie's content write a conflicted copy` (**deferred**)                      | integration (PostgreSQL), extend `sync.int.test.ts:338`                | Instead of `fence - 1`: A acquires, then `UPDATE locks SET lease_expires_at = clock_timestamp() - interval '1 s'` and `locks.sweepNow()`. B acquires and writes. A writes with its old fence: `conflict EBUSY stale-fence`, B's bytes unchanged, and the conflicted-copy inode exists. Runs where `DATABASE_URL` is set (CI db job).                                                                          |
| `VFS-09 a frozen holder's save after its lease expired becomes a conflicted copy` (**deferred**)                                     | E2E, extend `tests/e2e/lock-contention.spec.ts`                        | Needs UI-006. alice opens `plan.md` (X). CDP `Page.setWebLifecycleState {state: 'frozen'}` on alice (this freezes the page and its workers, the real analogue of a GC pause) for TTL + 2 s. bob opens the file writable, saves "B". alice is unfrozen, types and saves. Asserted: the banner "Your lock expired…", `plan.md` = "B", a conflicted copy with alice's text, and `lsof` shows fences f and f + 1. |

### 5.2 Part (b): adaptive glass legibility (deferred by the ARB)

Part (b) is not built in Workflow B. When it is scheduled:

- the wallpaper sampler should draw and blur in an `OffscreenCanvas` in a worker, so the main thread only receives the samples (ARB, 0006-N4);
- the pref keys and the Settings Appearance pane need a handoff to whoever owns `apps/src/descriptor.ts` and `ui/src/apps/settings/**` at that time (`gdrive-ui` in Wave 3);
- any `img-src blob:` change for photo wallpapers needs its own security review. No Wave-3 RFC owns it, and no Wave-3 builder may change `web/build/csp.ts` (ARB, S-0006-02).

**Architecture.**

```
root attributes (data-theme, data-accent, data-transparency, data-wallpaper) + prefers-* media + viewport size
        │ MutationObserver + matchMedia + ResizeObserver (debounced 150 ms)       [wm/src/shell/Desktop.tsx]
        ▼
wallpaper-luma.ts  (DOM, once per change, requestIdleCallback)
   load /wallpapers/<id>-<theme>.svg (same-origin, img-src 'self') ─► draw into a 180 × 112 canvas with the
   same object-fit: cover crop as the CSS ─► 3-pass box blur per surface radius ─► saturate() matrix
   ─► per-surface region samples (menu bar band, Dock rect, Control Centre rect, whole screen for popovers)
        ▼
legibility.ts  (pure, framework-free, unit- and property-tested)
   solve(samples, textRoles per surface, glass tokens, target) ─► { scheme, alphaFloor, minRatio } per surface
        ▼
CSSOM only (CSP-safe): root.style.setProperty('--pl-glass-<surface>-a-min', '0.64') and
   <MenuBar scheme="dark"> / <Dock scheme="dark"> props ─► data-theme on the component root
```

**The solver** (`wm/src/shell/legibility.ts`, pure):

- Inputs: backdrop samples (sRGB triples after blur and saturate) for one surface; the surface's glass colour and token alpha α₀ in scheme s; the text roles on that surface with their targets (menu bar: `--pl-text`, `--pl-text-muted` at 4.5; Dock: `--pl-text` running dot at 3.0; HUD: `--pl-text`, `-muted`, `-tertiary`, `--pl-accent-text` at 4.5; popover: `--pl-text`, `-muted` at 4.5); a margin m = 0.2; and a target T = 4.5, or 7.0 under `prefers-contrast: more`.
- Scheme (menu bar and Dock only, the two surfaces that sit directly on the wallpaper): pick the theme scheme unless the other scheme reaches a higher minimum ratio at α₀, as macOS does for the menu bar. Popovers and the HUD keep the theme scheme, because they sit over windows whose colours follow the theme.
- Alpha: the smallest α in [α₀, 0.97] (0.01 steps; ≤ 97 evaluations × ≤ 400 samples) such that every sample and every role reaches T + m. When 0.97 is not enough, return `{ alphaFloor: 1, capped: true }`. That is the opaque surface, which already passes DSN-03.
- For popovers and the HUD, the sample set also includes the theme's window surfaces (`--pl-glass-window-bg` over `--pl-surface`), because windows are what usually lies behind them. Under `prefers-contrast: more` it includes pure black and white (the any-backdrop floor), which gives users who need it the guaranteed worst case.
- Output: never lower than α₀ (goal 5). It is deterministic, and it returns the achieved `minRatio` for observability.

**CSS (component modules; `tokens.css` stays within DSN-39).** In each consumer, the plain token declaration stays first as the fallback, and a relative-colour declaration applies the floor where supported (Chrome 119+, Firefox 128+, Safari 18+):

```css
.bar {
  background: var(--pl-glass-menubar-bg); /* fallback: unchanged behaviour */
  background: rgb(
    from var(--pl-glass-menubar-bg) r g b / max(alpha, var(--pl-glass-menubar-a-min, 0))
  );
}
```

Because the floor is combined with `max()`, the opaque fallbacks (reduce transparency, no `backdrop-filter`, where `alpha` is 1) stay opaque, and the default 0 changes nothing. The new custom properties are added to `COMPONENT_INPUTS` in `tokens.test.ts:19`.

**DSN-41 subtree fix.** Extend the two reduce-transparency blocks (`tokens.css:811-846`) to `:root, [data-theme]` and `:root[data-transparency='reduce'], :root[data-transparency='reduce'] [data-theme]`, matching the `@supports` block at `:799-800`. The cost is about 30 B gzip. If the DSN-39 test fails, the guard moves to a shell-layer stylesheet, `ui/src/shell/glass-guards.css`, that is not inlined on boot. The solver also returns no scheme flip whenever transparency is reduced or `forced-colors: active`.

**Wallpaper choice** (needed for the demo; cut-able to one extra option, §14):

- A new pref `appearance.wallpaper: 'aurora' | 'daylight' | 'eclipse'` (default `aurora`) in `apps/src/descriptor.ts`, applied as `data-wallpaper` by `applyAppearance`.
- A "Wallpaper" pop-up button in `ui/src/apps/settings/panes/AppearancePane.tsx`.
- `Wallpaper.module.css` rules `:global(:root[data-wallpaper='daylight']) .wallpaper { background: url('/wallpapers/daylight-light.svg') center / cover; }` and so on for each theme.
- Two new original SVGs in `web/public/wallpapers/`: "Daylight", a near-white warm field that stresses dark glass; "Eclipse", a near-black field with a bright rim that stresses light glass and the scheme flip. They use gradients only (DSN-22, no Apple imagery), each ≤ 4 KB. `aurora` maps to the existing `wallpaper-{light,dark}.svg` twins.

**Failure modes.**

- The image fails to load, or the canvas is unavailable: keep the token alphas and log `legibility: wallpaper <id> not sampled`.
- The viewport resizes while sampling: the last change wins (generation counter).
- Theme toggling fast: debounced 150 ms, with the solve cached per `(wallpaper, theme, accent, W×H bucket of 64 px)` in a small `dsa` LRU (capacity 16).
- The solver hits the cap: the surface is opaque, which is still legible; counted in observability.
- A window under the Dock: the Dock carries only non-text indicators, and its token dark-scheme value 2.17 over white is below 3:1. So when the compositor reports any window rect intersecting the Dock rect, the Dock's sample set gains the theme window surface. This is geometry, not pixels (`wm/src/compositor/geometry.ts:39-47` reserves only 44 px at the bottom, so windows can sit under the 68 px Dock).

### 5.3 Part (c): Dock expansion and motion (deferred by the ARB)

Part (c) is not built in Workflow B. When it is scheduled, the DSN-44 frame budget must be measured under the spec's conditions: 10 windows open, both idle and under 3 × `burn` (WM-03, PROC-05; `specs/05-wm/window-manager.md:49`, `:54`). Both results go into `budgets.json` (ARB, 0006-S3).

**Approach band (McGuffin and Balakrishnan).**

- Expansion begins when the pointer is within D px above the glass top edge, with D = max(48, `iconSize`) px (52 by default).
- Derivation: a typical Dock approach at 1440×900 starts around the screen centre, about 400–450 px away. P = 0.9 leaves 40–45 px, so D ≥ 48 px keeps us at or before P = 0.9.
- The ramp is ρ(y) = smoothstep(1 − d/D), with d the distance to the glass top: 0 at the band's top, 1 at the edge. Scale = 1 + (falloff(x) − 1) · ρ.
- **Intent gate:** the band is active only while the pointer's vertical velocity is downward, over 0.15 px/ms (EWMA of `pointermove` deltas). This stops a pointer moving sideways over a window's status bar just above the Dock from magnifying it.
- Implementation: one passive `pointermove` listener on `document`, attached only while magnification is enabled and motion is not reduced. The glass top is cached from a `ResizeObserver` on the toolbar, and slot centres are re-measured on that observer and on `pointerenter`. There are no layout reads per move, preserving `Dock.tsx`'s R-READ rule.

**Anchored magnification.** New `magnifyAnchored(pointerX, slots, iconSize, max, range)` in `magnify.ts`: the growth to the left of the pointer is the full growth of slots entirely left of it, plus the proportional part of the slot under it. Shifts are `before + g/2 − leftGrowth`, so the point under the pointer stays fixed (analytic drift 0; §2.3 measured 15.1 px today). The glass follows with `translateX(Δ) scaleX(k)` about its left edge. A clamp keeps the Dock within 8 px of the viewport edges (the shift is then distributed), for wide Docks at 2×. The cost is that the Dock's ends move slightly more per pointer pixel (0.52 against 0.39 at 1.5×): accepted, because the ends are not the target.

**Motion (Chang and Ungar).**

- **Slow-in:** the ramp replaces the one-frame jump. At a 1 px/ms approach the scale reaches its maximum over 3 frames, at most 9 px per frame instead of 26 px in one frame.
- **Tracking:** unchanged. There is no smoothing while the pointer drives, which keeps solidity (keep up with the cursor).
- **Follow-through on exit:** a new token `--pl-ease-spring-dock`, a `linear()` sampled from a damped spring with stiffness 300, damping 26 and mass 1 (ζ ≈ 0.75, overshoot ≈ 2.8 %, 2 % settle ≈ 310 ms), over `--pl-motion-slow` 320 ms. It replaces `spring-soft` (`cubic-bezier(.32,1.28,.5,1)`, about 200 ms) for the Dock's `.glass`, `.slot` and `.scaler` transitions. The curve lives in `Dock.module.css` as a local custom property, not in `tokens.css` (DSN-39), and is generated by a 20-line script checked in as a test fixture.
- **Catch on arrival:** when `pl-anim-window-minimise` finishes, the target icon plays `pl-anim-dock-catch` (T scale 1 → 1.08 → 1, 240 ms, spring-soft, origin bottom centre). The wm animator already knows the target icon (`motion.ts` `dockIcon(app)`) and calls `DockApi.catch(appId)`, a new method next to `getIconRect` (`Dock.tsx:25-33`).
- **Reduced motion:** there is no approach listener and no magnification (unchanged), the catch is replaced by nothing (the minimised marker still appears), and every new duration is a token or `calc(ms * var(--pl-k))`.

**Frame budget.** The per-frame work is unchanged in kind (one rAF batch). `scales` and `shifts` reuse preallocated `Float64Array`s sized to the slot count, so no per-frame allocation happens. `will-change: transform` is set when the pointer enters the band, not at `pointerenter`, which gives the compositor about 3 frames of head start. The hypothesis is that this also removes the cold-sweep jank seen in the baseline; the trace decides.

## 6. Alternatives considered

**(a)**

1. **Server waits TTL + ε before re-granting (pure Gray and Cheriton).** Rejected. It lengthens every crash failover beyond the VFS-09 bound of TTL + 0.5 s, and it is still unsafe under unbounded pauses (a frozen tab can pause for minutes; §3.14.7). Fencing is independent of clocks.
2. **Drop fences and rely on the version CAS.** Rejected. The spec requires them (§3.14.4, VFS-09 MUST), the CAS cannot enforce "your lease is gone" when the base is current, and the user would lose the precise explanation.
3. **The client refuses to commit once its local deadline has passed.** Rejected. It breaks offline-first (OFF-01: every mutation goes through the outbox), and it would lose keystrokes during a transient stall. The server is the authority.

**(b)**

1. **Live-pixel sampling** (screen capture, `html2canvas`, WebGL readback of the page). Rejected: it needs `getDisplayMedia` permission or a DOM re-render, costs per frame, conflicts with CSP (runtime `<style>`), and raises privacy concerns about reading window content.
2. **One static worst-case alpha** (raise the tokens to the any-backdrop floors). Rejected as the default: the light HUD would need α 0.96, which destroys the glass identity (DSN-21). It is kept as the `prefers-contrast: more` behaviour.
3. **CSS-only tricks** (`mix-blend-mode: difference` text, `backdrop-filter: brightness() contrast()`). Rejected: the contrast is unpredictable, cannot be asserted in tests, and the colour inversion breaks the accent.
4. **Text halos** (Harrison's anti-interference outlines). Rejected for identity reasons; they remain a fallback if the α cap is hit often.

**(c)**

1. **McGuffin's limited-occlusion prototype** (max occlusion 20–50 %, neighbours overlap instead of moving). It reduces sideways motion but hides badges and running dots and looks unlike the reference. Rejected.
2. **Lagged, spring-follow tracking of the pointer.** Rejected: it violates solidity (the icon must keep up with the cursor) and adds acquisition delay.
3. **JavaScript spring physics per frame for the exit (WAAPI or rAF).** Rejected in favour of a CSS `linear()` spring, which runs on the compositor thread and costs no main-thread time.

## 7. Security, privacy and abuse

- **Fence spoofing:** a fence only helps its owner. The server matches `(osSessionId, fence)` against a live row (`fencing.ts:75-76`), so a forged or foreign fence gives `stale-fence`, never access. A client that omits fences is still bound by foreign-lease `EBUSY` and the version CAS. No new trust is placed in the client.
- **No new data leaves the device.** Fences are already part of `OpSubmit`. Wallpaper analysis runs locally on same-origin assets. Only 12 numbers (four alpha floors, two schemes and a few ratios) are kept, in memory and in data attributes.
- **CSP:** no static `style={{…}}` and no runtime `<style>`. Custom properties are written through the CSSOM (`style.setProperty`), which the policy allows (CLAUDE.md decision 1). Wallpapers load from `'self'`. There is no change to `web/build/csp.ts`. User images (Drive) would need `img-src blob:`, which is explicitly left to the Drive RFC.
- **Abuse or distraction:** the approach band's intent gate prevents flicker when working near the bottom of a window. There are no loops and no flashing (WCAG 2.3.1).
- **Licences:** everything is our own code. The spring curve is generated by our script. The wallpapers are original SVGs (DSN-22). There are no new dependencies and no `dependency_requests`.

## 8. Performance and budgets

| Item                                | Budget                                                                                                                                                                          | How it is checked                                                                               |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| (a) `fenceOf` per commit            | O(holders of the inode), ≤ 5 µs; 0 extra round trips                                                                                                                            | unit microbench in `kfs-fence.test.ts` (smoke)                                                  |
| (a) outbox record size              | +1 number (≤ 16 B JSON)                                                                                                                                                         | existing `jsonBytes` tests                                                                      |
| (a) extra heartbeats                | ≤ 1 per ε (≥ 250 ms) per lockd, only while suspect                                                                                                                              | `SYN-20` test                                                                                   |
| (b) wallpaper sample and solve      | ≤ 8 ms main thread per change, in `requestIdleCallback` after `desktop-interactive`; 0 per frame                                                                                | performance mark `legibility:solve` read by an E2E                                              |
| (b) memory                          | ≤ 90 KB transient (180×112×4 canvas, released); ≤ 2 KB resident (LRU of 16 solutions)                                                                                           | code review; heap snapshot in E2E (smoke)                                                       |
| (b) style recalculation per change  | 4 custom properties on `:root`: one recalculation, ≤ 3 ms at 1440×900                                                                                                           | DevTools trace note in the run notes                                                            |
| (b) bundle                          | wm +≤ 3 KB gzip; 2 SVGs ≤ 4 KB each (lazy, not on the boot path); `tokens.css` ≤ 5,120 B gzip                                                                                   | DSN-39 test; `tools/bundle-budget.ts`                                                           |
| (c) per-frame Dock write            | ≤ 0.3 ms for ≤ 20 slots; 0 allocations per frame; 0 layout reads in `pointermove`                                                                                               | unit microbench; code review (R-READ)                                                           |
| (c) frame time during a Dock sweep  | p95 ≤ 16.7 ms at 60 Hz; 0 frames > 33 ms on warm sweeps; ≤ 2 frames > 20 ms on the cold sweep (baseline 23); **with 10 windows open, idle and under 3 × `burn`** (ARB, 0006-S3) | new `tests/performance/frame/dock.spec.ts` on the CDP harness, lab-spec, 3 runs, median of p95s |
| (c) document `pointermove` listener | early-out when y < band top: ≤ 2 µs per event                                                                                                                                   | microbench                                                                                      |

## 9. Accessibility and UX

- **WCAG 1.4.3 and 1.4.11:** this is the point of part (b). Targets are 4.5:1 for text and 3:1 for indicators, and 7:1 under `prefers-contrast: more`.
- **1.4.11 in forced colours:** the solver is off, and the existing forced-colours rules apply (`tokens.css` and `Dock.module.css:197-210`).
- **Reduce transparency:** all glass is opaque, now including `[data-theme]` subtrees (DSN-41). The adaptive floor is inert (`max(1, x) = 1`).
- **Reduce motion (2.3.3):** no magnification, no approach listener, no catch or spring. Meaning is kept: the minimised marker appears and the tooltip still shows.
- **Keyboard:** unchanged. Magnification is pointer-only; the Dock's APG toolbar, roving tab stop and Escape behaviour (`Dock.tsx:231-264`) are untouched. The Wallpaper pop-up button in Settings follows the existing Select primitive's APG pattern.
- **Target size (2.5.8):** the rest size is 52 px ≥ 24 px, and expansion only enlarges.
- **Both themes:** the solver runs per theme, and the scheme flip mirrors macOS (a light theme on a dark wallpaper gets a dark menu bar).
- **Screen readers:** no change. The wallpaper is `aria-hidden`, and the scheme and alpha are presentational.
- **Lock UX:** the "suspect" state is shown in `lsof` and, optionally, as "Reconnecting lock…" in the Editor banner (Editor change deferred, §14). Lease loss keeps the existing "Your lock expired…" copy (§3.14.7).

## 10. Testing and evaluation

### 10.1 Unit and property

- **(a)** The tests in §5.1: `zombie.test.ts`, `zombie.prop.test.ts`, `kfs-fence.test.ts`, and the `units.test.ts` and `lockd.test.ts` extensions.
- **(b)** `wm/src/shell/legibility.test.ts`:
  - `DSN-40 solve keeps the token alpha when the built-in wallpaper already passes`: fixtures are the measured samples from `baseline-measurements.json`.
  - `DSN-40 solve raises the dark menu-bar alpha over a white backdrop until muted text reaches 4.7:1`.
  - `DSN-40 solve flips the menu bar to the dark scheme over a near-black wallpaper in the light theme`.
  - `DSN-40 property: for random backdrops the result meets the target or is opaque, and is never below the token alpha`.
  - `DSN-41 no scheme flip under reduced transparency or forced colours`.
- **(b)** `ui/src/tokens/tokens.test.ts`: `DSN-41 every [data-theme] subtree gets opaque glass under both reduce-transparency selectors` (block parser, like `:248`), and `DSN-39` still passes.
- **(b)** `wm/src/shell/wallpaper-luma.test.ts` with a fake canvas: crop mapping for `cover` at 16:10, 16:9 and 4:3; blur radius per surface; generation counter.
- **(c)** `ui/src/shell/dock/magnify.test.ts` (new):
  - `DSN-42 anchored magnification keeps the point under the pointer fixed (drift < 0.01 px) over a full sweep at 1.5x and 2x`;
  - `DSN-42 the approach ramp is 0 at the band top, 1 at the glass edge and monotonic`;
  - `DSN-42 the intent gate ignores horizontal movement in the band`;
  - `DSN-43 entry changes icon size by at most 10 px per frame at a 1 px/ms approach`;
  - `DSN-43 the Dock spring overshoots between 2 and 4 % and settles within 2 % by 320 ms` (by parsing the `linear()` points).
- **(c)** `ui/src/shell/dock/Dock.test.tsx`: `DSN-43 the catch class is added on DockApi.catch and removed on animationend`, and `DSN-30 no pointermove listener is attached under reduced motion`.

### 10.2 Integration and E2E (QA :4718, both themes, 1440×900, 1280×800 and 1920×1080)

- **(a)** The `sync.int.test.ts` extension (DB CI job), and the `lock-contention.spec.ts` frozen-holder test (after UI-006).
- **(b)** New `tests/a11y/glass-contrast.spec.ts`. For each wallpaper and theme: hide the chrome through the CSSOM, screenshot, and compute the per-pixel ratio as in §10.4. Assert the menu bar, Control Centre (opened) and a popover all reach at least 4.5:1. Also assert `data-glass-scheme` and `--pl-glass-*-a-min` values, and 0 CSP violations.
- **(b)** Reduce transparency (both the Settings override and emulated `prefers-reduced-transparency`): every glass surface's computed background alpha is 1.
- **(c)** New `tests/performance/frame/dock.spec.ts`: the approach from above plus left-right-left sweeps, as in the baseline script, through `frame/capture.ts` and `frame/parse.ts`. New budget rows in `tests/performance/budgets.json`: `DSN-44.dock-frame` (p95 ≤ 16.7 ms), `DSN-44.dock-cold` (≤ 2 frames > 20 ms) and `DSN-44.dock-loaf` (0 LoAF > 50 ms attributed to our origin).
- **(c)** `tests/e2e`: an icon screenshot at the dock edge crossing (scale ≥ 0.95 · max). Screenshots go to `docs/design/wave3/platform/` and are read by the builder.

### 10.3 Metrics for the capstone report (baseline against new)

| Metric                                                                  | Baseline (2026-09-30)                                                 | Target                                          |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------- |
| Client ops carrying a fence while their process holds server X          | 0 % (G1)                                                              | 100 %                                           |
| Fenced zombie writes applied, in property runs (1,000 schedules)        | n/a: fences are never sent, so un-fenced zombies fall back to the CAS | 0                                               |
| Stall-to-"lock lost" latency without a visibility event (demo TTL 15 s) | up to `HB_MS` (5 s) + RTT                                             | ≤ ε + RTT (≈ 0.45 s) at the next commit         |
| Min contrast, menu-bar muted text, worst bundled wallpaper, dark theme  | 7.17 on aurora; ≈ 2.4 projected on Daylight                           | ≥ 4.7 (4.5 + margin) on every bundled wallpaper |
| Min contrast, Control Centre tertiary text, light theme                 | 4.63                                                                  | ≥ 4.7                                           |
| Mean glass-alpha increase on the built-in wallpaper (identity cost)     | —                                                                     | ≤ 0.02 (expected 0.00: it already passes)       |
| Drift of the target under the pointer, max and mean (1.5×; 2×)          | 15.1 / 3.5 px; 30.2 / 7.0 px                                          | 0 / 0 px                                        |
| Icon scale when the pointer crosses the Dock edge (vertical approach)   | 1.0 (expansion starts inside)                                         | ≥ 0.95 · max                                    |
| Largest one-frame icon size change on entry                             | 26 px                                                                 | ≤ 10 px at a 1 px/ms approach                   |
| Dock sweep frame p95, warm and cold                                     | 16.7 ms, 33.3 ms (headless smoke)                                     | 16.7 ms, 16.7 ms (lab-spec)                     |

**Optional pointer-acquisition study (first to cut).** A gallery page, `ui/gallery/pages/dock-fitts.tsx`, runs a Fitts task: start box, then a Dock icon, with 3 conditions (static, today's magnification, approach plus anchored), 5 team members × 3 amplitudes × 10 trials. It logs movement time and misses and fits MT = a + b·ID with the final width, as McGuffin did. Synthetic Playwright pointers cannot measure human acquisition, so the automated suite relies on the analytic proxies above (final width at crossing, drift). The predicted effect from Fitts: A = 400 px, W from 52 to 78 px, ID from 3.12 to 2.62 bits, so a 0.5-bit reduction, about 50–100 ms at b = 0.1–0.2 s/bit.

### 10.4 Reproducing the baselines

These are the scripts used for this RFC, kept in the designer's scratchpad; the builder rewrites them as the specs above.

- **Contrast:** Playwright with channel `chrome`, 1440×900, session file. Hide `header` (the menu-bar glass), the Dock nav and overlays through the CSSOM, then screenshot. Downsample 4×, run a 3-pass box blur with σ equal to the material blur, apply the CSS `saturate()` matrix in sRGB, composite the glass token and then the text token, and compute the WCAG ratio per pixel. `anyBackdropMin` uses pure black and white.
- **Drift:** `ui/src/shell/dock/magnify.ts`, imported directly (Node type stripping), over the QA Dock geometry.
- **Frames:** rAF deltas in the page during a scripted sweep (smoke only).

## 11. Rollout

- **Flags.** No general feature-flag registry exists today (`kernel/src/core/io/types.ts:159` has only boot flags), and the ARB decided not to add one in Wave 3 (RFC 0001 Q9). Kernel flags are root-only sysctls, and desktop flags are `DesktopPrefs` keys:
  - `sync.fenceWrites`: a **root-only sysctl** (`'on' | 'off'`, default `'on'`), read at each commit (ARB, 0006-S4; the draft had a build-time `IoDeps` flag). Off restores today's behaviour (no fences), and the server is unchanged. The deferred ε re-verification will ride on the same flag.
  - `appearance.adaptiveGlass` (a `DesktopPrefs` key, default **on**, not shown in Settings). Off means no solver, no floors and no flips. The wallpaper picker is independent and always on.
  - `dock.expansion`: `'classic' | 'approach'` (a `DesktopPrefs` key, default **`approach`**). `classic` is exactly today's `magnify` plus `spring-soft`, which also serves as the A/B condition for the study and the viva.
- **Order.** (a) can ship before UI-006; it is inert until the engines link. (b) and (c) ship independently.
- **Migration.** There is none: no DB, IndexedDB or protocol change. `OutboxRec.fence` already exists, and old records without it replay as today.
- **Rollback.** Flip the flag, or revert the files listed in §13. A server rollback is never needed.
- **Compatibility.** The relative-colour CSS falls back to the plain token in older browsers, so there is no adaptation there, but also no regression.

## 12. Observability

- **(a)** klog `lockd: lease <ino> suspect (+<ms> past local deadline), re-verifying`, and `lockd: lease <ino> lost (<reason>) fence <f>`. `lsof` gains a `suspect` column. Server: a new counter `plotinium_lock_events_total{event=granted|expired|revoked|stale_fence|lease_busy}` and a histogram `plotinium_lock_expiry_lateness_seconds` in `server/src/obs/metrics.ts`, incremented from `LockManager` and the write verdicts. Metrics are cut-able (§14). Structured log `lock.stale_fence` with `{ino, fence, lockFence, osSessionId}`, no content.
- **(b)** `data-glass-scheme`, `data-glass-a-min` and `data-glass-min-ratio` attributes on each surface root (read by E2E and visible in DevTools), a performance mark `legibility:solve`, and klog `legibility: <wallpaper>/<theme> menubar dark α≥0.62 (min 4.8:1) …`, plus `capped` when a surface fell back to opaque.
- **(c)** The existing frame meter HUD (Control Centre tile, `frame-sampler.ts`) shows the p95 live during the demo, a performance mark `dock:magnify-start` when the band activates, and the trace budgets in §10.2.

## 13. Ownership and work breakdown (ARB: only part (a), by `platform`)

The canonical owned paths are in [PLAN.md](PLAN.md). `platform` is the wave's step-0 integrator and owns every kernel file that part (a) touches.

| Step               | Time | Exact paths                                                                                                                                                                                                                                                                                                                                                                                                                                                     | When                       |
| ------------------ | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| a1                 | 45 m | `kernel/src/core/net/engines.ts`, `kernel/src/core/net/factory.ts` (the `LockdEngine` delegations), `kernel/src/core/fs/kfs.ts` (`KernelFsDeps.fenceOf` and the `prepareCommit` argument), `kernel/src/core/io/index.ts` (the `fenceOf` line and the `sync.fenceWrites` sysctl), `kernel/src/core/fs/tests/kfs-fence.test.ts` (new), `kernel/src/core/net/tests/factory-fence.test.ts` (new), `vfs/src/sync/tests/units.test.ts` (extended; see the note below) | inside step 0b             |
| a2-server          | 45 m | `server/src/engine/locks/zombie.test.ts` and `zombie.prop.test.ts` (new), `server/src/engine/locks/README.md` (the stale heap note)                                                                                                                                                                                                                                                                                                                             | after step 0; stretch goal |
| a2-lockd, SYN-20   | –    | `vfs/src/locks/lockd.ts`, `vfs/src/locks/tests/lockd.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                   | deferred                   |
| E2E, frozen holder | –    | `tests/e2e/lock-contention.spec.ts`                                                                                                                                                                                                                                                                                                                                                                                                                             | deferred                   |
| (b), (c)           | –    | as in the draft, re-planned when scheduled                                                                                                                                                                                                                                                                                                                                                                                                                      | deferred                   |

Two notes:

- `vfs/src/sync/tests/units.test.ts` is extended only by `platform` in Wave 3.
- The spec edits and the `AI_USAGE.md` entry are `platform`'s anyway, because it owns `specs/**`, `CHANGELOG.md`, `AI_USAGE.md` and `SECURITY.md` in Wave 3 (ARB, 0006-N3).

**Interface contracts:**

- **The stabilize track** (fix-system-services) has finished UI-006's factory. Workflow B starts after the close-out, so `platform` builds on the closed-out `factory.ts`.
- **`kfs.ts`** belongs to `platform` alone in Wave 3. RFC 0004's `warmFile` and `cacheState` delegate to `warm.ts` (predictive-cache).

## 14. Risks, mitigations and the cut line

| Risk                                                                                    | Mitigation                                                                                                                                   |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| UI-006 slips, so (a) is not visible in the product                                      | (a)'s value is proven by the deterministic and DB tests; the viva shows the property test and the int test; the E2E is `fixme` with a reason |
| The relative-colour syntax is unsupported in the demo browser                           | The demo runs on current Chrome; the fallback is the unchanged token                                                                         |
| The SVG twin differs from the CSS gradient, so the analysis mismatches what is drawn    | The E2E contrast spec measures the real rendered desktop; the unit fixtures come from the measured values; the tolerance is 0.2 ratio        |
| The approach band triggers magnification while the user works at a window's bottom edge | Intent gate (downward velocity); D ≤ `iconSize`; the flag falls back to `classic`                                                            |
| `tokens.css` exceeds the DSN-39 5 KB budget                                             | DSN-41 guards move to a non-boot shell stylesheet (§5.2)                                                                                     |
| Spring overshoot reads as wobble                                                        | ζ = 0.75 with ≈ 2.8 % overshoot; a design review in both themes; the flag falls back to `classic`                                            |
| Window content behind a popover or HUD is arbitrary                                     | Documented limitation; the theme-surface samples cover the common case; `prefers-contrast: more` uses the any-backdrop floor                 |

**Cut line (ARB).** Already cut from Workflow B: parts (b) and (c), SYN-20, the frozen-holder E2E, the server lock metrics, and the human pointer-acquisition study. Within what remains, the first to drop is the a2-server zombie tests (SYN-21), which are a stretch goal.

**Never cut:** the fence plumbing through `LockdEngine`, the `sync.fenceWrites` kill switch, and the SYN-19 tests, including the fence-0 case.

## 15. Open questions

1. Should the Editor show the `suspect` state ("Reconnecting lock…")? _Deferred with SYN-20._
2. Should `lock.acquire` return `fence: null` for local scope instead of a number? _ARB: no ABI change. The number stays; it never reaches the wire (§5.1, step 6)._
3. Does a shared feature-flag registry land with the Drive RFC? _ARB: no registry in Wave 3; kernel flags are root-only sysctls (PLAN.md, C-19)._
4. Should the scheme flip also apply to the Dock in the light theme over dark wallpapers? _Deferred with part (b)._
5. Are dedicated-worker timers exempt from Chrome's intensive throttling? _Deferred with SYN-20 (unverified in the spec)._

## 16. Spec and doc changes

**New requirement IDs**

| ID     | Statement                                                                                                                                                                                                                                                                                                                                       | Spec file                                                                      |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| SYN-19 | Every commit by a process holding a server X lease carries that lease's fence from the lock engine into `OutboxRec.fence` and `OpSubmit.fences`. Kernel-local advisory fences never reach the wire.                                                                                                                                             | `specs/06-sync/offline-and-sync.md` §3.14.4                                    |
| SYN-20 | (**Deferred** by the ARB) `lockd` treats its own lease as suspect from `expiresAt − ε`, with ε = max(250 ms, RTT/2 + 1 % of the TTL), and re-verifies with one immediate heartbeat. Writes still queue, and the server decides.                                                                                                                 | `specs/06-sync/offline-and-sync.md` §3.14.2, §3.14.7                           |
| SYN-21 | The paused-holder failure (pause, expiry, re-grant, write) is tested at unit, property, integration and E2E levels. No fenced write under an expired lease is ever applied.                                                                                                                                                                     | `specs/06-sync/offline-and-sync.md` §8                                         |
| DSN-40 | Menu bar, Dock, Control Centre and popover glass keep text at ≥ 4.5:1 (indicators ≥ 3:1; 7:1 under `prefers-contrast: more`) over every bundled wallpaper in both themes. This is computed once per wallpaper, theme, accent or viewport change from the wallpaper image, never from live pixels, and it only raises alpha or flips the scheme. | `specs/05-wm/visual-language-macos.md` §3.4, §3.9                              |
| DSN-41 | Reduce transparency, forced colours and missing `backdrop-filter` support override adaptive glass, including inside `[data-theme]` subtrees.                                                                                                                                                                                                    | `specs/05-wm/visual-language-macos.md` §3.4 (amends DSN-25)                    |
| DSN-42 | Dock expansion starts in an approach band D = max(48 px, icon size) above the Dock, gated on downward pointer velocity. Growth is anchored at the pointer, so the icon under it does not drift.                                                                                                                                                 | `specs/05-wm/visual-language-macos.md` §3.7.3                                  |
| DSN-43 | Dock motion: a ramped entry (≤ 10 px of size change per frame at 1 px/ms), unsmoothed tracking, a spring exit (ζ ≈ 0.75, 320 ms), and a catch on minimise arrival. Reduced motion removes all of it.                                                                                                                                            | `specs/05-wm/visual-language-macos.md` §3.7.3                                  |
| DSN-44 | Dock magnification frame budget: p95 ≤ 16.7 ms at 60 Hz, 0 frames > 33 ms on warm sweeps, ≤ 2 frames > 20 ms on the cold sweep, on the lab-spec harness.                                                                                                                                                                                        | `specs/05-wm/visual-language-macos.md` §3.10; `tests/performance/budgets.json` |

DSN-40 to DSN-44 are **deferred** with parts (b) and (c). The `DSN` and `SYN` prefixes are already registered (`tools/traceability/ids.ts:53`).

**Edits.** Applied by `platform`, which owns `specs/**` in Wave 3: SYN-19 and SYN-21 in the end-of-wave doc PR after the lead's ADR, or as `docs/design/wave3/spec-patches/0006.md` if the specs are Frozen and approval is pending. The part (b) and (c) edits wait for their wave.

- `specs/06-sync/offline-and-sync.md`:
  - §3.14.2: add the ε margin.
  - §3.14.4: add a note that the kernel attaches fences from the lock engine only.
  - §3.14.7: add the suspect state.
  - §8: add the new test titles.
- `specs/04-vfs/virtual-file-system.md` §3.16.3: "every commit … passes `lockd.fenceFor(pid, ino)`" now names `KfsDeps.fenceOf` as the mechanism.
- `specs/05-wm/visual-language-macos.md`:
  - §3.4: add the adaptive-floor rule and the materials recipe with `rgb(from …)`.
  - §3.7.3: update the Dock icon magnification row (approach band, anchoring, the Dock spring, returning in 320 ms) and add a new "Dock icon: window minimised into it: `pl-anim-dock-catch`" row.
  - §3.9: add the contrast targets over the wallpaper.
  - §8: add the test titles.
- `specs/05-wm/window-manager.md` (§3.7, the animator): the catch callback on minimise finish.
- `server/src/engine/locks/README.md`: the expiry index now runs on `dsa/heap`.
- `tests/performance/budgets.json`: `DSN-44.*` rows. The traceability tool (`tools/traceability.ts`) picks the new IDs up from the test titles.
- **Capstone mapping.** This RFC covers spec §9.3 VFS-09 (leases, fencing), §9.4 WM-03 and WM-07 (60 FPS; WCAG 2.2 AA contrast and reduced motion), §5.2 PLT-ID-06 (tokens in both themes), and §10.2 (it uses `dsa/lru`, `dsa/heap` and `dsa/ringbuffer`, with no library replacements). **AI coupling map** (`specs/10-ai/ai-safety-and-evaluation.md` §3.2): no cell changes. These features are part of the non-AI build, so the litmus job (ARC-06) is unaffected. Fencing hardens the VFS substrate that CPL-B-VFS (agent batches) relies on, in the spirit of GoEX's damage confinement; agent batches remain governed by `expectedVersions` (§5.1 failure modes).

## 17. Review log

| Date       | Reviewer                                                | Verdict                                                                           | Notes                                                                                                                                                                                                                                                                                                    |
| ---------- | ------------------------------------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-09-30 | critic-security ([review](reviews/security-privacy.md)) | Approve (security-neutral); 2 NIT                                                 | –                                                                                                                                                                                                                                                                                                        |
| 2026-09-30 | critic-arch ([review](reviews/architecture.md))         | Revise part (a), then approve; split the builder; 1 MUST-FIX, 4 SHOULD-FIX, 4 NIT | –                                                                                                                                                                                                                                                                                                        |
| 2026-09-30 | ARB                                                     | **APPROVED-WITH-CUTS**                                                            | Part (a)'s fence plumbing and SYN-19 ship in step 0 by `platform`; SYN-21 is a stretch goal. SYN-20, the E2E and the metrics are deferred. Parts (b) and (c) are deferred for capacity: this RFC is last in the lead's priority order, and Workflow B has 8 builders. Every finding is accepted (below). |

| Finding                                                                   | Severity | Decision                           | Applied in, and reason                                                                                             |
| ------------------------------------------------------------------------- | -------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 0006-M1 `LockdEngine` has no `fenceFor`, so no fence would reach the wire | MUST     | Accepted                           | §5.1 step 2; SYN-19 through `createEngineFactory`                                                                  |
| 0006-S1 G2 and G3 are stale; step 5 has no target                         | SHOULD   | Accepted                           | §2.1 re-baselined; step 6 dropped; Q2 answered (no ABI change)                                                     |
| 0006-S2 Three unrelated features for one builder                          | SHOULD   | Accepted, modified                 | Not split: parts (b) and (c) are deferred, and part (a) is folded into `platform`, which owns the files it touches |
| 0006-S3 The Dock frame budget omits the spec's conditions                 | SHOULD   | Accepted for when (c) is scheduled | §5.3, §8                                                                                                           |
| 0006-S4 `sync.fenceWrites` is build-time                                  | SHOULD   | Accepted                           | §5.1 step 5, §11: a root-only sysctl read at each commit                                                           |
| 0006-N1 `KfsDeps` does not exist                                          | NIT      | Accepted                           | §5.1 step 3: `KernelFsDeps`                                                                                        |
| 0006-N2 `fencedIno` is already public                                     | NIT      | Accepted                           | §5.1 step 4: no `vfs/src/index.ts` edit                                                                            |
| 0006-N3 `AI_USAGE.md` and the spec edits                                  | NIT      | Accepted                           | §13, §16: `platform` owns them in Wave 3                                                                           |
| 0006-N4 The sampler runs on the main thread                               | NIT      | Accepted for when (b) is scheduled | §5.2: `OffscreenCanvas` in a worker                                                                                |
| S-0006-01 Prove that fence 0 never reaches the wire                       | NIT      | Accepted                           | §5.1 test table (SYN-19 fence-0 case)                                                                              |
| S-0006-02 Nobody owns `img-src blob:`                                     | NIT      | Accepted                           | §5.2: needs its own security review; no Wave-3 builder may change the CSP's `img-src`                              |
| X1, X9                                                                    | –        | Accepted                           | `platform` is the integrator; spec edits via `platform`                                                            |
