# Verbose boot log (dark)

- **Stitch project:** 12849137298552292712
- **Stitch screen id:** none — generation timed out and never appeared in `list_screens` (15 polls, ~20 min). Not retried, per run instructions. See `screen.json`.
- **Design system:** Plotinium Glass (Dark), `assets/10121591451242352758`
- **Model:** GEMINI_3_8_FLASH, device DESKTOP (1440 × 900)
- **Files:** `screen.json` (Stitch timeout record), `reference.html` + `reference.png` (hand-built render of the same prompt; NOT a Stitch export). `screen.html` / `screenshot.png` are absent because Stitch returned no screen.
- **Spec sources:** `specs/02-boot/boot-and-services.md` §3.2 stage table, §3.7 "Verbose log (BOOT-05)", §5.6 timer allowlist (SVC-10), BOOT-13; `specs/05-wm/ui-design-system.md` §3.6 motion tokens, DSN-05, boot bar accessibility note.

## What this screen is

The verbose view of boot-ui. It is shown from the first frame when the profile is `verbose` (boot menu entry, `reboot --verbose`, `?boot=verbose`) and is toggled at any time by **V**, which is buffered from the first line of the inlined script. It is the same boot as the splash: the same truthful progress value, the same klog ring, only a different view. The screen is framework-free boot-ui, so everything here is plain DOM and CSS.

**Hard constraint from SVC-10 / BOOT-02:** the boot path may not contain `setTimeout`, `setInterval`, `@keyframes` or `animation` (outside the two allowlisted modules). Every motion below is therefore a **CSS `transition`** fired by a real boot event (a klog line arriving, a progress value, a service state change), usually entering from `@starting-style`. Nothing loops and nothing moves on a clock. The block cursor does **not** blink here (the only looping animation the design system allows is the Terminal cursor, and the boot path cannot use keyframes).

## Final prompt

```text
Plotinium OS — "Verbose boot log" screen (1440x900 desktop, dark). This is the verbose boot mode of Plotinium, an AI-native web operating system; aesthetic inspired by the latest macOS Liquid Glass era but with its own identity. Absolutely NO Apple logo, NO Apple app names, NO SF Pro, NO SF Symbols, NO radiation/hazard symbols.

BACKGROUND: full-screen near-black #07070B with an extremely subtle violet radial glow (#5E5CE6 at ~6% opacity) behind the upper-left, and a faint film-grain texture. No windows, no dock, no menu bar — this is boot.

TOP-LEFT HEADER (small, 24px margin): the Plotinium logo — an abstract luminous atom: a bright white-violet nucleus dot with 2–3 thin elliptical violet (#5E5CE6) orbits at different angles — then the word "Plotinium" in Inter semibold 14px, and a dim grey chip "verbose boot" in JetBrains Mono 11px. TOP-RIGHT: dim grey JetBrains Mono 11px text "boot id 7f3e·b12c · 2026-09-24 09:41:07 PKT".

MAIN LOG (the hero): a terminal-style log occupying most of the screen, left-aligned, 48px left margin, in JetBrains Mono 12px, line-height 20px. Every line has the timestamp bracket in dim grey (#6E6E78), then the component tag in violet (#8E8CF2, semibold), then the message in soft white (#E6E6EC). Show these lines exactly, one per row:
[ 0.000] firmware: Plotinium 0.3.0 · POST ok (workers, indexeddb, opfs, crypto) · quota 2.1 GB, persisted
[ 0.004] loader: profile=normal · service worker active (offline-capable)
[ 0.011] kernel: process table ready (hash map, cap 1024) · pid 1 = init
[ 0.013] sched: priority heap + RR · quantum 8 ms · workers 7/8 cores · aging 250 ms
[ 0.019] mm: memory manager armed · budget 256 MB · swap tiers: opfs, cloud
[ 0.021] svc: 18 manifests · 30 edges · acyclic · 7 levels
[ 0.087] storage: opened plotinium-vfs v7 (IndexedDB) in 64 ms
[ 0.212] vfs: mounted / · 12,408 inodes · 3 users · quotas enforced
[ 0.402] sync: WARN backend unreachable · offline mode · outbox holds 3 ops · retry in 2 s   ← this entire line in AMBER #FFB340 with a small amber "WARN" pill
[ 0.405] lockd: DEGRADED (requires sync) · local advisory locks only   ← entire line AMBER #FFB340 with a small amber "DEGRADED" pill
[ 0.644] ai.indexer: 412 chunks pending · scheduled at priority 32 (background)
[ 0.731] desktop: interactive · 4 windows restored · boot 0.73 s · 2 services degraded   ← entire line GREEN #30D158 with a small green check mark
After the last line show a blinking block cursor (violet) on an empty line.

RIGHT SIDE (optional, subtle): a narrow translucent dark glass panel (backdrop blur, 1px white/8% hairline border, 16px radius) titled "Services" listing tiny status rows with colored dots: init (green, pid 1), sched (green), vfs (green), storage (green), syncd (amber, offline), lockd (amber, degraded), ai.indexer (violet, background, pid 23), desktop (green). Summary at bottom: "16 ok · 2 degraded · 0 failed".

BOTTOM: a slim 3px progress bar pinned to the very bottom edge spanning the full width, filled ~100% with a violet-to-light-violet gradient and a soft glow. Just above it, left: JetBrains Mono 11px dim grey "Plotinium 0.3.0 · build a1f93c2"; center: a small glass keycap showing "V" followed by "Press V to hide log"; right: "boot 0.73 s".

Everything crisp, high contrast, calm, beautiful, like a premium OS verbose boot.
```

