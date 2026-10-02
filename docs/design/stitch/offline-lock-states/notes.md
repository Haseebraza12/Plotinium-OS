# Offline and lock-contention state (`offline-lock-states`)

| Field | Value |
|---|---|
| Stitch project | `12849137298552292712` (Plotinium OS) |
| Stitch screen id | none. Generation timed out, and no screen appeared in `list_screens` after 14 polls over about 11 minutes. It was not retried, per the run's instructions. See `screen.json`. |
| Design system | DARK · `assets/10121591451242352758` (Plotinium Glass, Dark) |
| Model | GEMINI_3_8_FLASH · DESKTOP 1440×900 |
| Files | `screen.json` (Stitch timeout record), `reference.html` and `reference.png` (a hand-built render of the same prompt; **not** a Stitch export). `screen.html` and `screenshot.png` are missing because Stitch returned no screen. |
| Spec anchors | `specs/06-sync/offline-and-sync.md` §3.14.7 (read-only mode, degraded `lockd`), §3.15.2 (connectivity indicator, degraded list, `aria-live`), §3.4 and §3.11 (outbox, exactly-once) · `specs/05-wm/ui-design-system.md` §3.7 (Banner, Popover), §3.8.7 (tray chip), §3.8.12 (Editor banners, save state) · `specs/05-wm/window-manager.md` §3.18 (frame meter, WMD-19) |
| Requirement IDs | OFF-01, OFF-02, OFF-04, VFS-09, WM-03, PROC-05, WMD-19, SYN-09, DSN-05 |

## What the screen shows

The device lost its network at 14:28:51. `syncd` is in the OFFLINE state, and the tray chip in the menu bar reads **Offline · 3 queued** in warning amber with a cloud-off icon. The student clicked the chip, so the chip is pressed and a glass popover hangs from it. The popover lists the three durable outbox operations (`write ~/notes.md`, `mkdir ~/drafts`, `mv ~/a.txt → ~/archive/a.txt`) and the promise **Will replay automatically · exactly once**. It also lists the two degraded services from `svcmgr` (`sync — offline`, `lockd — local advisory locks only`), each with a since-time.

The focused Editor has `/home/shared/report.md` open read-only. Before the connection dropped, bob held the X lease, so the amber banner reads **bob is editing report.md — you have read-only access. Lease expires in 11 s**, with a lease countdown bar and a **Notify me** button. An unfocused Terminal behind it shows the same fact from the shell (`lsof`), the offline `ai` refusal and a queued write. The frame meter HUD sits in the bottom-right corner (`p95 14.2 ms · 60 fps`, a 24-bar graph with one amber spike above the 16.7 ms budget line). The floating dock shows Files, Terminal, Editor (running dots), Task Manager, Search, Settings and Trash.

## Final prompt

Sent verbatim to `generate_screen_from_text` (DESKTOP, DARK design system, GEMINI_3_8_FLASH):

