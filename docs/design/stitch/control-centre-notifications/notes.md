# Control Centre and Notifications (dark)

- **Stitch project:** 12849137298552292712
- **Stitch screen id:** none. Generation returned only a session id and no screen appeared (see `screen.json`).
- **Design system:** Plotinium Glass (Dark), `assets/10121591451242352758`
- **Model:** GEMINI_3_8_FLASH, device DESKTOP (1440 x 900)
- **Files:** `screen.json` (Stitch outcome record), `reference.html` + `reference.png` (hand-built render of the same prompt; NOT a Stitch export). `screen.html` / `screenshot.png` are absent because Stitch returned no screen.
- **Specs:** [window-manager.md](../../../../specs/05-wm/window-manager.md) §3.11 (tray items and exact strings), §3.17 (notifications, WMD-18), §3.18 (frame meter, WMD-19); [ui-design-system.md](../../../../specs/05-wm/ui-design-system.md) §3.3 (motion tokens, DSN-05), §3.7 (toast, button, progress), §3.8.16 (notifications)

## Review notes

**No Stitch render exists for this screen.** `generate_screen_from_text` was called once (15:33Z) and returned only a session id (`18409215182823102728`), no screen id. Per the run rules it was not retried; `list_screens` stayed `{}` on 10 polls over about 15 minutes (the same outage the sibling screens hit), so `get_screen`, the downloads and `edit_screens` were impossible. `screen.json` records this. To keep the design reviewable, `reference.html` is a hand-built render of the prompt below with the Plotinium Glass (Dark) tokens, and `reference.png` is its 1440 x 900 Chromium capture (Playwright). The HTML is labelled "NOT a Stitch export". Reloading it plays the entrance (panel spring, 18 ms tile stagger, notification column); the switches, Light/Dark segment, memory slider (pointer and keyboard), card dismiss with FLIP re-flow, Clear all and Restart all work, and it was run with and without `prefers-reduced-motion` with no console errors.

Checked on `reference.png`:
- Menu bar: atom logo, bold "Editor", File to Help; status area with sync (cloud + green dot), AI pill, `142/256 MB` meter, the Control Centre trigger in its pressed state, Search, `Thu 24 Sep 10:42`.
- Control Centre: all 8 modules present with the exact prompt strings: "Online · synced" (Last sync 10:41), Sync queue "0 pending", "Degraded services: none" (All 9 services healthy), Appearance Light/Dark with Dark selected, Reduced motion off ("Follow system"), Memory budget slider at 256 MB (128 MB to 1 GB, "Using 142 MB"), Focus mode off, Frame meter on (and the frame-meter overlay `p95 16.7 ms · 60 Hz · dropped 0.4% · LoAF>50 ours 0 / other 1` shown left of the panel, top-right, as WMD-19 describes). Footer "Plotinium 0.3.0 · build a1f93c2" and "Settings…".
- Notifications: header with Clear all and Show less; the four cards with app icons, titles, bodies and times; Restart (primary) and Later (ghost); "Show in Files"; a grouped-stack edge under the last card with "+2 from Files".
- Dock with Plotinium app icons and running dots; no Apple marks or names (grep-checked); lucide-style glyphs; Inter and JetBrains Mono.
- Contrast: primary text 92% and secondary 64% white on 55 to 65% dark glass. Tertiary text (times, tick labels) was raised from 42% to 55% white during review, because 42% measured about 3.8:1 on the tile tint; 55% gives about 5.3:1.

Deviations and issues to settle:
1. Body copy was shortened so that the panel plus four cards fit in 900 px: card 1 reads "You hold the edit lock now · alice released it" (the Editor source is the app icon and the accessible name), and card 4 reads "Your version was kept as `report (conflict from bob).md`", following the spec's conflict-copy wording. On shorter viewports the notification column must scroll (`max-height` = work area, `overflow-y: auto`) and must never slide under the dock.
2. "Online · synced" is not one of the spec's exact tray strings (see Spec alignment notes).
3. App icons are coloured gradient tiles with white glyphs, which is the macOS-style direction. ui-design-system §3.6 still specifies `--pl-surface-2` tiles with an accent glyph. One of them must be chosen (DSN) before icons are drawn; every screen in this folder should follow that choice.
4. The panel is 360 px wide, not the 340 px in the prompt, to match the 360 px toast width in §3.7 so that a banner lines up with the centre column.
5. The Control Centre trigger glyph (two stacked switches) is our own drawing, not a lucide icon; replace it with lucide `toggle-right` pair or keep it as a custom icon on the logo grid.

