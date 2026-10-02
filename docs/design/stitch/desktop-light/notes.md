# Desktop (light)

- **Stitch project:** 12849137298552292712
- **Stitch screen id:** none. Generation timed out and no screen was ever listed (see Status below)
- **Design system:** Plotinium Glass (Light), `assets/3690503530025860907`
- **Model:** GEMINI_3_8_FLASH, device DESKTOP (1440 x 900)
- **Files:** `reference.html` (hand-built, animated reference render, NOT a Stitch export), `reference.png` (1440 x 900 capture of it), `screen.json` (record of the failed Stitch call)
- **Companion:** [desktop-dark](../desktop-dark/notes.md) holds the full menu-bar, dock and window-chrome animation table. It applies unchanged in light mode; this file lists what differs and adds the Editor and Settings details.
- **Specs:** [ui-design-system.md](../../../../specs/05-wm/ui-design-system.md) §3.6, §3.8.7, §3.8.8, Editor and Settings screen specs; [window-manager.md](../../../../specs/05-wm/window-manager.md)

## Status: Stitch generation failed; a hand-built reference stands in

- `mcp__stitch__generate_screen_from_text` was called once (projectId 12849137298552292712, DESKTOP, design system assets/3690503530025860907, GEMINI_3_8_FLASH) at about 15:17 UTC on 2026-09-24. The call timed out, as the tool warns it may, and was **not retried**.
- `mcp__stitch__list_screens` was then polled 10 times at 30-second intervals, and about 8 more times at 60 to 90 seconds, until 15:52 UTC. Every call returned `{}`. `get_project` kept `updateTime` at 15:22:02 UTC throughout, so no new screen was saved. Other agents in this run hit the same problem (for example, `files-light` got only a `sessionId` back). No screen id means `get_screen` and `edit_screens` could not be called, so there is no `screen.html` or `screenshot.png`. See `screen.json` for the record.
- **Fallback:** `reference.html` is a hand-built, working, animated render of the prompt below, built on the project's design system (Plotinium Glass tokens, Inter plus JetBrains Mono, #5E5CE6). `reference.png` is a 1440 x 900 Playwright capture of it, taken after the entrance animations settle. It is **not a Stitch export**, and the HTML file says so in a header comment.
- **To regenerate in Stitch later:** run the prompt below once. When `list_screens` shows a screen titled "Plotinium Desktop — Light", download `htmlCode.downloadUrl` to `screen.html` and `screenshot.downloadUrl` to `screenshot.png` next to this file, then fill in the screen id above.

### Review of the reference render (read from `reference.png`)
- **Branding:** the atom logo is solid violet in light mode (the pale glowing variant washed out on the light menu bar); Plotinium names only; no Apple marks or hazard symbols. ✔
- **Menu bar:** bold "Editor" plus File, Edit, Format, View, Window, Help, with the same status items as dark mode. ✔
- **Windows:** the focused Editor (bottom centre, 844 x 528) has the "Edited" tag, the Write/Split/Preview control with Split selected, a violet "Ask AI" button, an outline with "2 Process Scheduler" active, Markdown source for lines 12-29 with syntax colours and the current line 18 highlighted, and a rendered preview (heading, list, code chips, code block, table). Its status bar reads "Markdown · UTF-8 · Ln 18, Col 42 · 1,284 words · Autosaved 10:41 · /home/student/notes/os-report.md". Files sits behind at the top left with an icon grid; Settings sits behind at the top right showing Appearance, the Light/Dark/Follow system thumbnails (Light ringed), 7 accent dots (violet selected), the Sidebar icon size pop-up, the Reduce motion and Reduce transparency switches (off), and "Plotinium 0.3.0 · build a1f93c2". ✔
- **Dock:** running dots under Files, Editor and Settings; Editor magnified by the demo hover with an "Editor" tooltip. ✔
- **Deviations from the prompt:** (1) the layout was changed from the prompt's geometry so all three windows stay legible, with Files and Settings in the top corners and the Editor in front at the bottom centre; (2) "Saved to …" became "Autosaved 10:41 · …", because the "Edited" tag and "Saved" contradicted each other; (3) the Auto theme is labelled "Follow system", per the spec's wording; (4) the Users row doesn't show "(alice, bob)" in the sidebar, since that belongs in the Users pane; (5) the Settings sidebar is mostly behind the Editor in this composition (only the search field, user card and Appearance item show).
- **Contrast:** tertiary labels use 52% black on white glass (about 4.6:1 on pure white, lower on the lavender tint). Keep text off the wallpaper and on tints of at least 60% opacity.

