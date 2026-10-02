# Desktop (dark)

- **Stitch project:** 12849137298552292712
- **Stitch screen id:** none. Generation timed out and no screen was ever listed (see Status below)
- **Design system:** Plotinium Glass (Dark), `assets/10121591451242352758`
- **Model:** GEMINI_3_8_FLASH, device DESKTOP (1440 x 900)
- **Files:** `reference.html` (hand-built, animated reference render, NOT a Stitch export), `reference.png` (1440 x 900 capture of it), `screen.json` (record of the failed Stitch call)
- **Specs:** [ui-design-system.md](../../../../specs/05-wm/ui-design-system.md) §3.6 (motion), §3.8.7 (desktop, taskbar, launcher), §3.8.8 (window chrome); [window-manager.md](../../../../specs/05-wm/window-manager.md) (focus, z-order, minimise and restore, tray, OFF-04)

## Status: Stitch generation failed; a hand-built reference stands in

- `mcp__stitch__generate_screen_from_text` was called once (projectId 12849137298552292712, DESKTOP, design system assets/10121591451242352758, GEMINI_3_8_FLASH) at about 15:17 UTC on 2026-09-24. The call timed out, as the tool warns it may, and was **not retried**.
- `mcp__stitch__list_screens` was then polled 10 times at 30-second intervals, and about 8 more times at 60 to 90 seconds, until 15:52 UTC. Every call returned `{}`. `get_project` kept `updateTime` at 15:22:02 UTC throughout, so no new screen was saved. Other agents in this run hit the same problem (for example, `files-light` got only a `sessionId` back). No screen id means `get_screen` and `edit_screens` could not be called, so there is no `screen.html` or `screenshot.png`. See `screen.json` for the record.
- **Fallback:** `reference.html` is a hand-built, working, animated render of the prompt below, built on the project's design system (Plotinium Glass tokens, Inter plus JetBrains Mono, #5E5CE6). `reference.png` is a 1440 x 900 Playwright capture of it, taken after the entrance animations settle. It is **not a Stitch export**, and the HTML file says so in a header comment.
- **To regenerate in Stitch later:** run the prompt below once. When `list_screens` shows a screen titled "Plotinium Desktop — Dark", download `htmlCode.downloadUrl` to `screen.html` and `screenshot.downloadUrl` to `screenshot.png` next to this file, then fill in the screen id above.

### Review of the reference render (read from `reference.png`)
- **Branding:** atom logo (glowing nucleus and two orbits) in the menu bar; Plotinium names only (Files, Terminal, Editor, Task Manager, Settings, Search, Control Centre). No Apple marks, no SF Symbols (lucide-style strokes), no hazard symbols. ✔
- **Menu bar:** bold "Files" plus File, Edit, View, Go, Window, Help. The status area has sync with a green dot, the AI pill, the memory glyph with "142/256 MB", Control Centre, Search, and "Thu 24 Sep 10:42". ✔
- **Windows:** the focused Files window has an inset floating vibrancy sidebar (Favourites, Locations, Tags) and 11 rows (the prompt's 7 plus lab3-paging.md, sync-protocol.md, kernel-panic.png and todo.txt, so the list doesn't look empty; the status bar reads "11 items"). Terminal sits behind at the upper right with `ls -la` output and a violet block cursor. Task Manager is furthest back, at the lower right, with the CPU sparkline, a memory progress bar, and pids 1/2/7/12/23/41/44 with ai.indexer at priority 32 highlighted. Unfocused windows have grey traffic lights and a 16% dim layer. ✔
- **Dock:** our own squircle icons; running dots under Files, Terminal and Editor; Files magnified by the demo hover with a "Files" tooltip. ✔
- **Contrast:** body text sits on glass tints of at least 62% opacity. The first pass used 38% white for tertiary labels (column headers, section headings), which is below AA at 11-12 px, so the reference now uses `--label-2` 66% and `--label-3` 55%. Carry these values into the tokens file and verify them with the DSN-03 contrast test over the darkest and lightest wallpaper regions.
- **Deviations from the prompt's geometry:** Files is 800 x 548 at (72, 132); Terminal is at the upper right (856, 58); Task Manager is at (858, 412). Overlaps are kept small so the Terminal text stays readable.