## Final prompt

```text
Plotinium OS desktop (1440x900, dark Liquid Glass style inspired by the latest macOS, but with its own identity: NO Apple logo, NO Apple app names, NO SF Symbols; use thin lucide-style line icons, Inter font). Title: "Control Centre and Notifications".

BACKGROUND: a dark navy-to-deep-violet abstract wallpaper with soft luminous gradients. One dimmed Editor window ("os-report.md — Editor") is partially visible on the left behind the panels, slightly out of focus.

MENU BAR (top, 28px, translucent frosted glass, full width): at left a small luminous violet atom logo (bright nucleus with two thin elliptical orbits, accent #5E5CE6), then bold "Editor", then menus File, Edit, View, Format, Window, Help. At right the status area: a cloud-check sync icon with a green dot, a sparkle "AI" pill, memory meter "142/256 MB", a Control Centre icon (two stacked toggle switches) shown in PRESSED/active state with a highlighted pill background, a search magnifier, and the clock "Thu 24 Sep 10:42".

CONTROL CENTRE PANEL: a 340px-wide glass panel dropped from the menu bar at top-right (8px below the bar, 12px from the right edge), heavy backdrop blur, 1px inner white highlight border at 12% opacity, 20px corner radius, large soft shadow. Inside, a grid of rounded glass tiles (16px radius, slightly lighter glass):
- Row 1, a wide 2-column tile "Connectivity": wifi-like signal icon in a filled violet circle, title "Online · synced", subtitle "Last sync 10:41 · syncd"; next to it a tile "Sync queue" with a big "0" and label "pending".
- Row 2, full-width tile "Degraded services: none" with a green shield-check icon and subtitle "All 9 services healthy · vfs, sched, syncd, ai.indexer…".
- Row 3, two square toggle tiles: "Appearance" with a segmented control Light | Dark (Dark selected, violet), and "Reduced motion" with a switch OFF.
- Row 4, full-width slider tile "Memory budget" with a memory-chip icon, a violet filled slider track at about one-third, value label "256 MB", tick labels 128 MB and 1 GB.
- Row 5, two square toggle tiles: "Focus mode" (moon icon, switch OFF, subtitle "Notifications allowed") and "Frame meter" (activity/gauge icon, switch ON in violet, subtitle "60 fps overlay").
- Footer small text: "Plotinium 0.3.0 · build a1f93c2" and a gear link "Control Centre Settings…".

NOTIFICATIONS COLUMN: directly below the Control Centre, same width, aligned right, a header row "Notifications" with a "Clear all" text button and a "Show less" chevron. Four stacked glass notification cards (16px radius, subtle depth, app icon at left as a rounded-square colored icon, bold title, body text, relative time at top-right):
1. Editor app icon (violet, pen-nib glyph): title "Lock granted — report.md", body "You now hold the edit lock on /home/student/notes/report.md. alice released it.", time "now".
2. Settings app icon (grey gear): title "Restart to update", body "Plotinium 0.3.1 is ready. Your windows will be restored.", time "2m ago", with two buttons at bottom right: a violet filled "Restart" button and a ghost "Later" button.
3. Search app icon (sparkle/magnifier, teal): title "Semantic index up to date", body "ai.indexer indexed 1,284 files in /home/student · 0 errors", time "9m ago".
4. Files app icon (blue folder): title "Conflict saved as copy", body "os-report (conflict from bob's session).md saved in /home/student/notes", time "14m ago", with a "Show in Files" link.
Cards 3 and 4 are slightly stacked/overlapped to hint at a grouped stack.

DOCK: floating glass capsule centered at the bottom with app icons: Files (blue folder), Terminal (dark prompt ">_"), Editor (violet pen), Task Manager (green activity graph), Settings (grey gear), Search (magnifier sparkle), a thin separator, and Trash. Small running-indicator dots under Files, Terminal and Editor.

Overall: premium, calm, macOS-grade polish, generous spacing, high readable contrast (white text at 92% and secondary text at 64% on dark glass), violet accent #5E5CE6 used sparingly.
```

## Spec alignment notes (read before building)