> Plotinium OS — Offline and lock-contention state (DARK, Liquid Glass desktop, 1440x900). Plotinium is a web-based operating system inspired by the latest macOS Liquid Glass look but with its own identity. Never use the Apple logo, SF Symbols or Apple app names. Use lucide-style thin line icons. Accent violet #5E5CE6. Warning amber #FFB340.
>
> BACKGROUND: dark deep-violet/indigo abstract wallpaper with soft blurred light blooms.
>
> MENU BAR (top, 28px, translucent dark glass with backdrop blur, hairline bottom border): at far left the Plotinium logo — an abstract luminous atom: a bright white-violet nucleus with 2–3 thin elliptical orbits in violet #5E5CE6 (no radiation or hazard symbol). Then bold app name 'Editor' and menus 'File  Edit  View  Window  Help'. At the right: an AMBER status pill with a cloud-off icon reading 'Offline · 3 queued' (highlighted/pressed because its popover is open), then wifi-off icon, battery 82%, Control Centre toggle icon, search icon, and clock 'Thu 24 Sep  14:32'.
>
> GLASS POPOVER (anchored directly under the 'Offline · 3 queued' pill with a small arrow notch, 340px wide, frosted dark glass, 14px radius, large soft shadow):
> - Header row: amber cloud-off icon, title 'You're offline', subtitle 'Changes are saved locally and queued.'
> - Section label 'QUEUED OPERATIONS (3)' then three rows each with an icon, monospace path and time: 'write  /home/student/notes/os-report.md  · 14:29', 'mkdir  /home/student/drafts  · 14:30', 'mv  /home/student/a.txt → /home/student/archive/a.txt  · 14:31'. Each row has a small grey 'pending' clock badge.
> - A reassurance line with a check-shield icon: 'Will replay automatically · exactly once'.
> - Divider, section label 'DEGRADED SERVICES' with two rows with amber dots: 'sync — offline' and 'lockd — local advisory locks only'.
> - Footer: secondary button 'Retry now' and a text link 'Open Task Manager'.
>
> EDITOR WINDOW (centre-left, large, glass titlebar with red/yellow/green traffic-light controls at the top left, title 'report.md — /home/student/shared/report.md', a 'Read-only' lock chip in the titlebar): a translucent vibrancy sidebar on the left listing files (os-report.md, report.md selected, scheduler-notes.md, drafts/). At the top of the editor content a full-width AMBER-tinted glass banner with a lock icon and small avatar 'B': 'bob is editing report.md — you have read-only access. Lease expires in 11 s' with a thin countdown progress bar under it and a violet button 'Notify me' on the right. Below, markdown text in a monospace-friendly font with line numbers, greyed slightly to show read-only: '# Operating Systems Report', '## 3. Scheduler', 'Plotinium uses a multilevel feedback queue with 64 priority levels…', 'ai.indexer (pid 23) runs at priority 32 so it never starves the UI…'. A status bar at the bottom: 'Markdown · UTF-8 · Ln 14, Col 3 · Read-only · lock held by bob (uid 1002)'.
>
> FRAME-METER HUD (small glass capsule in the bottom-right corner above the dock, monospace): 'p95 14.2 ms · 60 fps' with a tiny 24-bar sparkline bar graph in green with one amber spike, and a small label 'frame budget 16.7 ms'.
>
> FLOATING DOCK (bottom centre, frosted glass, rounded 22px, soft shadow) with our own rounded-square app icons: Files, Terminal, Editor (active dot underneath), Task Manager, Search, Settings, and a separator then Trash. Small labels are not needed.
>
> Also a small toast notification at the top right under the menu bar: 'Connection lost · Working offline' with amber icon, fading.
>
> Overall: macOS-grade polish, layered translucent glass, soft large shadows, crisp 1px inner highlights, readable contrast, Inter font.

**Differences in `reference.html`, all deliberate:**
- Warning amber is the design-system token `#FF9F0A`, not `#FFB340`.
- Queued paths are shortened to `~/notes.md`, `~/drafts` and `~/a.txt → ~/archive/a.txt`, matching the task's `write notes.md, mkdir drafts, mv a.txt`.
- The file is in `/home/shared`, because a file bob can lock must be shared.
- The "Connection lost" toast is left out. It would sit under the open popover, and in the real sequence it appears first and is dismissed when the popover opens (row 1 of the animation table).
- The banner adds a second line, `X lease · fence 41 · last seen 14:31:02`. See Issues.

## UI elements and their states

