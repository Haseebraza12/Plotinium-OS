# Task Manager: Processes tab (dark)

| Field | Value |
|---|---|
| Stitch project | `12849137298552292712` |
| Stitch screen id | none: generation timed out, no screen returned (see `screen.json`) |
| Design system | Plotinium Glass (dark), `assets/10121591451242352758` |
| Model | GEMINI_3_8_FLASH, DESKTOP 1440x900 |
| Files | `reference.html`, `reference.png` (menu closed) and `reference-menu.png` (the End Process menu open, showing **Force kill (kill -9)**). These are a hand-built render of the prompt below, **not** a Stitch export. `screen.json` is the Stitch failure record. |
| Spec links | `specs/03-kernel/processes-and-scheduling.md` (states NEW, READY, RUNNING, BLOCKED, SUSPENDED, TERMINATED; MLFQ; executors), `specs/03-kernel/memory-and-paging.md` (faults, speculative pages), `specs/10-ai/predictive-prefetch.md` §3.8 (`prefetch:*` at PRI 39), `specs/02-boot/boot-and-services.md` (services as PCBs) |

## What this screen shows

The Task Manager's **Processes** tab while `burn` (pid 301, a CPU-bound student test program) saturates executor 4. The user has selected `burn` and can end it (SIGTERM, or kill -9 from the dropdown) or renice it. The other rows show the full process state machine at once:

- **RUNNING** (green): `burn` 301, `ai.indexer` 23, `sched` 2
- **READY** (blue): `editor` 131, `terminal` 101, `syncd` 4, `prefetch:terminal` 220
- **BLOCKED** (amber, with the reason): `ai.agent` 212 (awaiting llm), `vfs` 3 (io), `lockd` 5 (lease wait), `init` 1 (wait)
- **SUSPENDED** (grey, "paged out"): `files` 104, with 0 B resident and 38 MB swapped out

`ai.indexer` runs at priority 32 (niced +12) with a **background** badge. `prefetch:terminal` is a speculative pre-fetch job at idle priority 39 with a dashed violet **speculative** badge. The bottom panel shows a CPU sparkline for each of the 6 executors, and the frame-time p95 of 14.2 ms, inside the 16.7 ms budget.

## Stitch status and the reference render

**Stitch did not produce this screen.** `generate_screen_from_text` (DARK design system, GEMINI_3_8_FLASH, DESKTOP) returned "The operation timed out." at about 15:19Z, with no screen id or session id. Per the run rules it was **not retried**. `list_screens` returned `{}` on 20 polls between about 15:20Z and 15:47Z, and the project's `updateTime` stayed at 15:22Z. With no screen id, `get_screen` and `edit_screens` could not be used. The details are in `screen.json`.

`reference.html` is a hand-built 1440x900 render of the same prompt in the Plotinium Glass (dark) design system. `reference.png` and `reference-menu.png` (opened with `?menu=1`) are its Chromium screenshots. The HTML implements the window open, the staggered row entrance, the CPU-bar `scaleX` fill, the segmented thumb, the menu pop, the one-shot hot-executor glow, the histogram `scaleY` rise, and the dock magnification. All of them are zeroed under reduced motion.

Visual review of `reference.png`:

- Present: the segmented control `Processes | Memory | Scheduler | AI`; **End Process** with its chevron, **Renice…** and search with the `/` hint; the summary row; and the dense sortable table (CPU % is the active sort, descending) with every requested row.
- State pills: RUNNING green, READY blue, BLOCKED amber with the reason, SUSPENDED grey "paged out". Each pill has a glyph, so state is never colour-only.
- Badges and values: `ai.indexer` 23 shows priority 32, +12 niced, and the **background** badge; `prefetch:terminal` shows the dashed **speculative** badge at priority 39; `burn` 301 shows 98.0 % in a hot bar and is selected; `files` 104 shows 0 B resident (38 MB swapped).
- Bottom panel: a sparkline for each of the 6 executors, with exec-4 at 99 % highlighted; a frame-time p95 card reading **14.2 ms** with a green check, the caption "under 16.7 ms budget" and a histogram with the budget line; memory 1.9 / 4.0 GB; and page faults 627 /s. The status bar reads `Plotinium 0.3.0 · build a1f93c2`.
- No Apple marks. Numerals are tabular. Contrast holds: pill text is at or above 4.5:1 on its tint, and the selected row is white on accent at 85 % (about 5.3:1).

