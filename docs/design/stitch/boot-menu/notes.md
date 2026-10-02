# Boot menu (Plotinium Boot Manager) — Stitch design notes

| Field | Value |
|---|---|
| Stitch project | `12849137298552292712` |
| Stitch screen id | `__SCREEN_ID__` (none returned in this run; see Generation status) |
| Design system | Plotinium Glass — Dark (`assets/10121591451242352758`) |
| Model | `GEMINI_3_8_FLASH`, device `DESKTOP`, 1440 × 900 |
| Files | `screen.json` (raw Stitch response) · `reference.html` + `reference.png` (hand-built fallback render) · `reference-safe-preselected.png` · `screen.html` / `screenshot.png` to be added when Stitch returns a screen |
| Screen spec | [ui-design-system.md §3.8.2](../../../../specs/05-wm/ui-design-system.md) · behaviour in [boot-and-services.md §3.7](../../../../specs/02-boot/boot-and-services.md) |
| Requirements | BOOT-05, BOOT-06, BOOT-13, SVC-05, SVC-06, SVC-07, DSN-14 |
| Owner | R3 with R5 · gate P3 (v0.3.0) |

## Generation status (read first)

**Stitch did not return a screen for this slug.** The single `generate_screen_from_text` call (2026-09-24 ≈15:22Z) failed with `The operation timed out.` and returned no screen or session id. It was not retried (run rule). `list_screens` returned `{}` on about 20 polls from 15:23Z to 15:48Z, so `get_screen`, the downloads and `edit_screens` were impossible. The raw response is in `screen.json`.

**Fallback, so the team is not blocked:** `reference.html` is a hand-built, fully interactive render of the prompt. It supports ↑/↓, Home/End, 1–4, Enter, Esc, pointer hover, press and double-click, a live 3 s countdown that the first key stops, and the exit transition. `reference.png` shows the default state (`?still`). `reference-safe-preselected.png` shows the variant after two failed boots (`?still&failed=2`). The review below was done on those PNGs.

**Visual review:** a 480 px dark glass panel with the hairline border, inner highlight and large shadow. The header has the atom mark, `Plotinium Boot Manager` and `0.3.0 · a1f93c2`. The four options have lucide line icons, and the selected row shows a violet wash, a 2 px left rule, a focus ring and a `▶` marker. The footer has keycaps and `auto-boot in 3 s` with a three-segment ring. The helper line sits under the panel. No Apple marks. Fixed during review: a duplicate element id (`n`, shared with an SVG gradient) broke the countdown; the ring segment gaps disappeared at 16 px (now butt caps and 20° gaps); the tabular-figure setting spaced out the hyphen in `auto-boot`; and `--` rendered as a ligature in `reboot --menu`.

When Stitch recovers, re-run the prompt below. Replace `__SCREEN_ID__` above, then save `screen.html` and `screenshot.png` next to the reference files.

## Final prompt

