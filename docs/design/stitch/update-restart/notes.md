# Restart to update (`update-restart`)

| Field | Value |
|---|---|
| Stitch project | `12849137298552292712` (Plotinium OS) |
| Stitch screen id | none. The call returned session `12522471168370334759` but no screen id, and no screen appeared in `list_screens` after 14 polls over about 11 minutes. It was not retried. See `screen.json`. |
| Design system | LIGHT · `assets/3690503530025860907` (Plotinium Glass, Light) |
| Model | GEMINI_3_8_FLASH · DESKTOP 1440×900 |
| Files | `screen.json` (Stitch record), `reference.html` and `reference.png` (a hand-built render of the same prompt; **not** a Stitch export). `screen.html` and `screenshot.png` are missing because Stitch returned no screen. |
| Spec anchors | `specs/06-sync/offline-and-sync.md` §3.16 (versioned Service Worker, the update flow, "Restart to update", OFF-05) · `specs/02-boot/boot-and-services.md` §3.10 (graceful shutdown order, `Stopping <service> · n of 18`, BOOT-12, SVC-11) · `specs/05-wm/ui-design-system.md` §3.7 (Dialog: initial focus on the safe action; determinate progress only, DSN-07), §3.8.7 (the `Restart to update` primary chip), §3.8.16 (toast `Plotinium 0.3.1 is ready — Restart to update`) |
| Requirement IDs | OFF-05, BOOT-12, SVC-11, MEM-04 (session restore), DSN-05, DSN-07, WM-07 |

## What the screen shows

A new build finished installing in the background. The waiting Service Worker reported `VERSION 0.3.1, BUILD c47e0b9`, so the menu bar shows a violet **Restart to update** chip. The student opened Settings › Software Update and clicked it. A light glass alert dialog is centred over a lightly dimmed desktop. It has the 68 px Plotinium atom app icon, **Plotinium 0.3.1 is ready**, and the version line `0.3.0 · a1f93c2 → 0.3.1 · c47e0b9 · 18.4 MB · downloaded`. Below that are a four-item **What's new** list with a **Full release notes** link, the required body sentence, an **Install updates automatically** checkbox, and the buttons **Later** and **Restart Now** (primary). Initial focus is on **Later**, the safe action.

A separate inset in the bottom-right corner, labelled **After "Restart Now"**, previews the next state. It has a determinate violet progress ring at 62 % around the atom, **Restarting Plotinium…**, `62% · stopping services · 11 of 18`, and the verbose line **Stopping services (reverse order) · flushing 3 dirty pages · saving session…**. A step list follows in the spec's real order: checkpointed 4 window processes (done), flushed dirty pages 3/3 (done), saved session · 4 windows (done), stopping `sync` · outbox flushed 11/18 (current, with an 18-segment service bar), and activate 0.3.1 and reload (next). The footer reads `Session saved for student (uid 1001) · 4 windows` and `≤ 8 s`.

## Final prompt

Sent verbatim to `generate_screen_from_text` (DESKTOP, LIGHT design system, GEMINI_3_8_FLASH):