Deliberate differences from the prompt:

- A 12th row, `lockd` pid 5 (BLOCKED, lease wait), makes the table match "12 processes" in the summary. `lockd` is a real service in the boot spec.
- The logo follows the identity spec, not the atom (see the brand note below).

## Final prompt

Sent once to `generate_screen_from_text` (not retried):

```text
Screen title: "Plotinium Task Manager — Processes (Dark)". A full 1440x900 desktop of Plotinium, an AI-native web operating system, in its Liquid-Glass dark theme (inspired by the latest macOS, but with its own identity; NO Apple logo, NO Apple app names, NO SF Symbols). Accent colour violet #5E5CE6. Use lucide-style thin line icons only.

BACKGROUND: deep indigo-to-violet abstract wallpaper with soft blurred light blooms.

MENU BAR (top, 28px, translucent frosted glass): at far left the Plotinium logo — a small luminous abstract atom (bright violet nucleus with 2-3 thin elliptical orbit rings, no hazard symbol) — then bold app name "Task Manager", then menus "File  Edit  View  Process  Window  Help". Right side: sync-cloud with green dot, wifi, battery 82%, Control Centre icon, Search magnifier, clock "Thu 24 Sep  14:32".

MAIN WINDOW (centred, about 1240x740, dark translucent glass, 14px rounded corners, 1px inner hairline highlight, large soft shadow):
- TITLE BAR / UNIFIED TOOLBAR: traffic-light circles at left (red, amber, green). Title "Task Manager". Centred segmented control with four segments "Processes | Memory | Scheduler | AI" — "Processes" is selected (raised glass pill with violet tint). On the right of the toolbar: a destructive button "End Process" (x-octagon icon) with a small chevron dropdown that shows the option "Force kill (kill -9)", a button "Renice…" (sliders icon), and a rounded search field with placeholder "Search processes".
- A thin summary row under the toolbar: "12 processes · 6 executors · load 1.84 · uptime 2h 14m".
- PROCESS TABLE (dense, 28px rows, zebra-subtle, sortable column headers with a small sort chevron; "CPU %" is the active sort, descending, highlighted in violet). Columns: PID | Name | User | State | Priority / Nice | CPU % | Memory | Faults | Executor.
  State is shown as a coloured pill: RUNNING (green), READY (blue), BLOCKED (amber), SUSPENDED (grey, with small text "paged out").
  Rows (use exactly this data):
  301 | burn | student | RUNNING | 20 / 0 | 98.0 (red-tinted inline bar) | 12.4 MB | 3 | exec-4
  23 | ai.indexer  [background badge] | system | RUNNING | 32 / +12 niced | 21.6 | 184.0 MB | 412 | exec-5
  212 | ai.agent | student | BLOCKED (awaiting llm) | 20 / 0 | 4.1 | 96.2 MB | 58 | exec-2
  131 | editor | student | READY | 20 / 0 | 2.8 | 48.7 MB | 17 | exec-1
  2 | sched | system | RUNNING | 0 / -20 | 1.9 | 2.1 MB | 0 | exec-0
  101 | terminal | student | READY | 20 / 0 | 1.2 | 22.3 MB | 5 | exec-3
  3 | vfs | system | BLOCKED (io) | 10 / -10 | 0.9 | 31.5 MB | 9 | exec-0
  4 | syncd | system | READY | 10 / -5 | 0.6 | 14.8 MB | 2 | exec-1
  104 | files | student | SUSPENDED paged out | 20 / 0 | 0.0 | 0 B resident (38 MB swapped) | 121 | —
  220 | prefetch:terminal  [speculative badge, dashed violet outline] | student | READY | 39 / +19 | 0.3 | 6.0 MB | 0 | exec-5
  1 | init | root | BLOCKED (wait) | 0 / 0 | 0.0 | 1.2 MB | 0 | exec-0
  The row "burn 301" is selected (violet highlight). The background and speculative badges are small rounded glass tags; the "niced" note is a small grey tag.
- BOTTOM PANEL (glass inset with rounded corners, below the table): left part "CPU per executor" showing 6 small sparkline cards labelled exec-0 ... exec-5 with current percentages (exec-0 12%, exec-1 18%, exec-2 6%, exec-3 9%, exec-4 99% in red-orange, exec-5 41%), each a thin smooth line chart with gradient fill. Right part: a stat card "Frame time p95" with big number "14.2 ms", a green circle-check icon and caption "under 16.7 ms budget", plus a tiny histogram. Also small stats "Memory 1.9 / 4.0 GB" with a bar and "Page faults 627 /s".
- STATUS BAR (bottom of window): "Plotinium 0.3.0 · build a1f93c2" at left, "Updated every 1 s" with a pause icon at right.

DOCK (bottom centre, floating rounded glass shelf): own-design app icons for Files, Terminal, Editor, Task Manager (with a running dot), Search, Settings, and trash after a thin divider.

Overall: macOS-grade polish, crisp 12-13px UI text with tabular numerals, high-contrast readable text on glass, soft shadows, coherent OS look.
```

