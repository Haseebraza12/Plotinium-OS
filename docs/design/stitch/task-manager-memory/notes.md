# Task Manager: Memory tab (dark)

- **Stitch project:** 12849137298552292712
- **Stitch screen id:** none. `generate_screen_from_text` returned "The operation timed out." at about 15:19Z with no screen id, and was not retried. `list_screens` returned `{}` on more than 20 polls from 15:20Z to 15:47Z; `get_project` never changed after 15:22:02Z, and `list_projects` showed 0 screens in this project. Every sibling agent in this run saw the same. With no screen id, `get_screen` and `edit_screens` could not be used. **To do:** re-run the prompt below when Stitch recovers, then save `screen.html` and `screenshot.png` next to the reference.
- **Design system:** `assets/10121591451242352758` (Plotinium Glass, Dark)
- **Model:** GEMINI_3_8_FLASH, device DESKTOP (1440x900)
- **Files:** `reference.html` and `reference.png` are a **hand-built reference render, NOT a Stitch export** (Stitch produced no screen; see below). `screen.json` records the failed request. `screen.html` and `screenshot.png` do not exist yet.
- **Spec links:** `specs/03-kernel/memory-and-paging.md` (MEM-01 … MEM-07, KMM-12, KMM-13), `specs/10-ai/predictive-prefetch.md` (PRE-06 Task Manager view)

## Final prompt

Sent once to `generate_screen_from_text` (it timed out and was not retried):

```text
Plotinium OS desktop (1440x900), dark Liquid Glass style inspired by the latest macOS. Show the full desktop: a deep violet-to-indigo abstract wallpaper, a thin translucent top menu bar (left: a small luminous atom logo glyph in violet #5E5CE6 — a bright nucleus with 2 thin elliptical orbits, NOT an Apple logo — then bold 'Task Manager', 'File', 'Edit', 'View', 'Process', 'Window', 'Help'; right: wifi, battery, Control Centre toggle icon, Search magnifier icon, 'Thu 24 Sep 14:32'), and a floating frosted-glass dock at the bottom with rounded-square Plotinium app icons (Files, Terminal, Editor, Task Manager (active dot), Settings, Search) using lucide-style line glyphs.

Centre: a large Task Manager window (about 1180x740) with dark translucent glass, 12px corner radius, soft large shadow, red/yellow/green traffic-light window controls top-left. Unified toolbar: window title 'Task Manager', a segmented control with tabs 'Processes', 'Performance', 'Memory' (selected, violet), 'Scheduler', 'Predictions', a search field 'Filter processes' and an 'End Process' button (disabled).

MEMORY TAB CONTENT:
1) Header row: 'Memory budget' label, large number '231 / 256 MB accounted', a small chip '90% · above high watermark 85%', and a 'Reclaim now' secondary button.
2) A tall rounded horizontal STACKED BAR spanning the width showing the budget, segmented with legend below: Kernel 18 MB (slate), Apps 86 MB (violet #5E5CE6), ai.embed model 100 MiB (teal, labelled 'evictable'), Vector index 15 MB (cyan), Speculative 12 MB (diagonal hatched pattern, amber), Free 25 MB (empty track). Thin vertical tick markers at 75% 'low' and 85% 'high' watermark.
3) A row of 5 glass stat cards with small sparklines: 'Page faults 1,284' (+12/s), 'Hit ratio 97.2%', 'Paged out 312 MB', 'Paged in 88 MB', 'Swap: OPFS 1.2 GB · Cloud 340 MB' (two mini bars).
4) Left (about 70% width): a per-process table with a sticky header, columns: PID, Process, User, Resident, Swapped (local / remote), Faults, Pin (toggle switch). Rows: 1 init root 2.1 MB 0 / 0 12 pinned(on); 7 sched root 1.4 MB 0 / 0 3 (on); 9 vfs root 6.8 MB 0.4 / 0 41; 12 syncd root 3.2 MB 1.1 / 0.6 18; 23 ai.indexer student (priority 32) 14.6 MB 22 / 8 201; 24 ai.embed root 100 MiB 0 / 0 9 (evictable tag); 118 terminal student 8.4 MB 0 / 0 4; 121 files student 11.9 MB 2.4 / 0 57; 134 editor student 24.3 MB 6.8 / 1.2 96; 140 prefetch:editor student 12.0 MB speculative 0; 151 memhog alice 48.0 MB 96 / 40 612 (row highlighted, soft-limit warning '!'); 163 notes bob 5.5 MB 3.1 / 2.0 22. Resident column shows tiny inline bars. One row hovered with a subtle glass highlight.
5) Right (about 30% width): a small glass 'Predictions' panel: title 'Predictions', tag chip 'Markov-2 · local only', 'Next app' with three rows and horizontal confidence bars: 'Terminal 62%', 'Files 21%', 'Editor 9%'; reason text 'after Files → Editor (markov-2, 14 obs)'; 'θ = 0.40 · 612 launches'; 'Speculative: 12 MB · expires 00:48'.
Footer status bar inside window: 'Thrashing guard: off · 4.2 faults/s · updated 1 s ago' and 'Plotinium 0.3.0 · build a1f93c2'.

Typography: Inter, clean hierarchy, readable contrast on glass. Lucide-style line icons only. No Apple logo, no Apple app names, no SF Symbols, no hazard or radiation symbols.
```

