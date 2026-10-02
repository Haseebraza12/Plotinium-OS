# Terminal: AI plan (`terminal-ai`)

| Field | Value |
|---|---|
| Stitch project | `12849137298552292712` (Plotinium OS) |
| Stitch screen id | none: Stitch timed out and returned no screen (see `screen.json`) |
| Design system | DARK · `assets/10121591451242352758` (Plotinium Glass, Dark) |
| Model | GEMINI_3_8_FLASH · DESKTOP 1440×900 |
| Files | `screen.json` (Stitch timeout record, with the exact request); `reference.html` + `reference.png` (hand-built render of the same prompt, **NOT a Stitch export**; the PNG is a 1440×900 headless-Chrome capture of `reference.html?capture`). There is no `screen.html` or `screenshot.png` because Stitch returned no screen. |
| Spec anchors | `specs/10-ai/agentic-shell.md` §3.3, §3.12, §3.13, §3.17, §3.18 · `specs/05-wm/ui-design-system.md` §3.6, §3.8.9, §3.8.15 |
| Requirement IDs | AGT-02, AGT-03, AGT-08, AGT-10, DSN-05, DSN-15, DSN-16 |

## What the screen shows

A student has typed an `ai` instruction in the Terminal. The kernel has validated the plan and run it as a dry run. It has printed the plan block and the blast radius, asked `Proceed? [y/N/e=edit]` with **N** as the default, and received `y`. The screen shows the green commit line with the undo token. A faint autocomplete popover from an earlier `ai` keystroke is still visible on the right. The status strip shows the agent process and the LLM route.

## Final prompt

Sent once to `generate_screen_from_text` (DESKTOP, DARK design system, GEMINI_3_8_FLASH). It was not retried after the timeout.

