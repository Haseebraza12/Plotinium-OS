# Overview and App Switcher (dark)

- **Stitch project:** 12849137298552292712
- **Stitch screen id:** none. Generation returned only a session id and no screen appeared (see `screen.json`).
- **Design system:** Plotinium Glass (Dark), `assets/10121591451242352758`
- **Model:** GEMINI_3_8_FLASH, device DESKTOP (1440 x 900)
- **Files:** `screen.json` (Stitch outcome record), `reference.html` + `reference.png` (hand-built render of the same prompt; NOT a Stitch export). `screen.html` / `screenshot.png` are absent because Stitch returned no screen.
- **Specs:** [window-manager.md](../../../../specs/05-wm/window-manager.md) §3.9 (keyboard shortcuts, WM-07), §3.12 (window–process coupling and paging), §3.18 (frame meter), §3.19 (accessibility); [ui-design-system.md](../../../../specs/05-wm/ui-design-system.md) §3.6 (motion), §3.8.7 (window switcher overlay)

## Review notes

**No Stitch render exists for this screen.** `generate_screen_from_text` was called once (15:33Z) and returned only a session id (`1160210699169062467`), no screen id. Per the run rules it was not retried; `list_screens` stayed `{}` on 10 polls over about 15 minutes (the same outage the sibling screens hit), so `get_screen`, the downloads and `edit_screens` were impossible. `screen.json` records this. `reference.html` is a hand-built render of the prompt below with the Plotinium Glass (Dark) tokens, and `reference.png` is its 1440 x 900 Chromium capture (Playwright), labelled "NOT a Stitch export". It is built the way the notes say Overview should be built: each window is a full-size window DOM scaled with `transform` only, and on load each one FLIPs from a "desktop" rectangle into its slot with the spring curve. `Alt+`` ` / `Alt+Shift+`` ` (and `Alt+J` / `Alt+K`) move the switcher plate and update the `listbox` announcement, the arrow keys move the grid selection, and it runs with and without `prefers-reduced-motion` with no console errors.

Checked on `reference.png`:
- Dimmed (45%) and blurred wallpaper; the blur is a static pre-blurred layer that only fades.
- Desktops strip: "Desktop 1" (active, violet outline, miniature windows), "Desktop 2", the round "+" button; the Overview key hint (`Alt` `O`) at top right.
- Five windows with real-looking content and traffic lights: Files — notes (sidebar, 6 files including `report (conflict from bob).md`), Terminal — ~ (`ps` with init 1, sched 7, vfs 9, syncd 14, ai.indexer 23 at priority 32, terminal 31, files 35, violet cursor), Editor — os-report.md (heading, body, "Lock: student · Saved" footer), Task Manager (process table with ai.indexer selected, memory graph `142 / 256 MB`, reclaim line at 85%), Settings — About (atom logo, "Plotinium 0.3.0 · build a1f93c2", `student (uid 1001)`).
- Terminal is the selected option: 3 px accent outline with glow, `scale(1.03)`, close button at top-left, accent caption pill.
- Switcher HUD: five 72 px icons, Terminal on the highlight plate at `scale(1.08)`, title "Terminal ~ · 2 of 5", key hints with keycaps.
- No Apple marks or names (grep-checked); captions are 12 px semibold at 92% on about 62% glass.