## UI elements and states

### Toolbar (unified title bar, 52 px)
| Element | States |
|---|---|
| Traffic lights | focused (coloured), unfocused (grey), hover reveals glyphs, pressed, focus-visible |
| Segmented control "Processes, Memory, Scheduler, AI" | selected (raised glass pill, violet tint), hover (6 % tint), pressed, focus-visible (roving tabindex, arrow keys), disabled "AI" segment on the AI-off build (hidden, not greyed) |
| **End Process** (danger, x-octagon icon) | **disabled** when nothing is selected or the selection is pid 1 or `sched` (tooltip "System process: cannot end"); default (red text on glass); hover (red 16 % tint); pressed; focus-visible; **confirming** (the button turns into a "End burn (301)?" confirm pill for 3 s); **pending** (spinner until the process reaches TERMINATED) |
| End Process chevron menu: "End (SIGTERM)", "Force kill (kill -9)", "Suspend (SIGSTOP)", "Continue (SIGCONT)" | menu open, item hover, item disabled (Continue is disabled unless the process is stopped); kill -9 is shown in danger red with the shortcut "Alt+Ctrl+Q" |
| **Renice…** (sliders icon) | disabled with no selection; opens a popover with a slider from -20 to +19, the current nice value, the resulting priority, and an "Apply" button; **error** in the popover: "EPERM: only root may lower nice below 0" |
| Search field ("Search processes") | empty (placeholder), focused (accent ring, `/` shortcut), typing (rows filter live, matches highlighted), no results ("No process matches "xyz"" with a clear button), clear x |

### Summary row
"12 processes · 6 executors · load 1.84 · uptime 2h 14m". Numbers update in place every second.

### Process table
| Element | States |
|---|---|
| Column headers PID, Name, User, State, Priority / Nice, CPU %, Memory, Faults, Executor | default; hover (tint plus the sort chevron preview); **active sort** (CPU % descending, violet label and chevron); focus-visible; resizable (drag the divider; the cursor changes) |
| Row | default; zebra (2 % tint); hover (6 % tint); **selected** (accent at 85 %, white text; `burn` 301); multi-select (Shift or Ctrl-click); focus-visible (inset ring); **terminated** (the row fades out, then collapses); **new** (the row fades in from the top of its sort position) |
| State pill | RUNNING green, READY blue, BLOCKED amber with the reason in a second word, SUSPENDED grey with "paged out". Each pill has a text label and a glyph (play, clock, pause-circle, moon) so that colour is never the only signal. |
| Priority / Nice cell | base priority / nice; niced processes show a grey "niced" tag; real-time (nice -20) shows a small up-arrow |
| CPU % cell | the number plus an inline bar; bars above 80 % turn red-orange; `burn` shows 98.0 |
| Memory cell | resident size; SUSPENDED shows "0 B resident (38 MB swapped)" |
| Faults cell | page faults per second; turns amber above 100 /s |
| Executor cell | exec-0 to exec-5, or "—" when not resident |
| Badges on the name | **background** (`ai.indexer`, glass tag), **speculative** (`prefetch:terminal`, dashed violet outline), **service** (a small gear before system services), **kernel** (sched, vfs) |
| Row context menu | End, Force kill, Renice…, Suspend, Show in Memory tab, Copy PID |
| **Loading** | first paint shows 8 skeleton rows |
| **Empty** | only after a search: "No process matches" |
| **Error** | "Kernel not responding · last update 6 s ago" banner above the table; the numbers freeze and dim to 60 % |