- **Control Centre is new.** The spec has a bottom tray with separate popovers per item (§3.11). In the macOS-style layout the tray's connectivity, degraded-services and memory items stay as compact menu-bar status items, and the **Control Centre** gathers the same data plus the quick toggles in one panel. Each tile reads the same kernel events as the tray item it mirrors (`net.state`, `svc.*`, `mem.pressure`), so there is one store and two views.
- **Exact strings.** The spec's connectivity text is `Online`, `Syncing n ops`, `Reconnecting in 4 s`, `Offline · n queued`, `Sign in to sync`. The mock shows "Online · synced", which is not a spec string. Either add `Online · synced` to §3.11 or show `Online` as the title with "All changes synced" as the subtitle. Do not invent strings in code.
- **Degraded services** uses the spec's text in its list rows (`sync — degraded · backend unreachable · retry in 4 s (attempt 3)`) and its "Retry now" button (`svc.control({name, action:'retry'})`). "Degraded services: none" is the empty state of that tile.
- **Reduced motion toggle** maps to the Settings override `:root[data-motion="reduce"]` (ui-design-system §3.3 rule 4: "Follow system / Always"). Switch off means *Follow system*, not "motion forced on"; if the OS asks for reduced motion the switch shows off with the subtitle "System setting is on".
- **Memory budget** is MEM-01. The slider writes the same setting as Settings → Memory and needs the kernel to accept it: it commits on release, not while dragging, and a refusal (for example a budget below current usage) snaps the thumb back and shows an inline error.
- **Frame meter** toggles the WMD-19 overlay (the same switch as Settings → Developer → Frame meter and `framemeter on|off`). The subtitle shows the live `p95 16.7 ms · 60 Hz` once the overlay is on.
- **Toast placement.** §3.17 puts toasts bottom-right above the taskbar. With a top menu bar and a bottom dock, banners belong **top-right, 8 px under the menu bar** (the same column as the notification centre, so a toast visibly "files itself" into the centre). Update §3.17; the rules on count (max 3), timers (6 s / 10 s / sticky errors, paused on hover and focus) and "never cover the focused element" stay unchanged.
- **Level colour.** The spec toast has a 4 px left rule in the level colour. The glass cards drop the rule; the level is carried by a small level glyph next to the time (info, success, warning, error) and in the accessible name, never by colour alone.
- **Focus mode** is a Plotinium design addition: while on, info and success toasts are not shown as banners (still stored in the centre); warnings and errors still appear, because errors are `role="alert"` and must not be silenced.
- **No blur animation.** `backdrop-filter` values are fixed per surface; panels fade in with the blur already set (DSN-05, "only transform and opacity animate").

## UI elements and states

### Menu-bar trigger
| Element | States |
|---|---|
| Control Centre status button (two-switch glyph), `aria-haspopup="dialog"`, `aria-expanded`, `aria-controls="cc-panel"` | default; hover (`--pl-surface-3` pill); focus (3 px accent ring); pressed/open (filled glass pill, panel below); disabled never |
| Notification unread count (small accent badge on the clock or bell) | hidden at 0; count 1 to 9; "9+"; announced with the button name ("Notifications, 3 unread") |

### Control Centre panel (`role="dialog"`, `aria-label="Control Centre"`, non-modal, 340 px)
| Element | States |
|---|---|
| Panel | closed; opening; open; closing. `Esc`, outside click or a second click on the trigger closes it and returns focus to the trigger. Focus lands on the first tile when opened by keyboard. |
| Connectivity tile (wide, button opening the sync detail view) | `Online` (green dot, "All changes synced · last sync 10:41"); `Syncing 3 ops` (arrows glyph); `Reconnecting in 4 s` (clock glyph, countdown redrawn at most 1 Hz); `Offline · 2 queued` (cloud-off, warning colour); `Sign in to sync` (warning, with a Sign in button); hover; focus; pressed |
| Sync queue tile | `0 pending` (muted); `n pending` (accent number); error ("2 failed · Retry"); loading (skeleton digit on first mount, never a spinner) |
| Degraded services tile | healthy: "Degraded services: none", "All 9 services healthy"; degraded: "2 degraded" with a warning glyph and one row per service with Retry now; starting: "starting (3)" after `desktop-interactive`; expanded (rows visible) and collapsed; Retry now: default, pressed, retrying (disabled with "Retrying…"), failed |
| Appearance segmented control (`role="radiogroup"`, Light / Dark) | Light selected; Dark selected (mock); hover on the unselected segment; focus (ring on the group, arrows move); disabled never. A third option "Auto" (follow system) can be added later. |
| Reduced motion switch (`role="switch"`, `aria-checked`) | off (Follow system); on (Always); off with "System setting is on" subtitle; hover; focus; pressed |
| Memory budget slider (`role="slider"`, `aria-valuemin=128`, `aria-valuemax=1024`, `aria-valuenow=256`, `aria-valuetext="256 megabytes"`, step 64 MB) | idle; hover (thumb grows); dragging (value label follows); keyboard stepping (arrows 64 MB, PageUp/PageDown 256 MB, Home/End); committing (thumb dims, label "Applying…"); error (kernel refused: snaps back, inline text "Budget can't be below current use (198 MB)", `role="alert"`); disabled for a guest session ("Managed by the administrator") |
| Focus mode switch | off ("Notifications allowed"); on ("Banners silenced · errors still shown"); hover; focus |
| Frame meter switch | off; on ("p95 16.7 ms · 60 Hz" live subtitle); hover; focus |
| Footer | version text "Plotinium 0.3.0 · build a1f93c2" (selectable, copy on click with a "Copied" status); "Control Centre Settings…" link (hover underline, focus ring) opens Settings |