## Layout (1440 × 900)

1. **Header row** (24 px margins, `role="banner"`): atom logo (nucleus + 2–3 elliptical orbits, violet `#5E5CE6`), wordmark `Plotinium` (Inter Semibold 14), chip `verbose boot` (JetBrains Mono 11, tertiary label). Right: `boot id 7f3e·b12c · 2026-09-24 09:41:07 PKT` (mono 11, tertiary).
2. **Log** (`role="log"`, the hero, 48 px left margin, JetBrains Mono 12/20): one row per klog line, `[ssss.mmm]` timestamp in tertiary grey, `subsystem:` tag in violet `#8E8CF2` semibold, message in label white 92 %.
3. **Services rail** (right, optional at ≥ 1280 px wide; hidden below): narrow dark glass panel, 16 px radius, hairline border, title `Services`, one row per service with a state dot **and** a state word, footer `16 ok · 2 degraded · 0 failed`.
4. **Footer strip** above the bar: left `Plotinium 0.3.0 · build a1f93c2`; centre keycap `V` + `Press V to hide log`; right `boot 0.73 s` (or the live elapsed time while booting).
5. **Progress bar**: 3 px, full width, pinned to the bottom edge, violet → light-violet fill with a soft glow.

### Log content (illustrative, mirrors Spec §6.6)

```text
[ 0.000] firmware: Plotinium 0.3.0 · POST ok (workers, indexeddb, opfs, crypto) · quota 2.1 GB, persisted
[ 0.004] loader: profile=normal · service worker active (offline-capable)
[ 0.011] kernel: process table ready (hash map, cap 1024) · pid 1 = init
[ 0.013] sched: priority heap + RR · quantum 8 ms · workers 7/8 cores · aging 250 ms
[ 0.019] mm: memory manager armed · budget 256 MB · swap tiers: opfs, cloud
[ 0.021] svc: 18 manifests · 30 edges · acyclic · 7 levels
[ 0.087] storage: opened plotinium-vfs v7 (IndexedDB) in 64 ms
[ 0.212] vfs: mounted / · 12,408 inodes · 3 users · quotas enforced
[ 0.402] sync: WARN backend unreachable · offline mode · outbox holds 3 ops · retry in 2 s      (amber)
[ 0.405] lockd: DEGRADED (requires sync) · local advisory locks only                       (amber)
[ 0.644] ai.indexer: 412 chunks pending · scheduled at priority 32 (background)
[ 0.731] desktop: interactive · 4 windows restored · boot 0.73 s · 2 services degraded     (green)
```

`WARN`, `DEGRADED`, `FAIL` and `KERNEL PANIC` are always **text prefixes** (BOOT-05 test "verbose lines carry WARN and DEGRADED text prefixes, not colour alone"). Amber is warning `#FF9F0A` family (the render uses `#FFB340` for contrast on near-black); green is success `#30D158`.

## Elements and states