### Bottom panel
| Element | States |
|---|---|
| CPU per executor: 6 sparkline cards exec-0 to exec-5 | default; hover shows a crosshair and a value tooltip; **hot** (above 90 %, exec-4 at 99 % in red-orange); **idle** (under 5 %, a flat line at 38 % opacity); **lost** (executor crashed: grey card, "restarting…") |
| Frame time p95 card: "14.2 ms", green check, "under 16.7 ms budget", mini histogram | **ok** (green check, under 16.7 ms); **warn** (amber, 16.7 to 33 ms); **bad** (red, over 33 ms, with "long animation frames: n") |
| Memory "1.9 / 4.0 GB" bar; "Page faults 627 /s" | ok, warn (over 80 % of memory), and the fault count turns amber above 500 /s |

### Status bar
"Plotinium 0.3.0 · build a1f93c2" on the left; "Updated every 1 s" with a pause button on the right. **Paused** state: "Paused · click to resume", and the numbers stop animating.

## Intended animations

These rules come from `specs/05-wm/ui-design-system.md` §3.6 and DSN-05:

- Only `transform` and `opacity` animate.
- Durations use the motion tokens: `--pl-motion-fast` (120 ms), `--pl-motion-med` (200 ms) and `--pl-motion-slow` (320 ms).
- There is no free-running decorative loop (WCAG 2.2.2). The only continuous motion is live data, and the status-bar **pause** button stops it (2.2.2 "pause, stop, hide").
- Under `@media (prefers-reduced-motion: reduce)` or `:root[data-motion="reduce"]`, the tokens are 0 ms, so every change is instant (I-DS4). The fallback column says what the user sees instead.

**Proposed new easing tokens** (open item for R3, to add to §3.6):

- `--pl-ease-spring: cubic-bezier(0.34, 1.36, 0.64, 1)` for presses, pills and badges.
- `--pl-ease-spring-soft: linear(0, 0.157 7.1%, 0.54 17.2%, 0.828 27.3%, 0.94 35.4%, 1.006 45.5%, 1.02 55.6%, 1.006 70.7%, 1)` for panels, rows and windows.