### What the reference implements (open `reference.html` in Chrome)
- Entrance: the menu bar slides down, the dock springs up, the dock icons stagger in, and the windows scale in from 0.94 in back-to-front order.
- Dock magnification that follows the pointer, using transform only: icons re-flow outwards and the glass capsule stretches with `scaleX`. It also has tooltips, a press scale, a single launch bounce for apps that aren't running, and running dots.
- Clicking a window focuses and raises it, crossfades its shadow layer, and swaps the bold app name and app menus in the menu bar. Windows can be dragged by the title bar; double-clicking it zooms.
- Traffic lights reveal their glyphs on hover. Close fades and scales out; minimise is a genie-like move into the dock icon; clicking the dock icon restores it; zoom uses a FLIP transform.
- Menus (atom menu, app menu and each menu title) open with a fade and a 4 px slide, open neighbours on hover while a menu is open, and close on `Esc`. The Control Centre popover has glass tiles.
- Reduced motion: every duration is multiplied by `--pl-k` (0 under `prefers-reduced-motion` or `data-motion="reduce"`), JavaScript animations are skipped, and there is no dock magnification. Playwright smoke test: menus, minimise and restore, close and reopen, and Control Centre all pass in both themes; under reduced motion, 0 running animations with a non-zero duration; no page errors.


## Final prompt