### What the reference implements (open `reference.html` in Chrome)
- Entrance: the menu bar slides down, the dock springs up, the dock icons stagger in, and the windows scale in from 0.94 in back-to-front order.
- Dock magnification that follows the pointer, using transform only: icons re-flow outwards and the glass capsule stretches with `scaleX`. It also has tooltips, a press scale, a single launch bounce for apps that aren't running, and running dots.
- Clicking a window focuses and raises it, crossfades its shadow layer, and swaps the bold app name and app menus in the menu bar. Windows can be dragged by the title bar; double-clicking it zooms.
- Traffic lights reveal their glyphs on hover. Close fades and scales out; minimise is a genie-like move into the dock icon; clicking the dock icon restores it; zoom uses a FLIP transform.
- Menus (atom menu, app menu and each menu title) open with a fade and a 4 px slide, open neighbours on hover while a menu is open, and close on `Esc`. The Control Centre popover has glass tiles.
- Reduced motion: every duration is multiplied by `--pl-k` (0 under `prefers-reduced-motion` or `data-motion="reduce"`), JavaScript animations are skipped, and there is no dock magnification. Playwright smoke test: menus, minimise and restore, close and reopen, and Control Centre all pass in both themes; under reduced motion, 0 running animations with a non-zero duration; no page errors.


## Final prompt

```text
Screen title: "Plotinium Desktop — Dark". A full 1440x900 desktop of Plotinium, an AI-native web operating system, in DARK mode. Visual language: premium Liquid-Glass-era desktop OS — layered translucent frosted glass (backdrop blur 30-40px, saturation boost), 1px inner hairline highlights on glass edges, very large soft diffuse shadows, generous 12-16px corner radii, crisp Inter typography, violet accent #5E5CE6. Use lucide-style thin line icons only. NO Apple logo, NO apple-style product names, NO SF Symbols. No radiation or hazard symbols anywhere.

WALLPAPER: a deep luminous abstract field — midnight navy (#0B0D1F) flowing into rich violet (#3B2A8C) and indigo glows, with soft aurora ribbons of #5E5CE6 and a faint magenta bloom lower right. Smooth, no stock photos.

MENU BAR (top, full width, 28px tall, translucent dark glass with blur, thin bottom hairline):
- Left: a small Plotinium logo glyph (an abstract luminous atom: bright white-violet nucleus dot with two thin elliptical orbits crossing, in #5E5CE6), then the bold app name "Files", then menus "File", "Edit", "View", "Go", "Window", "Help" in 13px medium white text.
- Right status items in order, 13px, evenly spaced: a cloud-sync icon with a tiny green status dot; an "AI" pill with a small sparkle icon (violet); a small memory meter bar glyph with text "142/256 MB"; a Control Centre toggle icon (two stacked sliders/switches); a search magnifier icon; and the clock "Thu 24 Sep 10:42".

WINDOWS (three overlapping glass windows, each with traffic-light controls at top-left: red close, amber minimise, green zoom circles 12px):
1) FOCUSED "Files" window, front and centre-left (about 860x540, positioned x≈300, y≈150), with a very large soft shadow (0 30px 80px rgba(0,0,0,.55)) and full-opacity glass. Title bar shows back/forward chevrons, the path "/home/student/notes", a view-mode segmented control (list/grid), and a search field "Search in notes". Left vibrancy SIDEBAR (translucent, 200px) with section headers in small caps grey: "FAVOURITES": Home (selected, violet pill highlight), Documents, Downloads, Recent; "LOCATIONS": "/" (root), "/tmp", "Shared"; "TAGS": coloured dots Violet "Report", Green "DSA", Amber "Kernel". Main area: a file LIST table with columns Name, Size, Kind, Modified, Owner. Rows: "os-report.md" 18 KB Markdown "Today 10:31" student (selected row, violet highlight); "scheduler-notes.md" 6 KB Markdown "Yesterday 22:14" student; "vfs-design.pdf" 1.2 MB PDF "22 Sep" alice; "boot-log.txt" 4 KB Text "Today 09:58" student; "dsa/" folder "—" Folder "21 Sep" student; "screenshots/" folder "—" Folder "20 Sep" bob; "ai-index.json" 88 KB JSON "Today 10:40" student. Use small lucide file/folder icons with violet folders. Bottom status strip: "7 items · 3.1 GB available · Synced".
2) "Terminal" window behind it, to the upper right (about 620x380 at x≈760, y≈80), slightly dimmer (unfocused: 85% opacity, greyed traffic lights), dark glass with monospace JetBrains Mono 12px text:
"student@plotinium:~$ ls -la"
"total 48"
"drwxr-xr-x  6 student staff  4096 Sep 24 10:31 ."
"drwxr-xr-x  4 root    root   4096 Sep 20 08:00 .."
"-rw-r--r--  1 student staff   220 Sep 20 08:00 .profile"
"drwxr-xr-x  3 student staff  4096 Sep 24 10:31 notes"
"drwxr-xr-x  2 student staff  4096 Sep 21 17:02 dsa"
"-rw-r--r--  1 student staff  4011 Sep 24 09:58 boot-log.txt"
"student@plotinium:~$ " with a blinking violet block cursor. Tabs at top: "zsh — student" active.
3) Small "Task Manager" window further behind at the lower right (about 420x300 at x≈1000, y≈480), dimmest (unfocused). Shows a CPU sparkline chart in violet with area gradient, "CPU 23%", "Memory 142 MB of 256 MB" bar, and a mini process list: init pid 1, sched pid 2, vfs pid 7, syncd pid 12, ai.indexer pid 23 (priority 32), terminal pid 41, files pid 44.

DOCK (bottom centre, floating 12px above the bottom edge, rounded 22px glass capsule with blur and hairline border, ~64px tall): our own rounded-square app icons (squircles, 52px) with rich gradients and simple line glyphs: Files (violet-blue folder), Terminal (black with ">_" prompt), Editor (white-lavender with a pen nib), Task Manager (teal with a pulse/activity line), Settings (graphite with a gear), Search (violet with a magnifier and sparkle), then a thin vertical separator, then Trash (translucent bin). Small white running-indicator dots under Files, Terminal and Editor. Files icon slightly magnified as if hovered, with a small dark-glass tooltip "Files" above it.

Overall: calm, luxurious, highly detailed, readable contrast, pixel-perfect alignment.
```