> Plotinium OS — 'Restart to update' experience in LIGHT mode (Liquid Glass desktop, 1440x900). Plotinium is a web-based operating system inspired by the latest macOS Liquid Glass look but with its own identity. Never use the Apple logo, SF Symbols or Apple app names. Use lucide-style thin line icons. Accent violet #5E5CE6.
>
> BACKGROUND: bright light wallpaper with soft pastel lavender, pale blue and white gradient blooms. The desktop behind the dialog is slightly dimmed/blurred.
>
> MENU BAR (top, 28px, translucent white frosted glass, hairline border): Plotinium atom logo at far left (an abstract luminous atom: bright nucleus with 2–3 thin elliptical orbits in violet #5E5CE6, no hazard or radiation symbol), bold 'Settings', menus 'File  Edit  View  Window  Help'. Right side: a small violet badge-dot on a download-arrow icon (update ready), wifi, battery 76%, Control Centre icon, search icon, clock 'Thu 24 Sep  17:05'.
>
> A background Settings window (partly visible, dimmed) showing 'Software Update' in a vibrancy sidebar.
>
> CENTRED GLASS ALERT DIALOG (440px wide, white frosted glass with strong backdrop blur, 22px radius, very soft large shadow, 1px white inner highlight):
> - At the top centre a 64px Plotinium app icon: the luminous violet atom logo on a rounded-square glass tile with subtle glow.
> - Title (semibold 17px): 'Plotinium 0.3.1 is ready'
> - Subtitle small grey: 'You're on Plotinium 0.3.0 · build a1f93c2 → 0.3.1 · build c47e0b9 · 18.4 MB'
> - 'What's new' list with small violet check icons:
>   • 'Faster boot: services start in parallel where dependencies allow'
>   • 'Files: semantic search now indexes PDFs'
>   • 'Terminal: ai explain for failed commands'
>   • 'Fixes a lock lease renewal race in lockd'
>   • 'Security: session tokens rotate every 12 h'
>   and a text link 'Full release notes'.
> - Body paragraph: 'The update installs in the background and activates on your next restart. Your windows and unsaved work will be restored.'
> - A checkbox: 'Install updates automatically' (checked).
> - Buttons row at the bottom right: secondary glass button 'Later' and primary violet #5E5CE6 filled button 'Restart Now' with a focus ring.
>
> SHUTDOWN PROGRESS INSET (a smaller separate glass card at the bottom-right of the canvas, labelled above in small caps 'AFTER RESTART NOW' to show the next state, 320px): a circular progress ring in violet at 62% with the atom logo in its centre, title 'Restarting Plotinium…', and a monospace step line: 'Stopping services (reverse order) · flushing 3 dirty pages · saving session…'. Below that a tiny list of services with states: 'ai.indexer (pid 23) — stopped ✓', 'syncd — stopped ✓', 'vfs — flushing 3 dirty pages…' (spinner), 'sched — waiting', 'init (pid 1) — waiting'. A footnote 'Session saved for student (uid 1001) · 4 windows'.
>
> FLOATING DOCK at the bottom centre (light frosted glass, 22px radius) with our own rounded-square app icons: Files, Terminal, Editor, Task Manager, Search, Settings (active dot), separator, Trash.
>
> Overall: macOS-grade polish, layered translucent glass, soft large shadows, readable dark text on light glass, Inter font.

**Differences in `reference.html`, all deliberate and spec-driven:**
- The menu bar shows the spec's `Restart to update` **primary chip** (§3.8.7), not only a badge dot.
- The release notes are cut to four so the dialog stays short.
- **Later** has the initial focus ring, because §3.7 says "initial focus on the safe action". **Restart Now** stays the filled primary button and is bound to `Ctrl+Enter`.
- The inset uses **no spinner**, because DSN-07 allows no indeterminate progress. Its steps follow the real BOOT-12 order: checkpoint → flush → save session → stop services in reverse order → activate the update.
- The inset is drawn on dark glass to set it apart from the live dialog. In production the full-screen shutdown view follows the theme.

## UI elements and their states

| Element | Default (as rendered) | Hover | Focus | Active / pressed | Disabled | Empty | Loading | Error |
|---|---|---|---|---|---|---|---|---|
| Menu bar (light glass, atom mark, `Settings`, File to Help) | `rgba(255,255,255,.55)` with blur 30 px and a hairline | menu title tint 8 % black | ring | dropdown open | greyed items | n/a | n/a | n/a |
| **Restart to update** chip (tray, `button`) | violet fill, white text, download icon | `#4B49D6` | ring | opens this dialog | hidden while a shutdown is in progress | no update: the chip is absent | the update is downloading: no chip; Settings shows `Downloading 0.3.1 · 42 %` with a determinate bar | install failed: Settings shows `Couldn't install 0.3.1 · will retry at next boot` (no chip) |
| Settings window (inert behind the scrim) | lower contrast under the scrim | n/a | `inert` while the dialog is open | n/a | n/a | n/a | n/a | n/a |
| Scrim (below the menu bar) | `rgba(40,40,70,.18)` | n/a | n/a | a click nudges the dialog (it must be answered or dismissed with Later) | n/a | n/a | n/a | n/a |
| Dialog container (`role="alertdialog"`, 452 px, 22 px radius) | white glass at 74 % with blur 44 px, 1 px white inner highlight, large soft shadow | n/a | focus is trapped; initial focus is **Later** | n/a | n/a | n/a | n/a | n/a |
| App icon (68 px; the atom on a dark-violet rounded square with a glow) | static | n/a | n/a | n/a | n/a | n/a | n/a | n/a |
| Title `Plotinium 0.3.1 is ready` and the version line | 17 px semibold; the version line is secondary, mono for the build hashes | n/a | n/a | n/a | n/a | n/a | n/a | client or server skew: the title becomes `Restart to update required to sync` (spec §3.16.3 rule 4) |
| What's new list (4 items with violet checks) and **Full release notes** | inset card on white at 62 % | link underline | ring on the link | the link opens the notes in Editor (read-only) | n/a | no notes: `Maintenance release` | n/a | notes failed to load offline: `Release notes are available when online` |
| Body sentence | secondary text, 12.5 px, 1.5 line height | n/a | n/a | n/a | n/a | n/a | n/a | n/a |
| **Install updates automatically** checkbox | checked, violet | tint | ring | toggles; saved per device | disabled for non-admin guests (`guest` uid 65534) | n/a | n/a | n/a |
| Keyboard hint (`Esc Later · Ctrl+↵ Restart`) | tertiary with keycaps | n/a | n/a | n/a | n/a | n/a | n/a | n/a |
| **Later** (glass secondary) | glass with a hairline and the **focus ring** (initial focus) | tint | 3 px violet ring at 55 %, offset 2 px | pressed `scale(.97)`; closes the dialog and keeps the chip | never disabled | n/a | n/a | n/a |
| **Restart Now** (primary) | violet fill, glow | `#4B49D6` | ring | pressed `scale(.97)`; the dialog morphs into the shutdown view | disabled while another shutdown runs (EBUSY) and for agent-initiated calls (EPERM, never shown to the agent) | n/a | label `Restarting…` for up to 200 ms before the hand-off | `EBUSY`: inline text `A restart is already in progress` |
| Shutdown inset or view (`role="status"`) | ring 62 %, title, `62% · stopping services · 11 of 18` | n/a | n/a | n/a | n/a | n/a | this whole card **is** the loading state; the ring is driven by stopped-service weights (truthful rule) | a stop timeout logs `WARN` and the step reads `sync · force-stopped after 4 s` in warning text; a failed session save reads `Session saved locally only` |
| Progress ring (`role="progressbar"`) | stroke offset for 62 % | n/a | n/a | n/a | n/a | n/a | advances only when a step or service really completes | n/a |
| Verbose line (mono, violet-tinted) | `Stopping services (reverse order) · flushing 3 dirty pages · saving session…` | n/a | n/a | n/a | n/a | n/a | in production it shows only the **current** phase | n/a |
| Step list (done, now, todo) | check on green, ring-dot on violet, hollow ring | n/a | n/a | n/a | n/a | n/a | n/a | a step with a warning shows an amber triangle plus text |
| Service bar (18 segments) | 10 done, 1 in progress (half violet), 7 waiting | n/a | n/a | n/a | n/a | n/a | n/a | n/a |
| Footer (`Session saved for student (uid 1001) · 4 windows`, `≤ 8 s`) | secondary text | n/a | n/a | n/a | n/a | n/a | n/a | n/a |
| Dock | light glass; running dots under Files, Terminal, Editor and Settings | magnify | roving tabindex | press dim | the dock is inert during shutdown | n/a | n/a | n/a |

## Intended animations

Rules: only `transform` and `opacity` animate. The one exception is the progress ring's `stroke-dashoffset`, a single small SVG element comparable to the boot bar's `width` exception in `ui-design-system.md` §3.6; alternatively it can be built as two rotated half-discs so only `transform` changes. Nothing loops, and there is no spinner (DSN-07). Every duration is a motion token, and all tokens become 0 ms under `prefers-reduced-motion: reduce` or `:root[data-motion="reduce"]` (DSN-05).

Easing tokens are the same as in `offline-lock-states/notes.md`: `--pl-spring`, `--pl-spring-calm` (the `linear()` curves), `--pl-ease` `cubic-bezier(.2,.8,.2,1)`, `--pl-ease-out` `cubic-bezier(0,0,.2,1)` and `--pl-ease-in` `cubic-bezier(.4,0,1,1)`.

| # | Element | Trigger | Properties (transform, opacity) | Duration | Easing | Reduced-motion fallback |
|---|---|---|---|---|---|---|
| 1 | **Restart to update** chip | `update.available` from the kernel | `scale(.6)→1`, `opacity 0→1`; the other tray items shift left with a FLIP `translateX` | 320 ms | `--pl-spring` | chip appears; the tray reflows instantly |
| 2 | Chip attention pulse | first appearance only | glow pseudo-element `scale(1)→(1.4)`, `opacity .45→0`, **once** | 320 ms | `--pl-ease` | none |
| 3 | Toast `Plotinium 0.3.1 is ready — Restart to update` | same event, if the user is idle | `translateX(24px)→0`, `opacity 0→1`; auto-dismiss after 6 s with `opacity→0` | 200 ms in, 120 ms out | `--pl-spring-calm`, `--pl-ease-in` | instant |
| 4 | Scrim | dialog opens | `opacity 0→1` | 200 ms | `--pl-ease-out` | instant |
| 5 | Dialog | chip click or Settings › Restart | `scale(.94)→1`, `translateY(8px)→0`, `opacity 0→1` | 320 ms (opacity 200 ms) | `--pl-spring` | shown instantly |
| 6 | App icon | 80 ms after the dialog | icon tile `scale(.7)→1`, and the orbit group inside `rotate(-20deg)→0`, **once** | 420 ms | `--pl-spring` | static |
| 7 | What's new rows | after the dialog lands, staggered 30 ms | `translateY(4px)→0`, `opacity 0→1` (total under 300 ms) | 200 ms each | `--pl-spring-calm` | all shown at once |
| 8 | Focus ring on **Later** | initial focus | ring pseudo-element `scale(1.15)→1`, `opacity 0→1`, once | 320 ms | `--pl-spring` | static ring |
| 9 | Buttons | hover or press | tint layer `opacity`; press `scale(1)→(.97)→1` | 120 ms | `--pl-ease`, `--pl-spring` | no scale; tint switches instantly |
| 10 | Checkbox | toggle | check glyph `scale(.5)→1`, `opacity 0→1` (or reversed) | 120 ms | `--pl-spring` | instant |
| 11 | Dialog nudge | click on the scrim | `translateX(0→6px→-4px→2px→0)` | 240 ms | `--pl-spring` | no nudge; one polite message `Choose Later or Restart Now` |
| 12 | Dialog close (**Later** or Esc) | Later or Esc | dialog `scale(1)→(.97)`, `opacity 1→0`; scrim `opacity 1→0`; the dialog shrinks towards the chip (`transform-origin` at the chip) | 200 ms | `--pl-ease-in` | removed instantly |
| 13 | Hand-off to shutdown (**Restart Now**) | click | the dialog body `opacity 1→0`; the app icon FLIPs (`translate` plus `scale`) to the ring centre while the ring card `scale(.96)→1`, `opacity 0→1`; windows and the dock fade `opacity 1→.0` behind | 320 ms | `--pl-spring-calm` | cut to the shutdown view |
| 14 | Progress ring | a step or service really completes | stroke offset animates to the new value (or the half-disc `rotate`) | 200 ms per update | `--pl-spring-calm` | ring jumps to the value |
| 15 | Step row | its step completes | the hollow ring cross-fades to a check (`opacity`); the check `scale(.6)→1`; the next row's dot `opacity 0→1` | 200 ms | `--pl-spring` | instant |
| 16 | Service bar segment | each service stops (reverse topological order) | the segment's violet layer `opacity 0→1` and `scaleX(.6→1)` from the left | 120 ms | `--pl-ease-out` | instant |
| 17 | Percent and `n of 18` | each update | digits change without a tween (tabular numbers); announced by the live region at most once per 5 s | n/a | n/a | same |
| 18 | Final reload | `controllerchange` or the 5 s fallback | the whole view `opacity 1→0` just before `location.reload()` | 120 ms | `--pl-ease-in` | instant reload |
| 19 | After reboot | boot splash shows `Updated to 0.3.1` | handled by `boot-splash/notes.md` (event-driven transitions only, no keyframes) | n/a | n/a | n/a |

## Accessibility

- **Dialog:** `role="alertdialog"`, `aria-modal="true"`, `aria-labelledby="upd-title"` and `aria-describedby="upd-body"`, so a screen reader hears `Plotinium 0.3.1 is ready. The update installs in the background and activates on your next restart. Your windows and unsaved work will be restored.` Focus is trapped. **Later** is the initial focus (safe action, §3.7), and focus returns to the chip on close. Esc = Later; Ctrl+Enter = Restart Now; Enter activates the focused button.
- **Landmarks:** the menu bar is `<header role="menubar">`; the tray is `role="group" aria-label="Status"`; the Settings window becomes `inert` behind the dialog; the dock is `<nav aria-label="Dock">`.
- **Chip:** a `<button>` named `Restart to update to Plotinium 0.3.1`.
- **Shutdown view:** the container is `role="status"` with `aria-live="polite"`. The ring is `role="progressbar"` with `aria-valuenow` and `aria-valuetext="62 percent, stopping services, 11 of 18"`. The step list is a `<ol>`, and each state is text (`done`, `in progress`, `waiting`), not only an icon. The page never traps a screen-reader user: during shutdown, only the status region is exposed and everything else is `inert`.
- **Contrast:** body text at 62 % of `#12121C` on white glass at 74 % over a light wallpaper is about 5.6:1. The violet `#4543C9` link is about 7:1 on white. White on `#5E5CE6` is 4.9:1. Tertiary 46 % text is used only for hints and keycaps.

## Review of `reference.png`

Checked: the light menu bar has the atom mark, `Settings` and the violet `Restart to update` chip, with no Apple marks or names. The dialog is centred with the atom app icon, the exact title, the version line with both build hashes, four release notes and the link, the exact body sentence, the checked auto-install option, and **Later** (focused) plus **Restart Now** (primary). The inset shows the "After Restart Now" label, the determinate ring at 62 % with the atom, the exact verbose line, the ordered steps, the 11-of-18 service bar and the session footer. The Plotinium dock sits at the bottom. All text is readable.

## Issues

1. **No Stitch output.** A session id came back, but no screen appeared (see `screen.json`). `reference.html` and `reference.png` are a hand-built stand-in. Generate again when Stitch recovers and compare.
2. **The verbose line lists three phases at once.** The requested line names three phases together, but BOOT-12 runs them in order (flush → save → stop services). In production, show the current phase only and keep this sentence as the dialog's explanation.
3. **Spinner removed.** The prompt asked for a spinner on `vfs — flushing…`. DSN-07 forbids indeterminate progress, so the inset uses determinate steps and segments instead.
4. **Default button.** In macOS the filled button is the Return default. The Plotinium spec (§3.7) puts initial focus on the safe action, so here **Later** is focused and **Restart Now** needs Ctrl+Enter. Confirm this with R3.
5. **Release-notes facts are placeholders.** Replace them with the real `CHANGELOG.md` entries for 0.3.1 when the tag exists. The instructor's approval of a hash-only patch tag is still an open question (spec §3.16.3 rule 5).
