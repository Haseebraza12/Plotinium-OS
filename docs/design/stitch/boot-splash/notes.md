# Boot splash — Stitch design notes

| Field | Value |
|---|---|
| Stitch project | `12849137298552292712` |
| Stitch screen id | `__SCREEN_ID__` (none returned in this run; see Generation status) |
| Design system | Plotinium Glass — Dark (`assets/10121591451242352758`) |
| Model | `GEMINI_3_8_FLASH`, device `DESKTOP`, 1440 × 900 |
| Files | `screen.json` (raw Stitch response) · `reference.html` + `reference.png` (hand-built fallback render) · `screen.html` / `screenshot.png` to be added when Stitch returns a screen |
| Screen spec | [ui-design-system.md §3.8.1](../../../../specs/05-wm/ui-design-system.md) · behaviour in [boot-and-services.md §3.2, §5.5, §5.6](../../../../specs/02-boot/boot-and-services.md) |
| Requirements | BOOT-01, BOOT-02, BOOT-05 (V key), BOOT-06 (Esc key), BOOT-13, DSN-07, SVC-10 |
| Owner | R3 (visuals) with R5 (progress wiring) · gate P2 (v1), P3 (DAG-driven) |

## Generation status (read first)

**Stitch did not return a screen for this slug.** The single `generate_screen_from_text` call (2026-09-24 ≈15:22Z) returned only `sessionId 6123745423513717547` and no screen. It was not retried (run rule). `list_screens` returned `{}` on about 20 polls from 15:23Z to 15:48Z, so `get_screen`, the downloads and `edit_screens` were impossible. Every sibling slug in this run hit the same wall. The raw response is in `screen.json`.

**Fallback, so the team is not blocked:** `reference.html` is a hand-built, working render of the same prompt, and `reference.png` is its 1440 × 900 screenshot (Playwright Chromium). It follows every rule in this file: transitions only, no `@keyframes`, no timers. Open `reference.html?replay` to watch a simulated boot (orbit ticks, sweep, digit roll, stage drift, zoom-through exit) and `?motion=reduce` for the reduced-motion path. The review below was done on `reference.png`.

**Visual review of `reference.png`:** centred column, 96 px atom mark, `Plotinium` wordmark, version line, 280 px bar at 62 % with glow, sheen and a luminous tip, `vfs: mounting / (12,408 inodes)`, `Service start · 7 of 9`, and two glass hint chips (`Esc` Boot menu, `V` Verbose log). No Apple marks and no Apple names. Text contrast is AA on #0B0D17. Fixed during review: extra spacing in the count line, the V label swap concatenating text, and the hint chips not leaving with the column on exit.

When Stitch recovers, re-run the prompt below. Replace `__SCREEN_ID__` above, then save `screen.html` and `screenshot.png` next to the reference files.

## Final prompt

```text
Plotinium OS boot splash screen (screen title: "Boot Splash"). Full-screen desktop 1440x900. No menu bar, no dock, no windows, no other UI.

Background: deep midnight #0B0D17 flowing into dark violet #1A1440 (radial, brighter behind the centre), with 3 very large, very soft, heavily blurred luminous colour blobs drifting behind (violet #5E5CE6 at 25% opacity upper-left, deep indigo #3A2FA0 lower-right, a faint cool cyan #5AC8FA at 8% near the bottom). Over it, a barely visible generative wallpaper of 4 thin partial orbit arcs (1px, white at 5% opacity).

Centre: one vertical column, max width 480px, centred both ways, 12px gaps:
1. Logo, 96px: an abstract luminous atom. A bright white-to-lavender nucleus dot with a soft violet bloom glow, and 3 thin elliptical orbits (1.5px strokes, gradient violet #5E5CE6 to lavender #A5A4FF) rotated 0°, 60° and 120° around the nucleus, with one tiny bright electron dot on one orbit. It must NOT look like a radiation or hazard symbol and must NOT be an Apple logo.
2. Wordmark "Plotinium" in Inter Semibold 34px, white, letter-spacing -0.5px.
3. Secondary line "version 0.3.0 · build a1f93c2" in Inter Regular 13px, muted grey #8E8EA0.
4. 28px gap, then a slim progress bar 280px wide and 4px tall, fully rounded pill: track white at 10% opacity; fill a violet gradient #5E5CE6 to #8B8AFF at exactly 62% of the width, with a soft violet glow under it and a brighter white luminous sweep highlight near the leading edge of the fill.
5. Under the bar: "vfs: mounting / (12,408 inodes)" in Inter 13px, white at 85%.
6. Below it: "Service start · 7 of 9" in Inter 12px, muted #8E8EA0.

Bottom centre of the viewport, 24px above the bottom edge: two small hint chips side by side with 12px gap, each a dark frosted-glass pill (white 6% fill, 1px hairline white 10% border, 6px radius, backdrop blur) containing a keycap and a label in Inter 12px muted: chip 1 keycap "Esc" + label "Boot menu"; chip 2 keycap "V" + label "Verbose log". Keycaps are small rounded rectangles with a 1px border and a subtle bottom edge.

Style: minimal, cinematic, calm, huge negative space, premium macOS-grade startup polish in the Liquid Glass era. No spinner, no loading dots, no Apple logo, no SF Symbols, no extra text, no buttons.
```