### Notifications column (`role="region"`, `aria-label="Notifications"`)
| Element | States |
|---|---|
| Header "Notifications" + "Clear all" + "Show less" | Clear all: default, hover, focus, disabled when empty; Show less / Show more toggles the grouped stack (`aria-expanded`) |
| Notification card (`article`, `aria-labelledby` title, `aria-describedby` body) | unread (accent dot left of the time); read; hover (lifts 1 px, reveals a 24 x 24 close button); focus (ring round the card; `Delete` dismisses); pressed (opens the source app); dismissing; swiped (follows the pointer); grouped (collapsed behind the top card with a "+2" count) |
| 1. Editor: "Lock granted — report.md", "now" | info level; click opens the file in Editor with the lock held |
| 2. Settings: "Restart to update", body "Plotinium 0.3.1 is ready. Your windows will be restored." with **Restart** (primary) and **Later** (ghost) | Restart: default, hover, focus, pressed, busy ("Restarting…", disabled while the BOOT-12 shutdown runs). Later: hides the card until the next boot and leaves the menu-bar chip. |
| 3. Search: "Semantic index up to date", "ai.indexer indexed 1,284 files" | success level; no actions |
| 4. Files: "Conflict saved as copy", body names the copy in `/home/student/notes`, **Show in Files** | warning level; the action opens Files with the copy selected |
| Empty state | bell-off glyph, "No notifications", secondary "You're all caught up." |
| Error state | a notification that failed to render its action shows the text only, never a broken button |
| Banner (toast) variant | the same card, top-right under the menu bar, max 3; timer pauses on hover and focus; sticky for errors |

### Dock and background
| Element | States |
|---|---|
| Dock (Files, Terminal, Editor, Task Manager, Settings, Search, Trash) | as in `desktop-dark/notes.md`; running dots under Files, Terminal and Editor |
| Background Editor window | dimmed (unfocused), not interactive while the panel has focus, but still clickable (clicking it closes the panel and focuses the window) |

## Intended animations

Durations map to motion tokens. The spring curves are the same proposed additions as in `desktop-dark/notes.md`:

```css
--pl-ease-spring: linear(0, 0.009, 0.035 2.1%, 0.141 4.4%, 0.723 12.9%, 0.938 16.7%, 1.017 19.4%, 1.067, 1.089 24.9%, 1.085 27.6%, 1.043 34.9%, 1.005 45.3%, 0.994 52.3%, 1.001 72.3%, 1);
--pl-ease-spring-soft: cubic-bezier(.32, 1.28, .5, 1);
```

Under `prefers-reduced-motion: reduce` or `:root[data-motion="reduce"]` every motion token is 0 ms (DSN-05); the last column says what the user still sees.