Deviations and issues to settle:
1. The hint text uses `Alt+`` ` / `Alt+Shift+`` ` / `Esc` rather than the prompt's "Alt+Tab", because the host OS takes `Alt+Tab` before Chrome sees it and window-manager §3.9 binds switching to `Alt+`` `. The prompt's "Ctrl+Up · Overview" hint became the proposed `Alt+O`.
2. The faint dock under the HUD was left out: Overview slides the dock and menu bar away (animation #3), and the HUD needs the bottom edge.
3. Thumbnails are the real windows at 50%, so their text is tiny. This is intended: names come from the caption pills and each option's accessible name.
4. Desktops (spaces) are not in the v1 WM spec; the strip is drawn so the layout is reserved, but it ships behind a flag.
5. App icon style (coloured tiles against the §3.6 surface-2 tiles) needs the same decision as in `control-centre-notifications/notes.md`.

## Final prompt

```text
Plotinium OS "Overview" window switcher screen (1440x900, dark Liquid Glass style inspired by the latest macOS window overview, but with its own identity: NO Apple logo, NO Apple app names, NO SF Symbols; use thin lucide-style line icons, Inter font). Title: "Overview and App Switcher".

BACKGROUND: the Plotinium desktop wallpaper (dark navy-to-deep-violet abstract luminous gradient) heavily dimmed (about 45% black overlay) and blurred.

TOP STRIP (spaces bar): a translucent glass strip across the top center, about 120px tall. It contains two small desktop-space thumbnails side by side: "Desktop 1" (active, with a 2px violet #5E5CE6 outline and tiny window thumbnails inside) and "Desktop 2" (a nearly empty wallpaper thumbnail), with their labels beneath, and a round glass "+" button to the right for adding a desktop. Small helper text at the far right of the strip: "Ctrl+Up · Overview".

WINDOW GRID: all five open windows scaled down (about 30-40% size) and tiled across the middle of the screen in two rows with generous even gaps, each with a soft large shadow, 12px corner radius and a real-looking miniature of its content. Beneath each thumbnail: a small rounded app icon plus the title label in a small glass pill.
1. "Files — notes": a file browser with a translucent sidebar (Home, Documents, notes, Trash) and a list: os-report.md, lecture-07-scheduling.md, lab3-vfs.png, todo.txt, with sizes and dates.
2. "Terminal — ~": a dark terminal showing "student@plotinium:~$ ps", rows: "PID PRI NAME" / "1 0 init" / "7 8 sched" / "9 8 vfs" / "14 16 syncd" / "23 32 ai.indexer" / "31 16 terminal" / "35 16 files", then a prompt with a violet cursor. This window is HIGHLIGHTED as the selected one: a 3px violet #5E5CE6 focus outline and slightly larger (hover/selected state), with a small red close "x" circle visible at its top-left corner.
3. "Editor — os-report.md": a markdown editor with heading "# OS Report — Process Scheduling", paragraphs, and a status footer "Lock: student · Saved".
4. "Task Manager": a table of processes with CPU and memory bars (init, ai.indexer 23, sched, vfs, syncd) and a small memory graph showing "142 / 256 MB".
5. "Settings — About": a settings window with a sidebar and an About pane showing a luminous violet atom logo (bright nucleus with 2-3 thin elliptical orbits) and text "Plotinium 0.3.0 · build a1f93c2".
Each window thumbnail keeps tiny traffic-light dots (red, amber, green) at its top-left.

APP SWITCHER HUD: overlaid at the bottom center, a large rounded glass pill/HUD (heavy blur, 28px radius, 1px inner light border, deep shadow) containing a horizontal row of large 72px app icons with generous spacing: Files (blue folder), Terminal (dark ">_" prompt), Editor (violet pen nib), Task Manager (green activity graph), Settings (grey gear). The Terminal icon is SELECTED: sitting on a lighter rounded-square glass highlight with a subtle violet glow, and its name "Terminal" is shown beneath it. Small hint text under the HUD: "Alt+Tab to cycle · Alt+` for windows of the same app · Esc to cancel".

No menu bar dock clutter is necessary, but keep a faint dimmed dock visible at the very bottom edge beneath the HUD. Overall: premium, cinematic, calm macOS-grade polish, readable white labels (92% opacity) on dark glass, violet accent #5E5CE6 used sparingly.
```

## Spec alignment notes (read before building)

- **Switch key is `Alt+`` `, not `Alt+Tab`.** Chrome never receives `Alt+Tab` (the host OS takes it). window-manager §3.9 binds *next window* to `Alt+`` ` (alternate `Alt+J`) and *previous* to `Alt+Shift+`` ` (alternate `Alt+K`); the switcher shows while `Alt` is held and releasing `Alt` focuses the highlighted window. All hint text in the HUD must use these keys.
- **The switcher is per window, drawn as icons.** §3.8.7 describes a 480 px list of window rows. The macOS-style HUD keeps the spec's semantics (items are *windows* in stacking order, minimised ones included) but draws each item as its app icon, with the highlighted window's title ("Terminal — ~") and state label (`minimised`, `suspended`) under the row. Two windows of the same app appear as two icons with a small window-count caption. The `listbox` announcement stays as specified: "Switch window: Terminal — student@plotinium:~, 2 of 5".
- **Overview is new.** Neither WM spec defines an Overview (all windows tiled). Proposed binding `Alt+O` (not in Chrome's reserved list checked on 2026-09-24; confirm in the W5 key audit and add it to the §3.9 table), plus a dock/menu-bar entry. No hot corner (a browser page cannot detect a screen corner reliably when not full screen).
- **Desktops (spaces) are out of v1 scope.** The top strip shows "Desktop 1", "Desktop 2" and "+". v1 has one desktop; build the strip behind a feature flag and hide it until multiple desktops exist in the WM spec (they would need a per-desktop z-order and session-layout changes in §3.15).
- **Thumbnails are the real windows.** Overview does not screenshot anything: each window element is FLIP-transformed (translate + scale) from its real rectangle into its grid slot. This is transform-only, cheap, and keeps live content (the Terminal keeps printing). Suspended or paged-out windows (§3.12) show their frozen last frame and the label `suspended`; restoring one from Overview shows "Restoring…" as specified.
- **Frame budget.** Overview with 10 windows must hold the WM-03 frame target with the frame meter on. `will-change: transform` is set on window elements only for the duration of the Overview transition and removed after.
- **Blur is never animated.** The dimmed, blurred desktop is a pre-blurred layer whose opacity animates.

## UI elements and states

### Backdrop
| Element | States |
|---|---|
| Dim + blur layer over the wallpaper (`aria-hidden`) | hidden; entering; shown (≈45% black over a fixed 30 px blur); leaving. Clicking empty backdrop exits Overview and restores the previously focused window. |
| Menu bar and dock | slid out (menu bar up, dock down) while Overview is open; the switcher HUD takes the bottom edge (the prompt's faint dock was dropped, see Review notes) |

### Desktops strip (feature-flagged, `role="tablist"`, `aria-label="Desktops"`)
| Element | States |
|---|---|
| Desktop thumbnail ("Desktop 1", "Desktop 2") `role="tab"` | active (2 px accent outline, `aria-selected="true"`); inactive; hover (scale up, close "x" appears for non-active desktops); focus (ring); drop target while a window is dragged over it (glow + scale); removing |
| "+" add desktop button | default; hover; focus; pressed; disabled at the maximum (4 desktops) with a tooltip "Up to 4 desktops" |
| Helper text (right of the strip) | static hint showing the Overview key once agreed (`Alt+O`) |

### Window grid (`role="listbox"`, `aria-label="Open windows"`)
| Element | States |
|---|---|
| Window thumbnail `role="option"` (Files — notes, Terminal — ~, Editor — os-report.md, Task Manager, Settings — About) | default; hover (lift and outline, close "x" 24 x 24 at top-left); keyboard-highlighted/selected (3 px accent outline, `aria-selected="true"`, the mock's Terminal); pressed; dragging (follows the pointer at small scale, other thumbnails keep their slots); closing (close guard dialogs still apply, for example unsaved Editor changes); minimised (shown with a `minimised` caption and 70% opacity); suspended (frozen frame, `suspended` caption); restoring ("Restoring…" caption, per §3.12) |
| Caption pill (app icon + title) | default; truncated with an ellipsis at 220 px, full title in the accessible name; highlighted with the thumbnail |
| Empty state | "No open windows" plus "Open Terminal" (`Alt+T`) and "Open Files" buttons |
| Error | a window whose process died while in Overview fades out and the grid re-flows |

### App switcher HUD (`role="listbox"`, `aria-label="Switch window"`)
| Element | States |
|---|---|
| HUD container (glass, 28 px radius) | hidden; delayed (120 ms hold threshold, so a quick `Alt+`` ` tap switches without flashing the HUD); shown; dismissing |
| Item (72 px app icon) `role="option"` | default; highlighted (lighter glass plate plus violet glow, `aria-selected="true"`; Terminal in the mock); hover (the pointer can also pick an item); minimised (small down-arrow badge); suspended (small pause badge); count caption when an app has 2+ windows |
| Title line under the row | shows the highlighted window's title and state ("Terminal — ~"); `aria-live` is not used here, the listbox announces the option |
| Hint line | "Alt+` next · Alt+Shift+` previous · Esc cancel" |

## Intended animations

Durations map to motion tokens; the spring curves are the proposed `--pl-ease-spring` and `--pl-ease-spring-soft` defined in `desktop-dark/notes.md`:

```css
--pl-ease-spring: linear(0, 0.009, 0.035 2.1%, 0.141 4.4%, 0.723 12.9%, 0.938 16.7%, 1.017 19.4%, 1.067, 1.089 24.9%, 1.085 27.6%, 1.043 34.9%, 1.005 45.3%, 0.994 52.3%, 1.001 72.3%, 1);
--pl-ease-spring-soft: cubic-bezier(.32, 1.28, .5, 1);
```

Under `prefers-reduced-motion: reduce` or `:root[data-motion="reduce"]` every motion token is 0 ms (DSN-05); the last column says what the user still sees.

| # | Element | Trigger | Properties (transform, opacity only) | Duration | Easing | Reduced-motion fallback |
|---|---|---|---|---|---|---|
| 1 | Backdrop (pre-blurred layer + dim) | Enter Overview (`Alt+O`, dock or menu entry) | opacity 0 → 1 | 280 ms | `--pl-ease-out` | Shown at once |
| 2 | Windows → grid | Enter Overview | FLIP: each window from its real rect to its slot, `translate(x, y) scale(s)`; all windows move together (no stagger), the focused one on top | 420 ms | `--pl-ease-spring` | Grid shown at once |
| 3 | Menu bar / dock out | Enter Overview | menu bar `translateY(-100%)`, dock `translateY(120%)`, both opacity 1 → 0 | 240 ms | `--pl-ease-in` | Hidden at once |
| 4 | Caption pills | After #2 settles (160 ms delay) | `translateY(4px)` → `0`, opacity 0 → 1 | 200 ms | `--pl-ease-out` | Shown with the grid |
| 5 | Desktops strip | Enter Overview (60 ms delay) | `translateY(-24px)` → `0`, opacity 0 → 1 | 360 ms | `--pl-ease-spring` | Shown at once |
| 6 | Thumbnail hover | Pointer enters | `scale(1)` → `1.03`; the outline pseudo-element opacity 0 → 1; close "x" `scale(.8)` → `1`, opacity 0 → 1 | 200 ms / 140 ms | `--pl-ease-spring-soft` / `--pl-ease` | Outline and "x" at once, no scale |
| 7 | Keyboard highlight | Arrow keys | one shared outline element `translate`s and `scale`s to the next thumbnail's box (FLIP) | 220 ms | `--pl-ease-spring` | Outline jumps |
| 8 | Pick a window | Click or `Enter` | chosen window FLIPs from slot back to its real rect and raises; the others return to theirs; then #1 and #3 reverse | 380 ms (backdrop 240 ms) | `--pl-ease-spring` (backdrop `--pl-ease-in`) | Overview removed at once, window focused |
| 9 | Cancel | `Esc`, backdrop click | all windows return to their rects; backdrop fades; menu bar and dock slide back | 340 ms | `--pl-ease-spring` | At once |
| 10 | Close from Overview | Close "x" or `Alt+Q` on the highlighted window | thumbnail `scale(.85)`, opacity 1 → 0; remaining thumbnails re-flow via FLIP | 200 ms, then 360 ms | `--pl-ease-in`, then `--pl-ease-spring` | Removed; grid jumps |
| 11 | Drag thumbnail | `pointerdown` + 4 px | thumbnail follows the pointer 1:1 at `scale(.6)`; on drop back it springs into its slot | follows pointer; 300 ms back | `--pl-ease-spring` | No pickup animation; drop moves at once |
| 12 | Desktop drop target | Drag over a desktop tab | target `scale(1.06)` and its glow pseudo-element opacity 0 → 1 | 200 ms | `--pl-ease-spring-soft` | Glow only, no scale |
| 13 | Drop onto desktop | Release over a tab | thumbnail `scale(.2)` toward the tab centre, opacity 1 → 0 | 260 ms | `--pl-ease-in` | Removed at once |
| 14 | Add desktop | "+" pressed | new tab `scale(.6)` → `1`, opacity 0 → 1; tabs to its left FLIP aside; "+" glyph `rotate(90deg)` and back | 300 ms; glyph 200 ms | `--pl-ease-spring` | Tab appears |
| 15 | Switch desktop | Click a tab, or `Ctrl+Alt+→/←` (to be audited) | current desktop layer `translateX(-100%)`, next from `translateX(100%)` → `0` | 480 ms | `--pl-ease-spring` | Crossfade 0 ms (instant cut) |
| 16 | Switcher HUD open | `Alt` held 120 ms after `Alt+`` ` | HUD `scale(.94)` → `1`, opacity 0 → 1; icons `translateY(6px)` → `0` with 15 ms stagger | 200 ms | `--pl-ease-spring` | HUD appears at once |
| 17 | Switcher highlight move | `Alt+`` ` / `Alt+Shift+`` ` / pointer | highlight plate `translateX` to the next icon; the icon `scale(1)` → `1.08`, the previous one back to `1` | 180 ms | `--pl-ease-spring-soft` | Plate jumps; no scale |
| 18 | Switcher wrap-around | Moving past the last item | plate opacity 1 → 0 at the end, 0 → 1 at the start (no slide across the HUD) | 120 ms | `--pl-ease` | Plate jumps |
| 19 | Title under the HUD | Highlight changes | old title opacity 1 → 0, new 0 → 1 with `translateY(3px)` → `0` | 120 ms | `--pl-ease` | Text swaps |
| 20 | Switcher commit | `Alt` released | HUD `scale(.98)`, opacity 1 → 0; the chosen window gets the focus-change animation from `desktop-dark` #15 (and #13 restore if it was minimised) | 140 ms | `--pl-ease-in` | HUD removed; window focused |
| 21 | Switcher cancel | `Esc` while `Alt` held | HUD fade out only, focus unchanged | 120 ms | `--pl-ease-in` | Removed |

Nothing loops. The Terminal inside its thumbnail keeps running live, but its cursor does not blink while the window is unfocused.

## Accessibility landmarks and roles

- Overview is a full-screen `role="dialog"` `aria-modal="true"` `aria-label="Overview"`; focus moves to the highlighted window option, is trapped inside, and returns to the previously focused window on exit.
- The window grid is a `listbox` with `role="option"` items (`aria-selected`, name "Terminal — ~, Terminal, running"), navigated with the arrow keys in 2-D (left/right within a row, up/down between rows), `Home`/`End`, `Enter` to pick, `Delete` or `Alt+Q` to close, `Esc` to cancel. Close buttons are 24 x 24 px.
- The desktops strip is a `tablist` with `role="tab"` items and a separate "Add desktop" button; dragging a window to a desktop has a keyboard alternative (window menu → "Move to Desktop 2") (WCAG 2.5.7).
- The switcher HUD is a `listbox` announced on open ("Switch window: Terminal — student@plotinium:~, 2 of 5") as the spec requires; each option carries its state ("minimised", "suspended"). It works entirely from the keyboard and with a single pointer (click an icon).
- Captions are at least 12 px on a 55%+ glass tint (AA 4.5:1); the selected outline is 3 px accent with a 2 px dark inner gap so it passes 3:1 against both the thumbnail and the backdrop (WCAG 2.4.13-style focus appearance).
- Under `prefers-reduced-transparency` or `forced-colors`, the backdrop becomes a solid `--pl-scrim` and captions get solid `--pl-surface` pills with 1 px borders.
