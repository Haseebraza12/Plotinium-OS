# Files: list view with context menu (light)

- **Stitch project:** 12849137298552292712
- **Stitch screen id:** pending — Stitch had not listed the generated screen when this run ended (see Status)
- **Design system:** Plotinium Glass (Light), `assets/3690503530025860907`
- **Model:** GEMINI_3_8_FLASH, device DESKTOP (1440 x 900)
- **Files:** `notes.md` now; `screen.html` and `screenshot.png` to be downloaded once Stitch lists the screen (see Status)
- **Specs:** [ui-design-system.md](../../../../specs/05-wm/ui-design-system.md) (tokens, data grid, menus), [window-manager.md](../../../../specs/05-wm/window-manager.md) (window semantics), [virtual-file-system.md](../../../../specs/04-vfs/virtual-file-system.md) (permissions, trash, quota)

## Status and review

**Generation not yet available (as of 2026-09-24 20:35 PKT).** `generate_screen_from_text` was called once at about 20:21 with the prompt below (the call returned session `2958429668086585372` without a screen id; the raw response is in `screen.json`). Per the task rules it was not retried. `list_screens` on the project was then polled 14 times over about 14 minutes (plus two `get_project` checks) and returned an empty list every time; `get_project` still showed the project's last update at 20:22. No sibling screen in this project had appeared either, so the Stitch queue was likely saturated by the parallel runs.

Because no screen exists yet, `screen.html` and `screenshot.png` are **not** in this folder and no visual review or `edit_screens` round was done. To finish:

1. `list_screens` on project 12849137298552292712 and find the screen whose title or prompt starts with "Plotinium OS — "Files" app in LIGHT mode, list view".
2. `get_screen`, then `curl -L` `htmlCode.downloadUrl` → `screen.html` and `screenshot.png` (or save the JSON as `screen.json`).
3. Review against the checklist below; fix with at most two `edit_screens` rounds.
4. Replace the screen id at the top of this file.

**Review checklist for this screen:** atom logo (not an apple) in the menu bar; no Finder/Spotlight/SF names or glyphs; five sortable column headers with `aria-sort`-style chevron on Name; mono permission strings; the capstone-proposal.pdf row in solid violet with white text; the context menu on kernel-notes.txt with all eight items, shortcuts, separators and Move to Trash in red; the status bar "42 items · 1.2 GB of 2 GB quota used" with a 60% bar; secondary text on frosted white glass at least 4.5:1.

## Final prompt

```text
Plotinium OS — "Files" app in LIGHT mode, list view (light Liquid Glass). Desktop 1440x900.

BACKGROUND: a soft pastel lavender-to-sky abstract wallpaper. At the very top a thin frosted white glass MENU BAR: left an abstract luminous atom logo (violet #5E5CE6 nucleus with 2 thin elliptical orbits, NOT an apple), then bold "Files", then menus "File  Edit  View  Go  Window  Help". Right: wifi, battery, Control Centre icon, Search magnifier, "Thu 24 Sep  10:42". At the bottom a floating frosted glass DOCK: Files (active dot), Terminal, Editor, Task Manager, Settings, Search, Trash, with custom gradient rounded-square icons using lucide-style line glyphs.

MAIN WINDOW (centered ~1200x720, 14px radius, big soft shadow, white translucent glass):
Traffic-light controls (red, amber, green) at top-left. UNIFIED TOOLBAR: back/forward chevrons, title "Documents", a path bar breadcrumb "/ › home › student › Documents", a view switcher segmented control (icons, list, columns, gallery — LIST selected in violet), a sort menu button, a share button and a small search field "Search".

LEFT SIDEBAR (vibrancy, light translucent, 210px): "Favourites": Home, Documents (selected, violet tint), Downloads, Recent. "Locations": "/", "/tmp", "/mnt". "Tags" with colour dots: Red urgent, Orange review, Violet capstone, Blue notes, Green done.

FILE LIST (sortable table): column headers "Name ▲" (active sort, chevron), "Date Modified", "Size", "Kind", "Permissions". Rows with zebra striping and file icons:
- os-report.md — Today, 09:18 — 24 KB — Markdown — -rw-r--r--
- capstone-proposal.pdf — Yesterday, 17:40 — 1.8 MB — PDF Document — -rw-r--r--  (this row SELECTED: solid violet #5E5CE6 highlight, white text)
- design (folder) — 22 Sep 2026 — -- — Folder — drwxr-xr-x
- kernel-notes.txt — 21 Sep 2026 — 8 KB — Plain Text — -rw-------
- scheduler.ts — 20 Sep 2026 — 12 KB — TypeScript — -rw-r--r--
- boot-log.txt — 19 Sep 2026 — 3 KB — Plain Text — -r--r--r--
- team-contract.md — 15 Sep 2026 — 6 KB — Markdown — -rw-rw-r--
- screenshot-wm.png — 14 Sep 2026 — 640 KB — PNG Image — -rw-r--r--
- vfs-diagram.svg — 12 Sep 2026 — 48 KB — SVG Image — -rw-r--r--
- run.sh — 10 Sep 2026 — 1 KB — Shell Script — -rwxr-xr-x
Permissions column in monospace font.

A CONTEXT MENU (frosted glass popover, 10px radius, shadow) open over the "kernel-notes.txt" row (that row has a light hover outline). Items with lucide icons and keyboard shortcuts on the right: "Open  ⌘O", "Open With ›", separator, "Get Info  ⌘I", "Rename", "Copy  ⌘C", separator, "Change Permissions…", "Lock for Editing", separator, "Move to Trash  ⌘⌫" in RED. "Get Info" is hovered with a violet highlight.

BOTTOM STATUS BAR of the window: "42 items · 1.2 GB of 2 GB quota used" with a thin rounded quota progress bar at 60% in violet, and on the right "student · /home/student/Documents".
Typography Inter, crisp readable contrast, no Apple logos or Apple app names.
```

