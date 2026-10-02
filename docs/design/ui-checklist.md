# Plotinium UI checklist

The tick list for every screen of the Liquid Glass UI: per screen, per element, per state and per animation. It is the evidence for UIG-24 in [specs/05-wm/ui-implementation-guide.md](../../specs/05-wm/ui-implementation-guide.md) (the guide), and it is attached, ticked, to the P2, P3 and P4 gate evidence.

- **Owner:** R3 WM/UI. **Reviewer:** R5 QA/DevOps (ticks the accessibility, visual and performance lines).
- **Sources:** `docs/design/stitch/<slug>/notes.md` and `reference.png` (hand-built renders: Stitch returned no screens, see the guide §1), corrected by the guide's decisions `D-01` … `D-25` (guide §3.1). When a note and the guide disagree, the line below already follows the guide and says so with `(D-nn)`.
- **How to tick:** tick a line only when it works in **both themes**, with **reduced motion**, and with the **keyboard only**, unless the line says otherwise. Paste the PR or test name next to a ticked line when it is not obvious.
- **Legend:** `→ RM:` is what the user sees with reduced motion (every motion token is 0 ms). "Exact" strings must match character for character (UIG-11). Durations are token names or the values of `ui/src/tokens/motion.css`.

---

## 0. Global checks (every screen)

### 0.1 Build rules

- [ ] Only `--pl-*` tokens in component CSS: no raw colour, px font size, radius, shadow, duration or z-index (DSN-02).
- [ ] Only `transform` and `opacity` are transitioned or animated; progress fills use `scaleX` (UIG-05, D-07).
- [ ] No infinite animation except the Terminal cursor and Editor caret blink (UIG-07, D-08).
- [ ] No spinner anywhere; busy states are text or determinate (UIG-07, D-09, DSN-07).
- [ ] `backdrop-filter` only on menu bar, dock, menus/popovers, Control Centre, notifications/toasts, Search, sheets/dialogs, HUDs; windows use the static tint (UIG-08).
- [ ] `will-change` only while animating; windows have `contain: layout paint` (UIG-08).
- [ ] User text rendered as text nodes; no HTML sinks (UIG-12, DSN-09).
- [ ] Status and error sentences come from a `format.ts` function (UIG-11).
- [ ] No Apple logo, Apple app names, SF Symbols or SF Pro; names are Files, Terminal, Editor, Task Manager, Settings, Search, Overview, Control Centre, Notifications; the logo is the atom (D-04).
- [ ] No `⌘`, `Alt+Tab`, `Ctrl+W`, `Ctrl+T`, `Ctrl+N`, `Ctrl+Tab`, `F6` or `F10` is used or shown (D-11).

### 0.2 Modes

- [ ] Light theme (`data-theme="light"` and `prefers-color-scheme: light`).
- [ ] Dark theme (`data-theme="dark"` and `prefers-color-scheme: dark`); forced opposite of the emulated scheme also renders correctly.
- [ ] Reduced motion (`prefers-reduced-motion` and `data-motion="reduce"`): no animation above 0 ms; every end state and every piece of information still shown (UIG-06).
- [ ] Reduced transparency (`prefers-reduced-transparency` and `data-transparency="reduce"`): glass becomes solid surfaces, no blur.
- [ ] Forced colours: shadows become 1 px `CanvasText` borders; focus uses `Highlight`; state glyphs stay distinct.
- [ ] 200 % zoom / viewport < 800 px: compact mode, no horizontal page scroll, nothing clipped.

### 0.3 Accessibility

- [ ] Landmarks and roles as listed for the screen; every control has an accessible name.
- [ ] Visible focus ring on every focusable element (`--pl-focus-ring`), ≥ 3:1 against its surroundings.
- [ ] Every target ≥ 24 × 24 CSS px (traffic lights by hit area).
- [ ] No state conveyed by colour alone (text or glyph always present).
- [ ] Text on glass ≥ 4.5:1 over the darkest and lightest wallpaper under it; glyphs and borders ≥ 3:1 (UIG-16).
- [ ] Live regions throttled (≤ 1 per 750 ms on boot surfaces, ≤ 1 per 2 s elsewhere, latest wins).
- [ ] axe: zero serious or critical in both themes (DSN-20).

### 0.4 Evidence

- [ ] Gallery story for the slug renders (`?story=<slug>`), with fixtures matching the reference render (UIG-14).
- [ ] Visual baselines: light/dark × settled/reduced (UIG-15).
- [ ] Side-by-side fidelity review against `reference.png` done; allowed deviations listed with their `D-nn` (guide §3.9.5).

---

## 1. Shared chrome (used by every desktop screen)

Components: `MenuBar`, `Dock`, `WindowFrame`, `TrafficLights`, `WindowOverlay`, `WindowMenu`, `ResizeHandles`, `ToastStack`, compositor snap preview. Gate: P2 (menu bar basics, dock, frame), P3 (status items, overlays, toasts). IDs: WM-01…WM-07, OFF-04, OFF-05, WMD-09…WMD-11, WMD-18, WMD-22, WMD-23.

### 1.1 Menu bar (28 px glass)

**Elements and states**

- [ ] Atom menu: default · hover pill · focus ring · open (pressed pill, menu below) · items `About Plotinium`, `Settings…`, `Lock Screen`, `Log Out <user>…`, `Restart…`, `Shut Down…`.
- [ ] Focused app name in bold: follows the focused window; `Plotinium` when the desktop has focus.
- [ ] App menus (per app manifest): default · hover · focus · open · disabled items at `--pl-text-disabled` with a reason · neighbour menu opens on hover while one is open.
- [ ] Connectivity item, exact texts: `Online` (check) · `Syncing 1 op` / `Syncing 3 ops` (arrows) · `Reconnecting in 4 s` (clock, from `retryAt`) · `Offline · 2 queued` (cloud-off, warning chip) · `Sign in to sync` (warning chip).
- [ ] Degraded item: hidden at 0 · `2 degraded` (warning chip) · `starting (3)` after `desktop-interactive`.
- [ ] Memory meter: `198 / 256 MB` + bar · warning at ≥ 85 % · danger at ≥ 95 % · both also stated in text in the popover and the accessible name.
- [ ] AI item: idle · indexing (popover `Indexing 42 %` with a determinate bar) · loading · `AI off` (struck sparkle) · error · hidden in the AI-off build and safe mode.
- [ ] `Restart to update` accent chip when `update.available`; absent otherwise; hidden during shutdown.
- [ ] `Offline-ready`: label visible 10 s, then icon only with the same accessible name.
- [ ] Secure indicator: `Secure prompt` or `Kernel confirmation` chip while the compositor shows a secure surface.
- [ ] Control Centre button · Search button · clock `Thu 24 Sep 10:42` with unread badge (hidden at 0, `9+` above 9).
- [ ] Stale state when the kernel link stops: values dimmed + `last update hh:mm:ss` (UIG-23).

**Animations**

- [ ] Entrance after login: `translateY(-100%)` → 0, 320 ms `--pl-ease-out`, delay 80 ms → RM: present.
- [ ] App name crossfade (old −3 px, new +3 px), 160 ms `--pl-ease` → RM: text swap.
- [ ] Menus `.pl-anim-menu-in` / `.pl-anim-menu-out`; item confirm blink once → RM: instant, no blink.
- [ ] Status popovers `.pl-anim-popover-in` from the item → RM: instant.
- [ ] Connectivity change: glyph crossfade + one ring pulse (≤ 1 per 2 s) → RM: glyph swap + announcement.
- [ ] Memory fill `scaleX` 200 ms; one pulse at 95 % → RM: value updates.
- [ ] AI sparkle rotates 180° once on start/finish → RM: static.
- [ ] Update chip `scale(.6)` → 1 + one glow pulse; neighbours FLIP → RM: appears.
- [ ] The clock changes with no animation.

**Accessibility**

- [ ] `<header>` › `<nav aria-label="Menu bar">` › `role=menubar`; status `role=group aria-label="Status"`.
- [ ] ←/→ between titles, ↓/Enter opens, Esc closes and returns focus; `Alt+B` focuses the bar.
- [ ] Status buttons named in full sentences ("Sync: offline, 2 changes queued"; "Memory: 198 of 256 megabytes used, 77 percent").
- [ ] Status changes announced in the tray live region (≤ 1 per 2 s).

### 1.2 Dock

**Elements and states**

- [ ] App items (52 px own icons): Files, Terminal, Editor, Task Manager, Settings, Search; separator; Trash (empty / full).
- [ ] Per item: default · hover (magnify + tooltip) · focus (ring + tooltip) · pressed (scale .92) · launching (one bounce until the first window) · running (dot) · active (activity ring) · attention (bounce once + name "needs attention") · count badge when > 1 window · minimised marker.
- [ ] Click semantics (WMD-10): one window focused → minimise · minimised → restore and focus · otherwise focus · several windows → group menu.
- [ ] Group menu: `New window`, the window list with states, `Minimise all`, `Close all`.
- [ ] Compact mode: 40 px icons, no magnification.

**Animations**

- [ ] Entrance: `translateY(24px) scale(.96)` → none, 420 ms `--pl-ease-spring`, delay 140 ms; icons stagger 30 ms → RM: present.
- [ ] Magnification (transform only, rAF, peak 1.45, neighbours ≈ 1.2 / 1.08, lift −10 px, capsule `scaleX`); 200 ms spring settle on leave → RM: none, tooltip only.
- [ ] Press `.pl-press` → RM: tint only.
- [ ] Launch `.pl-anim-dock-bounce` once → RM: dot appears.
- [ ] Attention `.pl-anim-dock-attention` once → RM: badge + announcement.
- [ ] Running dot `.pl-anim-pop-in` → RM: appears.
- [ ] Tooltip `.pl-anim-tooltip-in` (300 ms hover, immediate on focus) → RM: instant.

**Accessibility**

- [ ] `<nav aria-label="Dock">` › `role=toolbar`, roving tabindex (←/→, Home/End); Enter/Space activate; Shift+F10 or context key opens the group menu; `Alt+N` focuses the dock, Esc returns to the window.
- [ ] Names include state: "Files, running, 2 windows".

### 1.3 Window frame and traffic lights

**Elements and states**

- [ ] Frame: focused (coloured lights, `--pl-shadow-win-focus`, full-strength title) · unfocused (grey lights, `--pl-shadow-win`, dim layer, muted title) · dragging (`data-dragging`: `--pl-shadow-win-drag`, no transition) · maximised / full screen / snapped (radius 0 on the relevant edges) · minimised (inert, hidden).
- [ ] Chrome `titled` (Terminal) and `unified` (Files, Editor, Task Manager, Settings) (UIG-20).
- [ ] Traffic lights: default · group hover and focus-within show ×, −, ⤢ · pressed (darker) · zoom disabled on fixed-size windows (hollow, `aria-disabled`).
- [ ] Double-click on the title bar or a drag region toggles maximise; buttons inside a drag region never drag.
- [ ] Resize handles on 8 edges/corners with the right cursors; hidden when maximised, full screen or minimised.
- [ ] Window menu (`Alt+W`, Shift+F10, context key, right-click on a drag region): `Move`, `Size`, `Snap left`, `Snap right`, `Maximise`/`Restore`, `Full screen`, `Minimise`, `Close`, each with its keycap.
- [ ] Keyboard move/size mode: arrows 16 px, Shift+arrows 1 px, Enter commits, Esc restores; result announced ("Moved to 120, 80").
- [ ] Snap preview: accent-subtle fill, 2 px accent border, radius; appears in the side and top zones; cancelled on leaving the zone.

**Overlays (exact)**

- [ ] `Restoring… 3.1 / 5.0 MB` + 240 px determinate bar + `from local swap` / `from server` (drawn in the first frame after the click).
- [ ] `Suspended to save memory — click to restore`.
- [ ] `<App> stopped` · [Restart] [Details] (details as text).
- [ ] `<App> is not responding` · [Wait] [Force quit].
- [ ] `Closing…` (window inert).
- [ ] Close guard: `Discard unsaved changes to report.md?` · [Cancel] (focused) [Save and close] [Discard and close].
- [ ] `Not started in safe mode` · [Start].
- [ ] `Could not restore` · [Restart app] [Details] (EIO).

**Animations (compositor WAAPI, guide §3.5.3)**

- [ ] Open: from `opacity 0; scale(.94) translateY(10px)`, 360 ms `--pl-ease-spring`, origin at the dock icon when launched from the dock; first painted frame is keyframe 0 → RM: appears in the first flush.
- [ ] Close: to `opacity 0; scale(.96)`, 160 ms `--pl-ease-in`, only after the kernel's `close` → RM: removed at once.
- [ ] Minimise: genie approximation toward the dock icon, 320 ms `--pl-ease-genie` → RM: hidden at once, marker shown.
- [ ] Restore: reverse, 320 ms `--pl-ease-spring` → RM: shown at once.
- [ ] Maximise / un-maximise / snap / full screen: FLIP 260 ms `--pl-ease-spring`, origin `0 0` → RM: new geometry at once.
- [ ] Focus change: shadow-layer crossfade `--pl-motion-med`; dim layer 160 ms → RM: instant.
- [ ] Traffic-light glyphs fade + scale .6 → 1, 120 ms → RM: glyphs appear.
- [ ] Overlay card fade + `scale(.98)` → 1 → RM: present.
- [ ] Snap preview fade `--pl-motion-fast` → RM: instant.
- [ ] One animation per window at a time; a new command finishes the running one.

**Accessibility**

- [ ] `<section role=dialog aria-modal=false aria-labelledby="t{wid}">`; unified windows keep a visually hidden `h2`.
- [ ] Lights named "Close <title>", "Minimise <title>", "Zoom <title>"; 24 × 24 hit area.
- [ ] Every drag has a keyboard alternative (window menu) (WCAG 2.5.7).
- [ ] Restoring progress `role=progressbar` with byte counts; milestones 0 %, 50 %, done announced.

### 1.4 Toasts (D-10)