## Review against the prompt

Reviewed `reference.png` (1440x900, headless Chrome, captured after the intro animations settle):

- **Present:** menu bar with the atom glyph and the Task Manager menus; a floating dock (Files, Terminal, Editor, Task Manager, Settings, Search, Trash) with running dots; a 1180x760 glass window with traffic lights; tabs with Memory selected; `Filter processes`; `End Process` (disabled); `231 / 256 MB accounted` with the chip `90% · above high watermark 85%` and `Reclaim now`; the stacked bar (Kernel 18 + Apps 86 + ai.embed 100 MiB + Vector index 15 + Speculative 12, hatched = 231, Free 25) with LOW 75% and HIGH 85% ticks and a legend; five stat cards with sparklines (Page faults 1,284 +12/s, Hit ratio 97.2%, Paged out 312 MB, Paged in 88 MB, Swap OPFS 1.2 GB · Cloud 340 MB); the process table (PID, Process, User, Resident with inline bars, Swapped local / remote, Faults, Pin) with all 12 requested rows; the Predictions panel (`Markov-2 · local only`, Terminal 62%, Files 21%, Editor 9% with bars, the reason, θ 0.40, 612 launches, Speculative 12 MB · expires 00:48); the status bar with `Plotinium 0.3.0 · build a1f93c2`.
- **Deliberate additions:** the table is sorted by Resident, descending, with `aria-sort`; `editor` pid 134 is shown selected and `files` pid 121 hovered; memhog pid 151 (alice) has a warning tint and a `!` soft-limit badge; notes pid 163 (bob) is SUSPENDED and dimmed; ai.indexer shows `pri 32`; init and sched show their pins as on and locked; there is a table footer "12 of 31 processes"; the ai.embed segment shows its hover tooltip; a `FIRST TO EVICT` tag marks the speculative legend entry; the Editor prediction has a PRE-FETCHED tag, matching `prefetch:editor` pid 140.
- **Branding:** no Apple logo, Apple app names, SF Symbols or SF Pro; the icons are lucide-style line glyphs; the logo is the violet atom.
- **Contrast:** primary labels are 92% white and secondary labels 62% white on dark glass at about 80% opacity. The speculative segment is hatched, so it is not identified by colour alone.
- **Open points:** (1) Following the prompt, the budget reads "MB" while ai.embed reads "MiB". The spec (`memory-and-paging.md`) implements the 256 MB budget as 256 MiB, so the build should pick one unit label and use it everywhere. (2) The Reclaim now button is enabled at 90%, but the hint for the ≤ LOW_WM disabled state is only documented, not drawn.

## UI elements and states

Figures shown in the mock are the P3 gate scenario: `memhog --total 512M --procs 8` by alice, with the budget at 90% of 256 MiB.