| # | Element | Trigger | Properties | Duration | Easing | Reduced-motion fallback |
|---|---|---|---|---|---|---|
| 1 | Task Manager window | open | `scale(0.94 → 1)`, `opacity 0 → 1`, origin at the dock icon | `--pl-motion-med` | `--pl-ease-spring-soft` | appears at full size |
| 2 | Segmented control thumb | segment change | the glass pill slides with `translateX`; the width change runs on an inner layer with `scaleX`, and the label is counter-scaled | `--pl-motion-med` | `--pl-ease-spring` | the thumb jumps |
| 3 | Tab panels | segment change | outgoing `translateX(0 → -16px)`, `opacity 1 → 0`; incoming `translateX(16px → 0)`, `opacity 0 → 1` (mirrored for a leftward change) | `--pl-motion-med` | `--pl-ease-out` | the panels swap |
| 4 | Table rows | the 1 s re-sort | FLIP: each moved row `translateY(Δ → 0)`; **frozen** while the pointer is over the table or a row has keyboard focus, resumed 1 s after the pointer leaves | `--pl-motion-slow` | `--pl-ease-spring-soft` | rows reorder instantly; the re-sort interval stretches to 5 s |
| 5 | Row | process spawned | `translateY(-6px → 0)`, `opacity 0 → 1`; a violet "new" wash layer fades `opacity 0.3 → 0` once | `--pl-motion-med` (wash `--pl-motion-slow` × 3) | `--pl-ease-spring-soft` | the row appears with a static "new" dot for 3 s |
| 6 | Row | process TERMINATED | `translateX(0 → 24px)`, `opacity 1 → 0`, then the rows below FLIP up | `--pl-motion-med` + `--pl-motion-slow` | `--pl-ease-in`, then `--pl-ease-spring-soft` | the row is removed |
| 7 | State pill | state change (for example READY → RUNNING) | the old label `translateY(0 → -4px)`, `opacity 1 → 0`; the new label from `translateY(4px)`; the two coloured background layers crossfade | `--pl-motion-fast` | `--pl-ease-spring` | the pill swaps |
| 8 | SUSPENDED pill and row | paged out | the row settles `scale(1 → 0.99)` and `opacity 1 → 0.72` ("sinking"); the moon glyph fades in | `--pl-motion-slow` | `--pl-ease-spring-soft` | the row is dimmed |
| 9 | CPU % inline bar | value update | `scaleX(old → new)` from the left origin | `--pl-motion-slow` | `--pl-ease-out` | the bar jumps |
| 10 | Numbers (CPU %, memory, faults, load) | value update | a per-digit roll: the old digit `translateY(0 → -100%)`, the new one `100% → 0`; `tabular-nums` so the columns never jitter | `--pl-motion-med` | `--pl-ease-out` | the digits swap |
| 11 | Selection highlight | selection change | the accent pill moves between rows with `translateY` | `--pl-motion-fast` | `--pl-ease-spring-soft` | instant |
| 12 | End Process | first click | the button grows into a confirm pill "End burn (301)?": the background layer `scaleX(1 → 1.25)` and the labels crossfade; it reverts after 3 s | `--pl-motion-med` | `--pl-ease-spring` | the label swaps; there is still a 3 s confirm |
| 13 | End Process | kill -9 confirmed | the selected row shakes once `translateX(0, -4, 4, -2, 0 px)`, then row 6 runs | `--pl-motion-slow` | `--pl-ease-spring` | no shake; row 6 is instant |
| 14 | Chevron menu, Renice popover, context menu | open / close | open: `translateY(-4px → 0)`, `scale(0.98 → 1)`, `opacity 0 → 1` with the origin at the trigger; close: opacity only | `--pl-motion-fast` | `--pl-ease` / `--pl-ease-in` | shown and hidden instantly |
| 15 | Renice slider thumb | release | `translateX` snaps to the nearest integer nice value with a small overshoot | `--pl-motion-fast` | `--pl-ease-spring` | snaps instantly |
| 16 | Sort chevron | direction toggle | `rotate(0 → 180deg)` | `--pl-motion-med` | `--pl-ease-spring` | flips instantly |
| 17 | Executor sparklines | a new sample every 1 s (live data) | the path is drawn one sample wider than the card, and the SVG group `translateX(-step → 0)` scrolls it one step left per tick; the pause button stops it | 1000 ms per tick | `linear` | the path redraws in place once per second with no scroll |
| 18 | Hot executor card (exec-4) | crosses 90 % CPU | the glow layer pulses **once** `opacity 0 → 0.6 → 0.35` and then holds a static glow (no loop) | `--pl-motion-slow` × 2 | `--pl-ease` | a static glow at 0.35 |
| 19 | Frame-time check | p95 enters the ok band | `scale(0.6 → 1)`, `opacity 0 → 1` | `--pl-motion-med` | `--pl-ease-spring` | the check appears |
| 20 | Frame-time histogram bars | update | `scaleY(old → new)` from the bottom, staggered 20 ms per bar | `--pl-motion-slow` | `--pl-ease-spring-soft` | the bars jump |
| 21 | `speculative` badge | the prefetch job appears | a single sheen pass across the dashed outline, `translateX(-100% → 100%)` on a masked layer; then a static dashed outline | `--pl-motion-slow` × 2, once | `--pl-ease-out` | a static dashed outline |
| 22 | `background` badge tooltip | hover or focus | `translateY(4px → 0)`, `opacity 0 → 1` ("Idle-priority background job · yields to foreground input") | `--pl-motion-fast` | `--pl-ease-out` | the tooltip appears |
| 23 | Loading skeleton rows | first load | a sheen `translateX(-100% → 100%)`, at most 3 passes, then static | 1200 ms × 3 | `linear` | a static skeleton at 60 % opacity |
| 24 | Pause / resume | toggle | the pause and play icons crossfade with `scale(0.8 → 1)`; while paused, rows 4, 9, 10, 17 and 20 stop | `--pl-motion-fast` | `--pl-ease-spring` | the icon swaps |
| 25 | Dock icon | hover / launch | magnify `scale(1 → 1.45)` (neighbours at 1.2 and 1.08); on launch, one bounce `translateY(0 → -14px → 0)` | `--pl-motion-fast` / `--pl-motion-slow` | `--pl-ease-spring-soft` / `--pl-ease-spring` | no magnification or bounce; the running dot appears |