```text
Plotinium Terminal — AI plan (screen title: "Plotinium Terminal — AI plan"). A desktop scene of Plotinium, a web-based OS whose look is inspired by the latest Liquid Glass-era desktop design, with its own identity. Do NOT use any Apple logo, Apple app names, SF Symbols or SF Pro. Use lucide-style line icons and a monospace font such as JetBrains Mono for terminal text, Inter for UI chrome.

BACKGROUND: a deep violet-to-indigo blurred abstract wallpaper. At the very top a thin translucent glass menu bar: on the left the Plotinium logo (an abstract luminous atom: bright violet #5E5CE6 nucleus with 2-3 thin elliptical orbits, no radiation symbols), then bold "Terminal", then menus "Shell  Edit  View  Window  Help". On the right: wifi, battery, a Control Centre toggle icon, a Search magnifier and the clock "Thu 24 Sep  10:42". At the bottom a floating glass dock with Plotinium app icons (Files, Terminal (active, with a small dot below), Editor, Task Manager, Settings).

MAIN WINDOW (centered, about 1100x680, large soft shadow, 14px corner radius): a dark translucent glass Terminal window. Title bar with three traffic-light dots (red, amber, green) on the left, centered title "student — ~ — 120×36". A tab strip below with one active tab "zsh-like shell — 1" (with a small close x) and a "+" new-tab button.

TERMINAL CONTENT (monospace, 13px, generous line height):
Line 1 (dim, previous command): student@plotinium:~$ ls ~/notes
Line 2 (dim output): os-report.md   sched-notes.md   lab3-vfs.pdf   todo.txt
Line 3: prompt in violet "student@plotinium:~$" followed by white text: ai "move every PDF I changed last week into a new folder called reports, and make it read-only for others"
Line 4 (dim): ⠿ planning with ai.agent · resolved 12 matches in 38 ms

Then a nicely formatted PLAN BLOCK inside the terminal: a rounded box with a thin 1px violet-tinted border and a slightly lighter glass fill. Header row: "Plan · 4 steps · 1 transaction" in bold, with a small violet sparkle/wand icon on the left and a pill "read-write" on the right.
Numbered step rows, each with the command in white monospace, an arrow "→", and a dim effect label on the right in a small badge:
 1  mkdir ~/reports                                   → create 1 dir        (badge CREATE, green)
 2  find ~ -type f -name "*.pdf" -mtime -7            → 12 files            (badge READ, blue)
 3  mv <12 files> ~/reports/                          → modify 12 entries   (badge MOVE, violet)
 4  chmod -R o-w ~/reports                            → modify 13 inodes    (badge CHMOD, amber)
Under step 3, a small collapsed disclosure "▸ show 12 files" in dim text (e.g. lab3-vfs.pdf, sched-paper.pdf …).
Footer row of the plan box, separated by a hairline: "Blast radius: 13 inodes · 0 deletions · 0 overwrites · within quota" shown as small stat chips (13 inodes, 0 deletions in green, 0 overwrites in green, within quota with a check).

Then an inline confirmation line: "Proceed? [y/N/e=edit]" where the "N" is highlighted as the default in a filled violet pill with a focus ring, "y" and "e=edit" in outlined small pills. After it the typed answer "y".
Then the result line in green: "✓ committed in 41 ms · txn 8f2c · undo with: ai undo 8f2c" where "ai undo 8f2c" is in an inline code chip.
Then a fresh prompt "student@plotinium:~$ " with a blinking block cursor in violet.

RIGHT SIDE of the terminal content: a faint, semi-transparent frosted autocomplete popover (about 260px wide, 50% opacity, left-aligned to an earlier "ai" word) left over from a previous command, listing suggestions with small icons and dim descriptions: "ai undo <txn>  — revert a transaction", "ai log  — show audited actions", "ai explain  — explain last command", "ai plan  — dry-run only". The first row is subtly highlighted. Hint at bottom: "Tab to accept · Esc to dismiss".

BOTTOM STATUS STRIP inside the window (thin, 26px, glass, dim 11px text): left "ai.agent pid 212 · Claude via gateway" with a small green live dot; middle "txn 8f2c committed"; right "UTF-8 · zsh-like · 120×36 · /home/student".

Style: Liquid Glass translucency, subtle inner 1px highlight on glass edges, vibrancy, high contrast readable text (white at 92% on dark glass), violet #5E5CE6 accent, green #30D158 for success, amber #FF9F0A for chmod, red #FF453A reserved for danger. Version watermark tiny in the menu bar dropdown is not needed. Everything crisp and pixel-perfect.
```

**Where `reference.html` differs from the prompt, and why (spec alignment):**
- The window title is `student@plotinium: ~ — 120×36`. `shell-and-terminal.md` §3 says the title follows the shell's `user@host: cwd`; the macOS-style `student — ~` form in the prompt was dropped.
- It adds the kernel header `── Kernel confirmation · ai.agent (pid 212) ──` and the line `Needs confirmation because: chmod`, both required by `ui-design-system.md` §3.8.15.
- Step 4's effect carries the word `chmod` in red **and** in text (AGT-03 rule: a destructive step names its operation in text).
- It adds the hint `N is the default · Enter declines` next to the prompt (DSN-15).
- The observation line uses the spec's format: `ai: looking: find ~ -type f -name "*.pdf" (changed 2026-09-17 → 2026-09-24) … 12 files`.

## UI elements and their states

