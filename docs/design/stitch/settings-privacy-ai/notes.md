# Settings: Privacy & AI (dark)

| Field | Value |
|---|---|
| Stitch project | `12849137298552292712` |
| Stitch screen id | none: generation timed out and never appeared in `list_screens` (about 20 polls, 15:24Z to 15:48Z). Not retried, per run instructions. See `screen.json`. |
| Design system | Plotinium Glass (Dark), `assets/10121591451242352758` |
| Model | GEMINI_3_8_FLASH, DESKTOP 1440 x 900 |
| Files | `screen.json` (Stitch timeout record), `reference.html` + `reference.png` (hand-built render of the final prompt; NOT a Stitch export). `screen.html` / `screenshot.png` are absent because Stitch returned no screen. |
| Spec sources | `specs/05-wm/ui-design-system.md` §3.6 motion, §3.7 components, §3.8.14 Settings; `specs/10-ai/predictive-prefetch.md` §3.3 (PRE-05, I-C1, I-C6); `specs/10-ai/rag-semantic-search.md` (model, indexer, RAG-06); `specs/10-ai/agentic-shell.md` (AGT-03 confirmation, AGT-08 `ai log`, `ai status` budget) |

## What this screen shows

The Settings window with the **Privacy & AI** section selected in the sidebar. It is a macOS System Settings-style layout: a vibrancy sidebar with a user card, then grouped inset lists on the right. The page has three groups.

1. **Usage telemetry** (PRE-05). Telemetry is kept on the device, and this cannot be turned off here (the switch is locked, with the reason). Sending it to the server is off by default. There is a preview table of the latest events. Following spec invariant I-C6, events contain **app ids and times only**: never file names, paths or content. The actions are `View all…`, `Export…` and `Clear telemetry` (red, and never the default button).
2. **Semantic search** (RAG). The on-device embedding model is `mdbr-leaf-ir (local, 23 MB)`. The index status shows `412 chunks pending`, with a determinate bar and real counts, next to the `Rebuild index` button.
3. **AI agent** (AGT). The provider is `Claude via Plotinium gateway`, and the monthly budget meter shows `$3.20 of $50`. The `Require confirmation for all changes` switch is on, and `Open ai log…` opens the same records as `ai log` in the Terminal.

The footer shows `Plotinium 0.3.0 · build a1f93c2`.

## Final prompt