```text
Plotinium Boot Manager screen (screen title: "Boot Menu"). Full-screen desktop 1440x900. No menu bar, no dock, no windows.

Background: the Plotinium boot wallpaper (deep midnight #0B0D17 to dark violet #1A1440 gradient with large soft violet #5E5CE6 and indigo luminous blobs and a few faint thin orbit arcs), heavily blurred (40px) and dimmed by a 35% black scrim.

Centre: one dark Liquid-Glass panel, 480px wide, 14px corner radius, translucent dark fill rgba(24,24,36,0.72) with strong backdrop blur and saturation, 1px hairline border white at 12%, a subtle 1px inner top highlight, and a large soft diffuse shadow (0 30px 80px rgba(0,0,0,0.55)). Inside, 20px padding:

- Header row: a small 22px luminous atom logo (bright white-violet nucleus dot, 3 thin elliptical orbits in violet #5E5CE6 with a soft glow; not a radiation symbol, not an Apple logo), then the title "Plotinium Boot Manager" in Inter Semibold 17px white. At the right end of the header, muted 12px text "0.3.0 · a1f93c2". Under the header, a 1px hairline divider (white 8%).

- A keyboard listbox of 4 options stacked with 4px gaps. Each option row is 56px tall, 8px radius, with a 20px lucide-style line icon on the left (1.5px stroke), a title in Inter Medium 14px white and a description line under it in Inter 12px muted #9A9AB0:
  1. SELECTED and focused: icon "power"; title "Normal boot"; description "Start Plotinium and restore your session". The selected row has a violet #5E5CE6 fill at 22% opacity, a 2px solid violet #5E5CE6 left rule, a crisp 2px violet focus ring with 2px offset around the row, and a violet "▶" chevron marker on the right side of the row.
  2. icon "shield"; title "Safe mode"; description "No AI services · no autostart apps · default theme".
  3. icon "wrench"; title "Recovery"; description "File-system check · clear local cache · reset session".
  4. icon "terminal"; title "Verbose boot"; description "Timestamped kernel log".

- A 1px hairline divider, then a footer row in Inter 12px muted text. Left side: small keycaps "↑" "↓" then "select", a middle dot, keycap "Enter" then "boot", a middle dot, keycap "Esc" then "close". Right side: "auto-boot in 3 s" followed by a small 16px circular countdown ring (thin track white 15%, violet #5E5CE6 arc covering about two thirds of the circle).

Below the panel, 16px gap, centred very faint 11px text white 40%: "Hold Esc at start-up, or run reboot --menu, to open this menu".

Feel: macOS startup-options screen reimagined with Liquid Glass, calm and precise, high contrast text, visible keyboard focus. No Apple logo, no SF Symbols, no Apple app names, no mouse cursor.
```

## Read this before implementing any animation on this screen

The boot menu is part of the framework-free, inlined boot-ui (DSN-14), so the boot-path rules apply (boot spec §5.6, SVC-10):

- **No `@keyframes`, no CSS `animation`, no `setTimeout`/`setInterval`**, except the one allowlisted countdown timer in `wm/boot-ui/menu.ts` (`// boot-timer-allow: menu-countdown`). That module must not import `progress.ts`.
- Every animation below is therefore a **CSS transition** triggered by a key event, the countdown tick, or `transitionend`.
- Only `transform` and `opacity` animate. The frosted look is a static `backdrop-filter` plus a pre-blurred wallpaper layer that crossfades in; `filter`/`backdrop-filter` values never animate.

## Layout (1440 × 900)