Performance budget: the table updates once per second in one `requestAnimationFrame` batch, and only rows whose values changed are touched. FLIP measurements happen in a single read phase, before any writes. The screen itself must keep the frame-time p95 it displays under 16.7 ms.

## Brand note (logo)

The Stitch design-system brief and this run's prompt describe the logo as a "luminous atom" with 2 or 3 elliptical orbits. `specs/00-product/identity-and-branding.md` §3.6 (PLT-ID-03 and PLT-ID-16, checked at every P2 review) says the mark is **a plotted point on an orbit**. It is an open ring of about 266° in `--pl-accent` (stroke 20 of 160 units) with a solid point (r 25) in its gap at 1 o'clock. It has no gradients, glow, filters or hairlines. The spec **explicitly avoids the three-ellipse atom icon**, and "glowing" is on the identity spec's banned-words list. `reference.html` therefore draws the spec's mark as an inline `<symbol id="pl-logo">` (path `M 134.6 67.4 A 56 56 0 1 1 63.6 26.4` plus a circle at 108, 31.5). The build must use `docs/identity/logo.svg` / `logo-mono.svg` once R3 finalises them. The Stitch design systems should be updated to match, so that later renders stop drawing an atom.

## Accessibility: landmarks and roles

- Landmarks, in DOM order: `header` (the menu bar), `main` (the window layer, which holds this window as a labelled dialog), and `nav aria-label="Dock"`. There is no `role="application"` wrapper.
- Window: `role="dialog" aria-modal="false"` labelled "Task Manager". Traffic lights are `<button>`s labelled "Close", "Minimise" and "Zoom".
- Toolbar: `role="toolbar" aria-label="Process actions"` with arrow-key navigation between End Process, Renice… and search.
- Segmented control: `role="tablist"` with four `role="tab"` items; each panel is `role="tabpanel"` with `aria-labelledby`.
- End Process: `<button>` plus a menu button (`aria-haspopup="menu"`); menu items are `role="menuitem"`. Destructive items carry "(destructive)" in their accessible description, and kill -9 always needs a confirm step, whether by mouse or keyboard.
- Renice popover: `role="dialog"` with a labelled `<input type="range" min="-20" max="19">`, whose `aria-valuetext` is "nice +12, priority 32".
- Search: `role="searchbox"` with `aria-controls` pointing at the grid; the result count is announced politely ("3 processes match").
- Process table: `role="grid"` with `aria-rowcount`, `role="columnheader"` with `aria-sort="descending"` on CPU %, and `role="row"` with `aria-selected`. Arrow keys move between cells; Delete maps to End Process with a confirmation.
- Live updates are **not** announced row by row. A single `role="status" aria-live="polite"` region announces only process exits and state changes of the selected process ("burn, pid 301, terminated").
- State pills: text plus a glyph (never colour alone); the accessible name includes the reason ("Blocked, awaiting llm").
- Charts: each sparkline card is `role="img"` with an `aria-label` ("exec-4, CPU 99 percent, rising"). The frame-time card is `role="group"` with a text equivalent, and a "View as table" toggle reveals the raw numbers.
- Status bar: `<footer role="status">`; the pause toggle is `aria-pressed`.
- Contrast: numbers are `#FFFFFF` at 92 % on a surface at 78 % opacity or more (≥ 7:1). The READY blue pill uses `#64D2FF` text on a 16 % tint (≥ 4.5:1), and the amber and grey pills are checked the same way.