### Desktop chrome (shared with every screen)
| Element | Default | Hover | Focus | Active / pressed | Disabled | Empty | Loading | Error |
|---|---|---|---|---|---|---|---|---|
| Menu bar (28 px glass, `role="menubar"`) | logo, **Terminal**, Shell, Edit, View, Window, Help; tray on the right | menu title gets a 6 px-radius tint (`rgba(255,255,255,.10)`) | 3 px accent ring at 55 % | menu open: tint stays and the menu drops down | items greyed to 38 % label, `aria-disabled` | n/a | n/a | n/a |
| Plotinium mark (atom) | 16 px violet nucleus with 2 orbits | orbit opacity rises to 100 % | ring | opens the Plotinium menu (About Plotinium, Settings…, Lock screen, Log out student…) | n/a | n/a | n/a | n/a |
| Tray: Wi-Fi, battery, Control Centre, Search, clock `Thu 24 Sep 10:42` | icons at 92 % | tint pill | ring | panel open | n/a | n/a | Wi-Fi shows 3 animated bars while connecting (not looping: it stops when connected or after 10 s) | Wi-Fi-off icon plus `Offline · 2 queued` chip in warning |
| Dock (floating glass, 52 px icons) | Files, **Terminal** (running dot), Editor, Task Manager, Settings | icon magnifies (scale up to 1.35 at the pointer, neighbours 1.15) and a name tooltip appears | ring around the icon, name read out | icon dims to 80 % while pressed | n/a | n/a | launch: icon bounces once | crashed app: dot turns red and the tooltip reads `Terminal quit unexpectedly` |

### Terminal window
| Element | Default | Hover | Focus | Active | Disabled | Empty | Loading | Error |
|---|---|---|---|---|---|---|---|---|
| Traffic lights (close, minimise, zoom; 12 px) | red `#FF5F57`, amber `#FEBC2E`, green `#28C840` | all three show their glyphs (×, −, ↔) | ring on the focused light; `aria-label` "Close", "Minimise", "Zoom" | 85 % brightness | greyed `#4A4A50` when the window is unfocused | n/a | n/a | n/a |
| Title `student@plotinium: ~ — 120×36` | 13 px semibold, 70 % label | n/a | n/a | double-click zooms | 56 % when unfocused | n/a | n/a | n/a |
| Tab `zsh-like shell — 1` | selected: lighter glass pill, close × visible | unselected tabs lighten; × appears | ring inside the tab | pressed tint | n/a | n/a | activity dot while output arrives in a background tab | bell glyph after a failed command in a background tab |
| `+` new tab | icon button, 70 % | 92 % plus tint | ring | pressed | at 16 tabs (`aria-disabled`, tooltip `Tab limit reached`) | n/a | n/a | n/a |
| Terminal viewport (xterm.js, JetBrains Mono 13–14 px) | text at 92 %, dim output at 70 % | text cursor over text | the viewport has the focus ring on its inner edge; the cursor is solid when focused and an outline when not | selection in accent at 45 % | read-only while the kernel prompt is active: type-ahead is flushed | new shell shows only the prompt | braille spinner line `⠿ planning with ai.agent` while the agent is BLOCKED on `net:llm` | ANSI red `✗ rejected: <reason> — nothing ran` |
| Prompt `student@plotinium:~$` | violet user@host, 70 % path | n/a | n/a | n/a | n/a | n/a | n/a | exit code chip `2` in red after a failed command |