## Spec alignment notes (read before building)

- **Data grid.** The list follows the APG grid pattern from `ui-design-system.md` (row height 28 px, `aria-sort` on the sorted header, `tabular-nums`, virtualised above 2,000 rows). The spec's selected row uses `--pl-accent-subtle`; the macOS direction uses a solid accent row with white text when the window is focused, and `--pl-accent-subtle` when it is not. Record the change in the tokens PR.
- **Permissions column.** Symbolic mode strings (`-rw-r--r--`, `drwxr-xr-x`) in JetBrains Mono, `tabular-nums`. The accessible name spells it out ("owner read write, group read, others read").
- **Menu shortcuts.** In the browser, ⌘ maps to Ctrl on Linux and Windows. The menu shows the platform's modifier. Browser-reserved shortcuts (Ctrl+W, Ctrl+T, Ctrl+N) are never used.
- **Change Permissions… and Lock for Editing** are enabled only when the user may do them: chmod needs owner or root, and Lock needs `w` on the file. Otherwise they are disabled with a reason ("Only the owner can change permissions", "Locked by alice").
- **Move to Trash** is the destructive item: red, last in the menu and never the default. It moves the file to `~/.Trash` (undoable for 10 s from the toast); it is not a permanent delete.
- **Quota.** "42 items · 1.2 GB of 2 GB quota used" comes from the server quota; the thin bar is a determinate progress bar (no indeterminate variant exists, DSN-07).
- **Shell shape.** The macOS-style menu bar, dock and left traffic lights replace the taskbar and right-side window buttons in the current `window-manager.md`; that needs a spec PR before it is built.

## UI elements and states

### Desktop shell (context only)

| Element | States |
|---|---|
| Menu bar (frosted white glass): atom logo menu, "Files", File / Edit / View / Go / Window / Help, status items, clock "Thu 24 Sep 10:42" | default; title hover; menu open (accent pill); focus-visible |
| Dock: Files (running dot), Terminal, Editor, Task Manager, Settings, Search, Trash | default; hover magnify + label; pressed; running dot; Trash empty / full (after Move to Trash) |

### Window chrome and toolbar

| Element | States |
|---|---|
| Traffic lights | default; group hover (glyphs); pressed; inactive window (grey) |
| Back / Forward | enabled; disabled; hover; pressed; focus-visible |
| Title "Documents" and path bar `/ › home › student › Documents` | default; segment hover; drag-over drop target; overflow collapse `…`; current segment bold |
| View switcher (Icons, **List**, Columns, Gallery) | selected thumb (accent); hover; focus-visible |
| Sort menu button, Share button | default; hover; pressed; menu open; disabled (Share with no selection) |
| Search field "Search" | empty; focused (ring, model warm-up); typing; clear button |

### Sidebar

| Element | States |
|---|---|
| Favourites: Home, **Documents** (selected), Downloads, Recent | default; hover; selected (accent tint); focus-visible; drop target |
| Locations: `/`, `/tmp`, `/mnt` | default; selected; unmounted (dimmed) |
| Tags: urgent (red), review (orange), capstone (violet), notes (blue), done (green) | default; hover; filter active (`aria-pressed`); each dot always paired with its name |

### File list (data grid)