```text
Plotinium Settings window — section "Privacy & AI" selected. Dark Liquid Glass desktop OS UI inspired by the latest macOS System Settings, but with Plotinium's own identity (NO Apple logo, NO Apple app names, NO SF Symbols; use thin lucide-style line icons; accent violet #5E5CE6).

CONTEXT (1440x900 desktop): a top menu bar in translucent dark glass: at left a small luminous atom logo (bright violet nucleus with 2 thin elliptical orbits), then bold "Settings", then menus "File  Edit  View  Window  Help". At right: wifi, battery 82%, a Search magnifier icon, a Control Centre toggle icon, and clock "Thu 24 Sep  10:42". Behind everything a deep violet-to-indigo abstract wallpaper, softly blurred. At the bottom a floating translucent dock with rounded app icons (Files, Terminal, Editor, Task Manager, Settings — Settings has a small dot indicator underneath).

THE WINDOW (centred, ~1080x780, 14px corner radius, large soft shadow, layered translucent dark glass): traffic-light window controls (red, amber, green circles) at top-left. Title bar area shows back/forward chevrons and the title "Privacy & AI".

LEFT SIDEBAR (vibrancy glass, 250px): a search field "Search settings" at top; a user card: round avatar with initials "S", name "student", subtitle "uid 1001 · Plotinium Account". Then a grouped list with small coloured rounded-square icons: "Wi-Fi & Network", "Appearance", "Desktop & Dock", "Notifications", "Sound"; group 2: "Memory", "Scheduler", "Boot"; group 3: "Users & Groups", "Privacy & AI" (SELECTED — violet #5E5CE6 filled pill highlight, white text), "Files & Storage", "Sync"; group 4: "Keyboard", "Accessibility", "Developer", "About Plotinium".

RIGHT CONTENT (grouped inset lists like macOS System Settings, rounded 10px group cards with hairline separators, section headers in small grey caps):

Group "USAGE TELEMETRY":
- Row: "Keep telemetry on this device" with a toggle ON (violet) that is locked (dimmed, small lock icon); helper text: "Always on. Telemetry never leaves the device unless you opt in."
- Row: "Sync telemetry to server" toggle OFF, helper "Off. Sends launch, focus and close events to your account so a new device can predict your apps."
- Block "Recent events" with the summary "1,284 events · 94 KB · oldest 3 Sep · predictor Markov-2" and a small table with columns Time | Event | App | Previous app | Time bucket and 4 rows: "10:41:07 | focus | Editor | Files | Thu · 10–11", "10:40:52 | launch | Editor | Files | Thu · 10–11", "10:39:18 | focus | Terminal | Files | Thu · 10–11", "10:38:02 | close | Task Manager | Terminal | Thu · 10–11". Events hold app ids and times only: never file names or paths.
- Footer row: muted note "App ids and times only. No file names, paths or content." and right-aligned buttons "View all…" (glass secondary), "Export…" (glass secondary), "Clear telemetry" (red destructive).

Group "SEMANTIC SEARCH":
- Row: "Embedding model" value "mdbr-leaf-ir (local, 23 MB)" with a chip "On-device".
- Row: "Index status" with an amber dot and "412 chunks pending", a thin determinate progress bar at 88%, subtext "3,118 of 3,530 chunks indexed · ai.indexer pid 23 · priority 32", and a "Rebuild index" button (glass secondary with rotate icon) at the right.

Group "AI AGENT":
- Row: "Provider" value "Claude via Plotinium gateway" with a green "Connected" chip.
- Row: "Monthly budget" with a horizontal meter 6.4% filled in violet and "$3.20 of $50"; subtext "6.4% used · resets 1 Oct".
- Row: "Require confirmation for all changes" toggle ON with helper "The agent shows its plan and asks before it writes files, kills processes or changes settings."
- Row: "Last action 10:40 · summarise os-report.md · confirmed" and a button "Open ai log…".

Bottom of content: tiny grey text "Plotinium 0.3.0 · build a1f93c2".

Style: Inter, crisp white primary text, 60% white secondary text, hairline separators rgba(255,255,255,0.08), glass panels with backdrop blur, generous spacing, readable contrast.
```

## UI elements and states

### Window chrome and shell
| Element | States |
|---|---|
| Menu bar (atom mark, `Settings`, `File Edit View Window Help`, status items, clock) | default; menu open (item highlighted with the accent fill); focus-visible ring on keyboard focus; unfocused window turns the app name to secondary text |
| Traffic lights (close, minimise, maximise) | idle (colour only); hover over the group reveals the ×, − and ⤢ glyphs; pressed (darker by 12%); window unfocused (all three grey `rgba(255,255,255,0.18)`); disabled maximise is not used here |
| Back / forward chevrons | enabled; disabled (38% label) when there is no history; hover shows a glass capsule behind the icon; focus ring |
| Dock (Files, Terminal, Editor, Task Manager, Settings with a running dot) | idle; hover magnification; pressed; running dot; attention bounce (once) |

### Sidebar (`nav`)
| Element | States |
|---|---|
| `Search settings` field | empty (placeholder); focused (3px accent ring at 55%); typing (non-matching rows filter out and matching words are bolded); no results (`No settings match "xyz"`); a clear (×) button appears when not empty |
| User card `student`, `uid 1001 · Plotinium Account` | default; hover (surface-3); pressed; guest variant (`Guest`, with no uid and device settings disabled) |
| Section rows (icon + label) | default; hover (4% white fill); selected (`Privacy & AI`: accent fill at 85% with white text); focus-visible (ring inside the pill); disabled (AI-off build: `Privacy & AI` reads `Privacy` and the AI groups are hidden) |