| # | Element | Trigger | Properties (transform, opacity only) | Duration | Easing | Reduced-motion fallback |
|---|---|---|---|---|---|---|
| 1 | Control Centre trigger pill | Click or `Enter` | pill pseudo-element `scale(.85)` → `1`, opacity 0 → 1 | 120 ms | `--pl-ease` | Pill shown at once |
| 2 | Control Centre panel open | Trigger activated | `translateY(-8px) scale(.96)` → `none`, opacity 0 → 1; `transform-origin` at the trigger (top right) | 280 ms | `--pl-ease-spring` | Panel appears at once |
| 3 | Panel tiles | Panel open | each tile `translateY(6px) scale(.98)` → `none`, opacity 0 → 1, 18 ms stagger in reading order (8 tiles, 126 ms spread) | 220 ms each | `--pl-ease-spring-soft` | Tiles appear with the panel |
| 4 | Panel close | `Esc`, outside click, trigger | `scale(.98)`, opacity 1 → 0 (no stagger) | 160 ms | `--pl-ease-in` | Disappears at once |
| 5 | Tile press | `pointerdown` / `pointerup` on any tile | `scale(.97)` then back to `1` | 90 ms down, 240 ms up | `--pl-ease` down, `--pl-ease-spring-soft` up | Pressed tint only |
| 6 | Switch knob (Reduced motion, Focus mode, Frame meter) | Toggle | knob `translateX(0 → 14px)`; the "on" track is a second layer with opacity 0 → 1 (colour never transitions) | 200 ms | `--pl-ease-spring-soft` | Knob jumps; track swaps |
| 7 | Switch knob squash | `pointerdown` on a switch | knob `scaleX(1.2)` while held | 90 ms | `--pl-ease` | None |
| 8 | Appearance segment thumb | Light/Dark change | thumb `translateX` to the other segment | 260 ms | `--pl-ease-spring` | Thumb jumps |
| 9 | Theme change | Appearance changes | View Transition on `:root`: old snapshot opacity 1 → 0, new 0 → 1 (no colour tweening) | 240 ms | linear | Instant swap (`document.startViewTransition` skipped) |
| 10 | Memory slider thumb | Drag | thumb and fill follow the pointer 1:1 with no transition; the fill is `scaleX()` from the left, never `width` | follows pointer | none | Same (direct manipulation is not decorative motion) |
| 11 | Memory slider thumb grab | `pointerdown` / release | thumb `scale(1)` → `1.15` while held, back on release | 120 ms / 220 ms | `--pl-ease` / `--pl-ease-spring-soft` | No scale; a focus ring shows the active thumb |
| 12 | Memory slider keyboard step | Arrow keys | fill `scaleX` and thumb `translateX` to the next 64 MB step | 120 ms | `--pl-ease` | Jumps |
| 13 | Memory slider refused | Kernel rejects the value | thumb and fill spring back to the last committed value, then the error line `translateY(-4px)` → `0`, opacity 0 → 1 | 320 ms, then 160 ms | `--pl-ease-spring`, `--pl-ease-out` | Jump back; error line appears at once |
| 14 | Connectivity glyph | `net.state` change | old glyph opacity 1 → 0 with `scale(.8)`, new 0 → 1 from `scale(1.2)`; the status dot plays one ring pulse (`scale(1 → 1.8)`, opacity .5 → 0) once | 200 ms; ring 600 ms once | `--pl-ease`; ring `--pl-ease-out` | Glyph swaps; `role="status"` announcement |
| 15 | Sync queue digits | Pending count changes | old digit `translateY(0 → -8px)`, opacity 1 → 0; new digit from `translateY(8px)`, opacity 0 → 1 (odometer) | 200 ms | `--pl-ease-spring-soft` | Number swaps |
| 16 | Degraded rows expand | Tile activated when degraded | rows `translateY(-6px)` → `0`, opacity 0 → 1, 24 ms stagger; the chevron `rotate(0 → 90deg)` | 220 ms | `--pl-ease-spring-soft` | Rows appear at once |
| 17 | Focus mode moon | Switch on | glyph `rotate(-30deg) scale(.8)` → `none`, opacity .5 → 1 | 300 ms | `--pl-ease-spring` | Glyph swaps |
| 18 | Frame meter overlay | Switch on / off | overlay `translateY(-4px) scale(.98)` → `none`, opacity 0 → 1 (reverse on off, 140 ms) | 200 ms | `--pl-ease-out` | Appears at once |
| 19 | Notifications column | Panel opens | column `translateY(-12px)` → `0`, opacity 0 → 1, 60 ms after the panel; cards stagger 40 ms | 320 ms | `--pl-ease-spring` | Appears at once |
| 20 | Grouped stack (collapsed) | Rest state | card 2 at `translateY(8px) scale(.95)` opacity .6; card 3 at `translateY(16px) scale(.9)` opacity .35 | static | — | Same static layout |
| 21 | Stack expand / collapse | "Show more" / "Show less" or click the stack | FLIP each card from its stacked transform to its list position; the chevron `rotate(180deg)` | 340 ms, 30 ms stagger | `--pl-ease-spring` | Jumps to the new layout |
| 22 | New notification in the column | `notify` while the centre is open | new card `translateY(-16px) scale(.98)` → `none`, opacity 0 → 1; the cards below FLIP down by the new card's height | 300 ms | `--pl-ease-spring` | Card appears; others jump |
| 23 | Banner (toast) enter | `notify` while the centre is closed | `translateX(24px) scale(.98)` → `none`, opacity 0 → 1, from the right under the menu bar | 320 ms | `--pl-ease-spring` | Appears at once (still announced) |
| 24 | Banner auto-dismiss | 6 s / 10 s timer | `translateX(0 → 110%)`, opacity 1 → 0 | 200 ms | `--pl-ease-in` | Disappears at once |
| 25 | Banner files into the centre | Dismiss while the centre is opening | the banner FLIPs into the first slot of the column instead of leaving | 280 ms | `--pl-ease-spring` | Instant |
| 26 | Card hover | Pointer enters a card | card `translateY(-1px)`; close button opacity 0 → 1, `scale(.8)` → `1` | 160 ms / 140 ms | `--pl-ease` | Close button shown at once, no lift |
| 27 | Card dismiss (close button, `Delete`) | Dismiss | card `scale(.96)`, opacity 1 → 0; the cards below FLIP up | 180 ms, then 280 ms | `--pl-ease-in`, then `--pl-ease-spring` | Removed; others jump |
| 28 | Card swipe | Horizontal drag over 8 px | follows the pointer (`translateX`, opacity falls to .4 at 40% width); release past 40% flings out `translateX(110%)`, otherwise springs back | 200 ms out / 300 ms back | `--pl-ease-out` / `--pl-ease-spring` | No swipe (use the close button or `Delete`) |
| 29 | Clear all | Button | cards leave one by one, `translateX(24px)`, opacity 1 → 0, 30 ms stagger; then the empty state fades in with `translateY(4px)` → `0` | 180 ms each; empty 200 ms | `--pl-ease-in`; `--pl-ease-out` | Cards removed; empty state at once |
| 30 | Unread dot | Arrival / read | `scale(0)` → `1` on arrival; `scale(0)`, opacity 0 when read | 200 ms / 140 ms | `--pl-ease-spring-soft` / `--pl-ease-in` | Appears / disappears at once |
| 31 | Restart button | Press | `scale(.96)` and back; the label crossfades to "Restarting…" (opacity) | 90 ms / 160 ms | `--pl-ease` | Label swaps |
| 32 | Restart hand-off | BOOT-12 shutdown begins | the whole desktop layer opacity 1 → 0 and `scale(1)` → `.985`, then the boot splash takes over | 360 ms | `--pl-ease-in` | Cut to the splash |