- Background: the boot wallpaper (midnight #0B0D17 to violet #1A1440 with soft blobs and faint orbit arcs), shown through a pre-blurred copy and a 35 % black scrim.
- Centred panel, 480 px wide, radius 14 px, dark glass `rgba(24,24,36,.72)` with backdrop blur and saturation, 1 px hairline border white 12 %, 1 px inner top highlight, shadow `0 30px 80px rgba(0,0,0,.55)` (`--pl-shadow-dialog`). Padding 20–24 px.
- Header: 22 px atom mark, `Plotinium Boot Manager` (Inter Semibold 17 px, `--pl-text-lg`), right-aligned muted `0.3.0 · a1f93c2`; hairline divider.
- Listbox, 4 options, each with a lucide-style line icon, a title and a description line:
  1. `power` · `Normal boot` · `Start Plotinium and restore your session` (selected by default)
  2. `shield` · `Safe mode` · `No AI services · no autostart apps · default theme`
  3. `wrench` · `Recovery` · `File-system check · clear local cache · reset session`
  4. `terminal` · `Verbose boot` · `Timestamped kernel log`
- Footer: keycaps `↑` `↓` select · `Enter` boot · `Esc` close, and on the right `auto-boot in 3 s` with a 16 px countdown ring.
- Under the panel: faint helper line `Hold Esc at start-up, or run reboot --menu, to open this menu`.

## Elements and states

| Element | Default | Hover (pointer) | Focus-visible | Active / pressed | Disabled | Empty | Loading | Error / warning |
|---|---|---|---|---|---|---|---|---|
| Panel (`role="dialog"`) | Glass panel, shadow-dialog | — | Focus lands on the listbox, not the panel | — | — | — | — | Loader fallback: if the menu logic throws, boot-ui boots Safe with a `WARN` line (boot spec §3.2 stage 2); the menu never shows a broken state |
| Header logo + title | Static | — | — | — | — | — | — | — |
| Build tag `0.3.0 · a1f93c2` | Muted | — | — | — | — | — | — | Dev build: `0.3.0-dev.14 · a1f93c2` with `dev build` in `--pl-warning` |
| Warning line (only after 2 failed boots) | Hidden | — | — | — | — | — | — | Visible above the list: warning icon + `The last 2 boots failed. Safe mode is selected.` in `--pl-warning` on a 10 % warning tint; Safe mode pre-selected |
| Option row (`role="option"`) | Transparent, title white 92 %, description 60 % | Fill white 6 % (pointer only; hover never moves the selection) | Visible 3 px accent ring (the listbox has focus and `aria-activedescendant` points at the row) | Row `scale(.985)` while Enter or pointer is down | Not used in the normal menu. When no network: Normal and Safe still work offline, so no row is disabled; if a future mode is unavailable it shows 40 % opacity + `aria-disabled="true"` and is skipped by ↑/↓ | — | After Enter: the chosen row keeps the highlight, the others fade to 40 %, the footer reads `Starting <mode>…` until the splash takes over | — |
| Selected row (`aria-selected="true"`) | Accent #5E5CE6 at ~22 % fill, 2 px accent left rule, `▶` chevron in accent at the right | Same | Accent ring 2 px offset | Same as above | — | — | — | — |
| Row icon | Line icon, 20 px, stroke 1.5, 60 % | 80 % | Accent when selected | — | 40 % | — | — | — |
| Footer keycaps | Muted keycaps | — | — | The matching keycap shows pressed while its key is held (`keydown`/`keyup`) | — | — | — | — |
| Countdown label + ring | `auto-boot in 3 s`, ring full (3 segments) | — | — | — | Stopped by the first key press or pointer move: the label and ring fade out and the footer shows only the key hints | — | Ticks 3 → 2 → 1, one segment dims per second | — |
| Helper line under panel | White 40 %, 11 px | — | — | — | — | — | — | — |

Profiles that the menu starts (boot spec §3.7): Normal (volume manifests), Safe (built-in manifests, `safeMode:true` services only, no `ai.*`, frames only, default theme), Recovery (`kernel, sched, storage, wm, vfs` read-only, then the recovery console), Verbose (log view from the start; combines with the others).

Keys: ↑/↓ move (wrap at the ends), Home/End jump, Enter boots the selected entry, Esc closes the menu and boots Normal, 1–4 select and boot directly (proposed; see Issues). Any key stops the countdown.

## Motion tokens used

`--pl-motion-fast` 120 ms, `--pl-motion-med` 200 ms, `--pl-motion-slow` 320 ms, `--pl-ease`, `--pl-ease-in`, `--pl-ease-out` (ui-design-system §3.6), plus the proposed `--pl-spring-soft` and `--pl-spring` `linear()` curves defined in [../boot-splash/notes.md](../boot-splash/notes.md#motion-tokens-used). All become 0 ms under reduced motion.

## Intended animations

| # | Element | Trigger | Properties (from → to) | Duration | Easing | Reduced-motion fallback |
|---|---|---|---|---|---|---|
| 1 | Blurred wallpaper layer + scrim | Menu opens (splash exit #17 hands over) | Pre-blurred wallpaper `opacity 0 → 1`; scrim `opacity 0 → .35` | 240 ms | `--pl-ease-out` | Shown instantly |
| 2 | Panel | Menu opens | `opacity 0 → 1`, `transform: translateY(10px) scale(.96) → none` | 420 ms | `--pl-spring-soft` | Shown instantly at final position |
| 3 | Header, rows, footer (stagger) | Menu opens | Each `opacity 0 → 1`, `transform: translateY(4px) → none`; `transition-delay` 40 ms × index (header 0, rows 1–4, footer 5) | 240 ms | `--pl-ease-out` | No stagger, no movement |
| 4 | Selection highlight (one absolutely positioned glass pill behind the rows, not one per row) | ↑/↓, Home/End, number key, or pointer click | `transform: translateY(<row offset>)` to the new row | 260 ms | `--pl-spring` (small overshoot reads as a physical slide) | Jumps (0 ms) |
| 5 | Left accent rule | Same | Travels with the highlight (child of it) | 260 ms | `--pl-spring` | Jumps |
| 6 | `▶` chevron | Selection enters a row | Incoming row chevron `opacity 0 → 1`, `transform: translateX(-4px) → none`; outgoing row chevron fades out | 180 ms in, 120 ms out | `--pl-ease-out` / `--pl-ease-in` | Instant show/hide |
| 7 | Row icon | Selection enters a row | Icon `transform: scale(1) → scale(1.08)` and `opacity .6 → 1` (colour switches to accent via a stacked accent copy whose opacity rises) | 200 ms | `--pl-spring-soft` | Accent copy shown instantly, no scale |
| 8 | Row hover wash | `pointerenter` / `pointerleave` | Hover layer `opacity 0 → 1` | 120 ms | `--pl-ease` | Instant |
| 9 | Row press | Enter `keydown` or `pointerdown` | Selected row `transform: scale(1) → scale(.985)`; released on `keyup` / `pointerup` | 80 ms press, 220 ms release | `--pl-ease-out` / `--pl-spring` | No scale; highlight opacity steps to 1 |
| 10 | Footer keycap | `keydown` / `keyup` of ↑ ↓ Enter Esc | Keycap `transform: translateY(1px) scale(.92)`, fill `opacity +.1` | 80 ms / 160 ms | `--pl-ease-out` / `--pl-spring` | Opacity step only |
| 11 | Countdown ring (3 arc segments of 118°, 2° gaps) | Each 1 s tick of the allowlisted countdown | The segment for the elapsed second `opacity 1 → .15` | 240 ms | `--pl-ease` | Instant opacity step (the ring still counts down; it carries information) |
| 12 | Countdown numeral (`3` → `2` → `1`) | Same tick | Old digit `translateY(0) → translateY(-6px)`, `opacity → 0`; new digit from `translateY(6px)`, `opacity 0 → 1` | 200 ms | `--pl-spring-soft` | Text replaced |
| 13 | Countdown stop | First key press or pointer move | Label and ring `opacity 1 → 0`, `transform: translateX(4px)`; the key-hint group `translateX` recentres | 200 ms | `--pl-ease-in` | Removed instantly |
| 14 | Warning line (after 2 failed boots) | Menu opens with Safe pre-selected | `opacity 0 → 1`, `transform: translateY(-4px) → none`, before the rows' stagger | 240 ms | `--pl-ease-out` | Shown instantly |
| 15 | Non-chosen rows after Enter | Enter pressed | `opacity 1 → .4` | 160 ms | `--pl-ease` | Instant |
| 16 | Panel exit | Enter (any mode) or Esc (boots Normal) | Panel `opacity 1 → 0`, `transform: scale(1) → scale(.98)`; blurred wallpaper `opacity 1 → 0`; the splash column re-enters with its own entrance and now shows the mode (`Safe mode` badge, verbose log, or the recovery target) | 200 ms | `--pl-ease-in` | Instant swap |

Checks for the implementer:
- The countdown is the only timer; it lives in `menu.ts`, runs only while the menu is open, and stops on the first key. The transitions above are driven by its tick callback; none of them adds another timer.
- `transition-delay` for the stagger is CSS, not a timer; it is fine under SVC-10.
- The highlight pill is one element, so there is no layout thrash while moving the selection.

## Accessibility

- Landmark and roles: the panel is `role="dialog" aria-modal="true" aria-labelledby="bootmgr-title"` inside `<main>`; the header text is `<h1 id="bootmgr-title">Plotinium Boot Manager</h1>`.
- The option list is `role="listbox" aria-labelledby="bootmgr-title"` with `aria-activedescendant` set to the selected option. Focus lands on the listbox when the menu opens (roving via `aria-activedescendant`, not by moving DOM focus).
- Each row is `role="option" aria-selected="true|false"`, the title is the accessible name and the description line is linked with `aria-describedby`. Icons and the `▶` marker are `aria-hidden="true"`.
- Countdown: announced once through a polite live region as `auto-boot in 3 seconds` (not every second); when stopped, `auto-boot stopped` is announced once. The ring is `aria-hidden`; the label carries the meaning.
- Warning line: `role="status"` so it is read when the menu opens after 2 failed boots.
- Footer key hints: `aria-hidden="true"` for the keycaps, with a visually hidden sentence `Use the arrow keys to choose, Enter to boot, Escape to close.` referenced by `aria-describedby` on the listbox.
- The whole menu works from the keyboard alone (BOOT-13); pointer clicks select and double-click or click-then-Enter boots.
- Contrast: titles at white 92 % and descriptions at #9A9AB0 on a ≥ 72 % dark tint pass AA; the selected row's text stays white on the 22 % accent tint (check it at ≥ 4.5:1 in the implementation).
- Forced colours: the highlight pill becomes `Highlight` with `HighlightText`; the focus ring becomes a 2 px `CanvasText` outline.

## Issues and open points

- **Logo conflict (needs a team decision, R3 + R1).** This run's brief asks for a "luminous atom: nucleus with 2–3 elliptical orbits". The binding identity spec says the opposite: [identity-and-branding.md §3.6](../../../../specs/00-product/identity-and-branding.md) defines the mark as *an open ring with a solid point at 1 o'clock*, and says it "deliberately avoids the three-ellipse atom icon". It also forbids hairlines under 20 units, gradients and filters in the logo SVG. Both reference renders (and every sibling screen in this run) use the atom so the set stays consistent. Before the P2 gate, either update §3.6 to adopt the atom or swap in `docs/identity/logo.svg`. The splash's orbit-tick animation (#5) works with either mark: with the ring mark, rotate the plotted point around the ring instead.
- **Countdown length.** The brief and ui-design-system §3.8.2 say `auto-boot in 3 s`. The boot spec §3.7 says **5 s**, chosen for screen-reader users (WCAG 2.2.1), and lists it as open question W5 ("spec figure shows 3 s"). The render uses 3 s. The three-segment ring generalises to five segments if W5 settles on 5 s.
- **Ring vs the transform/opacity rule.** A smoothly draining ring needs `stroke-dashoffset`, which is neither transform nor opacity, and a continuous drain would need `@keyframes`. The design therefore uses one segment per second that fades (opacity only), driven by the allowlisted countdown's tick. The brief's "two-thirds arc" is the state at `2 s`.
- **Recovery wording.** The boot spec §3.7 uses `Recovery: fsck · clear cache · reset session`; ui-design-system §3.8.2 uses `file-system check · clear local cache · reset session`. The render follows the UI spec's wording, which is also closer to the capstone spec §6.5 text. Align the two specs.
- **Normal-boot description.** Neither spec gives a description line for Normal boot. `Start Plotinium and restore your session` is new copy; confirm it with R3.
- **Direct number keys (1–4) and double-click** are proposed additions, not in §3.7. They are cheap and keyboard-friendly, but R5's keyboard e2e must cover them if adopted.
- **Esc semantics.** Esc closes the menu *and boots Normal* (spec). The footer label says `close`. Consider `Esc  normal boot` so the result is not a surprise.
- **Countdown stop on pointer move** (proposed in the states table) is not in the spec, which says key press only. It is not implemented in `reference.html`, which stops on key press and pointer down only.
- **Comment text vs the CI grep.** As with the splash, remove the header comment that names the banned tokens when porting to `wm/boot-ui/menu.ts`.
