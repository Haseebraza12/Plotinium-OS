# Files: semantic search (dark)

- **Stitch project:** 12849137298552292712
- **Stitch screen id:** pending — Stitch had not listed the generated screen when this run ended (see Status)
- **Design system:** Plotinium Glass (Dark), `assets/10121591451242352758`
- **Model:** GEMINI_3_8_FLASH, device DESKTOP (1440 x 900)
- **Files:** `notes.md` now; `screen.html` and `screenshot.png` to be downloaded once Stitch lists the screen (see Status)
- **Specs:** [rag-semantic-search.md §3.5](../../../../specs/10-ai/rag-semantic-search.md) (query path, citations, notices), [ui-design-system.md](../../../../specs/05-wm/ui-design-system.md) (tokens, motion, components), [window-manager.md](../../../../specs/05-wm/window-manager.md) (window semantics)

## Status and review

**Generation not yet available (as of 2026-09-24 20:35 PKT).** `generate_screen_from_text` was called once at about 20:21 with the prompt below (the call timed out on the client side, which is expected for Stitch). Per the task rules it was not retried. `list_screens` on the project was then polled 14 times over about 14 minutes (plus two `get_project` checks) and returned an empty list every time; `get_project` still showed the project's last update at 20:22. No sibling screen in this project had appeared either, so the Stitch queue was likely saturated by the parallel runs.

Because no screen exists yet, `screen.html` and `screenshot.png` are **not** in this folder and no visual review or `edit_screens` round was done. To finish:

1. `list_screens` on project 12849137298552292712 and find the screen whose title or prompt starts with "Plotinium OS — "Files" app with semantic search".
2. `get_screen`, then `curl -L` `htmlCode.downloadUrl` → `screen.html` and `screenshot.png` (or save the JSON as `screen.json`).
3. Review against the checklist below; fix with at most two `edit_screens` rounds.
4. Replace the screen id at the top of this file.

**Review checklist for this screen:** atom logo (not an apple) in the menu bar; no Finder/Spotlight/SF names or glyphs; the query text readable in the search field; four result cards, each with a mono `path:line` citation, a violet highlighted snippet, a relevance bar with a number and an owner; the amber "Keyword search only — model loading" chip (replace any spinner with a determinate ring, see below); inspector rows including `rwxr-x---`, version 7 and lock status; label contrast on dark glass at least 4.5:1.

## Final prompt

```text
Plotinium OS — "Files" app with semantic search (DARK Liquid Glass). Desktop 1440x900.

BACKGROUND: a deep indigo-to-violet abstract wallpaper, softly blurred. At the very top a thin translucent glass MENU BAR: left an abstract luminous atom logo (bright violet #5E5CE6 nucleus with 2 thin elliptical orbits, NOT an apple), then bold "Files", then menus "File  Edit  View  Go  Window  Help". Right side: wifi, battery, a Control Centre toggle icon, a Search magnifier and "Thu 24 Sep  10:42". At the bottom a floating translucent glass DOCK with rounded app icons: Files (active, small dot under it), Terminal, Editor, Task Manager, Settings, Search, Trash. Icons are custom, lucide-style line glyphs on gradient rounded squares.

MAIN WINDOW (centered, ~1180x720, 14px corner radius, large soft shadow, dark frosted glass):
Top-left traffic-light window controls (red, amber, green circles). UNIFIED TOOLBAR in the same row: back / forward chevrons, a path bar breadcrumb "/ › home › student › notes" in monospace-ish chips, view toggles segmented control (grid, list, columns, gallery — list selected), and a wide rounded SEARCH FIELD with a sparkle AI icon containing the natural-language query "where did I discuss the memory leak in the UI component" with a clear (x) button and a small "Semantic" pill.

LEFT SIDEBAR (vibrancy, translucent, 220px): section "Favourites": Home, Documents, Downloads, Recent (lucide icons, Home highlighted). Section "Locations": "/", "/tmp", "/mnt". Section "Tags" with coloured dots: Red "urgent", Violet "capstone", Blue "notes", Green "done". At the bottom of sidebar a small quota meter "1.2 GB of 2 GB".

MAIN AREA: header "Semantic results" with subtitle "6 matches in /home/student · 184 ms". Beside it an amber alternative-state chip/banner with an info icon: "Keyword search only — model loading" and a small spinner.
A vertical list of RESULT CARDS (glass cards, 12px radius). Each card: a file icon, file name in bold, a monospace path:line citation, a 2-line snippet with the matching phrase highlighted in violet, a thin relevance score bar with a percentage, and the owner avatar + name on the right.
1) week6-standup.md — "notes/week6-standup.md:42" — "…Bob found a **memory leak in the WindowFrame UI component**; listeners were never removed on close…" — 94% — owner student
2) os-report.md — "notes/os-report.md:118" — "…the **leak in the dock component** grew heap by 3 MB per window open…" — 88% — owner student
3) bugs.log — "notes/bugs.log:7" — "…fixed: **UI component leak**, detached ResizeObserver in taskbar…" — 76% — owner alice
4) meeting-2026-09-17.md — "notes/meeting-2026-09-17.md:23" — "…discussed **memory profiling** of the Terminal renderer…" — 61% — owner bob
The first card is selected (violet 1px ring and slightly brighter glass).

RIGHT INSPECTOR PANEL (glass, 280px): large file icon, "week6-standup.md", kind "Markdown document". Rows: Permissions "rwxr-x---" in monospace, Owner "student (uid 1001)", Group "capstone", Size "4.2 KB", Modified "Today, 09:18", Created "17 Sep 2026", Version "7" with a "History" link, Lock status: a green lock chip "Unlocked — no editors" or a small row "Locked by alice · 2 min ago" as secondary. Buttons at bottom: "Open", "Open in Editor", "Share".

STATUS BAR at the bottom of the window: "6 results · indexed 1,284 files · ai.indexer pid 23". Everything has typography in Inter, subtle 1px inner highlights on glass, no Apple logos or Apple app names.
```