## Read this before implementing any animation on this screen

The splash is part of the inlined, framework-free boot-ui, so three binding rules apply:

1. **No `@keyframes`, no CSS `animation`/`animation-*`, no `setTimeout`/`setInterval`** in `wm/boot-ui/**` or the inlined `<style>`/`<script>` of `index.html` (boot spec §5.6, SVC-10; CI fails the build). The only two allowlisted timers are the boot-menu countdown and the stall watchdog, and neither may touch progress.
2. **Progress is truthful** (BOOT-02, DSN-07). Nothing on this screen may look like progress unless real work caused it. No spinner, no looping shimmer, no fake "breathing".
3. **Only `transform` and `opacity` animate**, with one exception: the bar fill animates `width` (ui-design-system §3.6).

So every animation below is a **CSS transition triggered by a real boot event** (asset bytes arriving, a klog line, a service reaching `done`, a stage change, a key press) or by `transitionend`. When the boot is working, the screen is alive; if the boot stalls, all motion stops, which is the truthful signal. The mock's "slow drifting blobs" and "luminous sweep" are reinterpreted this way: the blobs move one step per boot stage, and the sweep plays once per real progress update.

The entrance (animations 1–4) uses `@starting-style`: the browser transitions from a starting style on first render, with no class toggle and no timer. `requestAnimationFrame` is used only to restart a transition, such as the text swap. It never schedules anything that can move progress.

## Layout (1440 × 900)

