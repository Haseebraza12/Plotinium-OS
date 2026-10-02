# Editor: sync conflict and remote lock (dark)

| Field | Value |
|---|---|
| Stitch project | `12849137298552292712` |
| Stitch screen id | none: generation timed out, no screen returned (see `screen.json`) |
| Design system | Plotinium Glass (dark), `assets/10121591451242352758` |
| Model | GEMINI_3_8_FLASH, DESKTOP 1440x900 |
| Files | `reference.html` and `reference.png` (a hand-built render of the prompt below, **not** a Stitch export), and `screen.json` (the Stitch failure record) |
| Spec links | `specs/06-sync/offline-and-sync.md` SYN-08 (conflicted copy `name (conflict from <user>, <YYYY-MM-DD>).ext`, dated by the server's commit time) and its S/X leases; `specs/04-vfs/virtual-file-system.md` VFS-09 (a second writer gets EBUSY or read-only access) and VFS-10 (no update is silently lost); `specs/05-wm/ui-design-system.md` §3.6 (motion) |

## What this screen shows

The Editor opens `/home/student/notes/os-report.md` after the device comes back online. Two things are true at once:

1. **Sync conflict.** `student` edited the file offline (local v7) while the server moved to v8. The server kept v8 and saved the offline bytes as a sibling file, `os-report (conflict from student, 2026-09-24).md`. The banner says so and offers **Compare** and **Open conflicted copy**. Nothing was silently overwritten.
2. **Remote lock.** `alice` holds the write lease on the file (30 s lease, 12 s left). The document is read-only for `student` until the lease expires or alice releases it. The title-bar chip shows who holds it, and a countdown ring shows the time left on the lease.

The status bar reports `Ln 42, Col 7 · UTF-8 · Markdown · saved v8 · synced`.

## Stitch status and the reference render

**Stitch did not produce this screen.** `generate_screen_from_text` (DARK design system, GEMINI_3_8_FLASH, DESKTOP) returned "The operation timed out." at about 15:19Z, with no screen id or session id. Per the run rules it was **not retried**. `list_screens` returned `{}` on 20 polls between about 15:20Z and 15:47Z, and the project's `updateTime` never moved past 15:22Z. About 20 sibling screens generated concurrently in the same project hit the same failure. With no screen id, `get_screen` and `edit_screens` could not be used. The details are in `screen.json`.

To keep the design moving, `reference.html` is a hand-built 1440x900 render of the same prompt that follows the Plotinium Glass (dark) design system. `reference.png` is its Chromium screenshot, taken after the entrance animations settle. The HTML implements the entrance animations, hover and press states, and the reduced-motion rules described below, so it doubles as a motion prototype.

Visual review of `reference.png`:

- The macOS-grade layout is all there: a glass menu bar, traffic lights, the title with the lock chip and countdown ring (12 of 30 s, so 40 % remains), tabs with an amber conflict dot, the amber conflict banner with **Compare** and **Open conflicted copy**, the outline and files sidebar with a CONFLICT badge, Markdown highlighting, the current line 42 with the caret at column 7, a "Locked by alice" read-only tooltip, a minimap, the status bar `Ln 42, Col 7 · UTF-8 · Markdown · saved v8 · synced`, and the dock.
- No Apple marks, names, SF Symbols or SF Pro appear. It uses Inter, JetBrains Mono and lucide-style strokes.
- Contrast holds: white or amber-tinted text on the banner and chip is at or above 4.5:1, and body text on the window glass is about 12:1.

Deliberate differences from the prompt:

- The boot-log quote (lines 51 to 54) uses the real lines from `specs/02-boot/boot-and-services.md` §boot log (firmware, vfs, sync WARN offline, lockd DEGRADED) instead of the invented ones in the prompt.
- The logo follows the identity spec, not the atom (see the brand note below).

## Final prompt

Sent once to `generate_screen_from_text` (not retried):

```text
Screen title: "Plotinium Editor — Conflict (Dark)". A full 1440x900 desktop of Plotinium, an AI-native web operating system, in its Liquid-Glass dark theme (inspired by the latest macOS, but with its own identity; NO Apple logo, NO Apple app names, NO SF Symbols). Accent colour violet #5E5CE6. Use lucide-style thin line icons only.

BACKGROUND: a deep indigo-to-violet abstract wallpaper with soft blurred light blooms.

MENU BAR (top, 28px, translucent frosted glass): at far left the Plotinium logo — a small luminous abstract atom (bright violet nucleus with 2-3 thin elliptical orbit rings, no hazard symbol) — then the bold app name "Editor", then menus "File  Edit  View  Selection  Go  Window  Help". At the right: sync-cloud icon with green dot, wifi, battery 82%, a Control Centre toggle icon, a Search magnifier, and the clock "Thu 24 Sep  14:32".

MAIN WINDOW (centred, about 1180x720, dark translucent glass with 14px rounded corners, a 1px inner hairline highlight and a large soft drop shadow):
- TITLE BAR: three traffic-light circles at left (red close, amber minimise, green zoom). Centred title "os-report.md — ~/notes" with a small document icon. On the right of the title bar, a pill-shaped lock chip in muted amber glass: a small padlock icon, text "Read-only — locked by alice (lease 12 s)", and a tiny circular countdown ring (about 70% remaining) at its right end, plus a small avatar circle "A".
- TAB BAR (minimal, below the title bar): active tab "os-report.md" with an amber dot indicating conflict and a close x; inactive tabs "scheduler.ts" and "README.md". A "+" button at the end.
- CONFLICT BANNER (full width at the top of the editor area, amber/orange tinted glass, 1px amber border, rounded 10px, with a triangle-alert icon): headline "This file changed on the server while you were offline." second line "Your version was saved as os-report (conflict from student, 2026-09-24).md". Right-aligned buttons: primary filled "Compare" (with a split-columns icon) and secondary ghost "Open conflicted copy". A small dismiss x at the far right.
- LEFT SIDEBAR (narrow, vibrancy glass, 220px): section "OUTLINE" listing Markdown headings: "# OS Report", "## 1. Boot sequence", "## 2. Scheduler (MLFQ)", "## 3. Virtual memory", "## 4. Sync and conflicts" (selected, violet highlight), "## 5. AI indexer". Below, section "FILES" showing /home/student/notes: os-report.md, os-report (conflict from student, 2026-09-24).md (amber badge), lab-4.md.
- CODE AREA: monospace font (JetBrains Mono style) with a line-number gutter showing lines 30-55; line 42 highlighted with a subtle violet current-line band and a blinking caret at column 7. Markdown syntax highlighting: headings in violet, bold in white, inline code in teal, links in blue, list bullets in amber, comments grey. Realistic content, e.g.:
  30 ## 4. Sync and conflicts
  32 Plotinium syncs every file with a **version vector**. When the
  33 client reconnects, `syncd` compares the local version (v7) with
  34 the server version (v8).
  36 - If only one side changed, it fast-forwards.
  37 - If both changed, the server keeps v8 and the client copy is
  38   saved as a *conflicted copy* next to the original.
  40 ### 4.1 File locks
  42 A lock is a **lease**: `alice` holds it for 30 s and must renew.
  43 While locked, other users open the file read-only.
  45 ```ts
  46 const lease = await locks.acquire("/home/student/notes/os-report.md", { ttl: 30_000 });
  47 ```
  49 See [scheduler notes](./lab-4.md) and the boot log below:
  51 > [  0.000] plotinium: kernel 0.3.0 starting
  52 > [  0.012] vfs: mounted / (opfs)
  53 > [  0.031] sched: MLFQ with 3 queues ready
  54 > [  0.047] syncd: connected, 0 pending ops
  Also show a thin minimap on the right edge of the code area.
- STATUS BAR (bottom, 24px, translucent): left side "Ln 42, Col 7 · UTF-8 · Markdown · saved v8 · synced" with a small green check at "synced"; right side a lock icon "Read-only", "Spaces: 2", and a small violet AI sparkle chip "Ask AI".

DOCK (bottom centre, floating rounded glass shelf with soft reflection): own-design app icons for Files, Terminal, Editor (with a running dot beneath), Task Manager, Search, Settings, and a trash at the end, separated by a thin divider.

Overall: macOS-grade polish, crisp 13px UI text, high-contrast readable text on glass, soft large shadows, generous spacing, everything feels like one coherent OS.
```

## UI elements and states

### Menu bar (28 px glass strip)
| Element | States |
|---|---|
| Plotinium atom logo (opens the system menu) | default; hover shows a 6 % white tint; active (menu open) shows a 12 % tint; focus-visible shows a 3 px accent ring |
| App name "Editor" (bold) plus menus File, Edit, View, Selection, Go, Window, Help | default; hover; open (tinted, with the menu popover visible); disabled items inside menus at 38 % label; keyboard focus via F10 then the arrow keys |
| Status items: sync cloud (green dot), Wi-Fi, battery 82 %, Control Centre, Search, clock | sync cloud has four states: synced (green dot), syncing (the dot rotates), offline (grey dot plus a slash), error (red dot). Each item has hover, focus and pressed states. Offline changes the tooltip to "Offline · 3 changes queued". |

### Window chrome
| Element | States |
|---|---|
| Traffic lights (close, minimise, zoom) | focused: coloured; unfocused window: all three grey (#4A4A4F); hover over the group reveals the x, minus and diagonal-arrow glyphs on all three; pressed darkens the colour 12 %; focus-visible shows an accent ring around the group |
| Title "os-report.md — ~/notes" with document icon | default; unsaved edits show a dot in the close button; right-click on the icon opens a path popover (/home/student/notes/os-report.md) |
| **Lock chip** "Read-only — locked by alice (lease 12 s)" with a padlock, countdown ring and "A" avatar | **locked-by-other** (amber glass, ring draining); **renewed** (ring refills to 100 % when alice renews her lease, with a subtle pulse); **expiring** (under 5 s the ring and text turn warning amber at full saturation); **released** (the chip morphs to a green "Editable" chip, then fades out after 2 s); **locked-by-me** (violet chip "Editing — you hold the lock", no ring); hover shows a tooltip with the holder, lease time and fence number; focus-visible gives an accent ring; click opens a popover with "Request edit access" and "Notify me when free" |
| Tab bar: active "os-report.md" (amber conflict dot, close x), "scheduler.ts", "README.md", "+" | active (raised glass, full-strength label); inactive (60 % label); hover (6 % tint, close x appears); dirty (a dot replaces the x until hover); conflict (amber dot); dragging (lifted, with a shadow); overflow (the tab strip scrolls, with chevrons) |

### Conflict banner
| Element | States |
|---|---|
| Banner container (amber-tinted glass, 1 px amber border, triangle-alert icon) | visible; **loading** ("Checking server version…" with a spinner, shown while `syncd` resolves the conflict); **resolved** (turns green, "Conflict resolved · kept v8", then collapses); **error** (red, "Could not reach server · retry in 4 s"); dismissed (collapsed; reappears as a small amber "1 conflict" pill in the status bar) |
| "Compare" (primary, filled) | default, hover (lighter), pressed (scale 0.97), focus-visible ring, **loading** (spinner while the conflicted copy loads), disabled (when the conflicted copy was deleted) |
| "Open conflicted copy" (secondary, ghost) | default, hover (tinted), pressed, focus-visible, disabled (file missing, with a tooltip explaining why) |
| Dismiss x | hover, focus, pressed |

### Sidebar (vibrancy, 220 px)
| Element | States |
|---|---|
| OUTLINE list (headings of the document) | default; hover; **selected** "## 4. Sync and conflicts" (accent at 85 %, white text); follows the caret; **empty** ("No headings") |
| FILES list for /home/student/notes: os-report.md, os-report (conflict from student, 2026-09-24).md with an amber "conflict" badge, lab-4.md | default, hover, selected, focus-visible; **loading** (skeleton rows); **error** ("Permission denied · EACCES") |
| Sidebar collapse | expanded / collapsed (Ctrl+Alt+S) |

### Code area
| Element | States |
|---|---|
| Line-number gutter (lines 30 to 55) | default at 38 % label; the current line number at 92 %; hover on a number selects the line |
| Current line 42 | violet 8 % band; the caret blinks at column 7. **Read-only** shows the caret as a hollow bar and typing pops a small tooltip "Locked by alice", with no buffer change |
| Markdown highlighting | headings violet, bold white, inline code teal, links info-blue, bullets amber, block quotes (boot log) grey mono |
| Minimap | default at 40 % opacity; hover 70 %; dragging the viewport box scrolls the document |
| Selection | accent at 30 % |
| **Empty file** | "Empty file. Start typing, or press Ctrl+K to ask the AI." |
| **Loading** | skeleton lines shimmer (linear gradient sweep) |
| **Error** | "Could not open os-report.md · ENOENT" with a Retry button |

### Status bar (24 px)
| Element | States |
|---|---|
| "Ln 42, Col 7" | updates live; click opens Go to line |
| "UTF-8", "Markdown", "Spaces: 2" | hover; click opens a picker popover |
| "saved v8" | saving ("saving…" with a spinner), saved (vN), failed ("save failed · retry", red) |
| "synced" (green check) | synced / syncing (rotating arrows) / offline ("offline · 3 queued", grey) / conflict ("1 conflict", amber) |
| "Read-only" lock | shown only while another user holds the lease |
| "Ask AI" violet sparkle chip | default, hover glow, pressed, disabled (AI off build: hidden, not greyed) |

### Dock
Files, Terminal, Editor (running dot), Task Manager, Search, Settings, a divider, then Trash. States: default, hover magnification, pressed (darkened), running dot, bounce on launch, and a badge (for example Files "1" for the conflict).

## Intended animations

These rules come from `specs/05-wm/ui-design-system.md` §3.6 and DSN-05:

- Only `transform` and `opacity` animate.
- Durations use the motion tokens, so reduced motion can zero them all at once: `--pl-motion-fast` (120 ms), `--pl-motion-med` (200 ms) and `--pl-motion-slow` (320 ms).
- There is no looping animation longer than 5 s (WCAG 2.2.2). Anything that repeats stops by itself, or is live data that the user can pause.
- Under `@media (prefers-reduced-motion: reduce)` or `:root[data-motion="reduce"]`, every token is 0 ms, so each change below becomes an **instant state change**. No `Animation` has a duration above 0 (I-DS4). The fallback column says what the user sees instead.

**Proposed new easing tokens.** These give the Liquid-Glass spring feel and need to be added to §3.6. That is an open item for the spec owner (R3).

- `--pl-ease-spring: cubic-bezier(0.34, 1.36, 0.64, 1)`: a snappy spring with about 6 % overshoot, for chips, badges and presses.
- `--pl-ease-spring-soft: linear(0, 0.157 7.1%, 0.54 17.2%, 0.828 27.3%, 0.94 35.4%, 1.006 45.5%, 1.02 55.6%, 1.006 70.7%, 1)`: a soft spring with 2 % overshoot, for windows, banners and layout moves.
- The existing `--pl-ease`, `--pl-ease-in` and `--pl-ease-out` are kept for exits and fades.

| # | Element | Trigger | Properties | Duration | Easing | Reduced-motion fallback |
|---|---|---|---|---|---|---|
| 1 | Editor window | open | `scale(0.94 → 1)`, `opacity 0 → 1`, origin at the dock icon | `--pl-motion-med` | `--pl-ease-spring-soft` | the window appears at full size |
| 2 | Conflict banner | a `sync.conflict` event for the open file | the banner `translateY(-12px → 0)`, `opacity 0 → 1`; the code area below moves with a FLIP `translateY(-52px → 0)` so its layout never animates | `--pl-motion-slow` | `--pl-ease-spring-soft` | the banner is simply present; the code area is not shifted |
| 3 | Banner triangle icon | the banner enters (once per conflict) | attention nudge `rotate(0 → -8deg → 6deg → 0)` | `--pl-motion-slow`, once | `--pl-ease-spring` | a static icon |
| 4 | Banner | dismiss, or the conflict is resolved | `translateY(0 → -8px)`, `opacity 1 → 0`; the code area FLIPs up | `--pl-motion-med` | `--pl-ease-in` | removed instantly |
| 5 | Banner resolved state | `sync.resolved` | the green layer fades over the amber layer (two stacked layers, opacity only), then row 4 runs after 2 s | `--pl-motion-fast` | `--pl-ease` | the green state swaps in; the collapse is instant |
| 6 | Lock chip | `lock.held` by another uid | `scale(0.8 → 1)`, `opacity 0 → 1` | `--pl-motion-med` | `--pl-ease-spring` | the chip appears |
| 7 | Lock countdown ring | while the lease is held (a data-driven timer, not decoration) | two half-disc masks `rotate()` to the fraction of the lease left, updated once per second with a `--pl-motion-fast` transition, so it is never a free-running loop | per second | `--pl-ease` | the ring is hidden; the chip text "lease 12 s" updates every second |
| 8 | Lock chip | `lock.renewed` | pulse `scale(1 → 1.06 → 1)`; the ring snaps back to full | `--pl-motion-slow`, once | `--pl-ease-spring` | the number resets to 30 s |
| 9 | Lock chip | `lock.released` | the amber layer fades out; the green "Editable" layer fades in and scales `0.9 → 1`; the chip fades out 2 s later | `--pl-motion-med` + `--pl-motion-med` | `--pl-ease-spring-soft` then `--pl-ease-in` | the chip swaps to "Editable", then is removed after 2 s |
| 10 | Read-only keystroke | typing while locked | the tooltip "Locked by alice" rises: `translateY(4px → 0)`, `opacity 0 → 1`; the lock chip does a gentle shake `translateX(0, -3, 3, -2, 0 px)` | `--pl-motion-slow` | `--pl-ease-spring` | the tooltip appears with no shake |
| 11 | Caret | idle after typing | blinks by opacity `1 ↔ 0` with `steps(1)` and a 530 ms half-period; it **stops blinking after 5 s idle** and stays solid (WCAG 2.2.2) | 530 ms × up to 5 s | `steps(1)` | a solid caret, never blinking |
| 12 | Current-line band | the caret changes line | `translateY` to the new line | `--pl-motion-fast` | `--pl-ease-out` | jumps instantly |
| 13 | Tabs | open or close | open: `scaleX(0.6 → 1)` from the left edge plus opacity; close: the neighbours FLIP left | `--pl-motion-med` | `--pl-ease-spring-soft` | instant |
| 14 | Tab conflict dot | a conflict is detected | `scale(0 → 1.2 → 1)` | `--pl-motion-med` | `--pl-ease-spring` | appears |
| 15 | Buttons (Compare, Open conflicted copy, Ask AI) | press and release | `scale(1 → 0.97)` on press, spring back on release | `--pl-motion-fast` | `--pl-ease-spring` | only the colour changes (`:active` background) |
| 16 | Compare | click | a split view: the editor pane `translateX(0 → -50%)` while the diff pane enters `translateX(40px → 0)`, `opacity 0 → 1`; both panes are pre-sized, so no layout animates | `--pl-motion-slow` | `--pl-ease-spring-soft` | the diff view replaces the editor pane |
| 17 | Status "synced" check | sync completes | the check is revealed by an overlay mask that slides away (`translateX(0 → 100%)`), then settles with a `scale(0.8 → 1)` | `--pl-motion-med` | `--pl-ease-out` | a static check |
| 18 | Status sync arrows | while syncing | one rotation `rotate(0 → 360deg)` per sync operation (not an infinite loop); if a sync runs longer than 5 s the icon stops and the label reads "syncing…" | `--pl-motion-slow` × at most 5 s | `--pl-ease` | the static label "syncing…" |
| 19 | Outline selection pill | the caret enters a new section | the highlight moves between rows with `translateY` | `--pl-motion-med` | `--pl-ease-spring-soft` | instant |
| 20 | Minimap viewport | scrolling | `translateY` bound to the scroll position (scroll-linked, not a timed animation) | per frame | none | the same (it tracks input, so it is not decorative motion) |
| 21 | Menus and popovers (the lock popover, pickers, path popover) | open / close | open: `translateY(-4px → 0)`, `scale(0.98 → 1)`, `opacity 0 → 1`; close: `opacity 1 → 0` | `--pl-motion-fast` | `--pl-ease` / `--pl-ease-in` | shown and hidden instantly |
| 22 | Dock icon | pointer hover | magnification `scale(1 → 1.45)`, neighbours at 1.2 and 1.08, `translateY(-10px)`; the tooltip fades in | `--pl-motion-fast` | `--pl-ease-spring-soft` | no magnification; the tooltip only |
| 23 | Dock icon | app launch | one bounce `translateY(0 → -14px → 0)` (once, not repeated) | `--pl-motion-slow` | `--pl-ease-spring` | the running dot appears |
| 24 | Loading skeleton | the file is loading | a sheen layer `translateX(-100% → 100%)`, **at most 3 passes** (about 3.6 s), then a static skeleton | 1200 ms × 3 | `linear` | a static skeleton at 60 % opacity |

Choreography on reconnect: first the sync check (row 17), then after 80 ms the banner (row 2), then after 120 ms the tab conflict dot (row 14). The lock chip (row 6) is independent and appears whenever the lock event arrives. Never more than 3 elements move at once.

## Brand note (logo)

The Stitch design-system brief and this run's prompt describe the logo as a "luminous atom" with 2 or 3 elliptical orbits. `specs/00-product/identity-and-branding.md` §3.6 (PLT-ID-03 and PLT-ID-16, checked at every P2 review) says the mark is **a plotted point on an orbit**. It is an open ring of about 266° in `--pl-accent` (stroke 20 of 160 units) with a solid point (r 25) in its gap at 1 o'clock. It has no gradients, glow, filters or hairlines. The spec **explicitly avoids the three-ellipse atom icon**, and "glowing" is on the identity spec's banned-words list. `reference.html` therefore draws the spec's mark as an inline `<symbol id="pl-logo">` (path `M 134.6 67.4 A 56 56 0 1 1 63.6 26.4` plus a circle at 108, 31.5). The build must use `docs/identity/logo.svg` / `logo-mono.svg` once R3 finalises them. The Stitch design systems should be updated to match, so that later renders stop drawing an atom.

## Accessibility: landmarks and roles

- The page has no `role="application"` wrapper. Standard document semantics are used throughout, and only the CodeMirror content element captures keys.
- Landmarks, in DOM order: `header` (the menu bar), `main` (the window layer, which holds this window as a labelled dialog), and `nav` (the dock).
- Menu bar: `<nav aria-label="Menu bar">` with `role="menubar"`; each menu title is `role="menuitem" aria-haspopup="menu" aria-expanded`.
- Window: `role="dialog" aria-modal="false" aria-labelledby` pointing at the title. Traffic lights are `<button>`s with the labels "Close", "Minimise" and "Zoom".
- Lock chip: `<button aria-describedby="lock-tip">` with the text "Read-only, locked by alice, lease 12 seconds". The countdown ring is `aria-hidden="true"`. A `role="timer" aria-live="off"` holds the seconds; `aria-live="polite"` announces only "alice released the lock" and "Lease expiring".
- Tab bar: `role="tablist"` with `role="tab"` items (`aria-selected`, `aria-controls`); the conflict dot adds "has conflict" to the accessible name.
- Conflict banner: `role="alert"` on first appearance (announced once), then static `role="region" aria-label="Sync conflict"`. Buttons are real `<button>`s. Focus does not move automatically; F6 cycles to the banner.
- Sidebar: `<aside aria-label="Outline and files">`; the outline is `role="tree"` with `role="treeitem"` and `aria-level`; the files list is `role="listbox"`.
- Code area: the CodeMirror 6 `role="textbox" aria-multiline="true" aria-readonly="true"` while locked; the line numbers are `aria-hidden`.
- Status bar: `<footer role="status" aria-live="polite">`; only save and sync changes are announced, not the caret position.
- Dock: `<nav aria-label="Dock">` with `<button>`s named after the apps; the running state is in the name ("Editor, running").
- Colour is never the only signal: the conflict uses an icon plus text, the lock uses a padlock plus text, and the sync state uses a word plus an icon.
- Contrast: amber banner text is `#FFFFFF` at 92 % on an amber tint at 22 % over a 78 % dark surface (≥ 7:1). Muted labels stay at or above 60 % white on the window surface (≥ 4.5:1).