| # | Element | Default | Hover | Focus (keyboard) | Active / pressed | Disabled | Empty | Loading | Error |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Menu bar (atom glyph, `Task Manager`, File, Edit, View, Process, Window, Help; status items; clock) | 28px glass strip | Menu title gets a 6px-radius glass pill | 3px accent ring at 55% on the pill | Menu opens; the title pill stays filled | Items that do not apply (e.g. Process ▸ Resume on a running pid) at 38% label | n/a | n/a | n/a |
| 2 | Window chrome (traffic lights) | Coloured 12px circles | All three show glyphs (×, −, +) | Ring around the focused light | Circle darkens by 12% | Window not focused: all three grey #4A4A4E | n/a | n/a | n/a |
| 3 | Tab segmented control (Processes, Performance, **Memory**, Scheduler, Predictions) | Memory selected: violet thumb, white label | Unselected tab: label to 92% and a faint 4% fill | Ring on the segment; ←/→ move between tabs (roving tabindex) | Thumb slides to the pressed tab | n/a | n/a | n/a | n/a |
| 4 | `Filter processes` search field | Placeholder at 38% | Border goes to 16% white | Accent ring, placeholder stays until typing; `Esc` clears | n/a | n/a | No match: the table shows "No processes match 'xyz'" with a Clear filter link | n/a | n/a |
| 5 | `End Process` button | Disabled until a row is selected | Fill to 14% white | Ring | Scale 0.97 | 38% label, no hover (pinned and kernel pids such as init pid 1 keep it disabled, with the tooltip "Kernel process cannot be ended") | n/a | Spinner replaces the label while `kill` is pending | Toast "Could not end pid 151: EPERM" |
| 6 | Budget headline `231 / 256 MB accounted` + chip `90% · above high watermark 85%` | Number in large title, chip warning orange | Chip tooltip explains HIGH_WM / LOW_WM | Chip focusable, tooltip on focus | n/a | n/a | n/a | Number shows `— / 256 MB` with a shimmer on the bar | Chip turns danger red "Over budget for 1.2 s" when `maxOverBudgetMs` > 0 |
| 7 | `Reclaim now` button | Secondary glass button | Fill brightens | Ring | Scale 0.97, then label "Reclaiming… 18 MB" | While a reclaim pass is running, or when usage ≤ LOW_WM 75% | n/a | Inline progress in the label | Toast "Reclaim stopped: swap quota full" |
| 8 | Stacked budget bar (Kernel, Apps, ai.embed 100 MiB evictable, Vector index, Speculative hatched, Free) + LOW 75% / HIGH 85% ticks | Segments in legend colours; speculative uses a 45° hatch so it is not identified by colour alone | Hovered segment lifts 2px; tooltip with the exact MiB and "evictable" / "backed" / "speculative, expires 00:48" | Each segment is a focusable `listitem`; ←/→ move between segments; tooltip on focus | Clicking a segment filters the table to that category | n/a | Before the first sample: an empty track | Shimmer sweep across the track | Accounting worker unreachable: bar greys out, banner "Memory figures are stale (last 14:31:52)" |
| 9 | Stat cards: Page faults 1,284 (+12/s), Hit ratio 97.2%, Paged out 312 MB, Paged in 88 MB, Swap OPFS 1.2 GB · Cloud 340 MB | Glass cards with sparklines | Card lifts 1px and the sparkline shows a crosshair and value | Card focusable; its value is read out | n/a | Cloud swap offline: the Cloud line shows "Cloud · offline" in tertiary and a cloud-off icon | Zero values show "0" and a flat sparkline, never blank | Skeleton blocks | Hit ratio below 90% turns warning; faults > 20/s for 5 s show "Thrashing guard on" |
| 10 | Per-process table (PID, Process, User, Resident with inline bar, Swapped local / remote, Faults, Pin) | 26px rows, zebra at 2% | Row fill 6% white | Row focus ring; ↑/↓ move, Space selects, Enter opens the process inspector | Selected row in accent at 85% with white text | Rows of SUSPENDED processes at 60% label with a "suspended" tag | "No user processes are running" | Skeleton rows | Row with a soft-limit breach shows `!` and a warning tint (pid 151 memhog, alice) |
| 11 | Sortable column headers | Label at 60% | Label at 92% and a sort chevron appears | Ring | Toggles ascending / descending; `aria-sort` updates | n/a | n/a | n/a | n/a |
| 12 | Pin toggle per row | Off: grey track; On: accent track | Track brightens | Ring on the switch; Space toggles | Knob squishes (scale-x 1.15) mid-travel | init, sched and the focused window's process are always pinned (switch on and disabled, tooltip "Kernel processes are always resident") | n/a | While the pin request is pending, the knob pulses | Pin refused: switch springs back and a tooltip "Pinned set would exceed 50% of the budget" |
| 13 | `evictable` tag (ai.embed pid 24) and `speculative` tag (prefetch:editor pid 140) | Small outlined chips | Tooltip with the reason | Focusable via the row | n/a | n/a | n/a | n/a | n/a |
| 14 | Predictions panel: `Markov-2 · local only` chip, Next app rows Terminal 62%, Files 21%, Editor 9% with confidence bars, reason, θ = 0.40, 612 launches, Speculative 12 MB expires 00:48 | Bars in accent | Row tooltip with the full reason string | Rows focusable; the bars carry the percentage as text, not only length | Clicking a row opens Predictions tab | AI disabled in Settings → Privacy & AI: panel shows "Predictions are off" and a Settings link | Cold start: "Learning your habits · 12/50 launches" with confidence 0 | Bars shimmer | Predictor crashed: "Predictor unavailable" with a Restart link |
| 15 | Footer status `Thrashing guard: off · 4.2 faults/s · updated 1 s ago` and `Plotinium 0.3.0 · build a1f93c2` | Tertiary label | n/a | n/a | n/a | n/a | n/a | "updating…" | "Thrashing guard: ON · new heavy processes are refused" in danger colour |
| 16 | Dock and desktop behind the window | Floating glass dock, Task Manager has the running dot | Dock magnification | Dock items reachable with Ctrl+F3 | Icon bounces on launch | n/a | n/a | n/a | n/a |

