# Settings: About (dark)

- **Stitch project:** 12849137298552292712
- **Stitch screen id:** none. `generate_screen_from_text` returned "The operation timed out." at about 15:19Z with no screen id, and was not retried. `list_screens` returned `{}` on more than 20 polls from 15:20Z to 15:47Z; `get_project` never changed after 15:22:02Z, and `list_projects` showed 0 screens in this project. Every sibling agent in this run saw the same. With no screen id, `get_screen` and `edit_screens` could not be used. **To do:** re-run the prompt below when Stitch recovers, then save `screen.html` and `screenshot.png` next to the reference.
- **Design system:** `assets/10121591451242352758` (Plotinium Glass, Dark)
- **Model:** GEMINI_3_8_FLASH, device DESKTOP (1440x900)
- **Files:** `reference.html` and `reference.png` are a **hand-built reference render, NOT a Stitch export** (Stitch produced no screen; see below). `screen.json` records the failed request. `screen.html` and `screenshot.png` do not exist yet.
- **Spec links:** Settings sections map to `specs/03-kernel/memory-and-paging.md` (Memory: `mm.budget`), `specs/10-ai/predictive-prefetch.md` (Privacy & AI), `specs/14-devops/deployment-and-ci.md` (Updates, build id), `TEAM_CONTRACT.md` (roles R1 … R5)

## Final prompt

Sent once to `generate_screen_from_text` (it timed out and was not retried):

```text
Plotinium OS desktop (1440x900), dark Liquid Glass style inspired by the latest macOS System Settings. Show the full desktop: a deep violet-to-indigo abstract wallpaper, a thin translucent top menu bar (left: a small luminous atom logo glyph in violet #5E5CE6 — bright nucleus with 2 thin elliptical orbits, NOT an Apple logo — then bold 'Settings', 'Edit', 'View', 'Window', 'Help'; right: wifi, battery, Control Centre icon, Search icon, 'Thu 24 Sep 14:32'), and a floating frosted-glass dock at the bottom with rounded-square Plotinium app icons (Files, Terminal, Editor, Task Manager, Settings (active dot), Search) using lucide-style line glyphs.

Centre: a Settings window (about 980x680), dark translucent glass, 12px corner radius, soft large shadow, red/yellow/green traffic-light controls top-left.

LEFT SIDEBAR (vibrancy glass, 240px): a rounded search field 'Search' with magnifier icon; a user card with a circular violet gradient avatar showing 'S', name 'student', subtitle 'Plotinium Account · uid 1001'; then a list of sections, each with a small rounded-square coloured icon tile containing a white lucide-style glyph: General (gear, grey), Appearance (circle half, blue), Desktop & Dock (layout, indigo), Memory (memory chip, teal), Scheduler (gauge, orange), Network & Sync (refresh arrows, green), Privacy & AI (hand/sparkle, violet), Users & Groups (users, blue), Storage (hard drive, grey), Updates (download arrow, red badge '1'), About (info circle, violet) — About is SELECTED with a solid violet #5E5CE6 rounded highlight and white text. Small group separators between sections.

RIGHT CONTENT PANE (title 'About' in the toolbar with back/forward chevrons):
- Centred hero: a large luminous atom logo (~120px): a glowing white-violet nucleus with 3 thin elliptical orbits in violet #5E5CE6 and a soft bloom glow. Below: wordmark 'Plotinium' in large semibold type, subtitle 'An AI-native operating system for the web'.
- A rounded grouped glass list (macOS inset grouped style) with label on left, value right-aligned in secondary colour: 'Version' — '0.3.0 (build a1f93c2)'; 'Built' — '2026-09-24'; 'Kernel' — 'plotinium 0.3.0-a1f93c2'; 'Host' — 'Chrome 154 · 8 cores'; 'Memory budget' — '256 MB'; 'Storage' — 'OPFS 1.2 GB used · Cloud 340 MB'.
- A second grouped list titled 'Team' with 5 rows, each with a small circular initials avatar, a name and a role chip on the right: 'Ayesha Khan — Kernel', 'Bilal Ahmed — VFS / Database', 'Haseeb Raza — WM / UI', 'Sara Malik — AI Pipeline', 'Usman Tariq — QA / DevOps'.
- A footer row of two rounded glass buttons: 'System Report…' and 'Licences'. Beneath, small tertiary text: 'Lahore Garrison University · Capstone, Fall 2026' and '© 2026 Plotinium Team'.

Typography: Inter, clean hierarchy, readable contrast on glass. Lucide-style line icons only. No Apple logo, no Apple app names, no SF Symbols, no hazard or radiation symbols.
```