### Group: Usage telemetry
| Element | States |
|---|---|
| Switch `Keep telemetry on this device` (ON, locked) | on and locked (60% opacity, lock glyph, `aria-disabled="true"`, tooltip `Required for app pre-fetch. Never leaves the device unless you opt in.`); hover shows the tooltip; focusable so the reason is read aloud |
| Switch `Sync telemetry to server` (OFF) | off (default); hover; focus ring; pressed (the knob stretches by 4px); on; **pending** (a confirmation sheet explains what is sent and why, then calls `ai.telemetry.consent`); **error** `Not enabled on the server` (403 → `EACCES`) with the switch back off and an inline warning line; offline (disabled, `Connect to change sync`) |
| Recent events table (Time, Event, App, Previous app, Time bucket) | populated (4 rows, tabular numbers); hover row; selected row (accent-subtle); **empty** (`No telemetry recorded yet`, with the predictor in `cold start 0/50 launches`); **loading** (4 static skeleton rows, not animated); **error** (`Telemetry is kept in memory only — storage is full` banner, QuotaExceededError) |
| Summary line (`1,284 events · 94 KB · oldest 3 Sep · predictor Markov-2`) | default; cold start variant |
| `View all…` (secondary) | default, hover, pressed, focus, disabled while clearing |
| `Export…` (secondary) | default; busy (`Exporting…`, disabled); success toast `Saved ~/telemetry-20260924-1042.jsonl`; error toast with the errno |
| `Clear telemetry` (danger) | default (red text with a red hairline border); hover (danger-subtle fill); focus; opens an `alertdialog` (`Clear 1,284 events? The predictor restarts from cold start.`; when sync is on, a checkbox `Also delete the copy on the server`, checked by default); after clearing the table shows the empty state |

### Group: Semantic search
| Element | States |
|---|---|
| Embedding model row `mdbr-leaf-ir (local, 23 MB)` + chip `On-device` | ready; **loading** (`Model loading — showing keyword matches` in the warning colour); **unavailable** (`Semantic search unavailable — showing keyword matches`); safe mode or AI-off (`Semantic search not installed`, muted) |
| Index status (`412 chunks pending`, bar 88%, `3,118 of 3,530 chunks indexed · ai.indexer pid 23, priority 32`) | indexing (warning dot + determinate bar); up to date (success dot, `All 3,530 chunks indexed`, bar hidden); paused (`Paused while you search`); error (`Indexer stopped — EIO`, with a danger dot and `Show log`) |
| `Rebuild index` (secondary, rotate icon) | default; hover; focus; confirming (popover `Re-embed 3,530 chunks in the background?`); busy (label `Rebuilding…`, disabled; the icon does not spin because looping motion is banned); disabled in safe mode |

### Group: AI agent
| Element | States |
|---|---|
| Provider `Claude via Plotinium gateway` + status | connected (green dot + `Connected`); degraded (`Slow responses`, warning); offline (`Gateway unreachable — the agent is disabled`, danger dot); signed out (`Sign in to use the agent`) |
| Budget meter `$3.20 of $50` (6.4%) + `Resets 1 Oct` | normal (accent fill); ≥ 85% warning fill + `$43.10 of $50`; ≥ 100% danger fill + `Budget used — the agent is paused until 1 Oct`; loading (static placeholder bar) |
| Switch `Require confirmation for all changes` (ON) | on (default); off (the helper changes to `Destructive changes still always ask`, because AGT-03 confirmation is never bypassed); hover; focus; pressed |
| `Open ai log…` (secondary) + `Last action 10:40 · summarise os-report.md` | default, hover, focus; opens Terminal running `ai log -n 20`; empty variant (`No agent actions yet`) |

### Footer
`Plotinium 0.3.0 · build a1f93c2`: a selectable, muted text node.

## Intended animations

Only `transform` and `opacity` animate. Durations come from the motion tokens (`--pl-motion-fast` 120 ms, `--pl-motion-med` 200 ms, `--pl-motion-slow` 320 ms), plus two spring curves in the same style:
- `--pl-spring`: `linear(0, 0.009, 0.035 2.1%, 0.141 4.4%, 0.723 12.9%, 0.938 16.7%, 1.017 19.4%, 1.061 22.1%, 1.072 24.5%, 1.061 27.4%, 1.004 34.6%, 0.99 39.2%, 0.999 50.5%, 1)` (a small overshoot).
- `--pl-ease`: `cubic-bezier(.2, .8, .2, 1)`.

The reduced-motion rule for the whole screen: the tokens become 0 ms (`prefers-reduced-motion: reduce` or `data-motion="reduce"`), and an element that would slide or scale appears in place with at most a 120 ms opacity cross-fade. Nothing loops.