## Intended animations

All animations use `transform` and `opacity` only. Durations are for the default; under `prefers-reduced-motion: reduce` the fallback column applies.

Easing tokens:
- `--ease-spring`: `linear(0, 0.009, 0.035 2.1%, 0.141 4.4%, 0.723 12.9%, 0.938 16.7%, 1.017 20.1%, 1.043 23.5%, 1.035 28.2%, 1.007 36.2%, 0.998 45.4%, 1)` (a soft spring with about 4% overshoot)
- `--ease-out-expo`: `cubic-bezier(0.16, 1, 0.3, 1)`
- `--ease-snappy`: `cubic-bezier(0.34, 1.56, 0.64, 1)` (small overshoot, for knobs and thumbs)

| Element | Trigger | Properties | Duration | Easing | Reduced-motion fallback |
|---|---|---|---|---|---|
| Task Manager window | Open from dock or Search | `scale` 0.94 → 1, `opacity` 0 → 1, `translateY` 8px → 0 | 240ms | `--ease-spring` | Opacity 0 → 1 over 120ms, no scale |
| Window | Minimise to dock | Genie approximation: `scale` 1 → 0.1 and `translate` to the dock icon, `opacity` 1 → 0 | 320ms | `--ease-out-expo` | Opacity fade 150ms |
| Tab thumb (segmented control) | Tab change | `translateX` to the new segment, `scaleX` to its width | 280ms | `--ease-snappy` | Instant jump |
| Tab content | Tab change | Outgoing `opacity` 1 → 0 and `translateX` ∓12px; incoming `opacity` 0 → 1 and `translateX` ±12px → 0 | 200ms | `--ease-out-expo` | Crossfade 100ms |
| Stacked bar segments | First paint of the Memory tab | Each segment `scaleX` 0 → 1 from its left edge, staggered 40ms left to right | 480ms | `--ease-spring` | Segments appear at full size, opacity 0 → 1 over 120ms |
| Stacked bar segments | New sample (every 1 s) | `scaleX` from the old ratio to the new ratio (segments are positioned by `translateX`, so no width animation) | 400ms | `--ease-out-expo` | Instant update |
| Speculative hatch | While speculative pages exist | Hatch pattern layer `translateX` 0 → 8px, looping | 1.2s per loop | `linear` | Static hatch |
| Watermark tick (HIGH 85%) | Usage crosses above HIGH_WM | Tick `scaleY` 1 → 1.4 → 1 and the chip `opacity` pulse 0.6 → 1, twice | 600ms | `--ease-snappy` | Chip colour change only, no pulse |
| Budget number `231` | Value change | Old digits `translateY` 0 → -6px and `opacity` 1 → 0; new digits from +6px | 220ms | `--ease-out-expo` | Instant text swap |
| Stat cards | First paint | `opacity` 0 → 1, `translateY` 6px → 0, staggered 30ms | 260ms | `--ease-spring` | Opacity only, 120ms, no stagger |
| Stat card | Hover | `translateY` 0 → -1px; shadow layer `opacity` 0.4 → 0.7 | 160ms | `--ease-out-expo` | No lift; shadow opacity change only |
| Sparkline | New sample | Path group `translateX` by one step to the left (scrolling window) | 1000ms | `linear` | Static sparkline redrawn each second |
| Table rows | Initial load / filter change | `opacity` 0 → 1, `translateY` 4px → 0, staggered 12ms, capped at the first 20 rows | 180ms | `--ease-out-expo` | Rows appear at once |
| Table row | Re-sort | FLIP: each row `translateY` from its old position to the new one | 300ms | `--ease-spring` | Instant reorder |
| Table row | Process exits | `opacity` 1 → 0 and `scaleY` 1 → 0.9, then the rows below FLIP up | 220ms | `--ease-out-expo` | Row removed; no motion |
| Resident inline bar | Value change | `scaleX` to the new ratio | 400ms | `--ease-out-expo` | Instant |
| Pin toggle knob | Toggle | Knob `translateX` 0 → 14px with `scaleX` 1 → 1.15 → 1; track fill layer `opacity` 0 → 1 | 260ms | `--ease-snappy` | Knob jumps; fill changes at once |
| Pin toggle | Pin refused | Knob shakes `translateX` 0, 3, -3, 2, 0 px | 300ms | `linear` | No shake; tooltip only |
| Soft-limit `!` badge (pid 151) | Appears | `scale` 0.6 → 1, `opacity` 0 → 1 | 240ms | `--ease-snappy` | Opacity 0 → 1 |
| Predictions confidence bars | New prediction published | `scaleX` from old to new confidence; rows FLIP-reorder if the ranking changes | 420ms | `--ease-spring` | Instant |
| Prediction row "pre-fetched" tag | `prefetch:*` starts | `opacity` 0 → 1, `translateX` -4px → 0 | 200ms | `--ease-out-expo` | Opacity only |
| Skeleton / loading shimmer | Loading state | Highlight gradient layer `translateX` -100% → 100% | 1.4s loop | `linear` | Static 6% fill |
| Tooltips | Hover 400ms / focus immediately | `opacity` 0 → 1, `translateY` 4px → 0, `scale` 0.98 → 1 | 160ms | `--ease-out-expo` | Opacity only, 80ms |
| Menus (menu bar, context menu on a row) | Open | `opacity` 0 → 1, `translateY` -4px → 0 | 180ms | `--ease-out-expo` | Opacity only |
| Toast "Could not end pid 151" | Error | Slide in from top right: `translateX` 24px → 0, `opacity` 0 → 1 | 280ms | `--ease-spring` | Opacity only |
| `Reclaim now` button | Press | `scale` 1 → 0.97 → 1 | 140ms | `--ease-snappy` | None |