| Element | States |
|---|---|
| Column headers Name ▲, Date Modified, Size, Kind, Permissions | default; hover (fill + chevron preview); sorted ascending / descending (chevron, bold label); focus-visible; resize handle hover (col-resize cursor, 1 px accent line); dragging a column to reorder |
| Rows (name with file icon, date, size, kind, mono permissions) | default; zebra stripe; hover (4% fill); focus-visible (ring inside the row); **selected, window focused** (solid `#5E5CE6`, white text, permissions string also white); selected, window unfocused (accent-subtle, normal text); multi-selected (contiguous rows share one rounded block); context-target (1 px accent outline, as on `kernel-notes.txt`); cut (50% opacity); drag source (dimmed); folder drop target (accent outline, spring-load after 700 ms); renaming (inline text input with the name selected without the extension); locked by another user (lock badge + "Locked by alice" tooltip); no read permission (dimmed name, lock icon, opens with an `EACCES` banner) |
| Loading | 8 static skeleton rows after 150 ms (no shimmer loop) |
| Empty folder | centred "This folder is empty" + "Drop files here or press ⌘N for a new folder" |
| Error | in-window banner `role="alert"`: "You don't have permission to open /home/alice (EACCES)" with Back; or "Couldn't load this folder (EIO)" with Retry |
| Sync conflict | row badge "2 versions", opens the conflict sheet |

### Context menu (open on `kernel-notes.txt`)

| Item | Shortcut | States |
|---|---|---|
| Open | ⌘O | default; highlighted (accent pill, white text); focus via arrow keys |
| Open With › (Editor, Terminal for `.sh`, Choose…) | — | submenu closed / open (after 200 ms hover intent or →) |
| Get Info | ⌘I | shown **hovered** in the mock |
| Rename | Enter | default; disabled without `w` on the parent directory |
| Copy | ⌘C | default |
| Change Permissions… | — | enabled for owner/root; disabled with reason for others |
| Lock for Editing | — | enabled; "Unlock" when locked by you; disabled "Locked by alice" when locked by someone else |
| Move to Trash | ⌘⌫ | **destructive red** label and icon; highlighted red pill on hover; disabled without `w` on the parent directory |
| Separators | — | hairline, not focusable |

Menu container states: opening, open, submenu open, closing, typeahead (typing "g" jumps to Get Info).

### Status bar

`42 items · 1.2 GB of 2 GB quota used` + quota bar (60%, accent) + `student · /home/student/Documents` on the right. States: normal (< 80%); warning ≥ 80% (orange bar, "Quota nearly full"); danger ≥ 95% (red bar, "Free up space"); selection active ("1 of 42 selected, 1.8 MB").

## Intended animations

Motion tokens from `ui-design-system.md` §3.6 (`--pl-motion-fast` 120 ms, `--pl-motion-med` 200 ms, `--pl-motion-slow` 320 ms, `--pl-ease`, `--pl-ease-in`, `--pl-ease-out`), plus the new spring tokens proposed for the macOS direction (same as the dark Files screen):

```css
--pl-motion-window: 240ms;
--pl-ease-spring: linear(0, 0.034 2.2%, 0.135 4.6%, 0.29 7.3%, 0.52 11.2%, 0.74 15.8%, 0.88 20.4%, 0.96 25.4%, 1.01 31%, 1.025 36.8%, 1.02 44%, 1.006 55%, 0.999 70%, 1);
--pl-ease-pop: cubic-bezier(.34, 1.36, .64, 1);
```

Only `transform` and `opacity` animate; nothing loops; every token is 0 ms under reduced motion (DSN-05).