| Element | Default | Hover | Focus | Active | Disabled | Empty | Loading | Error |
|---|---|---|---|---|---|---|---|---|
| Header logo + wordmark | static, decorative logo (`aria-hidden`) | – | – | – | – | – | – | – |
| `verbose boot` chip | tertiary grey | – | – | – | – | – | – | changes to `verbose · safe` / `verbose · recovery` when the profile differs |
| Boot id + clock | tertiary grey mono | – | – | – | – | `boot id pending` until the kernel assigns one | – | – |
| Log row (info) | timestamp grey, tag violet, message white | row gets `rgba(255,255,255,0.04)` tint (pointer users can select text) | – (rows are not focusable; the log region is) | text selection uses accent 85 % | – | – | newest row enters (see motion) | – |
| Log row `WARN` | whole row amber, `WARN` pill | same tint | – | – | – | – | – | – |
| Log row `DEGRADED` | whole row amber, `DEGRADED` pill | same tint | – | – | – | – | – | – |
| Log row `FAIL` | whole row danger `#FF453A`, `FAIL` pill | same tint | – | – | – | – | – | leads to the recovery screen if the service is critical |
| Log row `KERNEL PANIC` | danger, bold | – | – | – | – | – | – | hands over to the kernel-panic screen |
| Final `desktop: interactive` row | success green + check glyph | – | – | – | – | – | – | – |
| Log region | scrolls; auto-sticks to the bottom while the user has not scrolled up | – | `tabindex="0"`, 3 px accent 55 % focus ring inset 4 px | – | – | before the first line: `waiting for firmware…` in tertiary | – | – |
| "Jump to latest" pill (appears when the user scrolled up and new lines arrived) | glass pill `↓ 3 new lines` bottom-right of the log | accent tint | focus ring | pressed scale 0.97 | – | hidden | – | – |
| Block cursor | violet block after the last line, **static** | – | – | – | – | – | shown while booting | hidden after `desktop: interactive` |
| Services rail row | dot + name + state word (`ok`, `starting`, `offline`, `degraded`, `background`, `failed`) + pid | row tint 4 % | – | – | greyed `not started (safe mode)` | – | `starting` with hollow dot | `failed` in danger red with retry countdown text from the kernel event (not a UI timer) |
| Services summary | `16 ok · 2 degraded · 0 failed` | – | – | – | – | `0 of 18 started` | counts update per event | failed count in danger red when > 0 |
| `V` keycap + hint | glass keycap, secondary label | keycap lightens | – | keycap depresses (translateY 1 px) when V is pressed | – | – | – | – |
| Version line | tertiary mono | – | – | – | – | – | – | – |
| Progress bar | violet fill at the true value `P` | – | – | – | – | 0 % track only | fill advances per event | turns danger red and stops (panic / recovery) |

## Intended animations

All durations use the tokens `--pl-motion-fast` 120 ms, `--pl-motion-med` 200 ms, `--pl-motion-slow` 320 ms, which are zeroed under reduced motion (DSN-05). All are `transition`s driven by events; none uses `@keyframes`, `animation`, `setTimeout` or `setInterval` (SVC-10). Only `transform` and `opacity` animate.

Easing tokens: `--pl-ease` = `cubic-bezier(.2, .8, .2, 1)`; `--pl-ease-out` = `cubic-bezier(0, 0, .2, 1)`; spring for the view toggle `--pl-spring` = `linear(0, 0.35 12%, 0.78 26%, 1.02 40%, 1.04 50%, 1.01 65%, 1)` (≈ 1.04 overshoot).

| # | Element | Trigger | Properties | Duration | Easing | Reduced-motion fallback |
|---|---|---|---|---|---|---|
| 1 | Splash ↔ verbose view | V keydown (or profile `verbose` at first paint: no animation, the log is simply there) | log layer `opacity 0→1`, `transform: translateY(8px) scale(0.985) → none`; splash logo layer `opacity 1→0`, `scale 1→0.96` (reverse on hide) | 200 ms (`med`) | `--pl-spring` | instant swap, no transform |
| 2 | New log line | a klog line appended (one DOM row) | `opacity 0→1`, `transform: translateX(-6px) → 0` from `@starting-style` | 120 ms (`fast`) | `--pl-ease-out` | appears instantly |
| 3 | Burst coalescing | > 8 lines inside one animation frame | only the last line of the frame gets #2; the rest appear with `opacity` only | 120 ms | linear | instant |
| 4 | Status pill (`WARN`, `DEGRADED`, `FAIL`) | row inserted with a prefix | pill `transform: scale(0.9) → 1`, `opacity 0→1`, 40 ms after the row (transition-delay) | 200 ms | `--pl-spring` | instant, no scale |
| 5 | Final `desktop: interactive` check glyph | `desktop.interactive` event | glyph `scale 0.6 → 1`, `opacity 0→1` | 320 ms (`slow`) | `--pl-spring` | instant |
| 6 | Progress fill | each progress event (`P` changes) | `transform: scaleX(P)` with `transform-origin: left` (spec §3.6 allows `width`; `scaleX` keeps us on transform-only and off layout) | 120 ms | `--pl-ease` | the transition is removed; the bar jumps to the value |
| 7 | Progress completion glow | `P` reaches 1 (`desktop-interactive`) | a 1-shot highlight overlay on the bar `opacity 0 → 0.9 → 0` using two chained transitions on class change (`.done` then `.settled` on `transitionend`); no loop, no timer | 320 ms + 320 ms | `--pl-ease-out` | no highlight |
| 8 | Services rail row state change | `svc.*` event | dot `scale 0.6→1` + `opacity`; state word cross-fades (old `opacity 1→0`, new `0→1`) | 120 ms | `--pl-ease` | instant text swap |
| 9 | Services rail entrance | first `svc` event (rail exists from first paint but is empty) | rail `opacity 0→1`, `translateX(12px) → 0` | 200 ms | `--pl-spring` | instant |
| 10 | "Jump to latest" pill | user scrolls up and a new line arrives / pill pressed | `opacity 0→1`, `translateY(6px) → 0`; pressed `scale 0.97` | 120 ms | `--pl-ease-out` | instant |
| 11 | `V` keycap | V keydown / keyup | `transform: translateY(1px)` then back | 120 ms | `--pl-ease` | none (visual state only) |
| 12 | Hand-off to login / desktop | `desktop.interactive` in Normal profile with verbose off, or V pressed after interactive | whole boot layer `opacity 1→0`, `scale 1→1.02` | 320 ms | `--pl-ease-in` for the exit | instant cut |