Performance notes: every animated layer gets `will-change: transform` only while animating. Bars and sparklines are sized by `transform: scaleX()` inside a fixed-width track, so a 1 Hz sample causes no layout. The table uses virtualised rows; FLIP animations are skipped when more than 40 rows move.

## Accessibility landmarks and roles

- Menu bar: `role="menubar"` with `menuitem`s; status items in a `role="group"` named "Status".
- Window: `role="dialog"` is not used; the window is a `section` with `aria-labelledby` pointing to the title "Task Manager". Traffic lights are `button`s named "Close", "Minimise", "Zoom".
- Toolbar: `role="toolbar"` named "Task Manager toolbar", containing the tab list, the search field (`role="searchbox"`, label "Filter processes") and the End Process `button`.
- Tabs: `role="tablist"`, five `role="tab"` with `aria-selected`, `aria-controls`; the Memory panel is `role="tabpanel"`.
- Budget bar: `role="meter"`, `aria-valuemin=0`, `aria-valuemax=256`, `aria-valuenow=231`, `aria-valuetext="231 of 256 MB accounted, 90%, above high watermark"`; its segments are a `role="list"` of `listitem`s with text labels (e.g. "ai.embed model, 100 MiB, evictable").
- Stat cards: a `role="list"`; each card is a `listitem` with the label and value as text; sparklines are `aria-hidden="true"` and have a text trend ("up 12 per second").
- Process table: native `table` with `caption` "Processes by memory", `th scope="col"`, `aria-sort` on the sorted column, `aria-rowcount` when virtualised, `aria-selected` on the selected row.
- Pin: `role="switch"` with `aria-checked` and label "Pin editor, pid 134".
- Predictions: `aside` with `aria-labelledby` "Predictions"; each bar is `role="meter"` with text percentage.
- Live updates: a single visually hidden `aria-live="polite"` region announces only threshold events ("Memory above high watermark", "Thrashing guard on"), never the 1 Hz samples.
- Contrast: all text sits on the window tint at 78% opacity; secondary labels at 60% white on #242428 meet 4.5:1. No information by colour alone: speculative is hatched, soft limit has a `!` glyph, evictable has a text tag.
- Keyboard: Ctrl+1 … Ctrl+5 switch tabs, `/` focuses the filter, Delete ends the selected process (with confirmation), P toggles pin on the selected row.

## What `reference.html` already implements

Open it in Chrome at 1440x900. It plays: the window's spring open; the menu bar dropping in and the dock rising; the budget-bar segments growing with a stagger; the looping speculative hatch; the pulsing chip dot; staggered stat cards and table rows; the inline resident bars and prediction bars growing; the `!` badge popping in; the Predictions panel sliding in; the segmented-control thumb springing between tabs on click; the pin switch squishing on toggle (Space or Enter); dock magnification on hover. After 6 s, live 1 Hz sampling starts on Page faults and faults/s, with digit ticks. `prefers-reduced-motion: reduce` turns loops off and cuts every entrance to a 120ms fade. The references use only `transform` and `opacity`, except the width set once on the tab thumb, which the build should replace with `scaleX`.