Nothing loops. The ring pulse (#14) plays once per state change, at most once per 2 s (the same limit as the live-region announcements).

## Accessibility landmarks and roles

- The trigger is a `button` in the menu bar's `role="group"` `aria-label="Status"`, with `aria-haspopup="dialog"`, `aria-expanded` and `aria-controls`. Keyboard shortcut to be agreed in the W5 key audit (proposal `Alt+C`; must not collide with Chrome).
- The panel is `role="dialog"` `aria-modal="false"` `aria-label="Control Centre"`. Focus moves in on keyboard open, `Tab` cycles inside the panel then continues to the notifications column, `Esc` closes and returns focus to the trigger.
- Tiles that open detail views are `button`s whose accessible name includes the state ("Connectivity: online, all changes synced, last sync 10:41"). Switches are `role="switch"` with `aria-checked`; the segmented control is a `radiogroup`; the memory control is `role="slider"` with `aria-valuetext` in words.
- The notifications column is `role="region"` `aria-label="Notifications"` containing a `list`; each card is an `article` labelled by its title and described by its body and time ("2 minutes ago"). Actions are real `button`s of at least 24 x 24 px (WCAG 2.5.8). Swipe has a keyboard and single-pointer alternative (close button, `Delete`) (WCAG 2.5.7).
- Banners (toasts): info, success and warning are `role="status"`; errors are `role="alert"`; they never take focus; timers pause on hover and focus (WCAG 2.2.1); a banner never covers the focused element (WCAG 2.4.11).
- Contrast: tile text sits on at least a 55% glass tint over the wallpaper (AA 4.5:1 for body, 3:1 for glyphs and the slider track). Under `prefers-reduced-transparency` or `forced-colors` the glass becomes a solid `--pl-surface` with 1 px borders.