```text
Screen title: "Plotinium Desktop — Light". A full 1440x900 desktop of Plotinium, an AI-native web operating system, in LIGHT mode. Visual language: premium Liquid-Glass-era desktop OS — layered bright translucent frosted glass (white at 55-70% with strong backdrop blur and saturation), 1px white inner hairline highlights and subtle grey outer hairlines, very large soft diffuse shadows, 12-16px corner radii, crisp Inter typography with near-black #1C1C1E text, violet accent #5E5CE6. Lucide-style thin line icons only. NO Apple logo, NO apple-style product names, NO SF Symbols. No radiation or hazard symbols.

WALLPAPER: a soft daylight gradient — pale lavender (#EDE9FF) into periwinkle (#B9B5FF) and a warm peach-pink glow in the lower left, with gentle flowing silk-like violet ribbons. Airy and bright.

MENU BAR (top, full width, 28px, light translucent glass with blur, thin bottom hairline):
- Left: the Plotinium logo glyph (abstract atom: bright violet nucleus dot with two thin elliptical orbits in #5E5CE6), then bold app name "Editor", then menus "File", "Edit", "Format", "View", "Window", "Help" in 13px medium dark text.
- Right status items: cloud-sync icon with tiny green dot; an "AI" pill with sparkle icon in violet; a memory meter glyph "142/256 MB"; a Control Centre toggle icon (stacked switches); a search magnifier; the clock "Thu 24 Sep 10:42".

WINDOWS (three overlapping light-glass windows; traffic-light controls at top-left — red, amber, green 12px circles):
1) FOCUSED "Editor" window, front and centre (about 900x580 at x≈270, y≈120), full-opacity glass, very large soft shadow (0 30px 70px rgba(40,30,90,.22)). Title bar: document title "os-report.md — ~/notes" with a small "Edited" grey tag, and on the right a segmented control "Write | Split | Preview" (Split selected), an "Ask AI" button with sparkle in violet. Left narrow translucent vibrancy sidebar "OUTLINE" listing headings: "1 Introduction", "2 Process Scheduler" (active, violet), "3 Virtual File System", "4 Sync & Locks", "5 Evaluation". Main split area: left pane is Markdown source in JetBrains Mono 13px with line numbers 12-30 and syntax colouring: "## 2 Process Scheduler", "Plotinium uses a **multilevel feedback queue** with 32 priority levels.", "- `ai.indexer` runs at priority 32 (lowest) so it never blocks the UI.", "- `sched` (pid 2) rebalances every 10 ms.", "```ts", "kernel.spawn('ai.indexer', { priority: 32 })", "```", "| pid | name | prio |", "| 1 | init | 0 |", "| 23 | ai.indexer | 32 |". Right pane: the rendered preview of the same content with a nice heading, bullet list, code block with light-violet background, and a small table. Bottom status bar: "Markdown · UTF-8 · Ln 18, Col 42 · 1,284 words · Saved to /home/student/notes/os-report.md".
2) "Files" window behind on the left (about 560x400 at x≈40, y≈330), unfocused and slightly dimmer (traffic lights greyed), with a light vibrancy sidebar (Favourites: Home, Documents, Recent; Locations: /, /tmp) and an icon grid of files: os-report.md, scheduler-notes.md, vfs-design.pdf, boot-log.txt, folders dsa and screenshots.
3) "Settings" window behind on the right (about 520x440 at x≈900, y≈300), unfocused. Sidebar with a user card "student · uid 1001" with a violet avatar, then items: Appearance (selected), Wallpaper, Dock & Menu Bar, Notifications, AI & Privacy, Users (alice, bob), Storage, About. Main pane "Appearance" with three theme thumbnails Light (selected with violet ring), Dark, Auto; an "Accent colour" row of 7 colour dots with violet selected; a "Reduce motion" toggle (off) and "Reduce transparency" toggle (off); footer text "Plotinium 0.3.0 · build a1f93c2".

DOCK (bottom centre, floating 12px above the bottom edge, light glass capsule 22px radius with hairline and soft shadow): our own rounded-square squircle app icons with rich gradients and simple line glyphs: Files (violet-blue folder), Terminal (black with ">_"), Editor (white-lavender with pen nib), Task Manager (teal with activity pulse line), Settings (graphite gear), Search (violet magnifier with sparkle), then a thin vertical separator, then Trash. Small dark running-indicator dots under Files, Editor and Settings.

Overall: premium, airy, meticulous detail, readable contrast, perfect alignment.
```

## Spec alignment notes (read before building)