## Spec alignment notes (read before building)

- **Menu bar and dock replace the spec's single taskbar.** `ui-design-system.md` §3.8.7 still describes a 44 px bottom taskbar with a tray, and §3.8.8 puts window controls on the right. The design direction has changed to a macOS-style layout: a 28 px top **menu bar** and a floating bottom **dock**, with traffic-light controls on the **left**. When the spec is updated, map the requirements across like this:
  - the taskbar's app groups (WMD-10: group by app id, count badge, background-activity dot, attention flash, click toggles focus or minimise) become **dock items**;
  - the tray (connectivity and degraded services for OFF-04, the memory meter, "Restart to update" for OFF-05) moves to the **menu-bar status area**;
  - the launcher button becomes the **atom menu** plus **Search** (`Ctrl+Space`).
- **Work area.** With a top bar and a floating dock, `work = { x: 0, y: 28, w: innerWidth, h: innerHeight - 28 - dockReserve }`. Maximised windows must stop above the dock (WCAG 2.4.11, focus not obscured). An auto-hide dock can come later; v1 keeps it fixed.
- **Shadows.** The mock's focused-window shadow (about `0 30px 80px rgb(0 0 0 / .55)`) is larger than `--pl-shadow-win-focus` (`0 10px 32px`). Update the token rather than hard-coding the value (DSN-02).
- **Radius.** The mock uses about 12 px for windows. `--pl-radius-win` is 10 px; either value is fine, as long as the token is the one place it is set.
- **No looping animation** (spec §3.6, WCAG 2.2.2). The wallpaper is static, and the only thing that loops is the Terminal cursor blink, which stops under reduced motion. Each status-item "pulse" plays once, never on a loop.
- **Only `transform` and `opacity` animate.** Blur values are never animated: `backdrop-filter` is fixed per surface, and glass panels fade in with their blur already set.

## UI elements and states

### Wallpaper
| Element | States |
|---|---|
| Desktop background (static navy-to-violet field, `aria-hidden`) | default only. Clicking empty desktop blurs every window: the menu bar shows "Plotinium" in bold, and the selection is cleared. |