| # | Element | Trigger | Properties | Duration | Easing | Reduced-motion fallback |
|---|---|---|---|---|---|---|
| 1 | Context menu | Right-click, Shift+F10 or the Menu key | `opacity: 0 → 1`, `transform: scale(.96) translateY(-4px) → scale(1) translateY(0)`, `transform-origin` at the pointer | 120 ms open | `--pl-ease-spring` | Menu appears at once |
| 2 | Context menu close | Esc, click outside, item chosen | `opacity: 1 → 0` | 100 ms | `--pl-ease-in` | Closes at once |
| 3 | Menu highlight pill | Pointer or arrow key moves between items | FLIP: pill `transform: translateY(Δ) → 0` | 80 ms | `--pl-ease` | Pill jumps |
| 4 | Menu item confirm | Item activated | highlight pill `opacity 1 → 0 → 1` once (the classic confirmation blink), then close (row 2) | 90 ms | linear | No blink; menu closes at once |
| 5 | Submenu "Open With" | 200 ms hover intent or → | `transform: translateX(-6px) → 0`, `opacity 0 → 1` | 120 ms | `--pl-ease-out` | Submenu appears at once |
| 6 | Row selection | Click or arrow keys | selected background pseudo-element `opacity 0 → 1`; for keyboard moves, FLIP `translateY(Δ) → 0` on the selection block | 120 ms | `--pl-ease` | Selection moves at once |
| 7 | Row hover | Pointer enters row | hover fill `opacity 0 → 1` | 80 ms | linear | Fill shown at once |
| 8 | Sort change | Header click | chevron `transform: rotate(0 → 180deg)`; visible rows FLIP `translateY(Δ) → 0`, 8 ms stagger, max 20 rows | 200 ms chevron, 320 ms rows | `--pl-ease-spring` | Chevron and rows change at once; status region announces "Sorted by Name, ascending" |
| 9 | View switcher | Choose another view | thumb `transform: translateX(Δ) → 0`; old view `opacity 1 → 0`, new view `opacity 0 → 1` | 200 ms thumb, 120 ms cross-fade | `--pl-ease-spring` / `--pl-ease` | Thumb and view swap at once |
| 10 | Folder navigation | Open a folder, Back, Forward | list `transform: translateX(±12px) → 0`, `opacity 0 → 1` (direction-aware); path bar segment slides in from the left | 200 ms | `--pl-ease-spring` | Content swaps at once |
| 11 | Move to Trash | Menu item or ⌘⌫ | row `transform: translateX(12px)`, `opacity 1 → 0`; rows below FLIP `translateY(+28px) → 0`; dock Trash icon `translateY(-6px) → 0` once and swaps to the full glyph; undo toast slides in `translateY(-8px) → 0`, `opacity 0 → 1` | 160 ms row, 200 ms reflow, 320 ms dock | `--pl-ease-in` row, `--pl-ease-spring` reflow, `--pl-ease-pop` dock | Row removed at once; toast appears at once; status region announces "Moved kernel-notes.txt to Trash. Undo with ⌘Z" |
| 12 | Inline rename | Rename item or Enter | input `opacity 0 → 1` over the label; on a name clash, input `translateX(0 → -4 → 4 → -2 → 0)` once | 120 ms, 240 ms shake | `--pl-ease-out`, linear | No shake; the error line and `role="alert"` explain the clash |
| 13 | Lock badge | Lock for Editing succeeds | lock icon `transform: scale(.6) → scale(1)`, `opacity 0 → 1`; shackle `translateY(-2px) → 0` | 200 ms | `--pl-ease-pop` | Badge appears at once |
| 14 | Get Info panel | Get Info or ⌘I | info window `transform: scale(row rect → 1)`, `opacity 0 → 1`, origin at the row | 240 ms | `--pl-ease-spring` | Panel appears at once |
| 15 | Quota bar | Window open, quota change | fill `transform: scaleX(0 → .6)`, `transform-origin: left` | 320 ms | `--pl-ease-spring` | Drawn at its final value |
| 16 | Drag and drop | Drag a row | drag image `transform: scale(1.02)`, shadow `opacity 0 → 1`; folder spring-load pulse `scale(1 → 1.02 → 1)` once at 700 ms | 120 ms, 200 ms pulse | `--pl-ease`, `--pl-ease-pop` | No scale or pulse; the drop target is still outlined |
| 17 | Window open | Launch Files from the dock | `transform: scale(.94) → scale(1)`, `opacity 0 → 1`, origin at the dock icon | 240 ms | `--pl-ease-spring` | Appears at once |

## Accessibility landmarks and roles

- **Window:** `<section role="dialog" aria-modal="false" aria-labelledby="t{wid}">` with the heading "Documents" as `t{wid}`.
- **Toolbar:** `role="toolbar"` labelled "Files toolbar"; the view switcher is a `radiogroup`; the path bar is `<nav aria-label="Path">` with `aria-current="location"` on "Documents".
- **Sidebar:** `<nav aria-label="Places">` with groups for Favourites, Locations and Tags; "Documents" has `aria-current="page"`; tag buttons use `aria-pressed`.
- **File list:** `role="grid"` labelled "Documents, 42 items", `aria-multiselectable="true"`, `aria-rowcount="42"` (virtualised). Column headers are `role="columnheader"` with `aria-sort="ascending"` on Name and buttons inside for sorting. Rows are `role="row"` with `aria-selected`; cells are `role="gridcell"`. Arrow keys move, Space toggles selection, Shift extends, Enter renames, ⌘O opens.
- **Context menu:** `role="menu"` with `aria-label="Actions for kernel-notes.txt"`; items `role="menuitem"`; "Open With" has `aria-haspopup="menu"` and `aria-expanded`; disabled items use `aria-disabled="true"` and stay focusable with their reason in `aria-describedby`; separators `role="separator"`. Focus moves into the menu on open and returns to the row on close; typeahead is supported. Shortcuts are exposed through `aria-keyshortcuts`.
- **Destructive item:** "Move to Trash" is never the default; its red colour is paired with the trash icon and the word "Trash".
- **Status bar:** `role="status"` region for selection counts, sort changes and trash/undo messages (rate-limited to one per 2 s). The quota bar is `role="progressbar"` (or `meter`) with `aria-valuenow="60"`, `aria-valuetext="1.2 GB of 2 GB used"`.
- **Contrast:** row text on the zebra stripe and on the selected accent row meets WCAG 2.2 AA (white on `#5E5CE6` is 4.9:1); secondary labels on frosted white glass use at least 60% black.