### Kernel plan block (written to the TTY by the kernel, AGT-03)
| Element | Default | Hover | Focus | Active | Disabled | Empty | Loading | Error |
|---|---|---|---|---|---|---|---|---|
| Header `Plan · 4 steps · 1 transaction` with wand icon | bold, 92 % | n/a | n/a | n/a | n/a | `Plan · 0 steps`: `✓ nothing to do` | header shows `Plan · …` with a static placeholder until the dry run finishes | `✗ rejected: ENOENT ~/reprots — nothing ran` |
| Step rows 1–4 (command, arrow, effect) | mono 92 %, effect 70 % | row tint 4 % white (decoration layer only) | n/a | n/a | n/a | n/a | n/a | an invalid step is marked `⚠ not in your request` (UNGROUNDED) in warning |
| Operation badges CREATE (green), READ (blue), MOVE (violet), CHMOD (amber) | tinted pill, bold 11 px caps, label text also printed so colour is never the only signal | n/a | n/a | n/a | n/a | n/a | n/a | n/a |
| Disclosure `▸ show 12 files` | 70 % | underline | ring | expanded `▾`: lab3-vfs.pdf, sched-paper.pdf, os-report-draft.pdf, … | n/a | n/a | n/a | n/a |
| Blast-radius chips: `13 inodes`, `0 deletions`, `0 overwrites`, `within quota` | neutral, green, green, green with a check | n/a | n/a | n/a | n/a | n/a | n/a | `over quota by 38 MB` in danger stops the plan (EDQUOT) |
| `Needs confirmation because: chmod` | 70 % label with `chmod` in red **and** in text | n/a | n/a | n/a | n/a | line omitted when no confirmation is needed | n/a | n/a |
| Prompt `Proceed? [y/N/e=edit]` | `N` is a filled violet pill with the focus ring (default); `y` and `e=edit` are outlined pills | n/a | the ring stays on `N` until a key is typed | the typed key is echoed (`y`) | n/a | n/a | n/a | timeout after 120 s prints `✗ confirmation timed out — nothing ran` |
| Result line `✓ committed in 41 ms · txn 8f2c · undo with: ai undo 8f2c` | ANSI green; `ai undo 8f2c` in a code chip | chip tint rises | the chip is a link target (Ctrl+click or Enter in link mode copies it to the prompt) | pressed | n/a | n/a | `committed locally · sync pending (offline)` in warning | `✗ declined — nothing ran` (70 %), or `✗ rejected: EAGAIN changed-since — nothing ran` in red |
| Fresh prompt with a violet block cursor | the cursor blinks (xterm default) | n/a | solid when focused | n/a | n/a | n/a | n/a | n/a |

### Autocomplete popover (stale, from a previous command)
| Element | Default | Hover | Focus | Active | Disabled | Empty | Loading | Error |
|---|---|---|---|---|---|---|---|---|
| Popover (260 px glass, `role="listbox"`) | 50 % opacity while stale; 100 % when live | row tint | `aria-activedescendant` on the highlighted row; highlight in accent at 85 % | Tab inserts the row | n/a | hidden when nothing matches | `…` row while man-page summaries load | never shows an error; it closes silently |
| Rows: `ai undo <txn>`, `ai log`, `ai explain`, `ai plan` (each with an icon and a 70 % description) | 92 % text | tint | highlighted row | inserted | n/a | n/a | n/a | n/a |
| Hint `Tab to accept · Esc to dismiss` | 56 % label | n/a | n/a | n/a | n/a | n/a | n/a | n/a |

### Status strip (26 px)
| Element | Default | Hover | Focus | Active | Disabled | Empty | Loading | Error |
|---|---|---|---|---|---|---|---|---|
| `ai.agent pid 212 · Claude via gateway` with a live dot | green dot | tooltip `ai.agent · PRI 20 · waiting on nothing` | ring; Enter opens Task Manager filtered to pid 212 | pressed | `ai.agent idle` in grey when no agent runs | n/a | amber dot and `waiting on net:llm` | red dot and `AI unavailable · plain shell` (graceful absence, OFF-04) |
| `txn 8f2c committed` | 70 % | underline | ring; Enter runs `ai log 8f2c` | n/a | n/a | hidden before the first txn | `txn 8f2c · syncing` | `txn 8f2c · rejected on sync` in red |
| `UTF-8 · zsh-like · 120×36 · /home/student` | 56 % | n/a | n/a | n/a | n/a | n/a | n/a | n/a |

## Intended animations

Rules from `ui-design-system.md` §3.6: only `transform` and `opacity` animate. Nothing loops except the Terminal cursor blink. Every duration is a motion token, and all tokens become 0 ms under `prefers-reduced-motion: reduce` or `:root[data-motion="reduce"]` (DSN-05). **Terminal text output itself never animates**; the effects below apply to the chrome and to the decoration layer drawn over the kernel's plan block (xterm decorations).