- Full-viewport background: `--pl-bg` (#0B0D17) into dark violet #1A1440, radial, brightest behind the centre column. Three soft blurred light blobs (violet #5E5CE6 at ~25 %, indigo #3A2FA0, faint cyan #5AC8FA at ~8 %) and a faint generative orbit-arc wallpaper (inline SVG, `aria-hidden`).
- Centred column, max width 480 px, gap `--pl-space-3`:
  1. Logo, 96 px (`--pl-boot-logo`).
  2. Wordmark `Plotinium`, Inter Semibold ~34 px, tracking −0.5 px.
  3. `version 0.3.0 · build a1f93c2` (`--pl-text-sm`, muted).
  4. Progress bar, 280 × 4 px pill (spec token `--pl-boot-bar-w` is 320 px; see Issues), fill at 62 %.
  5. Current step `vfs: mounting / (12,408 inodes)` (`--pl-text-sm`).
  6. Count `Service start · 7 of 9` (`--pl-text-xs`, muted).
- Bottom centre, 24 px above the edge: two frosted-glass hint chips, `Esc` Boot menu and `V` Verbose log.

## Elements and states

| Element | Default | Hover | Focus-visible | Active / pressed | Disabled | Empty | Loading | Error |
|---|---|---|---|---|---|---|---|---|
| Background + blobs | Stage-1 blob positions | — | — | — | — | — | Blobs step to the next stage preset on each stage change | Panic / recovery screens reuse the background, blobs frozen, scrim 35 % |
| Logo (atom mark) | Full opacity from first paint (BOOT-01) | — | — | Orbits advance one tick per boot event | — | — | Orbits advance per event; nucleus flashes on each service `done` | Frozen at the last tick |
| Wordmark | Static | — | — | — | — | — | — | — |
| Version line | `version 0.3.0 · build a1f93c2` | — | — | — | — | — | — | Dev build: prefix `dev build` in `--pl-warning`, `version 0.3.0-dev.14 · build a1f93c2` |
| Progress bar (`role="progressbar"`) | Track white 10 %, violet fill at true P | — | — | — | — | P = 0 before any bytes: track only, no sheen | Width follows P; sheen plays once per update | Stops at its last true value; the stall watchdog message replaces line 5 after 15 s with no event |
| Step line (line 5) | `<service>: <detail>` | — | — | — | — | Before stage 1 finishes: `checking system` | Stage labels: `checking system`, `Loading kernel · 38 of 104 KB`, `vfs: mounting / (12,408 inodes)` | `Plotinium is not making progress: <last event> (<n> s ago)` with `[T] Retry (reload) [S] Safe mode [D] Diagnostics` |
| Count line (line 6) | `Service start · 7 of 9` (done/total over the desktop ancestor set A) | — | — | — | — | Hidden before stage 4 | Counts up with real `done` events | Unchanged at failure; the recovery screen takes over (BOOT-08) |
| Hint chip `Esc  Boot menu` | Glass pill, muted text | Fill white 6 % → 10 %, text to 92 % | 3 px accent ring at 55 % (design system), 2 px offset | Keycap pressed while the key is down (or pointer down) | After the stage-2 profile decision Esc is ignored (boot spec §3.7): chip at 40 % opacity, `aria-disabled="true"`, tooltip `Boot menu: run reboot --menu` | — | — | — |
| Hint chip `V  Verbose log` | Glass pill | Same as above | Same as above | Keycap pressed; toggles verbose | Never disabled | — | — | — |
| Hint chip `V` (verbose on) | Accent hairline border, label `Hide log` | — | — | — | — | — | — | — |
| Live region (visually hidden) | Empty | — | — | — | — | — | Announces stage changes, at most once per 750 ms | Announces the failure title |

Other full-screen states on the same column (ui-design-system §3.8.1): Unsupported browser (`Plotinium cannot start in this browser` plus one fix line per missing capability), Not Plotinium (`This page is not Plotinium`), Another tab (`Plotinium is running in another tab` + primary `Use here`), Shut down (`Plotinium has shut down.` + `Start again`). All reuse the entrance transition below and never show a progress bar.

## Motion tokens used

Existing tokens (ui-design-system §3.6): `--pl-motion-fast: 120ms`, `--pl-motion-med: 200ms`, `--pl-motion-slow: 320ms`, `--pl-ease: cubic-bezier(.2,.8,.2,1)`, `--pl-ease-in: cubic-bezier(.4,0,1,1)`, `--pl-ease-out: cubic-bezier(0,0,.2,1)`. All motion tokens become `0ms` under `prefers-reduced-motion: reduce` or `data-motion="reduce"`.

Proposed additions (to be added to `wm/tokens/tokens.css` by R3; Chrome supports `linear()` since 113):

```css
--pl-spring-soft: linear(0, 0.063, 0.225 4.5%, 0.648 10.5%, 0.877 15%, 0.967 18.5%,
                         1.021 22.6%, 1.035 26.3%, 1.031 30.4%, 1.008 41.5%, 0.998 51.6%, 1);   /* ~3.5 % overshoot */
--pl-spring:      linear(0, 0.009, 0.035 2.1%, 0.141 4.4%, 0.723 12.9%, 0.938 16.7%, 1.017 19.4%,
                         1.067, 1.099 24.3%, 1.108 26%, 1.103, 1.085 30.8%, 1.042 35.3%,
                         0.994 40.9%, 0.981 44.1%, 0.978, 0.983 50.9%, 1.001 61.3%, 1.004 68.5%, 1); /* ~11 % overshoot */
--pl-motion-stage: 1200ms;   /* background drift per boot stage; 0ms under reduced motion */
```

Spring easings are never used on the progress bar: an overshoot would show more progress than P, which BOOT-02 forbids.

## Intended animations

All are CSS `transition`s on `transform` / `opacity` (bar: `width`). "Reduced motion" means `prefers-reduced-motion: reduce` or `data-motion="reduce"`; every duration token is then 0 ms.

| # | Element | Trigger | Properties (from → to) | Duration | Easing | Reduced-motion fallback |
|---|---|---|---|---|---|---|
| 1 | Logo group | First render (`@starting-style`) | `transform: scale(.96) → scale(1)`; orbit group `opacity: .7 → 1` (logo is visible from frame 1, BOOT-01) | 520 ms | `--pl-spring-soft` | Rendered at final state, no transition |
| 2 | Nucleus bloom (radial glow layer behind the nucleus) | First render (`@starting-style`) | `opacity: 0 → .85`, `transform: scale(.6) → scale(1)` | 640 ms, delay 80 ms | `--pl-ease-out` | Final state, glow shown statically |
| 3 | Wordmark, version line, bar, step lines (staggered) | First render (`@starting-style`) | `transform: translateY(6px) → none`; `opacity: .001 → 1` for the version, bar and step lines only (the wordmark keeps opacity 1 so BOOT-01's first paint holds) | 360 ms, `transition-delay` 60 / 100 / 140 / 180 ms | `--pl-spring-soft` | No movement, no delay; all at final state |
| 4 | Hint chips | First render (`@starting-style`) | `transform: translateY(8px) → none`, `opacity: 0 → 1` | 320 ms, delay 240 ms | `--pl-ease-out` | Shown immediately |
| 5 | Orbit rings (3 `<g>` elements) | Each real boot event (asset chunk received, klog line, service state change) increments `--tick` on the logo | `transform: rotate(calc(var(--tick) * 9deg))` on orbit A, `* -6deg` on orbit B, `* 4deg` on orbit C (parallax); the electron rides orbit A | 560 ms | `--pl-spring-soft` | No rotation (transition none, `--tick` ignored) |
| 6 | Nucleus flash | A service reaches `done` (`svc.done`) | `.flash` on: nucleus `transform: scale(1) → scale(1.12)`, bloom `opacity: .85 → 1`; `transitionend` removes `.flash` and it settles back | 140 ms in (`--pl-ease-out`), 420 ms out (`--pl-ease`) | as stated | None; the count line still updates |
| 7 | Progress fill | Each progress event (`apply(event)` in `progress.ts`) sets the width to the new P | `width: <previous P> → <new P>`; never past the reported value | `--pl-motion-fast` (120 ms) | `--pl-ease` (no overshoot) | `transition: none`; width jumps to P (BOOT-13 test `with reduced motion the bar has a 0 s transition`) |
| 8 | Luminous sweep (a 48 px white gradient sheen clipped inside the fill, anchored to its leading edge) | Same progress event: `.sweep` toggled on | `transform: translateX(-48px) → translateX(0)`, `opacity: 0 → .9`; on `transitionend` `.sweep` is removed and opacity returns to .35 | 260 ms in, 480 ms out | `--pl-ease-out` in, `--pl-ease` out | Sheen hidden (opacity 0); the fill's static gradient stays |
| 9 | Fill glow (box-shadow layer as a separate pseudo-element) | Progress event | `opacity: .5 → .8`, back on `transitionend` | 200 ms / 400 ms | `--pl-ease` | Static at .6 |
| 10 | Step line (line 5) | Label changes (`ctx.label`) | Outgoing span `translateY(0) → translateY(-4px)`, `opacity 1 → 0`; incoming span `translateY(4px) → 0`, `opacity 0 → 1`. If the previous swap was under 120 ms ago (compared with `performance.now()`, no timer), text is replaced without a transition | 120 ms out, 200 ms in | `--pl-ease-in` out, `--pl-spring-soft` in | Text replaced in place |
| 11 | Count line numeral (`7` → `8`) | `svc.done` for a member of A | Digit roll: old `translateY(0) → translateY(-6px)`, `opacity → 0`; new from `translateY(6px)` | 200 ms | `--pl-spring-soft` | Text replaced |
| 12 | Background blobs (3 absolutely positioned layers, pre-blurred as SVG radial gradients so no `filter` animates) | Boot stage changes (6 stages: POST, bootloader, kernel init, service start, login, session restore) | Each blob `transform: translate(x, y) scale(s)` to that stage's preset; `opacity` of the cyan blob rises .08 → .16 by stage 4 | `--pl-motion-stage` (1200 ms) | `--pl-spring-soft` | Blobs static at the stage-1 preset |
| 13 | Hint chip keycap | `keydown` of Esc or V (and `pointerdown`) | Keycap `transform: translateY(0) → translateY(1px) scale(.94)`; chip fill `opacity` +.06; released on `keyup` / `pointerup` | 80 ms press, 160 ms release | `--pl-ease-out` / `--pl-spring` | Colour change only (opacity step, 0 ms) |
| 14 | Esc chip becomes disabled | Stage-2 profile decision posted | Chip `opacity: 1 → .4` | 200 ms | `--pl-ease` | Instant |
| 15 | V chip, verbose on | V toggles verbose | Chip border `opacity` 0 → 1 on an accent pseudo-border; label crossfades `Verbose log` ↔ `Hide log` | 160 ms | `--pl-ease` | Instant |
| 16 | Column, verbose log shown | V toggles verbose | Column `transform: translateY(0) → translateY(-180px) scale(.86)`; the log panel (screen `boot-verbose-log`) rises `translateY(24px) → 0`, `opacity 0 → 1` | 320 ms | `--pl-spring-soft` | Crossfade only, 0 ms |
| 17 | Exit to the boot menu | Esc buffered and the stage-2 decision is "menu" | Column `opacity 1 → 0`, `transform: scale(1) → scale(.97)`; a pre-blurred copy of the wallpaper crossfades in (`opacity 0 → 1`), so `filter` never animates | 240 ms | `--pl-ease-in` | Instant swap |
| 18 | Exit to login / desktop | Login view mounted, or `desktop-interactive` | Column `opacity 1 → 0`, `transform: scale(1) → scale(1.04)` (zoom through); background `opacity 1 → 0` over the desktop wallpaper | 320 ms (`--pl-motion-slow`) | `--pl-ease-in` | Instant swap; P is already 1 so nothing is hidden |

Checks for the implementer:
- `grep -E "@keyframes|animation" wm/boot-ui` must stay empty (SVC-10); every effect above is a `transition`.
- Only elements 5–9, 10–11 and 12 react to boot events; none of them writes P. The sheen and glow read `aria-valuenow` changes; they never set them.
- `will-change: transform` only on the orbit groups and the blob layers, removed after `desktop-interactive`.

## Accessibility

- Landmarks: `<main aria-labelledby="boot-title">` wraps the column; the wordmark SVG is `role="img" aria-label="Plotinium"` and the visually hidden `<h1 id="boot-title">Plotinium is starting</h1>` names the page. The hint row is a `<footer>` (contentinfo) holding two `<button type="button">` chips with `aria-keyshortcuts="Escape"` and `aria-keyshortcuts="V"`.
- Decorative layers (blobs, orbit wallpaper, sheen, glow, logo orbits) are `aria-hidden="true"`; the logo itself is `role="img" aria-label="Plotinium logo"`.
- Progress bar: `role="progressbar"`, `aria-valuemin="0"`, `aria-valuemax="100"`, `aria-valuenow` as an integer (62), `aria-valuetext="Starting vfs, 7 of 9"`, `aria-describedby` pointing at line 5.
- A visually hidden `role="status" aria-live="polite"` region announces stage changes at most once per 750 ms (throttled by comparing timestamps, not by a timer).
- Contrast: line 5 at white 85 % and the muted lines at #8E8EA0 on #0B0D17 both pass WCAG AA; hint text sits on a glass chip with at least 6 % white fill.
- Keyboard: Esc and V work from the first line of the inlined script (keys buffered). The chips are also focusable, so pointer and switch users can open the menu.
- Forced colours: the bar track and fill switch to `CanvasText` / `Highlight`; the glow and sheen are hidden.

## Issues and open points

- **Logo conflict (needs a team decision, R3 + R1).** This run's brief asks for a "luminous atom: nucleus with 2–3 elliptical orbits". The binding identity spec says the opposite: [identity-and-branding.md §3.6](../../../../specs/00-product/identity-and-branding.md) defines the mark as *an open ring with a solid point at 1 o'clock*, and says it "deliberately avoids the three-ellipse atom icon". It also forbids hairlines under 20 units, gradients and filters in the logo SVG. Both reference renders (and every sibling screen in this run) use the atom so the set stays consistent. Before the P2 gate, either update §3.6 to adopt the atom or swap in `docs/identity/logo.svg`. The splash's orbit-tick animation (#5) works with either mark: with the ring mark, rotate the plotted point around the ring instead.
- **Service count.** The brief said `Service start · 7 of 13`. The spec's label is `done/total over A`, where A is the 9 services that `desktop` depends on (boot spec §5.5; ui-design-system §3.8.1 row 6). The prompt and render therefore use `7 of 9`.
- **Bar width.** The brief says 280 px, but the token `--pl-boot-bar-w` is 320 px (ui-design-system §3.6). The render uses 280 px as briefed. Pick one before P2; 320 px reads better at 1440 px.
- **"Slow drifting blobs" and "sweep" vs SVC-10.** A continuous drift or a looping shimmer would need `@keyframes`, which CI bans in the boot path, and it would also break DSN-07 (fake activity). Both are redesigned as event-driven transitions (animations #8 and #12). If the team wants ambient idle motion, it has to be added to the allowlist with R3 + R5 approval, and it would weaken the "stalls look stalled" property.
- **Proposed tokens.** `--pl-spring-soft`, `--pl-spring` and `--pl-motion-stage` are new. R3 should add them to `wm/tokens/tokens.css`. Watch the `tokens.css` ≤ 4 KB gzip budget (DSN-10).
- **Comment text vs the CI grep.** `reference.html` names the banned tokens in a comment. The SVC-10 grep would flag that comment if the file were copied into `wm/boot-ui/**`, so drop it when porting.
- **First-paint rule.** BOOT-01 requires the logo, name and version at first paint. The entrance keeps the logo and wordmark fully opaque (scale and translate only), and fades only the version, bar and status lines, from 0.001. If the e2e first-paint test checks the version line's visibility, start it at opacity 1 as well.