- The same menu-bar and dock mapping as [desktop-dark](../desktop-dark/notes.md#spec-alignment-notes-read-before-building) applies: WMD-10 maps to the dock, the tray to the menu-bar status area, and the launcher to the atom menu plus Search.
- **Light glass contrast.** White glass at 55-70% over a pale lavender wallpaper can drop secondary text below 4.5:1. Secondary labels in the menu bar and sidebars use `--pl-text-muted` on a tint of at least 70% opacity, and are checked by the DSN-03 contrast test in both themes.
- **Settings → Appearance** in the mock shows Light / Dark / Auto, "Reduce motion" and "Reduce transparency". The spec's Settings table (§4.2) names these `Follow system` / `Light` / `Dark` and "Reduce motion: Follow system / Always". Use the spec wording in the build ("Auto" becomes "Follow system"). "Reduce transparency" is a proposed addition: it swaps every glass surface for a solid `--pl-surface`.
- **Editor "Ask AI" button.** AI calls go through the server-side LLM gateway only (the API key never reaches the browser). The button opens the AI side panel; it never sends the document without the user's action.
- **Version string** in Settings → About: `Plotinium 0.3.0 · build a1f93c2` (identity spec, `uname`).

## UI elements and states

### Shared chrome (light values)
| Element | Light-mode specifics |
|---|---|
| Menu bar | `rgb(255 255 255 / .6)` glass, blur 30 px, saturation 180%, a 1 px bottom hairline at `rgb(0 0 0 / .08)`, dark labels; the focused app is **Editor**, with menus File, Edit, Format, View, Window, Help |
| Status items | sync (green dot), AI pill (violet on `--pl-accent-subtle`), memory "142/256 MB", Control Centre, Search, clock "Thu 24 Sep 10:42", with the same states as dark mode |
| Dock | light glass capsule with a 1 px white inner highlight and a soft violet-tinted shadow; running dots are dark (`--pl-text`) under Files, Editor and Settings |
| Traffic lights | coloured on the focused Editor; grey on the unfocused Files and Settings windows |
| Wallpaper | static pale lavender to periwinkle field with a warm peach glow at the lower left (`aria-hidden`) |

### Editor window (focused)
| Element | States |
|---|---|
| Title "os-report.md — ~/notes" + "Edited" tag | clean (no tag); edited (tag shown, dot in the close button); saving ("Saving…" status); saved; save error ("Could not save: disk quota", `role="alert"` banner); read-only lock banner ("Locked by alice — read-only") |
| Write / Split / Preview segmented control | default; hover; focus; selected (thumb) |
| "Ask AI" button (primary, sparkle) | default; hover (`--pl-accent-hover`); focus; pressed; loading (sparkle spins once, then "Thinking…"); disabled when AI is off (`aria-disabled`, tooltip "AI is turned off in Settings") |
| Outline sidebar (headings 1-5) | default; hover; active heading (accent); focus; empty ("No headings yet") |
| Source pane (CodeMirror, JetBrains Mono, line numbers 12-30) | focus caret; selection; search match highlight; lint gutter marker |
| Preview pane | rendered heading, list, code block (`--pl-accent-subtle` bg), table; loading (skeleton) on first render of a large file |
| Status bar "Markdown · UTF-8 · Ln 18, Col 42 · 1,284 words · Saved to /home/student/notes/os-report.md" | saved; unsaved; syncing; conflict ("Conflict with alice's version", links to the conflict view) |

### Files window (unfocused, left)
| Element | States |
|---|---|
| Sidebar (Favourites: Home, Documents, Recent; Locations: `/`, `/tmp`) | as in dark mode; the unfocused sidebar drops its vibrancy tint to 50% |
| Icon grid: os-report.md, scheduler-notes.md, vfs-design.pdf, boot-log.txt, dsa, screenshots | default; hover; selected; renaming; drop target (folder); empty; loading; error |

### Settings window (unfocused, right)
| Element | States |
|---|---|
| User card "student · uid 1001" | default; hover (opens Users) |
| Sidebar: Appearance (selected), Wallpaper, Dock & Menu Bar, Notifications, AI & Privacy, Users, Storage, About | default; hover; selected; focus |
| Theme thumbnails Light / Dark / Follow system | default; hover; selected (accent ring); focus; `radiogroup` |
| Accent colour dots (7) | default; hover (scale up); selected (ring and check mark, never colour alone); focus |
| Reduce motion toggle / Reduce transparency toggle | off; on; focus; disabled (managed by the system preference, with an explanation) |
| Footer "Plotinium 0.3.0 · build a1f93c2" | static, selectable text |

## Intended animations

All the shared chrome animations (menu bar and dock entrance, dock magnification, launch and attention bounces, window open, close, minimise, restore, maximise and focus, menus, popovers, Control Centre, focus ring) are defined once in [desktop-dark notes, rows 1-31](../desktop-dark/notes.md#intended-animations). The same tokens apply, and the light theme changes only colours and shadow opacity. These are the additions for the windows in this mock:

| # | Element | Trigger | Properties (transform, opacity only) | Duration | Easing | Reduced-motion fallback |
|---|---|---|---|---|---|---|
| L1 | Theme switch (Light ↔ Dark) | Settings → Appearance thumbnail or system change | A full-screen snapshot overlay of the old theme fades out (opacity 1 → 0) over the new theme; colours themselves are never transitioned | 280 ms | `--pl-ease` | Instant theme swap |
| L2 | Theme thumbnail selection ring | Click or arrow key | ring `scale(.9)` → `1`, opacity 0 → 1 | 180 ms | `--pl-ease-spring-soft` | Ring appears at once |
| L3 | Accent dot hover and select | Hover / click | dot `scale(1)` → `scale(1.15)`; the check mark `scale(0)` → `1` on select | 140 ms / 200 ms | `--pl-ease-spring-soft` | No scale; the check mark appears at once |
| L4 | Accent colour change | New accent selected | the same snapshot crossfade as L1, limited to accent-coloured elements (opacity) | 200 ms | `--pl-ease` | Instant |
| L5 | Toggle switch (Reduce motion, Reduce transparency) | Click / `Space` | knob `translateX(0 → 16px)`; the "on" track layer goes opacity 0 → 1 | 200 ms | `--pl-ease-spring-soft` | Knob jumps; track swaps |
| L6 | Settings pane change | Sidebar item click | the old pane opacity 1 → 0; the new pane opacity 0 → 1 with `translateX(8px)` → `0` | 180 ms | `--pl-ease` | Instant swap |
| L7 | Editor Write / Split / Preview | Segmented control | thumb `translateX`; the preview pane goes `translateX(24px)` → `0` and opacity 0 → 1 when shown, and the reverse when hidden; the source pane is resized by FLIP `scaleX` on a snapshot, then snapped to its real width | 220 ms | `--pl-ease-spring` | Instant layout change |
| L8 | Editor "Edited" tag | First unsaved change | opacity 0 → 1, `scale(.9)` → `1` | 140 ms | `--pl-ease-out` | Appears at once |
| L9 | Save confirmation | Save succeeds | the status text crossfades from "Saving…" to "Saved"; a check glyph goes `scale(.6)` → `1` once | 200 ms | `--pl-ease-spring-soft` | Text swap only; `role="status"` announces "Saved" |
| L10 | Outline active heading | Caret moves into another section | the shared highlight bar `translateY` to the new row | 160 ms | `--pl-ease` | Instant |
| L11 | Scroll sync (source ↔ preview) | Scroll in Split mode | none; the preview follows the source position instantly (no smooth scroll, to avoid motion sickness) | — | — | Same |
| L12 | "Ask AI" panel | Button click | the side panel `translateX(100%)` → `0`, opacity 0 → 1; the sparkle rotates 180° once | 280 ms | `--pl-ease-spring` | Panel appears at once; static sparkle |
| L13 | AI streaming text | Tokens arrive | each new chunk goes opacity 0 → 1 (no movement) | 120 ms | linear | Text appears without fading |
| L14 | Files icon-grid selection | Click / arrow keys | icon tile `scale(.97)` → `1` with the selection tint going opacity 0 → 1 | 120 ms | `--pl-ease` | Tint only |

## Accessibility landmarks and roles

- The landmarks are the same as [desktop-dark](../desktop-dark/notes.md#accessibility-landmarks-and-roles): a menu-bar `header` with `role="menubar"` and a status `group`, `main` for the work area, windows as `role="dialog" aria-modal="false"`, and a dock `nav` with `role="toolbar"`.
- Editor: the source pane is a CodeMirror `textbox` with `aria-multiline="true"` and a label "os-report.md source". The preview is a `region` labelled "Preview", with real headings (`h2`, `h3`). The outline is a `nav` with `aria-label="Outline"` containing a `list`, and the active heading has `aria-current="location"`. The Write / Split / Preview control is a `radiogroup`. The status bar is `role="status"` and announces save state only (not the caret position).
- Settings: a sidebar `nav` with `aria-label="Settings sections"` and `aria-current="page"` on Appearance. Theme choices and accent dots are each a `radiogroup` with arrow-key navigation, and each accent dot has a name ("Violet", "Blue"…). Toggles are `role="switch"` with `aria-checked`.
- Files (unfocused): the icon grid is an APG `grid` with `aria-selected`.
- Light-theme contrast: the violet accent #5E5CE6 on white passes 4.5:1 for text; on the lavender wallpaper, text is never placed directly on the wallpaper, only on glass tints of at least 60% opacity.