| # | Element | Trigger | Properties | Duration | Easing | Reduced motion |
|---|---|---|---|---|---|---|
| 1 | Settings window | open (from the dock or Search) | `transform: scale(.94) → 1`, `opacity 0 → 1` | 240 ms | `--pl-spring` | opacity 0 → 1 over 120 ms, no scale |
| 2 | Content pane | sidebar selection changes | outgoing pane `opacity 1 → 0` in 90 ms; incoming `translateY(6px) → 0`, `opacity 0 → 1` | 200 ms | `--pl-ease` | instant swap |
| 3 | Selected sidebar pill | selection moves to another row | the pill is one element that moves: `translateY(Δ)` to the new row (FLIP) | 280 ms | `--pl-spring` | pill jumps, no motion |
| 4 | Group cards | first render of the section | staggered 30 ms per group: `translateY(8px) → 0`, `opacity 0 → 1` | 200 ms | `--pl-ease` | all appear at once |
| 5 | Switch knob | toggle | knob `translateX(0 ↔ 20px)`; on press the knob is `scaleX(1.18)` (squash) and releases on toggle; the track's accent layer runs `opacity 0 ↔ 1` | 200 ms | `--pl-spring` | knob moves with no duration; colour change only |
| 6 | Locked switch | click or tap on it | lock glyph wiggle `rotate(-8deg → 8deg → 0)` once + tooltip `opacity 0 → 1`, `translateY(4px) → 0` | 320 ms wiggle, 120 ms tooltip | `--pl-spring` / `--pl-ease` | no wiggle; tooltip appears instantly |
| 7 | Sync consent sheet | switching `Sync telemetry` on | the sheet drops from the title bar: `translateY(-100%) → 0`; scrim `opacity 0 → .4` | 320 ms | `--pl-spring` | sheet fades in over 120 ms |
| 8 | Telemetry table rows | new event arrives while visible | new row `translateY(-6px) → 0`, `opacity 0 → 1`; rows below shift with a FLIP `translateY` | 200 ms | `--pl-ease` | row inserted with no motion |
| 9 | Clear telemetry | confirmed | rows collapse: each row `opacity 1 → 0`, `scaleY(1 → .6)`, 20 ms stagger; then the empty state `opacity 0 → 1` | 200 ms rows + 120 ms empty | `--pl-ease` in | instant replace |
| 10 | Clear alertdialog | opening | `scale(.96) → 1`, `opacity 0 → 1`; scrim `opacity 0 → .4` | 200 ms | `--pl-spring` | fade 120 ms |
| 11 | Index progress bar | `ai.index.status` update | the fill is a full-width layer moved with `transform: scaleX(p)` (origin left), not `width` | 320 ms | `--pl-ease` | jumps to the value |
| 12 | Index completes | pending count reaches 0 | status dot cross-fades from warning to success (`opacity`), check icon `scale(.6) → 1` once | 320 ms | `--pl-spring` | icon swaps instantly |
| 13 | Rebuild index button | click (after confirming) | icon turns once, `rotate(0 → 360deg)`, then stays still (a single turn, not a loop) | 480 ms | `--pl-ease` | no rotation |
| 14 | Budget meter | section shown / value changes | fill `scaleX(0 → .064)` on first show; the label counts up in text only (no layout animation) | 480 ms | `--pl-spring` | set directly |
| 15 | Buttons (all) | press | `scale(1 → .97)` on pointerdown, back on pointerup | 120 ms | `--pl-ease` | no scale |
| 16 | Buttons and rows | hover | hover-fill layer `opacity 0 → 1` | 120 ms | `--pl-ease` | kept (opacity only, 0 ms) |
| 17 | Toasts (export done, errors) | event | from the top right: `translateX(24px) → 0`, `opacity 0 → 1`; exit `opacity → 0`, `translateX(12px)` | 200 ms in, 120 ms out | `--pl-ease-out` in, `--pl-ease-in` out | fade 120 ms |
| 18 | Settings search filter | typing | non-matching rows `opacity → 0` and are removed; the remaining rows close up with a FLIP `translateY` | 200 ms | `--pl-ease` | instant filter |

## Review notes (reference render)

**There is no Stitch render for this screen** (see `screen.json`). Generation timed out and never appeared in `list_screens` (about 20 polls over 25 min); it was not retried. To keep the design reviewable, `reference.html` is a hand-built render of the final prompt using the Plotinium Glass (Dark) tokens, and `reference.png` is its 1440 x 900 Chromium capture (Playwright). Its source is labelled "NOT a Stitch export". Reloading `reference.html` plays the entrance: window scale-in, staggered sidebar rows, groups rising, table rows and the meter fills. The switches toggle on click; the locked one does not.