| Element | Default (as rendered) | Hover | Focus | Active / pressed | Disabled | Empty | Loading | Error |
|---|---|---|---|---|---|---|---|---|
| Menu bar (28 px dark glass, atom mark, `Editor`, File to Help) | glass `rgba(30,30,36,.55)` with blur 30 px | menu title gets a 6 px-radius tint at 10 % white | 3 px accent ring at 55 % on the menu title; arrow keys move between menus | menu open: tint stays and the dropdown hangs below | greyed menu items at 38 % | n/a | n/a | n/a |
| Connectivity chip (`button`, name = label) | **pressed**: solid amber, dark text, cloud-off icon, soft amber glow, `aria-expanded="true"` | brightens 6 % | ring | pressed = popover open | never disabled | online: `Online` with a check icon on plain glass (no fill) | `Reconnecting…` with a clock icon; `Syncing · 3 ops` with an arrows icon | `Offline · 3 queued (retry in 42 s)` after 3 or more failures; `Sign in to sync · 3 queued` when AUTH_REQUIRED |
| Tray icons (Wi-Fi off, battery 82 %, Control Centre, Search, Notifications, clock) | 16 px lucide at 92 % | tint | ring | opens that icon's panel | n/a | n/a | n/a | n/a |
| Popover container (`role="dialog"`, 352 px, 14 px radius, arrow notch at the chip's centre) | frosted `rgba(38,38,46,.72)`, hairline, dialog shadow | n/a | focus moves to the first focusable item (`Retry now`); Esc closes it and returns focus to the chip | n/a | n/a | n/a | n/a | n/a |
| Header (amber cloud-off badge, `You're offline`, `Changes are saved on this device and queued.`) | static | n/a | n/a | n/a | n/a | n/a | n/a | n/a |
| Queued operations list (`write`, `mkdir`, `mv` badges, mono path, queued time) | 34 px rows on a darker inset; verb badge on accent at 22 % | row tint 6 % and the full path in a tooltip when truncated | row focusable (listbox), ring on the row | Enter opens the file in Files | n/a | `Nothing queued · all changes are on the server` with a check icon | replaying: each row's clock icon becomes a determinate mini-bar and the row leaves when `op.result` arrives | a rejected op stays with a red `rejected · EACCES` tag and `restored` or `kept as …` text (spec §3.12) |
| Exactly-once assurance line | success-green text with a check-shield icon | n/a | n/a | n/a | n/a | hidden when the queue is empty | during replay: `Replaying 1 of 3 · exactly once` | n/a |
| Degraded services list (`sync — offline`, `lockd — local advisory locks only`, since-times) | amber dot plus text (colour is never the only signal) | row tint | row focusable; Enter opens Task Manager › Services filtered to that service | n/a | n/a | `No degraded services` | n/a | a failed service shows a red dot and `failed · <reason>` |
| **Retry now** (glass button) | glass with a hairline | tint rises | ring | pressed `scale(.97)` | disabled for 3 s after a click, showing `Checking…` | n/a | label `Checking…` with a determinate 3 s bar under the button (no spinner, DSN-07) | `Still offline · next check in 60 s` |
| `next check in 42 s` | tertiary text, `tabular-nums`, updates once a second | n/a | n/a | n/a | n/a | n/a | n/a | n/a |
| **Task Manager ↗** link | accent-tinted text | underline | ring | opens Task Manager › Services | n/a | n/a | n/a | n/a |
| Editor window (focused, 12 px radius, traffic lights, title `report.md — /home/shared`, **Read-only** chip) | focus shadow `0 22px 70px`; coloured traffic lights | traffic-light glyphs (×, −, +) appear on group hover | ring on each control; the window takes focus on click | n/a | the Read-only chip is a status, not a button | n/a | n/a | n/a |
| Sidebar (Shared, student, On this file) | vibrancy at 4 % white; selected row accent at 85 % with a lock glyph | row tint | ring | opens the file | `lab3 · not offline` is dimmed (EAGAIN `offline`) | n/a | n/a | n/a |
| `queued` pills on `notes.md` and `drafts` | warning-subtle pill with text | n/a | n/a | n/a | n/a | removed when the op is acknowledged | n/a | red `rejected` pill |
| Presence list (bob `editing`, student `viewing`) | gradient avatars with an initial and text status | tooltip `bob (uid 1002) · X lease · fence 41` | ring | n/a | n/a | only `student (you)` is listed | n/a | n/a |
| **Read-only lease banner** (`role="status"`) | amber-subtle glass with a 4 px amber left rule, avatar B with a lock badge, the text, a countdown bar and **Notify me** | n/a | n/a | n/a | n/a | n/a | n/a | lease lost to an expiry race: `Your lock expired while this tab was in the background` (spec §3.14.7) |
| Lease countdown bar (`progressbar`, 0 to 15 s demo TTL) | `scaleX(11/15)`; the text updates once a second | n/a | n/a | n/a | n/a | n/a | n/a | n/a |
| **Notify me** (primary) | accent fill with glow | `#7472FF` | ring | pressed `scale(.97)`; then it becomes `Notifying you` with a check, and `aria-pressed="true"` | n/a | n/a | n/a | n/a |
| Banner, **released** state | n/a | n/a | n/a | n/a | n/a | n/a | n/a | turns success-subtle: `report.md is available — open for writing` with **Open for writing** (primary) |
| Tabs (`report.md`, `notes.md ●`) | the active tab is lighter; the dot marks unsaved changes | tint | APG tabs pattern | selects | n/a | n/a | n/a | n/a |
| Code view (CodeMirror, `readonly`) | line numbers at 26 %; text at 72 % so read-only is visible; active line tinted | n/a | caret visible (you can select and copy) | n/a | typing does nothing, and one polite live message says `Read-only — bob holds the lock` (throttled to once per 5 s) | n/a | n/a | n/a |
| bob's remote caret (amber bar plus `bob` flag) | shown at bob's last known position | n/a | n/a | n/a | n/a | hidden when bob has no position | n/a | n/a |
| Status bar (`Markdown · UTF-8`, `Ln 14, Col 3`, lock state, `offline · 1 queued`) | 28 px, secondary text; warnings in amber with icons | n/a | n/a | n/a | n/a | n/a | `Saving…` | `Not saved` in danger |
| Terminal (unfocused) | dimmer glass, grey traffic lights, smaller shadow | n/a | clicking focuses and raises it | n/a | n/a | n/a | n/a | n/a |
| Frame meter HUD (`role="status"`, `--pl-z-meter`) | `p95 14.2 ms · 60 fps`, a green `OK` dot, 24 bars with a dashed 16.7 ms budget line, `dropped 0.4% · LoAF 0` | shows the full WMD-19 line `LoAF>50 ours 0 / other 1` | focusable when opened from Settings › Developer | click toggles compact and expanded | hidden when off (`framemeter off`) | `collecting…` for the first second | n/a | p95 above 16.7 ms: the dot turns amber and the label changes to `over budget` in text |
| Dock (Files, Terminal, Editor, Task Manager, Search, Settings, Trash) | glass capsule; running dots under Files, Terminal and Editor | icon magnifies (see animations) and a label appears | roving tabindex, ring on the icon | icon press dims it to 85 % | n/a | n/a | an app that is starting bounces once | n/a |

## Intended animations

Rules: only `transform` and `opacity` animate. Nothing loops (the HUD graph redraws once a second on data, which is not decoration). Every duration is a motion token, and all tokens become 0 ms under `prefers-reduced-motion: reduce` or `:root[data-motion="reduce"]` (DSN-05).

Easing tokens (the same as in `terminal-ai/notes.md` and `agent-confirm-sheet/notes.md`):
- `--pl-spring`: `linear(0, 0.048 3%, 0.163 6%, 0.360 10%, 0.557 14%, 0.725 18%, 0.878 23%, 0.973 28%, 1.026 34%, 1.038 42%, 1.021 52%, 1.004 64%, 0.999 80%, 1)`
- `--pl-spring-calm`: `linear(0, 0.035 3%, 0.118 6%, 0.265 10%, 0.420 14%, 0.562 18%, 0.709 23%, 0.819 28%, 0.907 34%, 0.971 42%, 1.001 52%, 1.006 64%, 1.003 80%, 1)`
- `--pl-ease` `cubic-bezier(.2,.8,.2,1)`; `--pl-ease-out` `cubic-bezier(0,0,.2,1)`; `--pl-ease-in` `cubic-bezier(.4,0,1,1)`

| # | Element | Trigger | Properties (transform, opacity) | Duration | Easing | Reduced-motion fallback |
|---|---|---|---|---|---|---|
| 1 | "Connection lost · Working offline" toast | `net.state` becomes `offline` | enter `translateX(24px)→0`, `opacity 0→1`; it leaves with `opacity→0`, `translateX(12px)` after 4 s or when the popover opens | 200 ms in, 120 ms out | `--pl-spring-calm` in, `--pl-ease-in` out | shown and hidden instantly; the live region still speaks once |
| 2 | Connectivity chip | label change (Online → Reconnecting… → Offline · n queued) | old label `opacity 1→0`, `translateY(0→-6px)`; new label `translateY(6px→0)`, `opacity 0→1` (vertical cross-fade); the amber fill layer fades in with `opacity` | 200 ms | `--pl-spring` | label and fill switch instantly |
| 3 | Chip attention pulse | first switch to Offline only | a glow pseudo-element `scale(1)→scale(1.35)`, `opacity .5→0`, **once** | 320 ms | `--pl-ease` | no pulse |
| 4 | Queued count | the count changes (3 → 4, or 3 → 2 on replay) | the digit rolls: old `translateY(0→-100%)`, new `translateY(100%→0)` inside a clipped span | 120 ms | `--pl-spring` | digit swaps instantly |
| 5 | Popover | chip click or Enter | `translateY(-6px)→0`, `scale(.96)→1` from the chip's centre (`transform-origin` at the arrow), `opacity 0→1` | 320 ms (opacity 200 ms) | `--pl-spring` | shown instantly |
| 6 | Popover rows | after the popover opens, staggered 40 ms | `translateY(6px)→0`, `opacity 0→1`; the whole stagger stays under 300 ms | 200 ms each | `--pl-spring-calm` | rows shown at once |
| 7 | Popover | Esc, click outside, or chip click | `opacity 1→0`, `scale(1)→(.98)` | 120 ms | `--pl-ease-in` | removed instantly |
| 8 | Queued op row on replay | `op.result` for that op | row `translateX(0→16px)`, `opacity 1→0`; the rows below FLIP up with `translateY` | 200 ms | `--pl-ease-in` for the exit, `--pl-spring-calm` for the FLIP | row removed and list reflows instantly |
| 9 | Retry now | click | icon `rotate(0→-360deg)` **once**; a determinate 3 s bar under the button (`scaleX(0→1)`, linear) because a real probe is in flight | 320 ms rotation; 3 s bar | `--pl-spring` for the rotation; `linear` for the bar | no rotation; the bar jumps in 1 s steps |
| 10 | Degraded service row | a service recovers | the amber dot cross-fades to a green dot (`opacity`), then the row leaves as in row 8 | 200 ms + 200 ms | `--pl-ease` then `--pl-ease-in` | instant |
| 11 | Read-only banner | the Editor gets EBUSY on `lock.acquire` | `translateY(-10px)→0`, `opacity 0→1`; the code view below moves with a FLIP `translateY` | 320 ms | `--pl-spring-calm` | banner and content appear instantly |
| 12 | Lease countdown bar | each 1 s tick, and on a renewal | `transform: scaleX(remaining / TTL)` from the left. A tick is 1000 ms `linear`. A renewal (bob's heartbeat, about every 5 s in the 15 s demo profile) refills the bar with a `--pl-spring` over 200 ms | 1000 ms tick; 200 ms refill | `linear`; `--pl-spring` | the bar steps once a second with no tween; the text is always shown |
| 13 | Lock badge on avatar B | banner enters | `scale(.6)→1`, `opacity 0→1` | 200 ms | `--pl-spring` | shown instantly |
| 14 | Notify me | press | `scale(1)→(.97)→1`; then the label cross-fades to `Notifying you` with a check at `scale(.6)→1` | 120 ms + 200 ms | `--pl-spring` | label swaps instantly |
| 15 | Banner, released | `lock.released` for this inode | amber tint layer `opacity 1→0` while the green tint layer `opacity 0→1`; the lock glyph `rotate(0→-20deg)`, `translateY(-2px)` (unlocking); the **Open for writing** button `scale(.9)→1`, `opacity 0→1` | 320 ms | `--pl-spring` | colours and button switch instantly |
| 16 | Read-only chip in the title bar | lock state change | `scale(.9)↔1`, `opacity` | 120 ms | `--pl-ease` | instant |
| 17 | bob's remote caret | bob's position update (at most 4 Hz) | `translate(x,y)` to the new position | 120 ms | `--pl-ease` | caret jumps |
| 18 | Code view | typing on a read-only buffer | a single horizontal nudge of the banner `translateX(0→4px→-3px→0)` to point at the reason; never on the text itself | 200 ms | `--pl-spring` | no nudge; the live message `Read-only — bob holds the lock` is enough |
| 19 | Frame meter HUD | turned on (Settings › Developer or `framemeter on`) | `translateY(8px)→0`, `scale(.96)→1`, `opacity 0→1` | 320 ms | `--pl-spring` | shown instantly |
| 20 | HUD bars | 1 Hz redraw with new data | the newest bar grows `scaleY(0→v)` from the bottom and the strip shifts left one bar with `translateX(-bar)`; the p95 digits change without animation (tabular numbers) | 200 ms | `--pl-spring-calm` | bars redraw without a tween |
| 21 | Over-budget bar | a sample above 16.7 ms | that bar's amber layer `opacity 0→1` | 120 ms | `--pl-ease` | instant colour |
| 22 | Dock magnification | pointer over the dock | hovered icon `scale(1→1.45)` and `translateY(-10px)`; neighbours `scale(1.2)` and `scale(1.08)`, computed from pointer distance | 120 ms follow | `--pl-spring` | no magnification; the label appears on hover and focus |
| 23 | Editor window focus | click on the Terminal, then back | shadow layer `opacity` cross-fade between the focus and rest shadows (two pseudo-elements); traffic lights `opacity` from grey to colour | 120 ms | `--pl-ease` | instant |
| 24 | Back online | `net.state` becomes `online` and replay starts | chip cross-fade (row 2) to `Syncing · 3 ops`; each op row exits (row 8); when the outbox is empty the chip becomes `Online` with a check `scale(.6)→1` | per row | per row | instant swaps; one live announcement `Back online · 3 changes synced` |

## Accessibility

- **Landmarks:** menu bar `role="menubar"` (`aria-label="Menu bar"`) inside a `<header>`; tray `role="group" aria-label="Status"` with its own `aria-live="polite"` region, limited to one announcement per 5 s (spec §3.15.2); windows are `role="region"` (`<section>`) named after their titles (`Editor — report.md (read-only)`, `Terminal — student — ~`); the dock is `<nav aria-label="Dock">` with `role="toolbar"` and a roving tabindex.
- **Connectivity chip:** a `<button>` whose accessible name equals its label (`Offline · 3 queued`), with `aria-haspopup="dialog"` and `aria-expanded`. Colour is never the only signal: the cloud-off icon and the word "Offline" carry the state.
- **Popover:** `role="dialog"` with `aria-label="Connectivity and degraded services"`. It is non-modal, so focus is not trapped; Esc closes it and returns focus to the chip. The queued list is a `<ul aria-label="Queued operations">`, and the degraded list is a `<ul aria-label="Degraded services">`. Each row reads as one sentence, for example `write ~/notes.md, queued 14:29`.
- **Banner:** `role="status"` (a warning, not an error), so it is announced politely once. The countdown is a `role="progressbar"` with `aria-valuemin="0"`, `aria-valuemax="15"`, `aria-valuenow` and `aria-valuetext="11 seconds left"`. The live region does **not** re-announce every tick; it speaks again only when the lease is released or renewed after an expiry.
- **Editor:** the CodeMirror content has `aria-readonly="true"`, and the window title includes `(read-only)` (spec §3.8.12). **Notify me** uses `aria-pressed` once armed.
- **Frame meter:** `role="status"` with `aria-label="Frame meter: p95 14.2 milliseconds, 60 frames per second"`. The bar graph is `aria-hidden`, and the numbers are the accessible content. It updates its label at most once every 5 s so it never chatters.
- **Keyboard:** Tab reaches the chip from the tray. Inside the popover: `Retry now` → queued rows (arrow keys) → degraded rows → `Task Manager`. In the Editor, `Ctrl+Shift+L` retries the lock (the same action as `Try again` in the spec banner).
- **Contrast:** amber text on the dark banner is `#FFE7C2` on about `#3a2a12`, well above 4.5:1. The chip uses dark text `#1b1200` on `#FF9F0A` (about 9:1). Tertiary 42 % white is used only for non-essential since-times and hints.

## Review of `reference.png`

Checked: the menu bar has the Plotinium atom, `Editor` and plain menus, with no Apple marks or names. The amber `Offline · 3 queued` chip is pressed, and the popover's arrow points at it. The popover shows three queued ops with verb badges, the exactly-once line, both degraded services and the Retry and Task Manager actions. The Editor has left traffic lights, a Read-only chip, the verbatim banner text with `11 s`, the countdown bar and **Notify me**. The status bar shows `Read-only · lock held by bob (uid 1002)`. The HUD reads `p95 14.2 ms · 60 fps` with 24 bars and one amber spike. Every app name is a Plotinium name. Text contrast is readable throughout.

## Issues

1. **No Stitch output.** Generation timed out, and the screen never appeared (see `screen.json`). `reference.html` and `reference.png` are a hand-built stand-in. When Stitch recovers, generate once with the prompt above, save `screen.html` and `screenshot.png`, and compare them with `reference.png`.
2. **Offline plus a server lease is a composite state.** Offline, `lockd` is degraded and cannot see bob's lease, so a live 11 s countdown is only the **last known** server value. The render keeps the requested text and adds `last seen 14:31:02`. Product decision needed: while offline, either freeze the countdown and show `rechecks when you reconnect`, or let the local copy expire and offer `Edit offline — may become a conflicted copy` (spec §3.14.7 and §3.12).
3. **Banner wording differs from the spec.** `ui-design-system.md` §3.8.12 gives `Locked by bob — read-only. The lock expires in 12 s if bob's session stops.` [Try again]. This screen uses the requested wording and **Notify me**. One wording needs to be chosen and the spec updated.
4. **HUD position.** WMD-19 places the frame meter top-right. It is bottom-right here because the prompt asks for it and the connectivity popover occupies the top-right. Either spec the position as a corner setting or move it back.
5. **Tray versus menu bar.** The spec still describes a bottom taskbar with a tray (`--pl-taskbar-h`). The Liquid Glass direction puts the status items in a top menu bar and uses a dock. `ui-design-system.md` §3.8.7 needs a matching update.