Easing tokens used below:
- `--pl-spring`: `linear(0, 0.048 3%, 0.163 6%, 0.360 10%, 0.557 14%, 0.725 18%, 0.878 23%, 0.973 28%, 1.026 34%, 1.038 42%, 1.021 52%, 1.004 64%, 0.999 80%, 1)` (damping 0.72, about 4 % overshoot)
- `--pl-spring-calm`: `linear(0, 0.035 3%, 0.118 6%, 0.265 10%, 0.420 14%, 0.562 18%, 0.709 23%, 0.819 28%, 0.907 34%, 0.971 42%, 1.001 52%, 1.006 64%, 1.003 80%, 1)` (damping 0.85, under 1 % overshoot)
- `--pl-ease` `cubic-bezier(.2,.8,.2,1)`; `--pl-ease-out` `cubic-bezier(0,0,.2,1)`; `--pl-ease-in` `cubic-bezier(.4,0,1,1)`

| # | Element | Trigger | Properties (transform, opacity) | Duration | Easing | Reduced-motion fallback |
|---|---|---|---|---|---|---|
| 1 | Terminal window | open from the dock | `scale(.94)→scale(1)`, `opacity 0→1`, transform-origin at the dock icon | 240 ms | `--pl-spring-calm` | appears instantly at full opacity |
| 2 | Terminal window | close (red light) | `scale(1)→scale(.96)`, `opacity 1→0` | 120 ms | `--pl-ease-in` | removed instantly |
| 3 | Terminal window | minimise | genie approximation: `translate()` toward the dock icon plus `scale(.2, .05)`, opacity 1→0.6 | 320 ms | `--pl-ease` | hidden instantly; the dock dot stays |
| 4 | Traffic-light glyphs | pointer enters the light group | glyph `opacity 0→1` | 120 ms | `--pl-ease-out` | glyphs shown on hover with no fade |
| 5 | New tab | `+` or Ctrl+Shift+T | `translateX(-8px)→0`, `opacity 0→1`; the other tabs shift with FLIP `translateX` | 200 ms | `--pl-spring` | tab appears in place |
| 6 | Tab close | × or Ctrl+Shift+W | `scale(1)→scale(.9)`, `opacity 1→0`; the other tabs shift with FLIP | 120 ms | `--pl-ease-in` | removed instantly |
| 7 | Planning line spinner `⠿` | agent BLOCKED on `net:llm` | braille glyph frames change every 80 ms; this is TTY text, bounded by the planning time and never longer than the 30 s gateway timeout | as long as planning lasts | linear steps | static `… planning` text with no frame changes |
| 8 | Plan block decoration (glass box behind the kernel text) | the kernel writes the Plan header | `opacity 0→1`, `translateY(6px)→0` | 200 ms | `--pl-spring-calm` | box appears instantly |
| 9 | Step badges (CREATE, READ, MOVE, CHMOD) | after the box, staggered 30 ms per row | `opacity 0→1`, `scale(.9)→scale(1)` | 120 ms each (total under 240 ms) | `--pl-spring` | all badges appear at once |
| 10 | Blast-radius chips | after the last badge | `opacity 0→1`, `translateY(4px)→0`, staggered 40 ms | 120 ms each | `--pl-spring-calm` | appear at once |
| 11 | Default `N` pill focus ring | `Proceed?` prompt is written | a ring pseudo-element `scale(1.25)→scale(1)`, `opacity 0→1`, **once** (attention pulse) | 320 ms | `--pl-spring` | static ring, no pulse |
| 12 | Kernel-confirmation strip over the title bar (DSN-16) | confirmation active | `translateY(-100%)→0`, `opacity 0→1`; exit reverses | 200 ms in, 120 ms out | `--pl-ease-out` in, `--pl-ease-in` out | shown and hidden instantly |
| 13 | Result line `✓` glyph decoration | commit acknowledged | check `scale(.6)→scale(1)`, `opacity 0→1` | 200 ms | `--pl-spring` | check shown instantly |
| 14 | Undo code chip `ai undo 8f2c` | hover or focus | tint layer (pseudo-element) `opacity 0→1` | 120 ms | `--pl-ease` | tint switches instantly |
| 15 | Undo chip | click (copies `ai undo 8f2c` to the prompt) | chip `scale(.96)→scale(1)`; a `Copied to prompt` tooltip `opacity 0→1`, `translateY(4px)→0` | 120 ms | `--pl-spring` | tooltip shown instantly, no scale |
| 16 | Autocomplete popover | open (typing `ai `) | `opacity 0→1`, `translateY(4px)→0`, `scale(.98)→scale(1)` | 120 ms | `--pl-spring-calm` | shown instantly |
| 17 | Autocomplete popover | goes stale (the command ran) | `opacity 1→0.5` | 200 ms | `--pl-ease` | opacity set to 0.5 instantly |
| 18 | Autocomplete highlight | ArrowUp or ArrowDown | a single highlight element moves by `translateY(row × 28px)` | 120 ms | `--pl-spring-calm` | highlight jumps |
| 19 | Autocomplete popover | Esc or Tab accept | `opacity→0`, `scale(.98)` | 120 ms | `--pl-ease-in` | removed instantly |
| 20 | `▸ show 12 files` disclosure | click or Enter | chevron `rotate(0)→rotate(90deg)`; the list rows `opacity 0→1`, `translateY(-4px)→0` (the box grows in one step, not by animating height) | 200 ms | `--pl-spring` | chevron and list switch instantly |
| 21 | Status-strip live dot | agent state changes (idle → running → waiting) | a halo pseudo-element `scale(1)→scale(2.2)`, `opacity .6→0`, **once per change** | 320 ms | `--pl-ease-out` | colour changes with no halo |
| 22 | Dock Terminal icon | app launch | `translateY(0)→(-14px)→0`, **one** bounce | 320 ms | `--pl-spring` | running dot appears; no bounce |
| 23 | Dock magnification | pointer moves along the dock | icon `scale(1→1.35)` from the pointer distance (rAF, no transition on the pointer axis) | follows the pointer; 200 ms settle on leave | `--pl-spring-calm` on leave | no magnification; the tooltip still shows |
| 24 | Menu bar menus | click a menu title | `opacity 0→1`, `translateY(-4px)→0` | 120 ms | `--pl-ease-out` | shown instantly |
| 25 | Cursor | idle at the prompt | xterm blink (the only looping animation) | xterm default | steps | `cursorBlink = false` (solid block) |