What I checked on `reference.png`:
- The layout is macOS System Settings-grade: vibrancy sidebar, traffic lights, back/forward, grouped inset cards, hairline separators, and a floating dock that clears the window (window bottom 818px, dock top 826px).
- Branding and names: the atom mark in the menu bar and on `About Plotinium`, and only Plotinium names (Settings, Files, Terminal, Editor, Task Manager, Search, Control Centre). There is no Apple logo, no Apple app names and no SF Symbols; icons are lucide paths.
- Every requested element is present: the locked `Keep telemetry on this device` (ON), `Sync telemetry to server` (OFF), the events table, `View all…` / `Export…` / `Clear telemetry` (red), `mdbr-leaf-ir (local, 23 MB)`, `412 chunks pending`, `Rebuild index`, `Claude via Plotinium gateway`, `$3.20 of $50`, the `Require confirmation for all changes` switch (ON), `Open ai log…`, and `Plotinium 0.3.0 · build a1f93c2`.
- Contrast: body text is 92% white on at least 80% dark glass. Secondary text at 62% white passes 4.5:1 on the card tint. Amber `412 chunks pending` (#FFB340) and red `Clear telemetry` (#FF6961) pass 4.5:1 on the card.

Deliberate deviations from the orchestrator prompt:
1. **The telemetry table shows app ids and times only**: Time, Event (`launch`/`focus`/`close`), App, Previous app, Time bucket. The first Stitch prompt I sent had rows such as `open /home/student/notes/os-report.md`, which would break PRE-05 invariant I-C6 ("Telemetry holds app ids and times only") and the Settings → Privacy row in `ui-design-system.md` §3.8.14. The final prompt above is corrected. If Stitch recovers and renders the original prompt, edit the table before using it.
2. The sidebar sections follow `ui-design-system.md` §3.8.14 (Memory, Scheduler, Boot, Developer) instead of the Displays/Focus rows in my first prompt.
3. The index bar is 88% (3,118 / 3,530), not the 78% in my first prompt, so the bar matches the numbers.
4. The spec's `Export as JSON` is labelled `Export…` as the prompt asks. It writes `~/telemetry-YYYYMMDD-HHmm.jsonl`.

To do when Stitch recovers: generate once with the final prompt, download to `screen.html` / `screenshot.png`, and compare with `reference.png`.

## Accessibility

- **Landmarks.** The window is `role="dialog"` with `aria-labelledby` pointing at the window title, and it is non-modal in the WM. Inside it, the sidebar is a `nav` with `aria-label="Settings sections"` and the content pane is `main`, headed by an `h1` (`Privacy & AI`). Each group is a `section` with an `h2` (`Usage telemetry`, `Semantic search`, `AI agent`).
- **Sidebar.** A list of links with `aria-current="page"` on the selected row. The search field is `role="searchbox"` and reports its filter results through a polite `role="status"` region (`3 settings match`).
- **Switches.** `button role="switch"` with `aria-checked`; each label is associated through `aria-labelledby` and each helper text through `aria-describedby`. The locked switch uses `aria-disabled="true"`, not `disabled`, so it stays focusable and announces its reason.
- **Table.** A native `table` with a `caption` of `Recent telemetry events` and `th scope="col"`. Times use `tabular-nums`, and a `time datetime="…"` element carries each timestamp.
- **Meters.** The budget is a `meter` element or `role="meter"` with `aria-valuemin="0"`, `aria-valuemax="50"`, `aria-valuenow="3.2"` and `aria-valuetext="3 dollars 20 of 50 dollars used this month"`. The index bar is `role="progressbar"` with `aria-valuetext="3,118 of 3,530 chunks indexed"`.
- **Status.** Index and gateway status changes are announced through `role="status" aria-live="polite"` at most once every 750 ms. Errors use `role="alert"`.
- **Destructive action.** `Clear telemetry` opens an `alertdialog`. Initial focus goes to `Cancel`, the safe action.
- **Colour is never the only signal.** Every status dot has a text label, and the locked state has both a lock glyph and text.
- **Contrast.** All text sits on at least a 78%-opaque glass tint, so secondary 60% labels still meet 4.5:1.
- **Focus order.** Sidebar search, the user card, the sidebar rows, then the content in reading order. Focus rings are a 3px accent at 55%, offset 2px.