- [ ] Top-right, 8 px under the menu bar, newest on top, at most 3 visible, 360 px.
- [ ] Levels: info / success (6 s), warning (10 s), error (sticky); level glyph + text, no colour-only rule.
- [ ] Timer pauses on hover and while focus is inside.
- [ ] Never covers the focused element (moves or queues).
- [ ] Repeats collapse ("Lock lost on 3 files"); ≤ 1 new toast per source per 2 s.
- [ ] Every toast is also in the notification centre.
- [ ] Enter `.pl-anim-notification-in`, leave `.pl-anim-notification-out`; files into the centre when it opens → RM: appear/disappear at once.
- [ ] info/success/warning `role=status`, error `role=alert`; toasts never take focus.

---

## 2. Boot screens (framework-free, `ui/src/boot`, inlined)

Global for this group:

- [ ] No Solid, JSX, lucide, xterm or CodeMirror import; DOM through `dom.ts` text nodes only (UIG-03).
- [ ] No `@keyframes`, `animation`, `setTimeout`, `setInterval` in `ui/src/boot/**` or the inlined output; only the two allowlisted timers in `wm/src/boot-ui` (SVC-10).
- [ ] Every animation is a CSS transition triggered by a real boot event, a key press or `transitionend`; if the boot stalls, all motion stops.
- [ ] Renders with the shell chunk blocked (DSN-14).
- [ ] No font request (system stack; outlined SVG wordmark) (UIG-17).

### 2.1 `boot-splash` — boot splash

Sources: `stitch/boot-splash/` · Builder: `Splash` · Gate: P2 (v1: assets + kernel init), P3 (DAG-driven) · IDs: BOOT-01, BOOT-02, BOOT-05 (V), BOOT-06 (Esc), BOOT-13, DSN-07, DSN-10, SVC-10.

**Elements and states**

- [ ] Background `--pl-bg` with the boot gradient; three blob layers (pre-blurred, positioned per boot stage); faint orbit-arc wallpaper (`aria-hidden`).
- [ ] Logo 96 px atom, fully visible at first paint (static HTML).
- [ ] Wordmark `Plotinium` (outlined SVG, `role=img aria-label=Plotinium`), visible at first paint.
- [ ] Version line exact: `version 0.3.0 · build a1f93c2`; dev build: prefix `dev build` in `--pl-warning` + `version 0.3.0-dev.14 · build a1f93c2`.
- [ ] Progress bar (`--pl-boot-bar-w` × `--pl-boot-bar-h`, pill): P = 0 shows the track only · moves only on real events · never past P · stops at its last true value on a stall.
- [ ] Step line: `checking system` → `Loading kernel · 38 of 104 KB` → `<service>: <detail>` (e.g. `vfs: mounting / (12,408 inodes)`).
- [ ] Count line: hidden before stage 4 · `Service start · 7 of 9` (done/total over the desktop ancestor set).
- [ ] Hint chips: `Esc` Boot menu and `V` Verbose log (glass pills with keycaps) · hover · focus ring · pressed while the key is down · Esc chip disabled after the stage-2 decision (40 %, `aria-disabled`, tooltip `Boot menu: run reboot --menu`) · V chip "on" state: accent hairline and label `Hide log`.
- [ ] Stall (15 s without a boot event): step line replaced by `Plotinium is not making progress: <last event> (<n> s ago)` with `[T] Retry (reload) [S] Safe mode [D] Diagnostics` (StatusCard).
- [ ] Critical failure hands over to the recovery screen; a cycle hands over to the kernel panic.

**Animations** (all transitions)

- [ ] 1 Logo group `scale(.96)` → 1 via `@starting-style`, 520 ms `--pl-ease-spring-soft` (opaque from frame 1) → RM: final state.
- [ ] 2 Nucleus bloom `opacity 0 → .85`, `scale(.6)` → 1, 640 ms, delay 80 ms → RM: static glow.
- [ ] 3 Wordmark translate only; version, bar, step lines fade + rise 6 px, 360 ms, delays 60/100/140/180 ms → RM: final state.
- [ ] 4 Hint chips `translateY(8px)` + fade, 320 ms, delay 240 ms → RM: shown.
- [ ] 5 Orbit ticks per boot event: `rotate(calc(var(--tick) * 9deg))`, −6°, 4° parallax, 560 ms spring-soft → RM: no rotation.
- [ ] 6 Nucleus flash on each service done: scale 1.12 then back (140 ms in, 420 ms out) → RM: none (count still updates).
- [ ] 7 Fill `transform: scaleX(P)`, `--pl-motion-fast` `--pl-ease`, never a spring (D-07) → RM: jumps to P.
- [ ] 8 Sweep sheen once per progress update (260 ms in, 480 ms out) → RM: hidden.
- [ ] 9 Fill glow pulse per update → RM: static.
- [ ] 10 Step-line swap (out −4 px 120 ms, in +4 px 200 ms), skipped if the previous swap was < 120 ms ago → RM: text replaced.
- [ ] 11 Count digit roll (200 ms) → RM: text replaced.
- [ ] 12 Blobs move to the stage preset on stage change (`--pl-motion-stage`) → RM: static at stage-1 preset.
- [ ] 13 Keycap press `translateY(1px) scale(.94)` → RM: opacity step.
- [ ] 14 Esc chip to 40 % on the stage-2 decision → RM: instant.
- [ ] 15 V chip border + label crossfade → RM: instant.
- [ ] 16 Column moves up (`translateY(-180px) scale(.86)`) when the verbose log opens; log rises → RM: crossfade 0 ms.
- [ ] 17 Exit to the boot menu: column fades + `scale(.97)`, pre-blurred wallpaper fades in → RM: instant swap.
- [ ] 18 Exit to login/desktop: zoom-through `scale(1.04)` + fade (`--pl-motion-slow`) → RM: instant swap.
- [ ] `will-change` only on orbit groups and blobs, removed after `desktop-interactive`.

**Accessibility**

- [ ] `<main aria-labelledby=boot-title>` with a visually hidden `h1` "Plotinium is starting"; hint row in `<footer>`.
- [ ] `role=progressbar`, `aria-valuemin=0`, `aria-valuemax=100`, integer `aria-valuenow`, `aria-valuetext` "Starting vfs, 7 of 9", `aria-describedby` → step line.
- [ ] Hidden `role=status` announces stage changes ≤ 1 per 750 ms (timestamp-throttled).
- [ ] Esc and V work from the first inline line (buffered); chips focusable with `aria-keyshortcuts`.
- [ ] Forced colours: track/fill `CanvasText`/`Highlight`, glow and sheen hidden.

**Deviations from the reference (build this)**

- [ ] Bar fill uses `scaleX`, not `width` (D-07).
- [ ] Bar width from `--pl-boot-bar-w` (token decides 240/280/320 px; one value).
- [ ] Atom logo, not the ring mark (D-04).

### 2.2 `boot-menu` — Plotinium Boot Manager

Sources: `stitch/boot-menu/` (+ `reference-safe-preselected.png`) · Builder: `BootMenu` · Gate: P3 · IDs: BOOT-05, BOOT-06, BOOT-13, SVC-05, SVC-06, SVC-07, DSN-14.

**Elements and states**

- [ ] Background: pre-blurred boot wallpaper + 35 % scrim.
- [ ] Panel 480 px, material `sheet` (static blur set once), hairline, inner highlight, `--pl-shadow-dialog`.
- [ ] Header: 22 px atom, `Plotinium Boot Manager`, right `0.3.0 · a1f93c2` (dev build variant with `dev build` in warning).
- [ ] Warning line only after 2 failed boots: `The last 2 boots failed. Safe mode is selected.` (`role=status`), Safe mode preselected.
- [ ] Options (icon, title, description): `Normal boot` — `Start Plotinium and restore your session`; `Safe mode` — `No AI services · no autostart apps · default theme`; `Recovery` — `File-system check · clear local cache · reset session`; `Verbose boot` — `Timestamped kernel log`.
- [ ] Option states: default · hover wash (pointer never moves the selection) · selected (accent tint, 2 px accent left rule, `▶`) · focus ring · pressed `scale(.985)` · after Enter: others fade to 40 %, footer `Starting <mode>…`.
- [ ] Footer keycaps `↑` `↓` select · `Enter` boot · `Esc` close; countdown `auto-boot in 5 s` with a 5-segment ring (D-21); stops at the first key press.
- [ ] Helper line under the panel: `Hold Esc at start-up, or run reboot --menu, to open this menu`.
- [ ] Loader exception → boots Safe with a `WARN` line; the menu never shows a broken state.

**Animations**

- [ ] 1 Blurred wallpaper + scrim fade 240 ms → RM: instant.
- [ ] 2 Panel `translateY(10px) scale(.96)` → none, 420 ms spring-soft → RM: instant.
- [ ] 3 Header, rows, footer stagger 40 ms (fade + 4 px) → RM: no stagger.
- [ ] 4–5 One highlight pill with the accent rule slides `translateY`, 260 ms `--pl-ease-spring` → RM: jumps.
- [ ] 6 `▶` fades in with `translateX(-4px)` → 0 → RM: instant.
- [ ] 7 Row icon `scale(1.08)` + accent copy fades in → RM: accent copy at once.
- [ ] 8 Hover wash opacity 120 ms → RM: instant.
- [ ] 9 Row press `scale(.985)` → RM: highlight opacity step.
- [ ] 10 Footer keycap press → RM: opacity step.
- [ ] 11 Countdown: one ring segment fades per tick → RM: instant step (still counts: it carries information).
- [ ] 12 Countdown digit roll → RM: text replaced.
- [ ] 13 Countdown stop: label and ring fade out, hints recentre → RM: removed.
- [ ] 14 Warning line in before the rows → RM: shown.
- [ ] 15 Non-chosen rows to 40 % after Enter → RM: instant.
- [ ] 16 Exit: panel fade + `scale(.98)`, splash re-enters showing the mode → RM: instant swap.

**Accessibility**

- [ ] `role=dialog aria-modal=true aria-labelledby=bootmgr-title`; `h1` title.
- [ ] `role=listbox` with `aria-activedescendant`; focus lands on the listbox; options `role=option aria-selected`, description via `aria-describedby`; icons and `▶` `aria-hidden`.
- [ ] ↑/↓ wrap, Home/End, Enter boots, Esc boots Normal; pointer click selects, double-click boots (if adopted, covered by the keyboard e2e).
- [ ] Countdown announced once ("auto-boot in 5 seconds") and once on stop ("auto-boot stopped"); ring `aria-hidden`.
- [ ] Hidden sentence "Use the arrow keys to choose, Enter to boot, Escape to close." linked from the listbox.
- [ ] Selected-row text ≥ 4.5:1 on the accent tint.

### 2.3 `boot-verbose-log` — verbose boot log

Sources: `stitch/boot-verbose-log/` · Builder: `VerboseLog` · Gate: P3 · IDs: BOOT-05, BOOT-13, DSN-08.

**Elements and states**

- [ ] Header: logo, `Plotinium`, chip `verbose boot` (`verbose · safe` / `verbose · recovery`), `boot id 7f3e·b12c · <timestamp>` (`boot id pending` before assignment).
- [ ] Log rows: `[    0.087] storage: opened plotinium v7 (IndexedDB) in 64 ms` — timestamp right-aligned in 11 columns, tag, message; empty state `waiting for firmware…`.
- [ ] Prefix pills as text: `WARN` (warning), `DEGRADED` (warning), `FAIL` (danger), `KERNEL PANIC` (danger, bold) — never colour alone.
- [ ] Final `desktop: interactive · 4 windows restored · boot 0.73 s · 2 services degraded` with a check glyph.
- [ ] Row hover tint (text selectable); selection colour `--pl-text-selection`.
- [ ] Auto-scroll sticks to the bottom until the user scrolls up; then `↓ 3 new lines` pill (Jump to latest).
- [ ] Static block cursor while booting; hidden after interactive (no blink).
- [ ] Services rail (≥ 1280 px wide only): dot **and** state word (`ok`, `starting`, `offline`, `degraded`, `background`, `failed`, `not started (safe mode)`), pid; summary `16 ok · 2 degraded · 0 failed`.
- [ ] Footer: `Plotinium 0.3.0 · build a1f93c2`, `V` keycap `Press V to hide log`, `boot 0.73 s` (live elapsed while booting).
- [ ] 3 px progress bar pinned to the bottom; turns danger and stops on panic/recovery.

**Animations**

- [ ] 1 Splash ↔ log toggle, 200 ms spring → RM: instant swap.
- [ ] 2 New line `translateX(-6px)` + fade 120 ms from `@starting-style` → RM: instant.
- [ ] 3 Bursts > 8 lines per frame: only the last line moves, the rest fade → RM: instant.
- [ ] 4 Prefix pill `scale(.9)` → 1, 40 ms after its row → RM: instant.
- [ ] 5 Final check `scale(.6)` → 1 → RM: instant.
- [ ] 6 Bar `scaleX(P)` 120 ms `--pl-ease` → RM: jumps.
- [ ] 7 Completion glow once (two chained transitions, no timer) → RM: none.
- [ ] 8 Rail row state change: dot scale + word crossfade → RM: text swap.
- [ ] 9 Rail entrance on the first service event → RM: instant.
- [ ] 10 Jump pill in/out → RM: instant.
- [ ] 11 V keycap press → RM: none.
- [ ] 12 Hand-off to login/desktop: fade + `scale(1.02)` → RM: cut.

**Accessibility**

- [ ] Header `role=banner`, log in `<main>`, rail `<aside aria-label=Services>`, footer `role=contentinfo`.
- [ ] Log `role=log aria-live=off aria-label="Boot log"`, `tabindex=0`, arrows/PgUp/PgDn scroll, `End` jumps to newest.
- [ ] Separate status region announces stage changes, summaries and `WARN`/`DEGRADED`/`FAIL` lines (≤ 1 per 750 ms).
- [ ] `V` toggles and announces `Boot log shown` / `Boot log hidden`.
- [ ] Timestamps ≥ 4.5:1 at 12 px on the dark surface.

### 2.4 `kernel-panic` — kernel panic

Sources: `stitch/kernel-panic/` · Builder: `Panic` · Gate: P3 · IDs: BOOT-04, BOOT-08, DSN-14.

**Elements and states**