## Accessibility

- **Landmarks:** menu bar `<nav aria-label="Menu bar">` containing `role="menubar"`; dock `<nav aria-label="Dock">` with `role="toolbar"`; each window is a labelled region (not a dialog): `<section role="region" aria-label="Terminal — student@plotinium: ~">`; tab strip `role="tablist"` with `role="tab"` (`aria-selected`, `aria-controls`) and `role="tabpanel"` for the viewport; status strip `role="status"` (`aria-live="polite"`, announces only changes: `txn 8f2c committed`, `AI unavailable`).
- **Terminal:** xterm `screenReaderMode` from Settings → Accessibility; the kernel block is plain text in the buffer, so screen readers read `Plan · 4 steps · 1 transaction`, each step, the blast radius and `Proceed? y, N default, e edit`. Operation type is always in text (`mkdir`, `chmod`, …); colour is supplementary.
- **Confirmation:** answered only by kernel-owned TTY input; type-ahead is flushed; the default is N (DSN-15). The kernel-confirmation strip over the title bar reads `Kernel confirmation · ai.agent pid 212 · answer in this terminal` and is announced once through `role="status"`.
- **Autocomplete:** `role="combobox"` on the prompt input proxy with `aria-expanded`, `aria-controls` pointing to the `role="listbox"`, and `aria-activedescendant`. The stale popover is `aria-hidden="true"` and `inert`.
- **Traffic lights:** real `<button>` elements with `aria-label` (Close window, Minimise window, Zoom window); 24 px hit targets around the 12 px circles.
- **Contrast:** 92 % white on the terminal glass tint (`rgba(20,20,26,.86)` or more opaque behind text) meets 4.5:1; secondary text (70 %) measures at least 7.5:1 and tertiary text (56 %) at least 4.5:1 on the opaque tint (computed; 40 % failed at 3.8:1 and was raised). Only disabled items go below this (38 %), which WCAG exempts.
- **Keyboard:** Ctrl+Shift+T new tab, Ctrl+Shift+W close tab, Ctrl+Tab next tab, Tab accept suggestion, Esc dismiss, Ctrl+C interrupt (also cancels a pending plan; nothing runs).