## Review against the prompt

Reviewed `reference.png` (1440x900, headless Chrome, captured after the intro animations settle):

- **Present:** menu bar with the atom glyph and the Settings menus; a floating dock with Settings running; a glass Settings window with traffic lights (Zoom is greyed because Settings has a fixed size); the sidebar with the search field (and a `Ctrl F` hint), the user card `student` / "Plotinium Account · uid 1001", and all 11 sections in 4 groups with coloured icon tiles, an Updates badge `1`, and About selected with the violet pill; the content toolbar with back/forward and the title "About"; a large luminous atom (nucleus with 3 orbits and electrons) and the `Plotinium` wordmark with its tagline; the System list (Version 0.3.0 (build a1f93c2), Built 2026-09-24, Kernel plotinium 0.3.0-a1f93c2, Host Chrome 154 · 8 cores, Memory budget 256 MB, Storage OPFS 1.2 GB · Cloud 340 MB, Signed in student · uid 1001); the Team list of 5 with initials avatars and role chips (Kernel, VFS / Database, WM / UI, AI Pipeline, QA / DevOps); the `System Report…` and `Licences` buttons; the footer "Lahore Garrison University · Capstone, Fall 2026 / © 2026 Plotinium Team".
- **Deliberate changes:** System and Team are two side-by-side inset groups rather than one column, so everything fits above the dock at 900px without scrolling. A version pill sits under the tagline. The Version row is shown hovered, with its copy affordance.
- **Branding:** no Apple logo, Apple app names, SF Symbols or SF Pro; the icons are lucide-style.
- **Contrast:** labels are 92% white and values 62% white on glass at about 82% opacity; the selected row is white on violet at 88%.
- **Open points:** (1) **The team names are PLACEHOLDERS.** `TEAM_CONTRACT.md` §1 still reads "_to fill_". The Stitch prompt above named "Haseeb Raza — WM / UI", but the reference does not assign a real person a role that is not recorded anywhere; it uses placeholder names with the R1 … R5 role codes. Replace them from TEAM_CONTRACT §1 before any demo, and fix the prompt the same way before a Stitch re-run. (2) "Chrome 154 · 8 cores" is sample data; at runtime it comes from `navigator.userAgentData` and `navigator.hardwareConcurrency`.

## UI elements and states