## Spec alignment notes (read before building)

- **Citation format.** The spec renders `path:lineStart-lineEnd  score  snippet` (for example `notes/week6-standup.md:42-51  0.94`). The mock shows the start line only, to keep the card compact. In the build, show `:42-51` in the citation and render the score as a number next to the bar (so the score is never shown by colour or length alone).
- **Fallback notice text.** The spec's exact notice is `semantic model loading — showing keyword matches` (RAG-06). The chip reads "Keyword search only — model loading" in the mock. Use the spec string for the chip's accessible name or change the spec: the two must match, because the e2e test asserts the text.
- **No spinner.** `ui-design-system.md` says there is no indeterminate progress variant (DSN-07) and no looping animation other than the Terminal cursor blink (WCAG 2.2.2). The model-loading chip must therefore show a **determinate** ring or bar driven by the `ai.embed` page-in bytes, never a looping spinner. If the mock shows a spinner, treat it as a placeholder.
- **Scope.** The Files search box calls `ai.semsearch` with `scope` = the current folder (`/home/student/notes`). The header therefore says "in notes", not "in /home/student".
- **Foreign results.** A result owned by alice or bob is shown only after `POST /api/index/verify`. It carries a "Shared · verified" badge with the server-supplied snippet. Offline, it is hidden and the notice `1 shared result hidden while offline` appears as a second chip.
- **Warm on focus.** The search field calls `ai.search.focus({on:true})` when it gains focus, so the model is warming before the first keystroke. The fallback chip should therefore be rare; it is a real state, not decoration.
- **Opening.** Selecting a result and pressing Enter (or double-click) opens the file in Editor at `lineStart`.
- **Shell shape.** The current `window-manager.md` describes a bottom taskbar, right-side window buttons and a 3 px accent strip. The macOS-style direction (menu bar, floating dock, traffic lights on the left) is a design change that needs a PR to `window-manager.md` and `ui-design-system.md` before it is built.

## UI elements and states

### Desktop shell (context only, shared with other screens)

| Element | States |
|---|---|
| Menu bar (28 px glass strip): atom logo menu, app name "Files", menus File / Edit / View / Go / Window / Help, status items (Wi-Fi, battery, Control Centre, Search, clock) | default; menu title hover (subtle fill); menu open (accent pill on the title); keyboard focus ring; status item with a warning badge (for example sync offline) |
| Dock (floating glass) with Files, Terminal, Editor, Task Manager, Settings, Search, Trash | icon default; hover (magnify, tooltip label); pressed (dim 80%); running (dot under icon); attention (one bounce); Trash empty / full glyph |

### Window chrome