- [ ] Static red edge vignette + violet centre haze (`aria-hidden`), no grain animation.
- [ ] Card ≈ 720 px, static tint, large shadow; 56 px alert medallion (triangle-alert, not a hazard symbol).
- [ ] Title exact: `Plotinium kernel panic` (DSN §3.8.4; the reference's shorter `Kernel panic` is not used).
- [ ] Explanation: `Plotinium stopped during boot because the service graph contains a cycle. Your files are safe; nothing was written.`
- [ ] Code block (focusable `pre`, copyable): `KERNEL PANIC: dependency cycle detected: sync → lockd → auth → sync` (danger, semibold) and `boot halted.`; one canonical cycle rotation shared with the log.
- [ ] Cycle diagram: nodes in a triangle, arrowheads, `closes cycle` label, dimmed dashed `storage` node; V1–V9 manifest panics replace the diagram with the offending file name; Worker-error variant adds a `Stack trace` disclosure.
- [ ] Buttons: `[R] Recovery console` (primary, initial focus), `[S] Safe mode`, `[D] Download diagnostics` (downloads `plotinium-boot-<bootId>.json`); busy labels `Rebooting into recovery…`, `Rebooting in safe mode…`, `Preparing boot record…`; others `aria-disabled` while one runs; download success `Saved plotinium-boot-7f3e.json`; blocked download message.
- [ ] Hint: `Use R, S or D, or Tab to move between options. Safe mode starts without AI services or autostart apps, using the built-in service list.`
- [ ] Footer: `boot #37 · 0.3.0 (a1f93c2) · <timestamp>` / `uptime 0.022 s`, atom + version.

**Animations** (`@starting-style` stagger)

- [ ] 1 Boot layer recedes (fade + `scale(.98)`) → RM: cut.
- [ ] 2 Vignette fade 320 ms → RM: full opacity.
- [ ] 3 Card `translateY(12px) scale(.96)` → none, 320 ms spring, delay 60 ms → RM: instant.
- [ ] 4 Medallion `scale(.7)` → 1, one overshoot, no pulse → RM: instant.
- [ ] 5 Title, explanation, code block fade + 6 px, delays 160/200/240 ms → RM: instant.
- [ ] 6 Diagram nodes `scale(.9)` → 1 in cycle order → RM: instant.
- [ ] 7 Edges revealed by a clip `scaleX` in cycle order, arrowheads fade → RM: drawn.
- [ ] 8 `closes cycle` label fade → RM: instant.
- [ ] 9 Buttons rise, delays 400/440/480 ms → RM: instant.
- [ ] 10 Focus ring on `[R]` after the entrance (`transitionend`) → RM: shown immediately.
- [ ] 11 Button hover tint + icon `translateX(1px)` → RM: tint only.
- [ ] 12 Press / R, S, D key: `scale(.98)` + keycap → RM: tint.
- [ ] 13 Diagram node hover lift → RM: opacity only.
- [ ] 14 R or S: card fades then `location.replace` on `transitionend` → RM: navigate at once.
- [ ] 15 D success check `scale(.6)` → 1 → RM: swap.

**Accessibility**

- [ ] `<main aria-labelledby=panic-title aria-describedby=panic-desc>`; not a modal.
- [ ] One `role=alert` announcement with the cycle spoken with commas.
- [ ] R, S, D work regardless of focus (`aria-keyshortcuts`); Tab order code block → R → S → D.
- [ ] Diagram `role=img` with the full text alternative.
- [ ] Danger text ≥ 4.5:1 on the card tint.

### 2.5 `recovery-console` — recovery console

Sources: `stitch/recovery-console/` · Builder: `RecoveryConsole` · Gate: P3 · IDs: BOOT-06, BOOT-08, SVC-06, VFS-11 (UI), DSN-15.

**Elements and states**

- [ ] No traffic lights (D-19).
- [ ] Top bar: atom, `Plotinium Recovery Console · 0.3.0 (a1f93c2)`; amber pill `Recovery mode — read-only file system` (after repair adds `local repairs are not synced until next login`); `Offline · storage 412 MB used`; clock (`aria-hidden`).
- [ ] Reason line, e.g. `Critical service "storage" failed: local database version is newer than this build (VersionError).`
- [ ] Action list with key chips and consequence lines (DSN §3.8.5 texts; keys per boot spec §3.8): `Retry boot`, `Safe mode`, `Check file system` (F), `Repair file system` (Y), `Clear local cache and re-sync` (C), `Reset session` (S), `Restore default service manifests` (M), `Boot log` (L), `Download diagnostics` (D), reboot `Normal` (N) / `Safe` (B).
- [ ] Row states: default · hover · focus (roving) · selected (accent pill) · running (determinate ring) · disabled while another destructive action runs (Diagnostics stays enabled) · error (red dot + `role=alert` banner with Retry).
- [ ] Destructive two-step confirmation: the button becomes `Press Enter again to confirm — deletes 212 MB of local data; 3 unsynced changes will be exported first` with `Cancel` focused; clear-cache always exports `plotinium-outbox-<timestamp>.json` first.
- [ ] fsck pane: header `File-system check`, subtitle `fsck / — local mirror · 12,408 inodes · started 14:31:52` (idle: `Not run yet this boot`); `Check | Check & repair (Y)` segmented (repair shows `Repairs are local-only; the next online login re-converges from the server`); checklist rows pending → running (ring) → passed (check + detail) → failed (x + detail, expandable) → repaired (wrench + `repaired 2`), each with a text status; 6 px determinate bar; caption `Stage 4 of 5 · 78%` (the `about n s left` estimate only after two passes); result log (empty `Run a check to see its report here.`; summary line green or red); buttons `Copy report` (→ `Copied`), `Boot log (L)`, `Reboot to desktop` (disabled while running).
- [ ] Other panes: clear cache step list with the exported file name; reset-session preview; manifests diff; diagnostics capability table + `Download JSON`; reboot choices `Normal (N)` / `Safe mode (B)`.

**Animations**

- [ ] 1 Console `scale(.94)` → 1 + fade 240 ms spring → RM: instant.
- [ ] 2 Top bar fade + `translateY(-6px)` → RM: instant.
- [ ] 3 Action rows stagger 30 ms → RM: together.
- [ ] 4 Selection pill FLIP 200 ms spring → RM: jumps.
- [ ] 5 Pane swap ±12 px (120 out / 200 in) → RM: instant.
- [ ] 6 Check mark `scale(.6)` → 1, tick revealed by a translating clip → RM: full size.
- [ ] 7 Running ring `rotate` per real progress only → RM: snaps.
- [ ] 8 Row status icon swap → RM: instant.
- [ ] 9 Bar `scaleX` → RM: snaps.
- [ ] 10 Completion glint once; bar green briefly → RM: no glint, green at once.
- [ ] 11 Log lines fade + 4 px → RM: appear.
- [ ] 12 Summary `scale(.98)` → 1 → RM: appears.
- [ ] 13 Button press `scale(.97)` → RM: none.
- [ ] 14 Confirm state morph → RM: instant.
- [ ] 15 Copy → Copied crossfade → RM: swap.
- [ ] 16 Reboot: fade + `scale(.98)` before `location.replace` → RM: navigate at once.

**Accessibility**

- [ ] `header role=banner`, `nav aria-label="Recovery actions"`, `main`.
- [ ] Action list `role=listbox` with `aria-activedescendant`; ↑/↓/Home/End; Enter runs; single-key shortcuts via `aria-keyshortcuts`, inactive while focus is in a text field.
- [ ] Checklist `ol aria-label="fsck passes"` with text statuses; progress `aria-valuetext` "Stage 4 of 5, quota totals, 78 percent".
- [ ] Result log `role=log aria-live=polite`; final summary also via `role=status`.
- [ ] Key chips that carry information at ≥ 60 % label opacity.

### 2.6 `unsupported-browser` — POST failure and other status cards

Sources: `stitch/unsupported-browser/` · Builder: `StatusCard` · Gate: P2 · IDs: BOOT-01, BOOT-08, SVC-14, PLT-ID-08.

**Elements and states**

- [ ] Fatal variant title exact: `Plotinium cannot start in this browser`; no Continue button (hidden, not disabled) (D-20).
- [ ] Degraded-only results do not show this card (WARN line only), except with `?boot=verbose`: title `Plotinium will run with reduced features` + `Continue in degraded mode`.
- [ ] Dimmed 64 px atom (40 %), overline `POWER-ON SELF TEST`, subtitle `Plotinium 0.3.0 · build a1f93c2 · Chrome 128 on Linux` (UA from `userAgentData` when available).
- [ ] Capability rows (Secure context, Web Workers, Module workers, IndexedDB, Origin Private File System, WebCrypto, Cross-origin isolation; optional Web Locks, Service Worker, Persistent storage): checking (`Checking…`) · pass (`Pass`) · missing (`Missing` + fix line) · degraded (`Degraded` + fix line) · expandable probe detail (`aria-expanded`) · `Unknown` if the probe throws.
- [ ] Fix lines exact: `Open http://localhost:4717, not a LAN IP`; `Storage disabled or private mode blocks IndexedDB`; `Swap falls back to IndexedDB (plotinium-swap)`; `Pre-emption falls back to messages · AI search runs single-threaded`.
- [ ] Buttons: `Copy diagnostics` (→ `Copied` 1.5 s; denied → `Couldn't copy` + Download JSON link), `Requirements` link (new tab, "(opens in a new tab)").
- [ ] Other variants on the same card: `This page is not Plotinium`; `Plotinium is running in another tab` + `Use here`; stall `Plotinium is not making progress: <last event> (<n> s ago)` + `[T] Retry (reload) [S] Safe mode [D] Diagnostics`; `Plotinium has shut down.` + `Start again`.
- [ ] Background aurora is static (no loop).

**Animations**

- [ ] 1 Card rise + fade 320 ms spring only after the POST result (a passing boot never flashes it) → RM: in place.
- [ ] 2 Logo dims to .4 + `scale(.96)` → RM: shown at .4.
- [ ] 3 Rows stagger 40 ms → RM: together.
- [ ] 4 Pass icon `scale(.6)` → 1 → RM: shown.
- [ ] 5 Missing/degraded icon one gentle overshoot (never a shake); fix line after 80 ms → RM: shown.
- [ ] 6 Row expand: detail fade + chevron `rotate(90deg)` → RM: toggle.
- [ ] 7 Button press spring → RM: none.
- [ ] 8 Copied crossfade → RM: swap.
- [ ] 9 Continue hand-off (verbose only): logo returns to full size where the splash logo sits → RM: cut.
- [ ] 10 Keyboard hint fades in once after the card settles (on `transitionend`, not a timer) → RM: shown.

**Accessibility**

- [ ] `main` › `section aria-labelledby` (not a modal); `footer` version line.
- [ ] Fatal announced via `role=alert`, degraded via `role=status`, including the count of unavailable features.
- [ ] `ul aria-label="Browser capabilities"`; each row one sentence; status is text.
- [ ] Initial focus: Continue (degraded) or Copy diagnostics (fatal); `Enter` and `D` declared with `aria-keyshortcuts`.
- [ ] Renders from inline HTML and CSS even if the probe script throws.

---

## 3. Login and desktop

### 3.1 `login-dark` and `login-light` — login and lock

Sources: `stitch/login-dark/`, `stitch/login-light/` · Components: `LoginScreen`, `UserPicker`, `UserTile`, `PasswordForm`, `GuestContinue`, `LoginStatusBadge`, `PowerRow`, `A11yPopover` · Gate: P2 (online), P3 (offline, lock) · IDs: BOOT-14, OFF-03, WCAG 3.3.8.

**Elements and states**

- [ ] Wallpaper: pre-blurred asset over the gradient (dark violet field / light lavender field with top haze); no live `backdrop-filter`; lock mode uses the session's wallpaper blurred; before the image decodes, solid `--pl-bg`.
- [ ] Date `Thursday, 24 September` above the clock `10:42` (`--pl-text-4xl`, light weight); 12/24 h from settings (24 h before login); short windows (< 700 px) shrink the clock to 64 px when the password is focused.
- [ ] No Wi-Fi, battery or keyboard-layout glyphs (D-17).
- [ ] User tiles (`radiogroup`): known device users + `Demo` + `Guest` + `Other user…` (username field); root never listed.
- [ ] Tile states: default 64 px at 70–75 % · hover 100 % + `scale(1.06)` · focus ring (offset 3 px) · pressed `scale(.96)` · selected 112 px (via transform) with white ring and violet halo (static) · disabled 40 % + lock badge + reason · offline without verifier: disabled `Needs network (no saved verifier)` · signed-in badge (lock mode).
- [ ] Guest selected: password field replaced by `Continue as guest` (offline: `Guest (offline, local only)`) + `Guest files are deleted when you log out.`
- [ ] Password pill: placeholder `Enter password` · hover · focus (ring, accent caret) · filled (dots, submit enabled) · caps lock glyph + `Caps Lock is on` · `Show` toggle (`aria-pressed`) · read-only while signing in · disabled while shutting down.
- [ ] Submit (circular arrow, `aria-label="Sign in"`): empty = `aria-disabled` at reduced opacity · filled · hover · pressed · focus.
- [ ] Signing in: the hint line shows the real stage `Checking password` → `Loading your desktop`; **no spinner, no sweep** (D-09).
- [ ] Error exact: `Invalid username or password` (`role=alert`), field cleared, border tint (never "Incorrect password — n attempts").
- [ ] Back-off exact: `Too many attempts. Try again in 28 s` (countdown from `backoffUntil`; input disabled).
- [ ] `Forgot password?` opens a popover `Ask an administrator to reset your password.` (no network).
- [ ] Status badge: offline `Offline — signing in with this device's saved verifier` (warning, cloud-off) · lock mode `Signed-in sessions: 1` (users glyph; hover lists sessions) · hidden otherwise.
- [ ] Power row: `Restart`, `Shut down` only (no `Sleep`, D-17); first press morphs into `Shut down?` + `Cancel` (reverts after 5 s); with sessions: `1 user is signed in — unsaved work may be lost`.
- [ ] Branding bottom-left: atom, `Plotinium 0.3.0`, mono `build a1f93c2` (tooltip with the build date).
- [ ] Accessibility button bottom-right: `Reduce motion`, `Reduce transparency`; no language picker (D-17).
- [ ] Session expired: the same screen as a dialog over the desktop.

**Animations**

- [ ] Wallpaper fade + `scale(1.08)` → 1 (`--pl-motion-xslow`) → RM: present.
- [ ] Date + clock drop-in (`translateY(-12px)`, spring) → RM: present.
- [ ] Clock digit swap per minute (±8 px + fade) → RM: instant.
- [ ] Tiles stagger 60 ms (`translateY(16px) scale(.9)` → none, spring) → RM: together.
- [ ] Tile hover/press scale → RM: opacity only.
- [ ] Selection FLIP (new `scale(.57)` → 1, old → .57, row re-centres) 420 ms spring → RM: instant swap.
- [ ] Password pill rise (`translateY(8px) scale(.96)`) → RM: present.
- [ ] Dots pop per keystroke (160 ms) → RM: instant.
- [ ] Submit enable `scale(.9)` → 1 → RM: opacity.
- [ ] Error `.pl-anim-login-shake` once → RM: no shake, error text only.
- [ ] Error text fade + 4 px → RM: instant.
- [ ] Badge in/out (`scale(.9)`, 6 px) → RM: instant.
- [ ] Power buttons stagger 50 ms; hover lift −2 px; press .94; confirm morph FLIP → RM: instant swaps.
- [ ] Popovers in/out → RM: instant.
- [ ] Success: `.pl-anim-login-unlock` (lock layer fades and scales, desktop enters) → RM: cut.
- [ ] **Removed** (D-08): wallpaper drift loop, halo breathing, badge dot pulse, verifying sweep/spinner, green-dot ripple, glass specular sweep, white flash.

**Accessibility**

- [ ] `<main aria-label="Sign in to Plotinium">`; wallpaper `aria-hidden`; clock `<time>` with `aria-live=off`.
- [ ] `radiogroup aria-label="Choose user"`, roving tabindex, Enter/Space select.
- [ ] `<form aria-label="Password for student">`, `autocomplete=current-password`, paste allowed, error linked by `aria-describedby`.
- [ ] Focus lands in the selected user's password field; Tab order: picker, password, submit, forgot, power, accessibility.
- [ ] Back-off announced once, not every second.
- [ ] Contrast: tertiary text ≥ 62 % (light) / ≥ 64 % (dark) over the glow; clock ≥ 3:1 (large text).

### 3.2 `desktop-dark` and `desktop-light` — desktop

Sources: `stitch/desktop-dark/`, `stitch/desktop-light/` · Components: `Desktop`, `Wallpaper`, shared chrome (§1), window contents of Files, Terminal, Task Manager (dark) and Editor, Files, Settings Appearance (light) · Gate: P2 · IDs: WM-01…WM-07, OFF-04.

**Elements and states**

- [ ] Wallpaper: static `--pl-wallpaper` (navy → violet dark; lavender → periwinkle with warm glow light); no animation.
- [ ] Clicking empty desktop blurs windows: menu bar shows `Plotinium`, selection cleared.
- [ ] Menu bar with the focused app (`Files` dark, `Editor` light) and its menus; status area: sync dot, `AI` pill, `142/256 MB`, Control Centre, Search, `Thu 24 Sep 10:42` (§1.1).
- [ ] Dock with our own squircle icons, running dots, Files tooltip on hover (§1.2).
- [ ] Focused window coloured lights + focus shadow; unfocused windows grey lights + dim (§1.3).
- [ ] Dark composition: Files focused (sidebar Favourites/Locations; no Tags section, D-18), Terminal behind (`ls -la` output), Task Manager furthest back (CPU sparkline, memory bar, pid list with `ai.indexer` at priority 32 highlighted).
- [ ] Light composition: Editor focused (`os-report.md — ~/notes`, `Edited` tag, Write/Split/Preview, `Ask AI`, outline, split preview, status bar), Files icon grid unfocused, Settings Appearance unfocused (theme thumbnails `Light` / `Dark` / `Follow system`; `Reduce motion`; `Reduce transparency`; **no accent dots**, D-13).
- [ ] Work area: maximised windows stop above the dock and below the menu bar (D-01).
- [ ] Compact mode below 800 px.

**Animations** (shared rows in §1; desktop-specific)

- [ ] Entrance: menu bar slide, dock spring, dock icons stagger, restored windows open back-to-front → RM: all present.
- [ ] Theme switch: snapshot overlay of the old theme fades out (280 ms); colours never transition → RM: instant swap.
- [ ] Settings thumbnail ring `scale(.9)` → 1; switch knob spring; pane crossfade → RM: instant.
- [ ] Editor mode switch: thumb slides; preview `translateX(24px)` + fade; `Edited` tag pop; save check once → RM: instant.
- [ ] Files view switch crossfade; row highlight slide; segmented thumb → RM: instant.
- [ ] Task Manager sparkline scrolls one step per second only while its window is focused → RM: redraw in place.
- [ ] Terminal cursor blinks only in the focused Terminal → RM: solid.

**Accessibility**

- [ ] Landmarks: menu-bar `header`, `main` (Windows region), dock `nav`; wallpaper `aria-hidden`.
- [ ] Keyboard: `Alt+N` dock, `Alt+B` menu bar, `Ctrl+Space` Search, `Alt+`` ` switcher (not `Alt+Tab`), `Alt+O` Overview, `Alt+C` Control Centre.
- [ ] Light theme: secondary text on glass tints ≥ 70 % opacity; accent text uses `--pl-accent-text`.

---

## 4. Apps

### 4.1 `terminal-ai` — Terminal with an AI plan

Sources: `stitch/terminal-ai/` · Components: `WindowFrame` (titled), `TerminalPane`, `TerminalStatusStrip` (P4), `ConfirmStrip` · Gate: P2 (Terminal), P4 (AI plan) · IDs: SYS-02, SHL-03, SHL-13, SHL-14, AGT-03, AGT-08, DSN-13, DSN-16.

**Elements and states**

- [ ] Title exact form `student@plotinium: ~` set by `term` from the shell's cwd; the size suffix (`— 120×36`) only if the shell spec adopts it.
- [ ] No tab strip and no `+` button (D-15).
- [ ] Viewport: xterm DOM renderer, JetBrains Mono 14 px, line height 1.2, padding `--pl-space-2`, theme from `--pl-term-*` and `--pl-ansi-*`, `minimumContrastRatio` 4.5.
- [ ] Prompt: `alice@plotinium` ANSI 2 bold, path ANSI 4 bold, `$`; root `#` with the user part in ANSI 1.
- [ ] Cursor: block, blinking only when focused; outline when unfocused; `cursorBlink: false` under reduced motion.
- [ ] Planning state while `ai.agent` waits on `net:llm`: static text `… planning` (no braille spinner, D-08).
- [ ] Kernel confirmation block (plain TTY text, DSN §3.8.15): header `── Kernel confirmation · ai.agent (pid 212) ──` in ANSI 12 bold; `Plan · 4 steps · 1 transaction`; steps with the destructive word (`delete`, `overwrite`, `chmod`, `chown`) in ANSI 1 **and** in text; names escaped (`\u{…}`); `Blast radius: 13 inodes · 0 deletions · 0 overwrites · within quota`; `Needs confirmation because: chmod`; `Proceed? [y/N/e=edit] ` with `N` default.
- [ ] Results exact: `✓ committed in 41 ms · txn 8f2c · undo with: ai undo 8f2c` (ANSI 2) · `✗ declined — nothing ran` · `✗ rejected: <reason> — nothing ran` · timeout `✗ confirmation timed out — nothing ran`.
- [ ] Badges, glass card, chips and the suggestions popover of the reference are **not** drawn in v1 (D-14, D-15).
- [ ] Kernel-confirmation strip over the title bar while the prompt is active: lock, mono atom, `Kernel confirmation · ai.agent pid 212 · answer in this terminal`; no controls.
- [ ] Menu-bar secure indicator lit during the confirmation.
- [ ] Status strip (P4, optional): `ai.agent pid 212 · Claude via gateway` (green dot) · `ai.agent idle` · `waiting on net:llm` (amber) · `AI unavailable · plain shell` (red); `txn 8f2c committed` / `· syncing` / `· rejected on sync`; `UTF-8 · 120×36 · /home/student`.
- [ ] Shell exits while the window is kept open: `[Process completed — press Enter to close]`.
- [ ] AI-off build: `ai` reports `command not found` (127).

**Animations**

- [ ] Window open/close/minimise via the compositor (§1.3) → RM as §1.3.
- [ ] Terminal text never animates.
- [ ] Confirmation strip `translateY(-100%)` → 0 + fade 200 ms; exit 120 ms → RM: instant.
- [ ] Status-strip dot halo once per state change → RM: colour + text only.
- [ ] Dock bounce once on launch → RM: dot only.

**Accessibility**

- [ ] Window region named by its title; xterm textarea focusable; `screenReaderMode` from Settings → Accessibility.
- [ ] The plan block is plain text in the buffer, read in order; operation type always in words.
- [ ] Confirmation answered only by TTY keys; type-ahead flushed; pastes ignored; default N.
- [ ] Strip announced once via `role=status`.
- [ ] Flood test (`yes | head -n 100000`): no LoAF > 50 ms, output ≤ 1 batch per frame (SHL-03).

### 4.2 `agent-confirm-sheet` — agent confirmation sheet (gated)

Sources: `stitch/agent-confirm-sheet/` · Builder: `AgentSheet` (framework-free) · Gate: P4 **only if an ADR approves it** (D-14) · IDs: AGT-03, DSN-15, DSN-16.

- [ ] ADR recorded (compositor-drawn on `--pl-z-secure`, never in the Terminal DOM; buttons call the kernel confirm path; the TTY prompt stays active and the first answer wins; same token rules). **Until then: none of the lines below is built.**
- [ ] Scrim over the Terminal content only (title bar and tab area readable); clicking it nudges the sheet (RM: status line `Answer the confirmation first`).
- [ ] Security band: mark, lock, `Kernel confirmation · ai.agent pid 212`, `secure layer · not drawn by the app`.
- [ ] Title `Confirm destructive plan`; subtitle naming the request; plan table (`#`, Operation, Path, Effect) with `DELETE` / `MOVE` / `CHMOD` as words; `· to trash` notes if the VFS gains a trash.
- [ ] Blast-radius tiles with `tabular-nums`: inodes, deletions (define: operations or inodes), overwrites; quota chip `within quota · 1.2 GB free`; over quota `over quota by 38 MB` disables Run plan (EDQUOT).
- [ ] Identity line `Runs as student (uid 1001) · one transaction · undo token issued`; elevated variant in warning.
- [ ] Disclosure `Why this needs confirmation` (collapsed by default) with reasons and codes (`DELETE`, `BLAST_RADIUS`, `CHMOD`) and the policy line.
- [ ] Buttons: `Edit plan` (secondary), `Cancel` (default, initial focus), `Run plan` (danger; `Ctrl+Enter` only, never plain Enter); running label `Running… 3 of 5` (determinate); rejection `✗ rejected: EAGAIN changed-since — nothing ran` with `Close`.
- [ ] Loading: 5 static skeleton rows, `Run plan` disabled; dry-run failure body `✗ Plan rejected: EACCES /system/bin — nothing ran`.
- [ ] Static warning at 100 s: `This request will be cancelled in 20 seconds — nothing will run`.
- [ ] Animations (transitions only): scrim fade; sheet slides from under the title bar (320 ms spring-calm); band; icon pop once; rows stagger 30 ms; badges pop; tiles `scale(.96)` → 1 (numbers never count up); focus-ring pulse once; disclosure; press; exit; result line check → RM: all instant.
- [ ] `role=alertdialog aria-modal=true`, labelled and described (title, subtitle, blast radius); real `<table>` with caption; focus trapped; returns to the Terminal prompt; result announced (`Plan cancelled, nothing ran` / `Committed, transaction 8f2c, undo with ai undo 8f2c`).

### 4.3 `files-light` — Files list view with context menu

Sources: `stitch/files-light/` (notes only, no render) · Components: `FilesView`, `PathBar`, `FileList`, `FileIconGrid`, `FileContextMenu`, `DeleteConfirm`, `PermissionsDialog`, `OwnerDialog`, `DetailsPane`, `OperationBanner`, `StatusBar` · Gate: P2 · IDs: VFS-07, DSN-09, DSN-15, DSN-19.

**Elements and states**

- [ ] Unified toolbar (drag region): Back / Forward (enabled, disabled at history ends), Up; title and path bar `/ › home › student › Documents` (segment hover, drop target, overflow `…`, current bold; `/` or click empty part to type a path); view switch `List | Icons`; search field (`Ctrl+F`) with `Name | Content`; view menu (`List`, `Show hidden files`).
- [ ] Sidebar Places: `Home`, `Shared` (when `/home/shared` exists), `Temporary` (`/tmp`), `Root` (`/`); states default, hover, selected, focus, drop target; no Tags section (D-18).
- [ ] Grid columns: `Name` (icon + name; symlink `→ target` muted), `Size` (human, right), `Modified` (`YYYY-MM-DD HH:MM`), `Owner`, `Mode` (mono `rwxr-xr-x`), `Sync` (`pending` + icon); directories first.
- [ ] Header states: default · hover · sorted asc/desc (chevron + `aria-sort`) · focus · (column resize/reorder optional).
- [ ] Row states: default · zebra · hover · focus ring inside the row · selected with window focused (solid accent, white text incl. the mode string, D-12) · selected with window unfocused (`--pl-selection-idle`) · multi-select block · context target outline · cut 50 % · drag source dimmed · folder drop target · renaming (inline field, name selected without extension) · locked by another user (lock badge + `Locked by alice`) · no read permission (dim + lock; opening shows the EACCES text).
- [ ] Loading: static skeleton rows after 150 ms; empty `This folder is empty`; errors `You do not have permission to open this folder` (`EACCES`) with Back, `Couldn't load this folder (EIO)` with Retry.
- [ ] Context menu exact: `Open`, `Open with ▸`, `Rename` (F2), `Copy` (Ctrl+C), `Cut` (Ctrl+X), `Paste` (Ctrl+V), `Delete…` (Delete; danger, last), `New folder`, `New file`, `Create link`, `Properties`; disabled items keep focus and state the reason (`Only the owner can change permissions`); type-ahead.
- [ ] Delete confirmation: `alertdialog` naming count and total size, `Cancel` focused (DSN-15); no "Move to Trash" (D-18).
- [ ] Permissions dialog: octal field + 3 × 3 checkbox matrix + sticky bit (owner or root); Owner dialog root-only, else disabled with the reason.
- [ ] Details pane (`Alt+Enter`): stat fields, lock holder, `Permissions…`, `Owner…`.
- [ ] Long operation (`cp -r`, `rm -r`): determinate bar with real node counts; failure line exact (`EIO — injected fault at node 500 — nothing was changed`).
- [ ] Status bar: `42 items · 1.2 GB of 2 GB quota used` + quota meter (warning ≥ 80 % `Quota nearly full`, danger ≥ 95 % `Free up space`); selection `1 of 42 selected, 1.8 MB`.
- [ ] Offline: normal UI plus `pending` sync markers.

**Animations**

- [ ] 1 Context menu `.pl-anim-menu-in` from the pointer → RM: instant.
- [ ] 2 Menu close fade → RM: instant.
- [ ] 3 Highlight pill FLIP 80 ms → RM: jumps.
- [ ] 4 Confirm blink once → RM: none.
- [ ] 5 `Open with` submenu slide → RM: instant.
- [ ] 6 Row selection fade / FLIP → RM: instant.
- [ ] 7 Row hover fill → RM: instant.
- [ ] 8 Sort: chevron rotate; visible rows FLIP (≤ 20, 8 ms stagger) → RM: instant + `Sorted by Name, ascending` announced.
- [ ] 9 View switch: thumb slide + crossfade → RM: instant.
- [ ] 10 Folder navigation ±12 px, direction-aware → RM: instant.
- [ ] 11 Delete: row exits (`translateX(12px)` + fade), rows below FLIP → RM: removed; status announces the result.
- [ ] 12 Rename field fade; name clash shakes once → RM: error text + `role=alert` only.
- [ ] 13 Lock badge pop → RM: instant.
- [ ] 14 Details pane slide in → RM: instant.
- [ ] 15 Quota bar `scaleX` on first show → RM: at value.
- [ ] 16 Drag image `scale(1.02)`; folder spring-load pulse once at 700 ms → RM: outline only.
- [ ] 17 Window open from the dock (compositor) → RM: instant.

**Accessibility**

- [ ] Window `role=dialog` labelled "Documents"; toolbar `role=toolbar` "Files toolbar"; path `nav aria-label=Path` with `aria-current=location`; sidebar `nav aria-label=Places` with `aria-current=page`.
- [ ] Grid `role=grid` "Documents, 42 items", `aria-multiselectable`, `aria-rowcount` when virtualised; arrows, Space, Shift+arrows, Enter (open), F2 (rename), Delete (confirmed), Shift+F10.
- [ ] Mode strings spelled out in the accessible name ("owner read write, group read, others read").
- [ ] Menu `role=menu aria-label="Actions for kernel-notes.txt"`; focus returns to the row on close.
- [ ] Status region ≤ 1 message per 2 s.
- [ ] A file named `<img src=x onerror=alert(1)>.txt` renders as text everywhere (DSN-09).

### 4.4 `files-semantic-search` — Files semantic search

Sources: `stitch/files-semantic-search/` (notes only, no render) · Components: `FilesView`, `SearchField`, `SemanticResults`, `ResultCard`, `SearchNotice`, `DetailsPane` · Gate: P4 · IDs: RAG-06, DSN-09, DSN-12.

**Elements and states**

- [ ] Search field with sparkle; placeholder `Search notes or ask a question`; mode switch `Name | Content` (the reference's `Semantic` pill maps to `Content`); focus calls `ai.search.focus` (warm-up); clear button; long query notice `Query shortened to 512 tokens`; inline error line.
- [ ] Header `Semantic results` / `Keyword results` + `4 files in notes · 184 ms` (scope is the current folder).
- [ ] Result card: file icon, name, citation `notes/week6-standup.md:42-51` (mono, link style, accent), snippet ≤ 240 chars with `<mark>` highlights (bold + colour), relevance meter + score `0.94` as text, owner, optional `Shared · verified`.
- [ ] Card states: default · hover lift · focus ring · selected ring · pressed `scale(.99)` · opening (Editor opens at `lineStart`) · stale (`Updating…`, score dimmed).
- [ ] Notices exact (RAG spec): `semantic model loading — showing keyword matches` (with a determinate ring from model bytes, never a spinner) · `Semantic search unavailable — showing keyword matches` (`role=alert`) · `1 shared result hidden while offline` · `Semantic search not installed` (AI-off build and safe mode: the switch shows only `Name`).
- [ ] Ready morph: `Semantic ready` with a check, then the chip leaves.
- [ ] Loading: 4 static skeleton cards after 150 ms; empty `No matches in notes` + `Search all of Home`, `Try keyword search`; errors `You can't search /home/alice` (`EACCES`), `The search index is being rebuilt` (`EIO`) with Retry.
- [ ] Details pane for the selected result: permissions mono, owner, group, size, modified, created, version + History, lock chip (`Unlocked — no editors`, `Locked by you` + Unlock, `Locked by alice · 2 min ago` → `Open read-only`, `Lock expired`), buttons `Open`, `Open in Editor`.
- [ ] Status bar: `4 results · indexed 1,284 files · ai.indexer pid 23 (PRI 32)`; indexing `Indexing 12 of 40 files` (determinate); `Indexing paused while you search`.

**Animations**

- [ ] 1 Window open (compositor) → RM: instant.
- [ ] 3 Focus ring pulse on the field → RM: shown.
- [ ] 4 Sparkle scale + rotate once on focus → RM: accent colour only.
- [ ] 5 Cards `translateY(8px)` + fade, stagger 30 ms (max 6) → RM: together.
- [ ] 6 Relevance bars `scaleX(0 → score)` 320 ms, 60 ms after the card → RM: at value.
- [ ] 7 Highlight fade → RM: shown.
- [ ] 8 Fallback chip in → RM: appears.
- [ ] 9 Chip → `Semantic ready` → leaves → RM: swaps, removed; announced.
- [ ] 10 Re-rank FLIP when semantic replaces keyword → RM: instant; `Showing semantic results` announced.
- [ ] 11–13 Card hover lift, press, selection ring → RM: shadow/ring only.
- [ ] 14–15 Inspector content swap and panel slide → RM: instant.
- [ ] 16 Lock chip swap + shackle → RM: instant; `Locked by alice` announced.
- [ ] 17–18 Sidebar pill FLIP; path segment in → RM: instant.
- [ ] 19 Open in Editor from the card rectangle → RM: instant.

**Accessibility**

- [ ] `role=search` with `input type=search aria-label="Search notes by meaning"`, `aria-controls` → results; the mode control is labelled.
- [ ] Results `role=listbox` with `aria-activedescendant`; option name "week6-standup.md, notes/week6-standup.md lines 42 to 51, score 0.94, owner student".
- [ ] Relevance `role=meter` with `aria-valuetext="94 percent relevant"`.
- [ ] Notices in a polite status region (≤ 1 per 2 s); model progress `role=progressbar` "Loading search model, 60 percent".
- [ ] Snippets are text nodes; `<mark>` spans built from offsets (DSN-09).
- [ ] Keys: `Ctrl+F` focus, Esc clears then returns to the list, Enter opens at `lineStart`, `Alt+Enter` details.

### 4.5 `editor-conflict` — Editor with a sync conflict and a remote lock

Sources: `stitch/editor-conflict/` · Components: `EditorView`, `EditorPane`, `EditorBanner`, `LockChip`, `MarkdownPreview`, `OutlineNav`, `EditorStatusBar` · Gate: P2 (basic), P3 (banners) · IDs: VFS-09, VFS-10, WMD-12.

**Elements and states**

- [ ] Atom logo (the reference draws the ring mark: replace, D-04).
- [ ] Title `os-report.md — ~/notes`; `(read-only)` appended while locked; close button shows a dot while `Edited`.
- [ ] Tabs of the reference are not built (one document per Editor window); the conflict dot moves to the toolbar file name.
- [ ] Lock chip states: locked by other `Read-only — locked by alice (lease 12 s)` with a determinate ring (`aria-hidden`) · renewed (ring refills) · expiring (< 5 s, stronger warning) · released → `Editable` (then fades after 2 s) · mine `Editing — you hold the lock` · offline: `last seen 14:31:02`, ring frozen (open question §9.1 of the guide); popover `Request edit access` / `Notify me when free`.
- [ ] Banners exact (DSN §3.8.12): conflict `This file changed on the server. Your version was saved as "report (conflict from alice, 2026-11-14).md".` [Open your version] [Dismiss] · lock `Locked by bob — read-only. The lock expires in 12 s if bob's session stops.` [Try again] · `report.md was changed by another window.` [Reload] [Keep mine] · `Not saved: your quota is full (99.8 of 100 MB). Nothing was written.` · `You can read this file but not write it.`
- [ ] Banner lifecycle: appears · resolved (green `Conflict resolved · kept v8`, then collapses) · error (`Could not reach server · retry in 4 s`, countdown from the event) · dismissed (a `1 conflict` pill in the status bar); no "Checking server version…" spinner (text only).
- [ ] Outline sidebar (`## 4. Sync and conflicts` selected, follows the caret; empty `No headings`); files list with the conflicted copy and a `conflict` badge.
- [ ] Code area: line numbers tertiary, current line band, Markdown highlighting from `--pl-syn-*`, selection; read-only caret hollow; typing shows the `Locked by alice` tooltip, no buffer change; empty file text; loading = static skeleton (≤ 3 sheen passes); error `Could not open os-report.md · ENOENT` + Retry.
- [ ] Status bar exact: `Ln 41, Col 7 · UTF-8 · LF · 12.4 KB · Saved`; save texts `Saved`, `Edited`, `Saving…`, `Saved · offline, 1 queued`, `Not saved`; sync `synced` / `syncing` / `offline · 3 queued` / `1 conflict`; `Read-only` while locked; `Ask AI` hidden (not greyed) in the AI-off build.
- [ ] Close guard while `Edited` (WMD-12).
- [ ] Compare view (split diff) opens from the conflict banner (stretch; P3 if time allows).

**Animations**

- [ ] 1 Window open (compositor) → RM: instant.
- [ ] 2 Banner `translateY(-12px)` + fade; body FLIPs down → RM: present, no shift.
- [ ] 3 Banner icon nudge once → RM: static.
- [ ] 4 Banner dismiss/resolve → RM: removed.
- [ ] 5 Resolved green layer crossfade → RM: swap.
- [ ] 6 Lock chip `scale(.8)` → 1 → RM: appears.
- [ ] 7 Lease ring `rotate` once per second from `expiresAt` (data, not decoration) → RM: ring hidden, text `lease 12 s` updates.
- [ ] 8 Renewal pulse once → RM: number resets.
- [ ] 9 Release → `Editable` → fade → RM: swap, removed after 2 s.
- [ ] 10 Read-only keystroke: tooltip rises; chip shakes once → RM: tooltip only.
- [ ] 11 Caret blink (allowed; stops under RM) → RM: solid caret.
- [ ] 12 Current-line band `translateY` → RM: jumps.
- [ ] 15 Button press → RM: colour only.
- [ ] 16 Compare split (pre-sized panes, transform only) → RM: swap.
- [ ] 17 Synced check reveal → RM: static.
- [ ] 18 Sync arrows one rotation per operation (never a loop; text `syncing…` after 5 s) → RM: text.
- [ ] 19 Outline pill FLIP → RM: instant.
- [ ] 21 Menus and popovers → RM: instant.
- [ ] No more than 3 elements move at once (reconnect choreography: sync check, banner +80 ms, conflict marker +120 ms).

**Accessibility**

- [ ] CodeMirror `textbox aria-multiline`, `aria-readonly=true` while locked; line numbers `aria-hidden`.
- [ ] Conflict banner `role=alert` on first appearance, then a static labelled region; F6 is **not** used (Chrome); focus reaches the banner by Tab order.
- [ ] Lock chip button "Read-only, locked by alice, lease 12 seconds"; `role=timer aria-live=off`; only release and expiry announced.
- [ ] Status bar `role=status` announcing save and sync changes only (never the caret).
- [ ] Keys: `Ctrl+S`, `Ctrl+Shift+S`, `Ctrl+F`; lock retry by the banner's `Try again`.

### 4.6 `task-manager-processes` — Task Manager, Processes tab

Sources: `stitch/task-manager-processes/` (+ `reference-menu.png`) · Components: `TaskManagerView`, `ProcessTable`, `StatePill`, `EndProcessButton`, `ReniceDialog`, `PerformancePanel`, `FrameMeterHud` · Gate: P3 · IDs: PROC-08, PROC-07 (UI), MEM-07, DSN-19, WMD-19.

**Elements and states**

- [ ] Atom logo (the reference draws the ring mark: replace, D-04).
- [ ] Tabs exact: `Processes`, `Memory`, `Predictions`, `Services`, `Performance` (D-13); `Predictions` hidden in the AI-off build.
- [ ] Toolbar: `End Process` split button · `Renice…` · filter (`/` focuses) · `Show all users`.
- [ ] End Process: disabled with no selection, and for pid 1 or kernel services (`System process: cannot end`) · first press → `End burn (301)?` for 3 s · menu `End (SIGTERM)`, `Force kill (kill -9)` (danger, confirmation dialog naming the process), `Suspend (SIGSTOP)`, `Continue (SIGCONT)` (only when stopped) · pending label `Ending…` until TERMINATED (no spinner).
- [ ] Renice dialog: range −20…19, current value, resulting priority, `Apply`; `EPERM` line `Only root may lower nice below 0`.
- [ ] Filter: empty · typing (live) · no match `No process matches "xyz"` + clear.
- [ ] Summary line `12 processes · 6 executors · load 1.84 · uptime 2h 14m`, digits update in place.
- [ ] Columns exact: `Name`, `PID`, `User`, `State`, `PRI`, `NI`, `CPU %`, `Memory`, `Faults`, `Waiting on`, `Time`.
- [ ] State pills with glyph + word: `running`, `ready`, `blocked` (+ reason, e.g. `net:llm`), `stopped`, `suspended` (`paged out`, memory `0 B resident (38 MB swapped)`), `new`, `zombie`.
- [ ] Badges: `background` (`ai.indexer`, PRI 32), `speculative` (dashed, `prefetch:*`, PRI 39), `service`, `kernel`.
- [ ] CPU cell: number + inline bar; ≥ 80 % in danger colour with the number; faults amber above 100/s with the number.
- [ ] Row states: default · zebra · hover · selected (solid accent, white text) · multi-select · focus ring · new (wash once) · terminated (exits) · suspended 72 %.
- [ ] Row context menu: `End`, `Force kill`, `Renice…`, `Suspend`, `Show in Memory tab`, `Copy PID`.
- [ ] Loading 8 static skeleton rows; stale banner `Kernel not responding · last update 6 s ago` with values dimmed (UIG-23).
- [ ] Performance tab: executor sparkline cards (hot > 90 % stated in text; idle < 5 %; lost `restarting…`); frame p95 card `14.2 ms` + `under 16.7 ms budget` (ok / warn 16.7–33 ms / bad > 33 ms with `long animation frames: n`), `View as table`; syscall rate.
- [ ] Status bar `Updated every 1 s` + pause (`Paused · click to resume`; all live motion stops).
- [ ] 256 processes at 10 Hz: ≤ 1 ms UI script per frame; ≤ 1 update per frame.

**Animations**

- [ ] 1 Window open (compositor) → RM: instant.
- [ ] 2 Tab thumb slide (`translateX` + inner `scaleX`) → RM: jumps.
- [ ] 3 Panels ±16 px crossfade → RM: swap.
- [ ] 4 Re-sort FLIP, frozen while hovered or focused → RM: instant reorder, interval stretched to 5 s.
- [ ] 5 New row `translateY(-6px)` + wash once → RM: static `new` dot for 3 s.
- [ ] 6 Terminated row exits then FLIP → RM: removed.
- [ ] 7 State pill label swap → RM: swap.
- [ ] 8 Suspended row settles to 72 % → RM: dimmed.
- [ ] 9 CPU bar `scaleX` → RM: jumps.
- [ ] 10 Digit roll (`tabular-nums`) → RM: swap.
- [ ] 11 Selection pill → RM: instant.
- [ ] 12 End Process confirm pill → RM: label swap (confirm still required).
- [ ] 13 kill -9 shake once then exit → RM: exit only.
- [ ] 14 Menus / renice popover → RM: instant.
- [ ] 15 Renice thumb snap → RM: snaps.
- [ ] 16 Sort chevron rotate → RM: flips.
- [ ] 17 Sparklines scroll one step per second while visible and not paused → RM: redraw in place.
- [ ] 18 Hot executor glow pulses once then static → RM: static glow.
- [ ] 19 Frame check pop → RM: appears.
- [ ] 20 Histogram bars `scaleY` stagger → RM: jumps.
- [ ] 21 `speculative` badge sheen once → RM: static dashed outline.
- [ ] 22 Badge tooltip → RM: instant.
- [ ] 23 Skeleton: static (≤ 3 sheen passes at most) → RM: static.
- [ ] 24 Pause/resume icon swap → RM: swap.
- [ ] No `Ctrl+1…5` tab keys (Chrome) — arrows in the tablist.

**Accessibility**

- [ ] Window labelled "Task Manager"; toolbar `role=toolbar` "Process actions"; `role=tablist` with `tabpanel`s.
- [ ] Grid `role=grid`, `aria-rowcount`, `aria-sort` on the sorted column, `aria-selected` rows; Delete = End Process with confirmation.
- [ ] One polite status region: process exits and state changes of the selected process only.
- [ ] Pill names include the reason ("Blocked, awaiting net:llm").
- [ ] Sparkline cards `role=img` with summaries; frame card has a text equivalent.
- [ ] Renice slider `aria-valuetext="nice +12, priority 32"`.
- [ ] Pill text ≥ 4.5:1 on its tint in both themes.

### 4.7 `task-manager-memory` — Task Manager, Memory tab (and Predictions)

Sources: `stitch/task-manager-memory/` · Components: `MemoryPanel`, `Meter` (segments), `Sparkline`, `PredictionsPanel`, `Table` · Gate: P3 (Memory), P4 (Predictions) · IDs: MEM-01 (display), MEM-07, PRE-06.

**Elements and states**

- [ ] Budget headline exact: `198.4 / 256 MB accounted · reclaim starts at 85%` (one unit label everywhere; the reference mixes MB and MiB).
- [ ] Threshold chip: `90% · above high watermark 85%` (warning) · over budget `Over budget for 1.2 s` (danger) · stated in text.
- [ ] `Reclaim now`: default · running `Reclaiming… 18 MB` · disabled while running or at ≤ LOW_WM (tooltip) · error toast `Reclaim stopped: swap quota full`.
- [ ] Stacked bar: kernel, apps, `ai.embed` (evictable), vector index, speculative (**static** 45° hatch, D-08), free; LOW 75 % and HIGH 85 % ticks; legend with text; segment hover/focus tooltip with exact MB and `evictable` / `backed` / `speculative, expires 00:48`; click filters the table; empty track before the first sample; stale state greyed with `Memory figures are stale (last 14:31:52)`.
- [ ] Stat cards: Page faults (`1,284`, `+12/s`), Hit ratio (`97.2%`, warning below 90 %), Paged out, Paged in, Swap (`OPFS 1.2 GB · Cloud 340 MB`; cloud offline `Cloud · offline`); zero values show `0` and a flat line; `Thrashing guard on` when faults > 20/s for 5 s.
- [ ] Per-process table columns exact (DSN §3.8.13): `Resident`, `Swapped (local)`, `Swapped (remote)`, `Faults`, `Hit ratio`, `Paged in`, `Paged out`, `Speculative` (text `speculative`); SUSPENDED rows 60 % + `suspended` tag; soft-limit breach `!` badge + warning tint; footer `12 of 31 processes`.
- [ ] `Pin` column of the reference is **not built** unless the memory spec adds a pin call (open request).
- [ ] Swap line exact: `Swap device: OPFS · write-behind to server: on`.
- [ ] Predictions (P4): top 3 apps with confidence as text (`Editor 0.62`) + meters; reason text; active `prefetch:*` jobs with pages and speculative bytes; model line `Markov-2 (Witten-Bell) · 214 launches · MFU fallback until 50`; cold start `Learning your habits · 12/50 launches`; disabled `Predictions are off` + Settings link; crashed `Predictor unavailable`.
- [ ] Footer `Thrashing guard: off · 4.2 faults/s · updated 1 s ago` / `Thrashing guard: ON · new heavy processes are refused` (danger).

**Animations**

- [ ] Segments `scaleX` 0 → value on first show (stagger 40 ms) → RM: at value.
- [ ] Segments per sample `scaleX` 400 ms `--pl-ease-out` → RM: instant.
- [ ] Speculative hatch: static (the reference's looping hatch is removed) → RM: static.
- [ ] HIGH tick + chip pulse **once** when crossing (not twice) → RM: colour/text only.
- [ ] Budget digits roll → RM: swap.
- [ ] Stat cards stagger on first show; hover lift → RM: together, no lift.
- [ ] Sparklines scroll one step per second → RM: redraw.
- [ ] Rows: load stagger (≤ 20), re-sort FLIP (skipped above 40 moved rows), exit → RM: instant.
- [ ] Resident inline bars `scaleX` → RM: instant.
- [ ] `!` badge pop → RM: fade 0 ms.
- [ ] Prediction bars `scaleX` + rank FLIP; `pre-fetched` tag in → RM: instant.
- [ ] Loading skeleton static → RM: static.
- [ ] Tooltips, menus, toasts per primitives → RM: instant.

**Accessibility**

- [ ] Budget `role=meter` (`aria-valuemin=0`, `aria-valuemax=256`, `aria-valuenow`, `aria-valuetext="231 of 256 MB accounted, 90%, above high watermark"`); segments a labelled `role=list`, reachable by ←/→ with the tooltip on focus.
- [ ] Stat cards a `role=list`; sparklines `aria-hidden` with text trends.
- [ ] Table with caption "Processes by memory", `aria-sort`, `aria-selected`.
- [ ] Predictions `aside` labelled; meters carry percentages as text.
- [ ] Threshold events announced once ("Memory above high watermark", "Thrashing guard on"), never the 1 Hz samples.

### 4.8 `settings-about` — Settings, About

Sources: `stitch/settings-about/` · Components: `SettingsView`, `SidebarList`, `AboutPane` · Gate: P2 · IDs: DSN-18, §5.3, PLT-ID-09.

**Elements and states**

- [ ] Window fixed size: zoom light disabled (hollow, `aria-disabled`).
- [ ] Toolbar back/forward chevrons (disabled at history ends) and the pane title `About`.
- [ ] Sidebar: search (`Ctrl+F` hint; filters sections, `No settings match "foo"`) · user card `student` / `uid 1001` (guest: `Guest · not signed in`; offline: `Account offline · changes will sync later`) · sections in the D-13 order: About, Appearance, Memory, Scheduler, Privacy & AI, Boot, Keyboard, Accessibility, Accounts, Developer, Help; states default, hover, selected (accent pill), focus, locked for guests (lock glyph).
- [ ] Hero: 96 px atom (static after its one-shot entrance; **no** continuous orbit rotation or breathing glow, D-08), wordmark `Plotinium`, tagline, version pill.
- [ ] System rows exact: `Version 0.3.0 "Orthorhombic"`, `Build a1f93c2 · built 2026-11-02`, kernel identifier, host (`navigator.userAgentData` brand + `hardwareConcurrency`), memory budget, storage (`Storage estimate unavailable` when unknown), signed-in user; hover shows a copy icon; click or Ctrl+C copies → `Copied` 1.2 s.
- [ ] `Section <S> · Team <NN>`; team list of five with role chips (Kernel, VFS / Database, WM / UI, AI Pipeline, QA / DevOps); names from `TEAM_CONTRACT.md` (placeholder `Member to be announced` until filled).
- [ ] Licence, repository link, `Third-party licences` (sheet from `THIRD_PARTY.md`; error `Could not load licences` + Retry), `Copy uname`, `System Report…` (label `Collecting…` while busy, no spinner).
- [ ] Footer `Lahore Garrison University · Capstone, Fall 2026`.

**Animations**

- [ ] Window open/close (compositor) → RM: instant.
- [ ] Sidebar pill FLIP 280 ms (`scaleY` 1.06 bump) → RM: jumps.
- [ ] Pane crossfade `translateY(6px)`; title `translateX(6px)` → RM: instant.
- [ ] Hero entrance once: logo `scale(.8)` → 1, orbits `rotate(-30deg)` → 0 (600 ms spring) → RM: static.
- [ ] Wordmark, tagline, rows stagger → RM: together.
- [ ] Copy icon → `Copied` chip → RM: text swap.
- [ ] Licences sheet `.pl-anim-sheet-in` with scrim → RM: instant.
- [ ] Buttons press → RM: none.
- [ ] Removed: orbit loops (18/26/34 s), nucleus breathing, looping skeleton shimmer (D-08).

**Accessibility**

- [ ] `nav aria-label="Settings sections"`, `aria-current=page`; `main` labelled by the `h1` `About`; wordmark is the `h2`.
- [ ] Info rows `dl`/`dt`/`dd`; team `list` with "Name, role".
- [ ] Sidebar search `role=searchbox` with a polite match count.
- [ ] `Copied version to clipboard` announced.
- [ ] Back/forward keys `Ctrl+[` / `Ctrl+]`; no `Ctrl+W` (Chrome).

### 4.9 `settings-privacy-ai` — Settings, Privacy & AI

Sources: `stitch/settings-privacy-ai/` · Components: `PrivacyPane`, `Toggle`, `Table`, `Meter`, `ProgressBar`, `Dialog`, `Sheet` · Gate: P4 · IDs: PRE-05, DSN-17, RAG (index), AGT-08 (log link).

**Elements and states**

- [ ] AI-off build: the section reads `Privacy` and the AI groups are hidden.
- [ ] Usage telemetry: locked switch `Keep telemetry on this device` (on, lock glyph, reason `Required for app pre-fetch. Never leaves the device unless you opt in.`, focusable) · `Sync telemetry to server` off by default → on opens a consent sheet → pending → `Not enabled on the server` (EACCES, switch back off) → offline disabled `Connect to change sync`.
- [ ] Events table: Time, Event (`launch`/`focus`/`close`), App, Previous app, Time bucket — **app ids and times only** (I-C6); populated · empty `No telemetry recorded yet` · static skeleton · error banner `Telemetry is kept in memory only — storage is full`.
- [ ] Summary `1,284 events · 94 KB · oldest 3 Sep · predictor Markov-2`.
- [ ] `View all…` · `Export…` (`Exporting…`, toast `Saved ~/telemetry-20260924-1042.jsonl`, or `Exported 0 events`) · `Clear telemetry` (danger) → `alertdialog` `Clear 1,284 events? The predictor restarts from cold start.` (+ `Also delete the copy on the server` when sync is on), `Cancel` focused → empty state; failure `Telemetry was not cleared (storage error). Try again.`
- [ ] Semantic search: model `mdbr-leaf-ir (local, 23 MB)` + `On-device`; states `Model loading — showing keyword matches`, `Semantic search unavailable — showing keyword matches`, `Semantic search not installed` (safe mode/AI-off); index `412 chunks pending`, determinate bar `3,118 of 3,530 chunks indexed · ai.indexer pid 23, priority 32`; up to date `All 3,530 chunks indexed`; `Paused while you search`; `Indexer stopped — EIO` + `Show log`; `Rebuild index` → confirm popover `Re-embed 3,530 chunks in the background?` → `Rebuilding…` (icon does not spin).
- [ ] AI agent: provider `Claude via Plotinium gateway` + status (`Connected`, `Slow responses`, `Gateway unreachable — the agent is disabled`, `Sign in to use the agent`); budget meter `$3.20 of $50` + `Resets 1 Oct` (warning ≥ 85 %, danger at 100 % `Budget used — the agent is paused until 1 Oct`); `Require confirmation for all changes` (off states `Destructive changes still always ask`); `Open ai log…` + `Last action 10:40 · summarise os-report.md` (empty `No agent actions yet`).
- [ ] Footer `Plotinium 0.3.0 · build a1f93c2`.

**Animations**

- [ ] 1 Window open → RM: instant.
- [ ] 2 Pane swap → RM: instant.
- [ ] 3 Sidebar pill FLIP → RM: jumps.
- [ ] 4 Groups stagger 30 ms → RM: together.
- [ ] 5 Switch knob spring + squash → RM: knob jumps.
- [ ] 6 Locked switch wiggle once + tooltip → RM: tooltip only.
- [ ] 7 Consent sheet drop → RM: instant.
- [ ] 8 New telemetry row slide + FLIP → RM: inserted.
- [ ] 9 Clear: rows collapse stagger then empty state → RM: replaced.
- [ ] 10 Alertdialog in → RM: instant.
- [ ] 11 Index bar `scaleX` → RM: jumps.
- [ ] 12 Index complete: dot crossfade + check once → RM: swap.
- [ ] 13 Rebuild icon turns once → RM: none.
- [ ] 14 Budget `scaleX` on first show → RM: set.
- [ ] 15–16 Button press and hover → RM: tint.
- [ ] 17 Toasts → RM: instant.
- [ ] 18 Search filter FLIP → RM: instant.

**Accessibility**

- [ ] `main` with `h1` `Privacy & AI`; groups are `section`s with `h2`s.
- [ ] Switches `role=switch` with labels and descriptions; the locked one uses `aria-disabled` (not `disabled`).
- [ ] Table with caption `Recent telemetry events`, `th scope=col`, `<time datetime>`.
- [ ] Budget `role=meter` `aria-valuetext="3 dollars 20 of 50 dollars used this month"`; index `role=progressbar` with counts.
- [ ] Status changes (≤ 1 per 750 ms) via `role=status`; errors `role=alert`.

---

## 5. Overlays and system states

### 5.1 `search-palette` — Search

Sources: `stitch/search-palette/` · Components: `SearchPalette`, `Listbox`, `Meter`, `Kbd` (view of the `search` app, D-25) · Gate: P4 · IDs: RAG-06 (notices), RAG-05 (timing), SYS-01.

**Elements and states**

- [ ] Opens with `Ctrl+Space` (alternate `Alt+S`) or the menu-bar magnifier; a second press focuses the open palette.
- [ ] Scrim: pre-blurred desktop snapshot + dim (only its opacity animates); click closes and returns focus.
- [ ] Panel (material `sheet`, 720 px), moved to the top third on short viewports; forced colours: solid `Canvas`, 1 px border.
- [ ] Query field: placeholder `Search files, apps and commands`; AI mode (Tab): sparkle icon, placeholder `Ask the agent…`; caret in accent; always focused.
- [ ] `Semantic` pill: on · model loading (`Keyword` + notice `semantic model loading — showing keyword matches`) · unavailable (`Semantic search unavailable — showing keyword matches`) · hidden in the AI-off build.
- [ ] 2 px determinate progress hairline: keyword stage (½) then semantic (1), then fades (no looping sweep).
- [ ] Groups `TOP HIT`, `SEMANTIC MATCHES`, `APPS`, `COMMANDS`; empty groups hidden.
- [ ] Rows: default · hover (preview changes only on selection) · selected (solid accent pill, preview follows) · pressed · focus-visible · disabled (`No permission`).
- [ ] Semantic rows: citation `~/finance/budget-2026-w38.csv:14` (mono, link style), snippet with bold `<mark>` matches (≤ 2 lines), relevance bar + percentage text; results from another home keep their full path.
- [ ] App rows (Files, Editor) with a running dot; command rows (`ai "summarise budget report"` → Terminal where the plan is still validated and confirmed; `semsearch budget`); offline: `ai` row disabled `Needs the gateway — offline`.
- [ ] Preview: file header (`Markdown · 12 KB · owner student · modified 18 Sep 2026 16:20`), rendered preview with highlighted lines, chips `Open`, `Reveal in Files`, `Ask AI about this`; states static skeleton · too large `No preview — 48 MB binary` · `You do not have permission to read this file · EACCES`; app/command previews.
- [ ] Empty `No results for "xyz"` + `Ask the agent: ai "xyz"`; error banner `Search failed — EIO. Showing keyword matches.`; offline notice `1 shared result hidden while offline`.
- [ ] Footer: `Enter` open · `Ctrl+Enter` reveal in Files · `Tab` AI mode (no `⌘`); timing `8 results · 38 ms · local index`, warning colour above 500 ms.

**Animations** (all ≤ 200 ms; input never blocked)

- [ ] 1 Scrim fade 160 / 120 ms → RM: instant.
- [ ] 2 Panel `.pl-anim-search-in` (`scale(.98) translateY(-8px)` → none) → RM: instant.
- [ ] 3 Close `.pl-anim-search-out` → RM: instant.
- [ ] 4 Launch-out `scale(1.02)` + fade while the target window opens → RM: instant.
- [ ] 5 Groups stagger 24 ms (max 4) → RM: together.
- [ ] 6 Row FLIP 120 ms while typing (no height animation) → RM: replace.
- [ ] 7 Selection pill 180 ms spring → RM: jumps.
- [ ] 8 Preview crossfade `translateX(8px)` → RM: swap.
- [ ] 9 Relevance bars `scaleX`, 20 ms stagger → RM: set.
- [ ] 10 Progress hairline steps → RM: opacity only.
- [ ] 11 AI mode icon swap (`rotate(-30deg)`, scale) + glow once → RM: icon swap.
- [ ] 12 Pill label crossfade → RM: instant.
- [ ] 13 Footer keycap press → RM: none.
- [ ] 14 Chip hover/press → RM: opacity only.
- [ ] 15 Empty-state outlined atom `scale(.9)` → 1 once → RM: fade 0 ms.

**Accessibility**

- [ ] `role=dialog aria-modal=true aria-label=Search`; background `inert`; focus trapped; Esc closes and restores focus to the opener.
- [ ] Input `role=combobox aria-expanded aria-controls aria-activedescendant aria-autocomplete=list`.
- [ ] One `listbox` with `group`s labelled by headers; option names with path and relevance ("budget-2026-w38.csv, line 14, relevance 92 percent").
- [ ] Preview `region aria-label="Preview of os-report.md"`, after the listbox in DOM order, reachable by Tab.
- [ ] `8 results` announced 400 ms after typing stops; notices polite; errors `role=alert`.
- [ ] ↑/↓, Home/End, Enter, Ctrl+Enter, Tab, Esc.

### 5.2 `control-centre-notifications` — Control Centre and Notifications

Sources: `stitch/control-centre-notifications/` · Components: `ControlCentre`, `NotificationCentre`, `ToastStack`, `FrameMeterHud` · Gate: P3 · IDs: OFF-04, MEM-01 (quick setting), WMD-18, WMD-19, DSN-04, DSN-05.

**Elements and states**

- [ ] Trigger (two-switch glyph) in the status group: default · hover · focus · open; `Alt+C`; unread count badge on the clock/bell (hidden at 0, `9+`), named "Notifications, 3 unread".
- [ ] Panel 360 px glass (backdrop allowed), opening/open/closing; Esc, outside click or the trigger close it and return focus.
- [ ] Connectivity tile titles exact (spec strings; the reference's `Online · synced` becomes title `Online` + subtitle `All changes synced · last sync 10:41`): `Online` · `Syncing 3 ops` · `Reconnecting in 4 s` (≤ 1 Hz redraw) · `Offline · 2 queued` (warning) · `Sign in to sync` (warning + Sign in button).
- [ ] Sync queue tile: `0 pending` · `n pending` (accent number) · `2 failed · Retry` · first-mount skeleton digit (never a spinner).
- [ ] Degraded services tile: `Degraded services: none` / `All 9 services healthy` · `2 degraded` with rows `sync — degraded · backend unreachable · retry in 4 s (attempt 3)` and `Retry now` (default, pressed, `Retrying…`, failed) · `starting (3)` · expanded/collapsed.
- [ ] Appearance: `Light` / `Dark` / `Follow system` (radiogroup).
- [ ] Reduced motion switch: off = Follow system; on = Always; off with subtitle `System setting is on` when the OS asks for it.
- [ ] Memory budget slider 128 MB – 1 GB, step 64 MB, `Using 142 MB`: idle · hover · dragging · keyboard stepping · committing on release (`Applying…`) · refused (springs back, `Budget can't be below current use (198 MB)`, `role=alert`) · guest `Managed by the administrator`.
- [ ] Focus mode: off `Notifications allowed` · on `Banners silenced · errors still shown`.
- [ ] Frame meter switch: off · on with live subtitle `p95 16.7 ms · 60 Hz`; the HUD shows top-right under the menu bar, shifted left of the open panel (D-22): `p95 16.7 ms · 60 Hz · dropped 0.4% · LoAF>50 ours 0 / other 1`.
- [ ] Footer: `Plotinium 0.3.0 · build a1f93c2` (click copies, `Copied` status), `Control Centre Settings…`.
- [ ] Notifications column: header `Notifications`, `Clear all` (disabled when empty), `Show less` / `Show more`; cards with app icon, title, body, time, level glyph, unread dot; hover reveals a 24 × 24 close button; grouped stack `+2 from Files`; empty `No notifications` / `You're all caught up.`; a card whose action cannot render shows text only.
- [ ] Example cards exact: `Lock granted — report.md`; `Restart to update` / `Plotinium 0.3.1 is ready. Your windows will be restored.` [Restart] (busy `Restarting…`) [Later]; `Semantic index up to date`; `Conflict saved as copy` with the conflict-copy name and [Show in Files].
- [ ] Column scrolls within the work area and never slides under the dock.

**Animations**

- [ ] 1 Trigger pill `scale(.85)` → 1 → RM: shown.
- [ ] 2 Panel `.pl-anim-cc-in` from top-right → RM: instant.
- [ ] 3 Tiles `.pl-anim-cc-tile` stagger 18–20 ms → RM: with the panel.
- [ ] 4 Close `.pl-anim-popover-out` → RM: instant.
- [ ] 5 Tile press `scale(.97)` → RM: tint.
- [ ] 6–7 Switch knob + squash → RM: jumps.
- [ ] 8 Appearance thumb slide → RM: jumps.
- [ ] 9 Theme change snapshot crossfade (colours never tween) → RM: instant.
- [ ] 10 Slider follows the pointer 1:1 (fill `scaleX`) → RM: same (direct manipulation).
- [ ] 11–12 Thumb grab scale; keyboard step → RM: jumps, focus ring shows the thumb.
- [ ] 13 Refused budget springs back, error rises → RM: jump + error.
- [ ] 14 Connectivity glyph crossfade + one ring pulse (≤ 1 per 2 s) → RM: glyph + announcement.
- [ ] 15 Queue digit roll → RM: swap.
- [ ] 16 Degraded rows expand stagger + chevron → RM: instant.
- [ ] 17 Focus-mode moon swap → RM: swap.
- [ ] 18 Frame meter HUD in/out → RM: instant.
- [ ] 19 Notification column in (60 ms after the panel), cards stagger 40 ms → RM: instant.
- [ ] 20 Collapsed stack static offsets (`.pl-notification-stack`) → RM: same static layout.
- [ ] 21 Stack expand/collapse FLIP → RM: jumps.
- [ ] 22 New card while open: slides in, others FLIP → RM: appears.
- [ ] 23–25 Toast enter / auto-dismiss / files into the centre → RM: instant.
- [ ] 26 Card hover lift + close button → RM: close button only.
- [ ] 27 Dismiss `scale(.96)` + fade, others FLIP → RM: removed.
- [ ] 28 Swipe follows the pointer, flings past 40 % → RM: no swipe (close button, Delete).
- [ ] 29 Clear all stagger 30 ms, empty state in → RM: instant.
- [ ] 30 Unread dot pop in/out → RM: instant.
- [ ] 31 Restart press + label swap → RM: swap.
- [ ] 32 Restart hand-off: desktop fades + `scale(.985)`, shutdown view takes over → RM: cut.

**Accessibility**

- [ ] Trigger `aria-haspopup=dialog aria-expanded aria-controls`; panel `role=dialog aria-modal=false aria-label="Control Centre"`; keyboard open moves focus to the first tile; Tab continues into the column.
- [ ] Tiles named with their state; switches `role=switch`; appearance `radiogroup`; memory `role=slider` with `aria-valuetext="256 megabytes"`.
- [ ] Column `role=region aria-label=Notifications`, `list` of `article`s (labelled by title, described by body and relative time); `Delete` dismisses; swipe alternatives exist (WCAG 2.5.7).
- [ ] Toasts: info/success/warning `role=status`, error `role=alert`; never take focus; timers pause on hover/focus; never cover the focused element.
- [ ] Focus mode never silences errors.

### 5.3 `overview-switcher` — Overview and the window switcher

Sources: `stitch/overview-switcher/` · Components: `OverviewLayer`, `AppSwitcherHud` (compositor moves the windows) · Gate: P4 (Overview), P2 (switcher) · IDs: WM-07, WM-02, WM-03.

**Elements and states**

- [ ] Overview opens with `Alt+O` (and a menu entry); no hot corner.
- [ ] Backdrop: pre-blurred layer + ~45 % dim (only opacity animates); click on empty backdrop exits and restores the previous focus.
- [ ] Menu bar slides up and dock slides down while Overview is open.
- [ ] Desktops strip hidden (feature flag, D-16).
- [ ] Window grid: the real windows scaled into slots (no screenshots); captions (app icon + title, ellipsis at 220 px) below each; states default · hover (lift, outline, 24 × 24 close at top-left) · keyboard highlight (3 px accent outline with 2 px inner gap, `scale(1.03)`) · pressed · dragging (small scale) · closing (close guard still applies) · minimised (`minimised` caption, 70 %) · suspended (frozen frame, `suspended`) · restoring (`Restoring…`).
- [ ] Empty state `No open windows` + `Open Terminal` (`Alt+T`) and `Open Files`.
- [ ] A window whose process dies while in Overview fades out and the grid re-flows.
- [ ] Switcher HUD (`Alt+`` ` / `Alt+Shift+`` `, alternates `Alt+J` / `Alt+K`): appears only after a 120 ms hold (a quick tap switches without flashing); items are **windows** in stacking order incl. minimised, drawn as 72 px icons with minimised/suspended badges and a count caption for several windows of one app; highlighted item on a plate with `scale(1.08)`; title line `Terminal — ~ · 2 of 5`; hints `Alt+`` ` next · `Alt+Shift+`` ` previous · `Esc` cancel (never `Alt+Tab`).
- [ ] Releasing `Alt` focuses (and restores) the chosen window; `Esc` cancels with focus unchanged.

**Animations**

- [ ] 1 Backdrop fade 280 ms → RM: shown.
- [ ] 2 Windows FLIP into slots together (compositor, 420 ms spring) → RM: grid at once.
- [ ] 3 Menu bar/dock out (240 ms `--pl-ease-in`) → RM: hidden.
- [ ] 4 Captions after 160 ms → RM: with the grid.
- [ ] 6 Thumbnail hover (scale 1.03, outline, close button) → RM: outline and button only.
- [ ] 7 Keyboard highlight FLIP 220 ms → RM: jumps.
- [ ] 8 Pick: chosen window FLIPs home and raises; others return; backdrop out → RM: removed, window focused.
- [ ] 9 Cancel: all return → RM: at once.
- [ ] 10 Close from Overview: thumbnail shrinks + fades, grid re-flows → RM: removed.
- [ ] 11 Drag thumbnail follows the pointer; springs back → RM: moves at once.
- [ ] 16 HUD open `scale(.94)` → 1, icons stagger 15 ms → RM: appears.
- [ ] 17 Plate `translateX` + icon scale → RM: jumps.
- [ ] 18 Wrap-around fades instead of sliding across → RM: jumps.
- [ ] 19 Title swap → RM: text swap.
- [ ] 20 Commit: HUD out, focus-change animation → RM: removed.
- [ ] 21 Cancel: HUD fades → RM: removed.
- [ ] Overview with 10 windows holds p95 ≤ 16.7 ms; `will-change` only during the transition.

**Accessibility**

- [ ] Overview `role=dialog aria-modal=true aria-label=Overview`; focus moves to the highlighted option, trapped, restored on exit.
- [ ] Grid `role=listbox`; options named "Terminal — ~, Terminal, running"; 2-D arrows, Home/End, Enter, `Delete`/`Alt+Q`, Esc.
- [ ] Switcher `role=listbox aria-label="Switch window"`, announced on open "Switch window: Terminal — alice@plotinium:~, 2 of 5"; pointer can pick an icon.
- [ ] Captions ≥ 12 px on ≥ 55 % glass; outline ≥ 3:1 against both thumbnail and backdrop.

### 5.4 `offline-lock-states` — offline and lock contention

Sources: `stitch/offline-lock-states/` · Components: `ConnectivityItem`, `ConnectivityPopover`, `EditorBanner`, `LockChip`, `EditorStatusBar`, `FrameMeterHud`, `ToastStack` · Gate: P3 · IDs: OFF-01, OFF-04, VFS-09, WMD-19.

**Elements and states**

- [ ] Connectivity chip pressed: `Offline · 3 queued` (warning fill, dark text, cloud-off) with the popover open; other states `Online` (plain glass), `Reconnecting in 42 s` (after repeated failures), `Syncing · 3 ops` → spec form `Syncing 3 ops`, `Sign in to sync` (AUTH_REQUIRED).
- [ ] Toast on going offline: `Connection lost · Working offline` (announced once).
- [ ] Popover (352 px, arrow at the chip): header `You're offline` / `Changes are saved on this device and queued.`; queued ops (`write ~/notes.md`, `mkdir ~/drafts`, `mv ~/a.txt → ~/archive/a.txt`) with verb badges, mono paths, queued times; empty `Nothing queued · all changes are on the server`; replay: each row's clock becomes a determinate mini-bar, row leaves on `op.result`; rejected op keeps a `rejected · EACCES` tag and `restored` / `kept as …` text.
- [ ] Exactly-once line `Will replay automatically · exactly once`; during replay `Replaying 1 of 3 · exactly once`.
- [ ] Degraded list: `sync — offline`, `lockd — local advisory locks only` with since-times, dot + word; empty `No degraded services`; failed service `failed · <reason>`.
- [ ] `Retry now`: default · `Checking…` with a 3 s determinate bar tied to the real probe (no spinner) · `Still offline · next check in 60 s`; `next check in 42 s` (`tabular-nums`, from the event's timestamp); `Task Manager ↗` opens Services.
- [ ] Editor read-only (focused): title `report.md — /home/shared` + `Read-only` status chip; banner (open question: DSN wording `Locked by bob — read-only. The lock expires in 12 s if bob's session stops.` [Try again] plus `Notify me`); lease countdown bar (`progressbar`, `11 seconds left`) with `last seen 14:31:02` while offline; `Notify me` → `Notifying you` (`aria-pressed`); released → success tint `report.md is available — open for writing` + `Open for writing`; expiry race `Your lock expired while this tab was in the background`.
- [ ] Sidebar presence list (bob `editing`, student `viewing`) with text status; `lab3 · not offline` dimmed (EAGAIN offline); `queued` pills (removed on ack, `rejected` in red).
- [ ] Code view read-only: text at reduced contrast but ≥ 4.5:1; typing announces `Read-only — bob holds the lock` (≤ 1 per 5 s); bob's remote caret flag.
- [ ] Status bar: `Markdown · UTF-8`, `Ln 14, Col 3`, lock state, `offline · 1 queued`, `Saving…`, `Not saved`.
- [ ] Frame meter HUD top-right (D-22), not bottom-right: `p95 14.2 ms · 60 Hz`, OK dot + text, 24 bars with the dashed 16.7 ms line, `over budget` as text when above.
- [ ] Back online: chip → `Syncing 3 ops`, rows leave, then `Online` with a check; one announcement `Back online · 3 changes synced`.

**Animations**

- [ ] 1 Offline toast in/out → RM: instant (still announced).
- [ ] 2 Chip label vertical crossfade; fill layer fade → RM: switch.
- [ ] 3 Chip glow pulse once on the first switch to offline → RM: none.
- [ ] 4 Queued count digit roll → RM: swap.
- [ ] 5 Popover in from the chip (320 ms spring) → RM: instant.
- [ ] 6 Rows stagger 40 ms (< 300 ms) → RM: at once.
- [ ] 7 Popover out → RM: instant.
- [ ] 8 Replayed row exits + FLIP → RM: removed.
- [ ] 9 Retry icon turns once; 3 s bar → RM: bar steps once per second.
- [ ] 10 Degraded row recovers: dot crossfade then exit → RM: instant.
- [ ] 11 Read-only banner in, content FLIP → RM: present.
- [ ] 12 Lease bar `scaleX` per second tick (linear) and refill on renewal (spring) → RM: steps, text always shown.
- [ ] 13 Lock badge on the avatar pop → RM: instant.
- [ ] 14 Notify me press + label swap → RM: swap.
- [ ] 15 Released: tint crossfade, lock glyph opens, button pops → RM: switch.
- [ ] 16 Read-only chip swap → RM: instant.
- [ ] 17 Remote caret `translate` (≤ 4 Hz) → RM: jumps.
- [ ] 18 Banner nudge on typing into the read-only buffer → RM: live message only.
- [ ] 19 HUD in → RM: instant.
- [ ] 20 HUD bars grow and shift once per second → RM: redraw.
- [ ] 21 Over-budget bar amber layer → RM: instant.
- [ ] 22–24 Dock magnification, focus change, back-online sequence → RM: per §1.

**Accessibility**

- [ ] Chip `<button>` named exactly by its label, `aria-haspopup=dialog aria-expanded`; tray live region ≤ 1 announcement per 2 s (5 s where the notes say so for the HUD).
- [ ] Popover `role=dialog` (non-modal) `aria-label="Connectivity and degraded services"`; focus to `Retry now`; Esc returns to the chip; lists are labelled `ul`s; each row one sentence.
- [ ] Banner `role=status` announced once; countdown not re-announced each tick; `aria-valuetext="11 seconds left"`.
- [ ] Frame meter `role=status` label updated at most every 5 s; bars `aria-hidden`.
- [ ] Warning text on the dark banner and on the amber chip ≥ 4.5:1.

### 5.5 `update-restart` — Restart to update

Sources: `stitch/update-restart/` · Components: `UpdateChip`, `UpdateDialog`, `ToastStack`; `ShutdownView` (framework-free) for the hand-off · Gate: P4 (P3 for the chip) · IDs: OFF-05, BOOT-12.

**Elements and states**

- [ ] Chip `Restart to update` (accent) when a new Service Worker is waiting (`update.available`); absent otherwise; hidden during shutdown; while downloading Settings shows `Downloading 0.3.1 · 42 %` (determinate) and no chip; install failure in Settings `Couldn't install 0.3.1 · will retry at next boot`.
- [ ] Toast `Plotinium 0.3.1 is ready — Restart to update` when the user is idle.
- [ ] Dialog (`alertdialog`, 452 px, light glass over a dimmed desktop): 68 px atom app icon; title `Plotinium 0.3.1 is ready` (skew variant `Restart to update required to sync`); version line `0.3.0 · a1f93c2 → 0.3.1 · c47e0b9 · 18.4 MB · downloaded` (mono hashes); What's new (4 items, from `CHANGELOG.md`; none → `Maintenance release`; offline → `Release notes are available when online`) + `Full release notes` (opens read-only in Editor); body `The update installs in the background and activates on your next restart. Your windows and unsaved work will be restored.`; checkbox `Install updates automatically` (disabled for guests); keyboard hint `Esc Later · Ctrl+Enter Restart`; buttons `Later` (initial focus) and `Restart Now` (primary; `Restarting…` for up to 200 ms; `A restart is already in progress` on EBUSY).
- [ ] Scrim click nudges the dialog (the dialog must be answered).
- [ ] Hand-off view (framework-free `ShutdownView`): determinate ring around the atom driven by stopped-service weights, `Restarting Plotinium…`, `62% · stopping services · 11 of 18`, the **current phase only** in production, ordered steps (checkpointed windows, flushed dirty pages, saved session, stopping services in reverse order, activate 0.3.1 and reload) with done / in progress / waiting in text, service segments; warnings `sync · force-stopped after 4 s`, `Session saved locally only`; footer `Session saved for student (uid 1001) · 4 windows`.
- [ ] No spinner anywhere (the reference's `vfs — flushing…` spinner is removed).

**Animations**

- [ ] 1 Chip `scale(.6)` → 1; tray FLIP → RM: appears.
- [ ] 2 Chip glow pulse once → RM: none.
- [ ] 3 Toast in/out → RM: instant.
- [ ] 4 Scrim fade → RM: instant.
- [ ] 5 Dialog `scale(.94) translateY(8px)` → none → RM: instant.
- [ ] 6 App icon `scale(.7)` → 1 + orbit `rotate(-20deg)` → 0 once → RM: static.
- [ ] 7 What's new rows stagger 30 ms → RM: together.
- [ ] 8 Focus ring pulse on `Later` once → RM: static ring.
- [ ] 9 Button hover/press → RM: tint.
- [ ] 10 Checkbox check pop → RM: instant.
- [ ] 11 Scrim-click nudge → RM: message `Choose Later or Restart Now`.
- [ ] 12 Later/Esc: dialog shrinks toward the chip → RM: removed.
- [ ] 13 Restart Now: icon FLIPs into the ring, windows and dock fade → RM: cut.
- [ ] 14 Ring advances only on real completions (half-disc `rotate`, not `stroke-dashoffset`) → RM: jumps.
- [ ] 15 Step row check pop → RM: instant.
- [ ] 16 Service segment fill (`scaleX`) → RM: instant.
- [ ] 17 Percent and `n of 18` change without tween; announced ≤ 1 per 5 s.
- [ ] 18 Final fade before reload → RM: instant.
- [ ] 19 After reboot the splash may show `Updated to 0.3.1` (event-driven, no keyframes).

**Accessibility**

- [ ] `role=alertdialog aria-modal=true`, labelled by the title, described by the body; focus trapped; initial focus `Later` (safe action); Esc = Later; Ctrl+Enter = Restart Now; focus returns to the chip.
- [ ] Chip named `Restart to update to Plotinium 0.3.1`.
- [ ] Shutdown view `role=status aria-live=polite`; ring `role=progressbar` `aria-valuetext="62 percent, stopping services, 11 of 18"`; steps an `ol` with text states; everything else `inert`.

---

## 6. Gate roll-up

| Gate           | Slugs whose sections must be fully ticked                                                                                                                                                                                                                                                                                         |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P2 (W7)        | §0, §1.2, §1.3, `boot-splash`, `unsupported-browser`, `login-dark`, `login-light` (online states), `desktop-dark`, `desktop-light`, `files-light`, `settings-about`, the Terminal lines of `terminal-ai`                                                                                                                          |
| P3 (W11)       | §1.1, §1.4, `boot-menu`, `boot-verbose-log`, `kernel-panic`, `recovery-console`, login offline and lock states, `editor-conflict`, `task-manager-processes`, `task-manager-memory` (Memory), `control-centre-notifications`, `offline-lock-states`, the switcher lines of `overview-switcher`, the chip lines of `update-restart` |
| P4 (W14)       | `files-semantic-search`, `search-palette`, `terminal-ai` (AI plan, strip, indicator), `settings-privacy-ai`, `task-manager-memory` (Predictions), `overview-switcher` (Overview), `update-restart`, and `agent-confirm-sheet` only if its ADR was approved                                                                        |
| Final (W17–18) | every line re-ticked on the examiner's machine; visual, axe, reduced-motion and trace evidence attached                                                                                                                                                                                                                           |