### Menu bar (`role="menubar"`, 28 px, glass)
| Element | States |
|---|---|
| Atom logo menu (About Plotinium, Settings…, Lock screen, Log out student…, Restart, Shut down) | default; hover (`--pl-surface-3` pill behind the glyph); focus (3 px accent ring); open (pressed pill, menu below) |
| App name "Files" (bold, the focused app's menu) | as above; the label crossfades when the focused app changes |
| Menus: File, Edit, View, Go, Window, Help | default; hover; focus; open; disabled items inside greyed (`aria-disabled`); keyboard: `F10` focuses the bar, arrow keys move, `Esc` closes |
| Sync / connectivity status (cloud icon + dot) | online-synced (green dot); syncing (arrows glyph, one pulse per change); offline (grey dot + "Offline" text in the popover); conflict (amber dot + count); error (red dot). The meaning is never shown by colour alone: the popover and `aria-label` spell it out. |
| AI status pill (sparkle + "AI") | idle; indexing (shows "Indexing 42%" in the popover); disabled by the user (struck-through sparkle, "AI off"); error (key or quota problem, red text) |
| Memory meter "142/256 MB" | normal (< 70%); warning (≥ 85%, amber); critical (≥ 95%, red, with a one-shot pulse); hover shows a popover with the top 3 processes |
| Degraded-services badge (hidden when healthy) | appears when a non-critical service is down, e.g. "syncd degraded", and opens a list (OFF-04) |
| Control Centre toggle | default; hover; open (panel below the right edge) |
| Search magnifier | default; hover; pressed opens the Search palette (`Ctrl+Space`) |
| Clock "Thu 24 Sep 10:42" | default; click opens Notifications and the calendar; updates each minute without animation |

### Dock (`role="toolbar"`, `aria-label="Dock"`, floating glass capsule)
| Element | States |
|---|---|
| App icons: Files, Terminal, Editor, Task Manager, Settings, Search | default; hover (magnify, tooltip label above); focus (accent ring round the icon, tooltip shown); pressed (scale 0.92); launching (one bounce); running (dot below); attention (one bounce plus a badge); count badge (for example `2` windows) |
| Separator | static |
| Trash | empty; has items (bin glyph filled); drop target (highlighted while a file is dragged over it) |
| Tooltip ("Files") | appears after a 300 ms hover or at once on keyboard focus |

### Windows (`role="dialog" aria-modal="false"`, labelled by their title)
| Element | States |
|---|---|
| Traffic lights (close, minimise, zoom; 12 px circles with 24 px hit targets) | default (coloured when focused); unfocused (grey); group hover (the glyphs x, −, ⤢ appear); pressed (darker); disabled (for example zoom on a fixed-size window, drawn hollow) |
| Title bar / unified toolbar | focused (full-opacity glass, label `--pl-text`); unfocused (dimmed, label `--pl-text-muted`); dragging (cursor grab); double-click maximises |
| Focused **Files** window | back and forward chevrons (disabled at history ends); path "/home/student/notes"; list/grid segmented control; search field (empty, typing, no results) |
| Files sidebar (vibrancy) | Favourites: Home (selected), Documents, Downloads, Recent; Locations: `/`, `/tmp`, Shared; Tags: Report, DSA, Kernel. Each item: default, hover, selected, focus, drop target |
| Files list (APG grid) | columns Name, Size, Kind, Modified, Owner with `aria-sort`; rows: default, hover, selected (accent), multi-select, renaming (inline input), cut (50% opacity), loading (skeleton rows), empty folder ("This folder is empty"), error ("Permission denied: /root") |
| Files status strip | "7 items · 3.1 GB available · Synced" (status updates in a `role="status"` region) |
| **Terminal** window (unfocused) | tab "zsh — student"; `ls -la` output; block cursor (blinks only when the window is focused, and not under reduced motion) |
| **Task Manager** window (unfocused) | CPU sparkline (redraws each second, with no animation when unfocused or under reduced motion); memory bar `role="progressbar"`; mini process list (init 1, sched 2, vfs 7, syncd 12, ai.indexer 23 at priority 32, terminal 41, files 44) |

## Intended animations

Each duration maps to a motion token. The two spring curves below are proposed additions, `--pl-ease-spring` and `--pl-ease-spring-soft`; everything else uses the existing `--pl-ease*` tokens. Under `prefers-reduced-motion: reduce` or `:root[data-motion="reduce"]` every motion token is 0 ms (DSN-05), so the fallback column says what the user still sees.

```css
/* proposed tokens */
--pl-ease-spring: linear(0, 0.009, 0.035 2.1%, 0.141 4.4%, 0.723 12.9%, 0.938 16.7%, 1.017 19.4%, 1.067, 1.089 24.9%, 1.085 27.6%, 1.043 34.9%, 1.005 45.3%, 0.994 52.3%, 1.001 72.3%, 1);
--pl-ease-spring-soft: cubic-bezier(.32, 1.28, .5, 1);   /* gentle overshoot for small items */
```

| # | Element | Trigger | Properties (transform, opacity only) | Duration | Easing | Reduced-motion fallback |
|---|---|---|---|---|---|---|
| 1 | Menu bar | Desktop first paint after login | `translateY(-100%)` → `0`, opacity 0 → 1 | 320 ms, 80 ms delay | `--pl-ease-out` | Appears at once |
| 2 | Dock | Desktop first paint after login | `translateY(24px) scale(.96)` → `none`, opacity 0 → 1 | 420 ms, 140 ms delay | `--pl-ease-spring` | Appears at once |
| 3 | Dock icons | Same, staggered left to right | `translateY(8px)` → `0`, opacity 0 → 1 | 240 ms each, 30 ms stagger | `--pl-ease-spring-soft` | Appear at once |
| 4 | Dock magnification | Pointer moves over the dock | icon `scale(1)` → up to `scale(1.45)` under the pointer, with neighbours at 1.2 and 1.08 and a `translateY` lift of up to −10 px; driven by pointer x with rAF, no transition while tracking | follows the pointer; 200 ms settle on leave | `--pl-ease-spring` on leave | No magnification; hover shows the tooltip only |
| 5 | Dock tooltip | Hover 300 ms or keyboard focus | `translateY(4px) scale(.96)` → `none`, opacity 0 → 1 | 120 ms | `--pl-ease` | Opacity only, 0 ms |
| 6 | Dock icon press | pointerdown / pointerup | `scale(.92)` then back to `scale(1)` | 90 ms down, 200 ms up | `--pl-ease` down, `--pl-ease-spring-soft` up | No scale; the pressed state shows as a darker tint |
| 7 | Dock launch bounce | App launched, until its first window appears (at most 1 bounce) | `translateY(0 → -14px → 0)` | 480 ms, played once | `--pl-ease-spring` | No bounce; the running dot appears at once |
| 8 | Running dot | Process starts or exits | `scale(0)` → `1`, opacity 0 → 1 (reversed on exit) | 200 ms | `--pl-ease-spring-soft` | Appears or disappears at once |
| 9 | Attention bounce (WMD-09) | Background window asks for focus | `translateY(0 → -10px → 0)`, 2 bounces, then stops | 2 × 360 ms | `--pl-ease-spring` | No bounce; a count badge plus a `role="status"` announcement |
| 10 | Window open | Window created | `scale(.94) translateY(8px)` → `none`, opacity 0 → 1; the origin is the dock icon's rectangle when launched from the dock | 240 ms | `--pl-ease-spring` | Appears at once |
| 11 | Window close | Close clicked | `scale(1)` → `scale(.96)`, opacity 1 → 0 | 160 ms | `--pl-ease-in` | Disappears at once |
| 12 | Window minimise (genie-like) | Minimise clicked | `translate()` toward the dock icon's centre plus `scale(.12)`, opacity 1 → 0.2 → 0; the rectangle is read at animation start (R-READ) | 320 ms | `cubic-bezier(.5, 0, .7, .4)` | Hidden at once; the dock item shows a minimised marker |
| 13 | Window restore | Dock click on a minimised window | The reverse of #12 | 320 ms | `--pl-ease-spring` | Appears at once |
| 14 | Window maximise / restore size | Zoom button or title-bar double-click | FLIP: the frame animates `transform` from the old rectangle to the new one; the content is painted at the final size | 240 ms | `--pl-ease-spring` | Jumps to the new size |
| 15 | Focus change | Window raised | the incoming window's shadow layer (a pseudo-element) goes opacity .45 → 1 while the outgoing one goes 1 → .45; content dim overlay 0.12 → 0 | 160 ms | `--pl-ease` | Instant swap |
| 16 | Traffic-light glyphs | Pointer enters the 3-button group | glyph opacity 0 → 1, `scale(.6)` → `1` | 120 ms | `--pl-ease` | Glyphs appear at once |
| 17 | Menu open | Click a menu title or press `F10` then `Enter` | menu `translateY(-4px) scale(.98)` → `none`, opacity 0 → 1, origin top-left | 140 ms | `--pl-ease-out` | Appears at once |
| 18 | Menu close | Select, `Esc` or outside click | opacity 1 → 0 | 100 ms | `--pl-ease-in` | Disappears at once |
| 19 | Menu item select | Item chosen | the highlight blinks once (opacity 1 → 0.4 → 1) before closing | 120 ms | linear | No blink |
| 20 | App name in menu bar | Focused app changes | old label opacity 1 → 0 with `translateY(-3px)`; new label opacity 0 → 1 from `translateY(3px)` | 160 ms | `--pl-ease` | Instant text swap |
| 21 | Status popovers (sync, AI, memory, clock) | Click a status item | `translateY(-6px) scale(.97)` → `none`, opacity 0 → 1, origin top-right | 180 ms | `--pl-ease-spring-soft` | Appears at once |
| 22 | Control Centre panel | Toggle click | `translateY(-8px) scale(.96)` → `none`, opacity 0 → 1; its tiles are staggered 20 ms | 240 ms | `--pl-ease-spring` | Appears at once |
| 23 | Sync state change | `net.state` or sync event | the status dot goes `scale(1)` → `scale(1.6)` → `1` once; the glyph crossfades (opacity) | 320 ms, once | `--pl-ease` | Glyph swaps at once and a `role="status"` announcement is made |
| 24 | Memory meter threshold | Crosses 85% or 95% | bar fill `scaleX` from the old to the new value (never `width`); a one-shot pulse (opacity 1 → .5 → 1) at 95% | 200 ms; pulse 320 ms | `--pl-ease` | The value updates at once |
| 25 | AI indexing | AI indexer starts or finishes | the sparkle rotates once (`rotate(0)` → `rotate(180deg)`) and fades from .6 to 1 | 400 ms, once | `--pl-ease-spring-soft` | Static glyph; the popover text changes |
| 26 | Files row hover and selection | Pointer and keyboard | the selection highlight slides between rows (`translateY` of a shared highlight layer) | 120 ms | `--pl-ease` | Instant highlight |
| 27 | Files view switch (list ↔ grid) | Segmented control | the old view opacity 1 → 0 while the new one goes 0 → 1 with `scale(.98)` → `1` | 180 ms | `--pl-ease` | Instant swap |
| 28 | Segmented control thumb | Selection change | the thumb `translateX` to the new segment | 200 ms | `--pl-ease-spring-soft` | Jumps |
| 29 | Task Manager sparkline | Every 1 s sample | the path layer `translateX(-step)`, then resets (no easing between samples when unfocused) | 1000 ms | linear | Redraws without sliding |
| 30 | Terminal cursor | Terminal focused | opacity blink (xterm default) | 1060 ms period | step | Off (`cursorBlink = false`) |
| 31 | Keyboard focus ring | Focus moves | ring opacity 0 → 1, `scale(1.04)` → `1` | 120 ms | `--pl-ease` | Ring appears at once |

## Accessibility landmarks and roles

- `header` containing the menu bar: `role="menubar"` with `aria-label="Application menu"`, and each top-level item `role="menuitem"` with `aria-haspopup="menu"` and `aria-expanded`. The status items are a separate `role="group"` with `aria-label="Status"` (not menu items), each a button with a full `aria-label` such as "Sync: online, all changes synced" or "Memory: 142 of 256 megabytes used". There is one polite `role="status"` live region for sync, AI and degraded-service changes (WCAG 4.1.3).
- `main` is the desktop work area containing the windows; the wallpaper is `aria-hidden="true"`.
- Each window is `role="dialog" aria-modal="false"` with `aria-labelledby` pointing at the title. The traffic lights are real `button` elements with `aria-label` "Close Files", "Minimise Files" and "Zoom Files", each with a 24 x 24 px hit target (WCAG 2.5.8) even though the circle is 12 px.
- `nav` with `aria-label="Dock"` wraps a `role="toolbar"` with roving tabindex (arrow keys move, `Enter` launches or focuses, `Shift+F10` opens the item menu). Running state is spoken: "Files, running, 1 window".
- Files sidebar: `nav` with `aria-label="Places"` and `role="tree"` sections. The file list uses the APG `grid` pattern with `aria-sort` and `aria-selected`.
- Task Manager: the sparkline is `role="img"` with an `aria-label` summary ("CPU 23%, steady"); memory is `role="progressbar"`; the process list is a `grid`.
- Terminal: xterm with `screenReaderMode` taken from Settings.
- Keyboard: `Alt+N` focuses the dock, `F10` the menu bar, `Ctrl+Space` opens Search, and `Alt+Tab` opens the window switcher (a `listbox`).
- Contrast: all text sits on a glass tint of at least 55% opacity (AA 4.5:1). Under `prefers-reduced-transparency` or the Settings override, glass becomes a solid `--pl-surface`. Under forced colours, shadows become 1 px `CanvasText` borders.