| Element | States |
|---|---|
| Traffic lights (close #FF5F57, minimise #FEBC2E, maximise #28C840) | default; group hover (x, -, + glyphs appear on all three); pressed (darker 15%); window inactive (all three grey, glyphs hidden); disabled maximise for fixed-size windows (grey outline); focus-visible (ring on the focused control) |
| Window frame (12 px radius, dark glass, hairline border) | focused (large soft shadow); unfocused (smaller shadow, toolbar labels dimmed to secondary); dragging (shadow grows); restoring from suspend (`Restoring… 3.1 / 5.0 MB` overlay, determinate) |

### Unified toolbar

| Element | States |
|---|---|
| Back / Forward chevrons | enabled; disabled (no history, 38% label); hover (ghost fill); pressed; focus-visible; long-press shows the history menu |
| Path bar `/ › home › student › notes` | default; segment hover (underline + fill); segment focus-visible; drag-over (accent tint: drop moves the file into that folder); overflow (middle segments collapse into `…` menu); current segment bold |
| View toggles: Icons, List, Columns, Gallery | selected (thumb behind the icon); hover; focus-visible; disabled for Columns and Gallery while results are showing (results are always a list) |
| Search field with AI sparkle icon, query "where did I discuss the memory leak in the UI component", clear (x), mode pill "Semantic" | empty (placeholder "Search notes or ask a question"); focused (3 px focus ring, model warm-up starts); typing; query submitted (loading: skeleton cards after 150 ms); results; clear button hover / pressed; mode pill Semantic / Keyword (a toggle: `--keyword` equivalent); query too long (truncated notice "Query shortened to 512 tokens"); error (inline error line with icon, linked by `aria-describedby`) |

### Sidebar (vibrancy)

| Element | States |
|---|---|
| Section headers Favourites, Locations, Tags | default; hover shows Hide / Show; collapsed (chevron rotated) |
| Favourites: Home, Documents, Downloads, Recent | default; hover; selected (accent-tinted pill, icon in accent); focus-visible; drop target (accent outline) |
| Locations: `/`, `/tmp`, `/mnt` | default; selected; `/mnt` unmounted (38% label, "Not mounted" tooltip); permission denied on open (banner in the main area) |
| Tags with colour dots: urgent (red), capstone (violet), notes (blue), done (green) | default; hover; selected (filter active); every dot is paired with the tag name (never colour alone) |
| Quota meter "1.2 GB of 2 GB" | normal (accent); ≥ 80% warning (orange + text "Nearly full"); ≥ 95% danger (red + "Quota full soon") |

### Results area

| Element | States |
|---|---|
| Header "Semantic results" + "4 files in notes · 184 ms" | results; keyword-only (title changes to "Keyword results"); stale (a file changed and is re-indexing: row shows "Updating…") |
| Fallback chip "Keyword search only — model loading" (warning) | loading (determinate ring from page-in bytes); ready (morphs to green "Semantic ready", then leaves); failed ("Semantic search unavailable — showing keyword matches", red outline, `role="alert"`) |
| Offline chip "1 shared result hidden while offline" | shown only when offline and a foreign result was hidden |
| Result card: file icon, name, citation `notes/week6-standup.md:42-51`, snippet with highlighted match, relevance bar + score `0.94`, owner avatar + name, optional "Shared · verified" badge | default; hover (lift 1 px, brighter glass); focus-visible (3 px ring); selected (accent ring, brighter glass); pressed (scale 0.99); opening (card flashes accent, Editor window zooms out of it); stale (score dimmed, "Updating…" chip); foreign verified (badge) |
| Loading skeleton | 4 static tinted card blocks (no shimmer loop) shown only if results take longer than 150 ms |
| Empty state | "No matches in notes" + suggestions: "Search all of Home", "Try keyword search"; illustration is the atom mark at 30% |
| Error state | `EACCES` "You can't search /home/alice" or `EIO` "The search index is being rebuilt" as an in-window banner (`role="alert"`) with a Retry button |

### Inspector panel

| Element | States |
|---|---|
| Header: large file icon, name `week6-standup.md`, kind "Markdown document" | single selection; multi-selection ("3 items", combined size); nothing selected (empty state "Select a result to see its info"); loading (static skeleton rows) |
| Info rows: Permissions `rwxr-x---` (mono), Owner `student (uid 1001)`, Group `capstone`, Size `4.2 KB`, Modified `Today, 09:18`, Created `17 Sep 2026`, Version `7` + History link | default; value copy on click (toast "Copied"); History link hover / focus; permissions row editable only for the owner or root (others see it read-only) |
| Lock status chip | Unlocked (green "Unlocked — no editors"); Locked by you (accent, "Unlock" action); Locked by alice (orange, "Locked by alice · 2 min ago", Open in Editor becomes "Open read-only"); stale lock (grey, "Lock expired") |
| Buttons Open (primary), Open in Editor (secondary), Share (ghost) | default; hover; pressed; focus-visible; disabled (`aria-disabled`, 38% label) |

### Status bar

`4 results · indexed 1,284 files · ai.indexer pid 23 (PRI 32)`: default; indexing in progress ("Indexing 12 of 40 files", determinate); indexer paused while search is focused ("Indexing paused while you search").

## Intended animations

Motion tokens come from `ui-design-system.md` §3.6 (`--pl-motion-fast` 120 ms, `--pl-motion-med` 200 ms, `--pl-motion-slow` 320 ms, `--pl-ease`, `--pl-ease-in`, `--pl-ease-out`). The macOS-style direction needs two new tokens, to be added to the tokens file through a PR:

```css
--pl-motion-window: 240ms;
--pl-ease-spring: linear(0, 0.034 2.2%, 0.135 4.6%, 0.29 7.3%, 0.52 11.2%, 0.74 15.8%, 0.88 20.4%, 0.96 25.4%, 1.01 31%, 1.025 36.8%, 1.02 44%, 1.006 55%, 0.999 70%, 1); /* soft spring, ~2.5% overshoot */
--pl-ease-pop: cubic-bezier(.34, 1.36, .64, 1); /* small overshoot for badges and chips */
```

All motion tokens are 0 ms under `prefers-reduced-motion: reduce` or `:root[data-motion="reduce"]` (DSN-05). Only `transform` and `opacity` animate. Nothing loops.

| # | Element | Trigger | Properties | Duration | Easing | Reduced-motion fallback |
|---|---|---|---|---|---|---|
| 1 | Files window | Open from the dock | `transform: scale(.94) → scale(1)`, `opacity: 0 → 1`, origin at the dock icon | `--pl-motion-window` 240 ms | `--pl-ease-spring` | Appears at once, no scale |
| 2 | Traffic-light glyphs | Pointer enters the control group | glyph `opacity: 0 → 1` | 120 ms | `--pl-ease-out` | Glyphs shown at once |
| 3 | Search field focus ring | Field gains focus | ring pseudo-element `opacity: 0 → 1`, `transform: scale(1.02) → scale(1)` | 120 ms | `--pl-ease-out` | Ring shown at once |
| 4 | AI sparkle icon | Field gains focus (model warm-up starts) | `transform: scale(1) → scale(1.15) → scale(1)`, `rotate(0 → 15deg → 0)`, runs once | 320 ms | `--pl-ease-pop` | No motion; icon colour changes to accent |
| 5 | Result cards | Results arrive | `transform: translateY(8px) → 0`, `opacity: 0 → 1`, staggered 30 ms per card, max 6 staggered, the rest together | 200 ms each | `--pl-ease-spring` | Cards appear together, no translate |
| 6 | Relevance bars | Card has entered | fill `transform: scaleX(0) → scaleX(score)`, `transform-origin: left` | 320 ms, 60 ms after its card | `--pl-ease-spring` | Bar drawn at its final length |
| 7 | Snippet highlight | Card has entered | highlight pseudo-element `opacity: 0 → 1` | 120 ms, 120 ms after its card | `--pl-ease-out` | Highlight shown at once |
| 8 | Fallback chip | Keyword fallback answer arrives | `transform: translateY(-4px) → 0`, `opacity: 0 → 1` | 200 ms | `--pl-ease-spring` | Chip appears at once |
| 9 | Fallback chip → "Semantic ready" | `ai.embed` becomes resident | old label `opacity 1 → 0`, new label `opacity 0 → 1`; check icon `scale(.6) → scale(1)`; after 1.5 s the chip leaves with `scale(1) → scale(.96)`, `opacity 1 → 0` | 200 ms cross-fade, 120 ms exit | `--pl-ease-pop` for the icon, `--pl-ease-in` for the exit | Label swaps at once; chip removed at once; the change is announced in the status region |
| 10 | Result re-rank | Semantic results replace keyword results | FLIP: each card `transform: translateY(Δ) → 0`; new cards `opacity 0 → 1`; removed cards `opacity 1 → 0` | 320 ms | `--pl-ease-spring` | List swaps at once; status region announces "Showing semantic results" |
| 11 | Result card hover | Pointer enters card | `transform: translateY(-1px)`; shadow pseudo-element `opacity 0 → 1` | 120 ms | `--pl-ease` | Shadow shown, no lift |
| 12 | Result card press | Pointer down / Enter | `transform: scale(.99)` then back | 80 ms down, 200 ms up | `--pl-ease-pop` on release | No scale; accent flash via opacity only |
| 13 | Selection ring | Selection changes (click, arrow keys) | ring pseudo-element `opacity 0 → 1` on the new card, `1 → 0` on the old | 120 ms | `--pl-ease` | Ring moves at once |
| 14 | Inspector content | Selection changes | old content `opacity 1 → 0`; new content `transform: translateX(6px) → 0`, `opacity 0 → 1` | 120 ms out, 200 ms in | `--pl-ease-in` / `--pl-ease-spring` | Content swaps at once |
| 15 | Inspector panel | Toggle (View › Show Inspector, ⌘I) | `transform: translateX(100%) → 0`, `opacity 0 → 1`; the results column resizes at once (no width animation) | 240 ms | `--pl-ease-spring` | Panel appears at once |
| 16 | Lock chip | Lock status changes (sync event) | old chip `opacity 1 → 0`; new chip `scale(.9) → scale(1)`, `opacity 0 → 1`; lock shackle `translateY(-2px) → 0` when it locks | 200 ms | `--pl-ease-pop` | Chip swaps at once; status region announces "Locked by alice" |
| 17 | Sidebar selection pill | Selection moves between sidebar items | FLIP: pill `transform: translateY(Δ) → 0` | 200 ms | `--pl-ease-spring` | Pill jumps at once |
| 18 | Path bar segment | Folder changes | new segment `transform: translateX(-4px) → 0`, `opacity 0 → 1` | 120 ms | `--pl-ease-out` | Segment appears at once |
| 19 | Open in Editor | Enter / double-click on a card | Editor window `transform: scale(card rect → 1)`, `opacity 0 → 1`, origin at the card | 240 ms | `--pl-ease-spring` | Editor window appears at once |
| 20 | Dock icon | Pointer hover over the dock | icon `transform: scale(1 → 1.35)` with neighbours `scale(1.15)`, `translateY(-8px)` | 120 ms follow | `--pl-ease` | No magnification; the tooltip label still shows |

## Accessibility landmarks and roles

- **Window:** `<section role="dialog" aria-modal="false" aria-labelledby="t{wid}">`; the title "Files — Search" has `id="t{wid}"` (window-manager.md). Minimised windows are `inert`.
- **Toolbar:** `role="toolbar"` labelled "Files toolbar", roving `tabindex`. Back / Forward and the view toggles are buttons with `aria-label`; the view toggles are a `radiogroup` (arrow keys). The path bar is `<nav aria-label="Path">` with an ordered list and `aria-current="location"` on the last segment.
- **Search:** `<search>` landmark (or `role="search"`) containing `<input type="search" aria-label="Search notes by meaning">`; the mode pill is a `switch` ("Semantic search", `aria-checked`). The input has `aria-controls` pointing at the results list.
- **Sidebar:** `<nav aria-label="Places">` with three groups (`role="group"` + `aria-labelledby` on each section header); the current place has `aria-current="page"`. Tags are buttons with `aria-pressed` for filtering.
- **Results:** `<main>` region labelled "Semantic results". The list is `role="listbox"` with `aria-activedescendant` (arrow keys move, Enter opens at `lineStart`); each card is `role="option"` with an accessible name like "week6-standup.md, notes/week6-standup.md line 42 to 51, score 0.94, owner student". The snippet is text nodes only (no HTML sinks, spec §3.5 step 8); the highlight is a `<mark>`.
- **Relevance bar:** `role="meter"` with `aria-valuenow="0.94"`, `aria-valuemin="0"`, `aria-valuemax="1"`, `aria-valuetext="94 percent relevant"`.
- **Notices:** the fallback chip and the offline chip are in a `role="status"` live region (polite); the failure variant is `role="alert"`. The model-loading progress is `role="progressbar"` with `aria-valuetext` such as "Loading search model, 60 percent". Announcements are rate-limited to one per 2 s (latest wins).
- **Inspector:** `<aside aria-label="File info">` with a description list (`<dl>`) for the info rows; the lock chip text is part of the accessible name, never colour alone.
- **Status bar:** `role="status"` for the indexing progress; the static counts are plain text.
- **Contrast:** all text sits on glass with at least a 0.72 opaque tint so it meets WCAG 2.2 AA (4.5:1); the snippet highlight uses accent text plus an underline, not colour alone.
- **Keyboard:** ⌘F / Ctrl+F focuses search; Esc clears the query then returns focus to the list; ⌘I toggles the inspector; ⌘↓ / Enter opens; Tab order: toolbar → sidebar → results → inspector → status.