## Issues and open points

### Visual review of `reference.png`

- **Layout.** The desktop reads as macOS-grade: glass menu bar, a centred dark-glass window with traffic lights on the left, a tab strip, the plan block as a violet-edged glass card, a stale suggestions popover at 50 % opacity on the right, a status strip, and a floating dock with its running dot.
- **Names and branding.** It uses only Plotinium names (Terminal, Files, Editor, Task Manager, Settings, Search, Control Centre) and the atom mark in #5E5CE6. It has no Apple logo, no SF Symbols (all icons are lucide-style SVG) and no SF Pro (it uses Inter and JetBrains Mono).
- **Content.** Every element in the prompt is present: the plan header, 4 steps with CREATE, READ, MOVE and CHMOD badges, the `show 12 files` disclosure, the blast-radius chips, `Proceed? [y/N/e=edit]` with N as a filled pill with a focus ring, the green commit line with the `ai undo 8f2c` chip, a fresh prompt with a violet block cursor, the 4-row suggestions popover with its Tab/Esc hint, and the status strip `ai.agent pid 212 · Claude via gateway`.
- **Contrast** (computed): primary text is 92 % white. Secondary text (70 %) is at least 7.5:1, and tertiary text (56 %) is at least 4.5:1 on the terminal tint. Success `#5BE07F` is 11:1 on the terminal background, and white on `#5E5CE6` is 5.06:1.
- **Fixes made during review:** the tertiary text was raised from 40 % to 56 % because 40 % measured 3.8:1; the N pill's attention ring is now a one-shot pulse (it was drawing a double ring); the cursor is captured in its visible phase (`?capture` switches the blink off only for the screenshot).

### Issues and open points

1. **No Stitch screen.** Generation timed out and `list_screens` stayed `{}` for about 25 minutes (17 polls). Every sibling agent saw the same. When Stitch recovers, generate once with the prompt above and compare the result with `reference.png`.
2. **Accent conflict to resolve in the tokens file.** `ui-design-system.md` §3.3 defines `--pl-accent` as orbit blue (`#3452d6` light, `#8aa2ff` dark), but the user's design direction and the Stitch design systems use violet `#5E5CE6`. PLT-ID-06 and DSN-02 need one value; this reference uses violet, with `#A9A8FF` as the text-on-dark variant.
3. **The rich plan block versus kernel-written ANSI.** The spec has the kernel write the plan block as plain TTY text. The badges, the glass card and the chips must therefore be xterm decorations drawn by trusted `term` code, only for lines the kernel tagged (for example an OSC marker that only the kernel TTY writer can emit), never by the agent process. The text stays the source of truth for screen readers and for copying.
4. **Motion tokens.** The design system's window-open time (240 ms) and the springs (`--pl-spring`, `--pl-spring-calm` as `linear()`) are not in the spec's token list (`--pl-motion-fast/med/slow`, three cubic-beziers). Add `--pl-motion-open: 240ms` and the two spring tokens, all zeroed under reduced motion.
5. **The braille spinner** `⠿` during planning is a repeating animation, and the spec allows only the cursor blink (WCAG 2.2.2). It is kept here as TTY text that lasts only as long as planning (at most the 30 s gateway timeout) and becomes static text under reduced motion. It needs sign-off, or a switch to static `… planning`.
6. **Transaction id length.** `agentic-shell.md` shows 8-hex ids (`0192f0c1`), while `ui-design-system.md` §3.8.15 uses `8f2c`. This screen keeps `8f2c` as instructed; the spec should settle on one short-id length.
7. **The prompt's `read-write` pill** was relabelled `dry run · read-write`, to make clear that nothing had run when the plan was shown.