Scroll stickiness uses `scrollTop` set on the next frame after a row is appended (`requestAnimationFrame`, not a timer); `scroll-behavior` is `auto` (no smooth scroll) so it never lags behind a fast boot.

## Accessibility

- Landmarks: header `role="banner"`; log area inside `<main>`; services rail `<aside aria-label="Services">`; footer `role="contentinfo"`.
- The log is `role="log"` with `aria-live="off"` by default (a 12-line burst in 0.7 s would flood a screen reader) and `aria-label="Boot log"`. It is keyboard-focusable (`tabindex="0"`) and scrollable by arrow keys and PgUp/PgDn.
- A separate visually hidden `role="status" aria-live="polite"` region announces stage changes and the summary (`Starting vfs, 5 of 9`, `2 services degraded`, `Desktop ready in 0.73 seconds`) at most once per 750 ms (spec §3.6 BOOT-13 note), throttled by event time, not a timer.
- `WARN`, `DEGRADED` and `FAIL` lines are also announced in the status region because they change what the user will find on the desktop.
- Progress bar: `role="progressbar"`, `aria-valuemin="0"`, `aria-valuemax="100"`, `aria-valuenow` integer %, `aria-valuetext` such as `Starting ai.indexer, 8 of 9`, `aria-label="Boot progress"`.
- Keyboard: `V` toggles the log (announced: `Boot log shown` / `Boot log hidden`); `Esc` before the stage-2 decision opens the boot menu; `End` in the log jumps to the newest line; `Tab` order: log → services rail → (nothing else interactive).
- Colour is never the only signal: prefixes are text, service dots carry state words, the final line carries a check glyph and the words `interactive` and `degraded`.
- Contrast: timestamps `#6E6E78` on `#07070B` are ≥ 4.5:1 at 12 px; amber `#FFB340` and green `#30D158` on near-black exceed 7:1. Forced-colours mode: dots become `CanvasText` outlines, pills use `Mark` / `MarkText`.
- `prefers-reduced-motion` or Settings "Reduce motion: Always": every motion token is 0 ms; the view still works identically.

## Review notes (Stitch render)

**No Stitch render exists** for this screen (see `screen.json`). To keep the design reviewable, `reference.html` is a hand-built render of the exact prompt and tokens above, and `reference.png` is its 1440 × 900 Chromium capture (Playwright). It is labelled "NOT a Stitch export" in its source. Open `reference.html?replay` to watch the lines arrive with the intended transitions (rAF-driven; no timers, no keyframes).

Checked on `reference.png`:
- Plotinium atom logo (nucleus + three elliptical violet orbits) and wordmark; no Apple marks, no SF fonts/symbols, no hazard symbol. PASS.
- All 12 log lines verbatim, violet tags, grey timestamps; `WARN` / `DEGRADED` as amber text pills (not colour alone); final line green with a check glyph. PASS.
- Services rail with state dots **and** state words, `ai.indexer` pid 23 background, summary `16 ok · 2 degraded · 0 failed`. PASS.
- Footer: version `Plotinium 0.3.0 · build a1f93c2`, `V` keycap with `Press V to hide log`, `boot 0.73 s`; 3 px violet bar pinned to the bottom. PASS.
- Contrast: all text ≥ 4.5:1 on `#07070B`. PASS.

Deviations from the prompt, on purpose:
- The prompt asked for a **blinking** cursor. The render and notes use a **static** cursor: the boot path cannot contain `@keyframes`/`animation` (SVC-10) and the design system allows no looping animation except the Terminal cursor (ui-design-system §3.6, WCAG 2.2.2).
- The rail adds `mm` and pids for `sched` (2) and `vfs` (9) for realism; the pids are illustrative, not from the spec.
- The design system's "luminous sweep" on the boot bar would be a loop; it is replaced by the one-shot completion glow (animation #7).

To do when Stitch recovers: generate once with the prompt above (replace "blinking" with "static"), download to `screen.html` / `screenshot.png`, and compare with `reference.png`.