| # | Element | Default | Hover | Focus (keyboard) | Active / pressed | Disabled | Empty | Loading | Error |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Menu bar (atom glyph, `Settings`, Edit, View, Window, Help; status items; clock) | 28px glass strip | Title pill at 10% white | Accent ring | Menu open | Inapplicable items at 38% | n/a | n/a | n/a |
| 2 | Window chrome (traffic lights; Zoom is disabled because Settings has a fixed size) | Coloured 12px circles | Glyphs appear | Ring | Darken 12% | Zoom greyed (#4A4A4E) at all times; all three grey when the window is not focused | n/a | n/a | n/a |
| 3 | Toolbar back / forward chevrons + pane title `About` | Chevrons at 60% | 8% white pill | Ring | Pressed fill 14% | Back disabled when history is empty (38%) | n/a | n/a | n/a |
| 4 | Sidebar search field | Placeholder "Search" at 38%, magnifier icon | Border 16% | Accent ring; typing filters sections and highlights matching settings with a soft accent glow | n/a | n/a | "No settings match 'foo'" with a Clear link | n/a | n/a |
| 5 | User card `student` (avatar S, "Plotinium Account · uid 1001") | Avatar with violet gradient | Card fill 6% white | Ring | Opens Users & Groups at the student account | n/a | Guest session: generic avatar and "Guest · not signed in" | Avatar shimmer while the profile loads | "Account offline · changes will sync later" in tertiary with a cloud-off icon |
| 6 | Sidebar sections (General, Appearance, Desktop & Dock, Memory, Scheduler, Network & Sync, Privacy & AI, Users & Groups, Storage, Updates, **About**) | Coloured icon tiles, label at 92% | Row fill 6% white | Row ring; ↑/↓ move, Enter opens, Home/End jump | Selected: accent #5E5CE6 at 85%, white label | Sections locked by policy at 38% with a lock glyph (e.g. Users & Groups for a non-admin) | n/a | n/a | Updates shows a red badge `1` when an update is available; a section whose service failed shows a warning glyph |
| 7 | Atom logo (hero) | Nucleus glow with 3 orbits | Orbits speed up slightly | n/a (decorative, `aria-hidden`) | Clicking seven times shows the build easter egg "Pu · 94" (optional) | n/a | n/a | n/a | n/a |
| 8 | Wordmark `Plotinium` + tagline | Large title | n/a | n/a | n/a | n/a | n/a | n/a | n/a |
| 9 | Info list (Version 0.3.0 (build a1f93c2), Built 2026-09-24, Kernel plotinium 0.3.0-a1f93c2, Host Chrome 154 · 8 cores, Memory budget 256 MB, Storage OPFS 1.2 GB · Cloud 340 MB) | Inset grouped list | Row fill 4%; a copy icon appears on the right | Row ring; Ctrl+C copies the value | Click copies the value; a "Copied" chip replaces the icon for 1.2 s | n/a | Unknown value shows "—" | Value skeleton | Storage estimate unavailable: "Storage estimate unavailable" in tertiary |
| 10 | Team list (5 members, initials avatars, role chips Kernel, VFS / Database, WM / UI, AI Pipeline, QA / DevOps) | Inset grouped list | Row fill 4% | Row ring | Opens a small popover with the member's owned subsystems | n/a | Names not yet filled: role chips only, with "Member to be announced" | n/a | n/a |
| 11 | `System Report…` button | Glass button | Fill brightens to 14% | Ring | Scale 0.97; opens the System Report window (`uname -a`, `free`, `df`, service DAG) | While a report is being generated | n/a | Label "Collecting…" with a spinner | Toast "System report failed: vfs unavailable" |
| 12 | `Licences` button | Glass button | Fill brightens | Ring | Opens a sheet listing THIRD_PARTY.md entries | n/a | n/a | Sheet skeleton | "Could not load licences" with Retry |
| 13 | Footer text (Lahore Garrison University · Capstone, Fall 2026; © 2026 Plotinium Team) | Tertiary label | n/a | n/a | n/a | n/a | n/a | n/a | n/a |
| 14 | Dock (Settings has the running dot) and wallpaper | Floating glass dock | Magnification | Ctrl+F3 | Bounce on launch | n/a | n/a | n/a | n/a |

## Intended animations

All animations use `transform` and `opacity` only. Under `prefers-reduced-motion: reduce` the fallback column applies.

Easing tokens:
- `--ease-spring`: `linear(0, 0.009, 0.035 2.1%, 0.141 4.4%, 0.723 12.9%, 0.938 16.7%, 1.017 20.1%, 1.043 23.5%, 1.035 28.2%, 1.007 36.2%, 0.998 45.4%, 1)` (soft spring, about 4% overshoot)
- `--ease-out-expo`: `cubic-bezier(0.16, 1, 0.3, 1)`
- `--ease-snappy`: `cubic-bezier(0.34, 1.56, 0.64, 1)`

| Element | Trigger | Properties | Duration | Easing | Reduced-motion fallback |
|---|---|---|---|---|---|
| Settings window | Open (dock, menu bar atom ▸ About Plotinium, or Search) | `scale` 0.94 → 1, `opacity` 0 → 1, `translateY` 8px → 0 | 240ms | `--ease-spring` | Opacity 0 → 1, 120ms |
| Window | Close | `scale` 1 → 0.96, `opacity` 1 → 0 | 160ms | `--ease-out-expo` | Opacity only, 100ms |
| Sidebar selection pill | Section change | Pill `translateY` to the new row (one shared element, not per-row fills) with `scaleY` 1 → 1.06 → 1 | 280ms | `--ease-snappy` | Pill jumps; no scale |
| Content pane | Section change | Outgoing `opacity` 1 → 0, `translateY` 0 → -6px; incoming `opacity` 0 → 1, `translateY` 6px → 0 | 220ms | `--ease-out-expo` | Crossfade 100ms |
| Pane title in toolbar | Section change | `opacity` 0 → 1, `translateX` 6px → 0 | 200ms | `--ease-out-expo` | Instant |
| Atom logo, nucleus | While visible | Glow layer `opacity` 0.7 ↔ 1 and `scale` 1 ↔ 1.06, alternating | 3.2s loop | `cubic-bezier(0.45, 0, 0.55, 1)` | Static glow at opacity 0.85 |
| Atom logo, orbits | While visible | Each orbit group `rotate` 0 → 360deg at different speeds (18s, 26s, 34s) and alternating directions; electron dots ride the orbit path via the rotated group | 18 to 34s loops | `linear` | Orbits static |
| Atom logo | About pane first shown | `scale` 0.8 → 1, `opacity` 0 → 1; orbits `rotate` -30deg → 0 | 600ms | `--ease-spring` | Opacity only, 150ms |
| Wordmark and tagline | About pane first shown | `opacity` 0 → 1, `translateY` 8px → 0, 60ms after the logo, tagline another 40ms later | 320ms | `--ease-out-expo` | Opacity only |
| Info list and Team list rows | About pane first shown | `opacity` 0 → 1, `translateY` 4px → 0, staggered 25ms | 240ms | `--ease-out-expo` | All appear at once |
| Info row copy | Click / Ctrl+C | Copy icon `scale` 1 → 0.6, `opacity` → 0; "Copied" chip `scale` 0.8 → 1, `opacity` 0 → 1; reverses after 1.2 s | 180ms | `--ease-snappy` | Text swap only |
| Team row popover | Click | `opacity` 0 → 1, `scale` 0.96 → 1 from the row's anchor, `translateY` -4px → 0 | 200ms | `--ease-spring` | Opacity only |
| Sidebar search results | Typing | Non-matching rows `opacity` → 0.3; matching rows' glow layer `opacity` 0 → 1 | 160ms | `--ease-out-expo` | Instant |
| Updates badge `1` | Update found | `scale` 0 → 1.15 → 1 | 360ms | `--ease-snappy` | Opacity 0 → 1 |
| Buttons (`System Report…`, `Licences`) | Press | `scale` 1 → 0.97 → 1 | 140ms | `--ease-snappy` | None |
| Licences sheet | Open | Sheet drops from the title bar: `translateY` -24px → 0, `opacity` 0 → 1; the pane behind dims via a scrim `opacity` 0 → 0.4 | 300ms | `--ease-spring` | Opacity only |
| Loading skeleton | Loading | Highlight layer `translateX` -100% → 100% | 1.4s loop | `linear` | Static 6% fill |

## Accessibility landmarks and roles

- Menu bar: `role="menubar"`; the atom glyph is a `menuitem` named "Plotinium menu" (About Plotinium, System Settings…, Lock Screen, Log Out student…).
- Window: a `section` with `aria-labelledby` "Settings". Traffic lights are `button`s named "Close", "Minimise", "Zoom" (Zoom `aria-disabled="true"`).
- Sidebar: `nav` with `aria-label="Settings sections"`; the search field is `role="searchbox"` with label "Search settings"; sections are a `list` of links/buttons with `aria-current="page"` on About. The user card is a `button` named "student, Plotinium Account, uid 1001".
- Content pane: `main` with `aria-labelledby` the pane title `h1` "About".
- Atom logo: decorative, `aria-hidden="true"`; the wordmark is the `h2` "Plotinium".
- Info list: a description list (`dl` with `dt`/`dd` pairs) inside a `section` labelled "System information".
- Team: a `section` with `h3` "Team" and a `list`; each `listitem` reads "Name, role".
- Buttons: native `button`s; `System Report…` has `aria-haspopup="dialog"`.
- Live region: `aria-live="polite"` announces "Copied version to clipboard".
- Contrast: labels at 92% and values at 60% white on the 78% window tint meet 4.5:1; the selected sidebar row uses white on #5E5CE6 at 85% (≥ 4.5:1). Section icons always come with a text label.
- Keyboard: Ctrl+F focuses sidebar search, Ctrl+[ / Ctrl+] for back and forward, Ctrl+W closes the window.

## What `reference.html` already implements

Open it in Chrome at 1440x900. It plays: the window's spring open; the menu bar dropping in and the dock rising; the sidebar search, user card and section rows fading up in a stagger; the Updates badge popping in; the atom logo scaling and rotating in, then three orbits rotating continuously (18s, 26s reversed, 34s) while the nucleus glow breathes; the wordmark, tagline, version pill, System rows and Team rows fading up in a stagger. Clicking a sidebar section springs one shared selection pill to that row (`translateY`, snappy easing). Clicking a System row copies its value and swaps the copy icon for a green check for 1.2 s. `prefers-reduced-motion: reduce` stops the orbits and the glow and cuts entrances to a 120ms fade.
