# Agent confirmation sheet (`agent-confirm-sheet`)

| Field | Value |
|---|---|
| Stitch project | `12849137298552292712` (Plotinium OS) |
| Stitch screen id | none: Stitch timed out and returned no screen (see `screen.json`) |
| Design system | DARK · `assets/10121591451242352758` (Plotinium Glass, Dark) |
| Model | GEMINI_3_8_FLASH · DESKTOP 1440×900 |
| Files | `screen.json` (Stitch timeout record, with the exact request); `reference.html` + `reference.png` (hand-built render of the same prompt, **NOT a Stitch export**; the PNG is a 1440×900 headless-Chrome capture of `reference.html?capture`). There is no `screen.html` or `screenshot.png` because Stitch returned no screen. |
| Spec anchors | `specs/10-ai/agentic-shell.md` §3.12 (dry run, blast radius, trash), §3.13 (kernel predicate, kernel-owned TTY, HMAC token), §3.17 (`ai log`) · `specs/05-wm/ui-design-system.md` §3.7 Dialog, §3.8.9 (DSN-16), §3.8.15 |
| Requirement IDs | AGT-03, AGT-04, AGT-08, AGT-10, DSN-15, DSN-16 |

## What the screen shows

`ai.agent` has built a plan for `ai "clean up my old build folders and lock down the lab3 notes"`. The kernel predicate says confirmation is required, so a glass **sheet** slides down from under the Terminal's tab strip. It shows the plan with operation badges, the blast radius, who the plan runs as, and why confirmation is needed. **Cancel** is the default and has the focus ring. **Run plan** is tinted as a danger action and is never the default (DSN-15). The Terminal content behind the sheet is dimmed.

## Final prompt

Sent once to `generate_screen_from_text` (DESKTOP, DARK design system, GEMINI_3_8_FLASH). It was not retried after the timeout.

```text
Plotinium Agent Confirm Sheet (screen title: "Plotinium Agent Confirm Sheet"). A desktop scene of Plotinium, a web-based OS whose look is inspired by the latest Liquid Glass-era desktop design, with its own identity. Do NOT use any Apple logo, Apple app names, SF Symbols or SF Pro. Use lucide-style line icons, Inter for UI text and JetBrains Mono for paths and commands.

BACKGROUND: deep violet-to-indigo blurred abstract wallpaper. Top: thin translucent glass menu bar with the Plotinium logo on the left (an abstract luminous atom: bright violet #5E5CE6 nucleus with 2-3 thin elliptical orbits; no radiation or hazard symbols), bold "Terminal", menus "Shell  Edit  View  Window  Help"; right side wifi, battery, Control Centre icon, Search magnifier, clock "Thu 24 Sep  10:47". Bottom: floating glass dock with Plotinium app icons (Files, Terminal active with dot, Editor, Task Manager, Settings).

MAIN WINDOW: a dark glass Terminal window (about 1100x700, 14px radius, big soft shadow) with traffic lights (red, amber, green) and centered title "student — ~ — 120×36", one tab "zsh-like shell — 1" and "+". The terminal content behind is dimmed (a dark scrim at 45%) and shows the last command: student@plotinium:~$ ai "clean up my old build folders and lock down the lab3 notes"  and dim text "⠿ planning with ai.agent…".

THE SHEET: attached to the bottom edge of the window's title bar/tab strip, sliding down from it (a desktop sheet style), centered horizontally, about 640px wide, slightly lighter frosted dark glass with a 1px bright inner top highlight, rounded bottom corners 16px, large soft shadow. It is a modal alertdialog.
Sheet contents from top to bottom:
1. Header: an amber warning triangle icon in a soft amber circle, title "Confirm destructive plan" (17px semibold, white), subtitle "ai.agent wants to run 5 steps in one transaction" (dim).
2. A compact PLAN TABLE with columns "#", "Operation", "Path", "Effect". Rows, each with a colored operation badge (small rounded pill, tinted background, bold uppercase 11px):
   1  DELETE (red #FF453A)   ~/projects/lab2/build/          → remove 1 dir, 9 files
   2  DELETE (red)            ~/projects/lab3/build/          → remove 1 dir, 7 files
   3  DELETE (red)            ~/projects/os-sim/.cache/        → remove 1 dir, 3 files
   4  MOVE (violet #5E5CE6)   ~/notes/lab3-vfs.md → ~/notes/archive/   → modify 1 entry
   5  CHMOD (amber #FF9F0A)   ~/notes/archive/  (go-rwx)       → modify 3 inodes
   Paths in monospace. Zebra rows very subtle.
3. A "Blast radius" summary card with three big counter tiles side by side: "23 inodes" (neutral white), "3 deletions" (red tinted), "0 overwrites" (green tinted), each with a tiny label under the number. A small right-aligned chip "within quota · 1.2 GB free".
4. A note line with a user icon: "Runs as student (uid 1001) · one transaction · undo token issued".
5. An EXPANDED disclosure section "▾ Why this needs confirmation" with two bullet reasons, each with a small icon: "Deletes files (3 directories, 19 files)" with a trash icon, and "Touches more than 20 inodes (23 > threshold 20)" with a layers icon. A tiny dim line: "Policy: agent.confirm.destructive = always".
6. Button row, right-aligned, 32px tall rounded buttons: a secondary glass button "Edit plan" with a pencil icon on the far left side of the row; then on the right "Cancel" which is the DEFAULT button: filled violet #5E5CE6 with white text and a clearly visible 3px violet focus ring (outer glow), and next to it a danger-tinted button "Run plan" with red text on a subtle red-tinted glass fill and red outline. Show keyboard hints in small dim keycaps under/next to buttons: "Esc" under Cancel is not needed; show "↵ Cancel" hint and "⌘/Ctrl+Enter Run plan" as tiny text.
7. Footer strip inside the sheet, separated by a hairline: left a small shield/scroll icon and "Audited in ai log" (dim), right "txn pending · ai.agent pid 212 · Claude via gateway".

Style: Liquid Glass translucency with vibrancy, crisp 1px hairlines at 10% white, text white at 92% for primary and 60% for secondary for strong contrast, generous 16-20px padding, visible focus ring on Cancel to show it is keyboard-first. Pixel-perfect, premium, calm.
```

**Where `reference.html` differs from the prompt, and why:**
- **The counts were made consistent.** Deletes remove 1 dir + 9 files, 1 dir + 6 files and 1 dir + 1 file (19 inodes). The move touches 1 inode. `chmod -R go-rwx ~/notes/archive/` touches 4 inodes, one of which is the moved file. That gives **23 distinct inodes**, `3 deletions` (three delete operations) and `0 overwrites`. The reason line reads `Deletes files (3 directories, 16 files)`.
- **A third reason, `Changes permissions on ~/notes/archive/ (CHMOD)`,** was added. `needsConfirmation()` in `agentic-shell.md` §3.13 flags CHMOD as well, so listing only two reasons would misstate the kernel's decision. Each reason shows its kernel reason code (`DELETE`, `BLAST_RADIUS`, `CHMOD`).
- **DELETE rows say `to trash`, and the deletions tile says `recoverable`.** Agent deletes are moved to `~/.trash/<txn>/` (§3.12).
- **An accent security band** `Kernel confirmation · ai.agent pid 212` (mark, lock) tops the sheet, and a `Kernel confirmation` chip appears in the menu bar (DSN-16).
- **The Run-plan shortcut is written `Ctrl+↵` only.** The `⌘` in the prompt was dropped because Plotinium runs in Chrome on any platform.
- **The window title is `student@plotinium: ~ — 120×36`**, following the spec's title format.

## UI elements and their states

| Element | Default | Hover | Focus | Active / pressed | Disabled | Empty | Loading | Error |
|---|---|---|---|---|---|---|---|---|
| Window scrim (over the Terminal content only, not the title bar) | `rgba(0,0,0,.45)` | n/a | n/a | clicking it nudges the sheet (the sheet stays open) | n/a | n/a | n/a | n/a |
| Sheet container (`role="alertdialog"`, 688 px, hangs from the tab strip) | frosted dark glass, 1 px inner top highlight, 18 px bottom radius, dialog shadow | n/a | focus is trapped inside while open | n/a | n/a | n/a | while the dry run finishes, the table shows 5 skeleton rows and **Run plan** is disabled | dry run fails: the sheet body is replaced by `✗ Plan rejected: EACCES /system/bin — nothing ran` with only **Close** |
| Security band (DSN-16: mark, lock, `Kernel confirmation · ai.agent pid 212`) | accent band on `--pl-z-secure` above the sheet | n/a | n/a | n/a | n/a | n/a | n/a | n/a |
| Warning icon (amber triangle in an amber circle) | `aria-hidden="true"` | n/a | n/a | n/a | n/a | n/a | n/a | n/a |
| Title `Confirm destructive plan` + subtitle `ai.agent wants to run 5 steps in one transaction` | 17 px semibold, 92 %; subtitle 70 % | n/a | n/a | n/a | n/a | n/a | n/a | n/a |
| Plan table (`#`, Operation, Path, Effect) | zebra at 3 % white, mono paths, effect at 70 % | row tint 6 % and the full path shows in a tooltip if truncated | row focusable with arrow keys (grid); ring on the row | n/a | n/a | n/a | skeleton rows with a shimmer that is **not** looping: one sweep, then static | an UNGROUNDED step shows `⚠ not in your request` and a SUSPICIOUS step shows `⚠ from file content` in warning text |
| Operation badges DELETE (red `#FF453A`), MOVE (violet `#5E5CE6`), CHMOD (amber `#FF9F0A`) | tinted pill, bold 11 px caps; the word is always in text | n/a | n/a | n/a | n/a | n/a | n/a | n/a |
| Recoverable note on DELETE rows | `· to trash` in 56 %, plus the policy line `deleted items go to ~/.trash/8f2c/` (agent deletes go to trash, §3.12) | n/a | n/a | n/a | n/a | n/a | n/a | n/a |
| Blast radius tiles: `23 inodes`, `3 deletions`, `0 overwrites` | neutral, red-tinted, green-tinted; numbers tabular | n/a | n/a | n/a | n/a | n/a | tiles show `—` | `over quota by 38 MB` replaces the quota chip in danger and **Run plan** is disabled (EDQUOT) |
| Quota chip `within quota · 1.2 GB free` | success tint with a check | n/a | n/a | n/a | n/a | n/a | n/a | see above |
| Identity line `Runs as student (uid 1001) · one transaction · undo token issued` | 70 % with a user icon | n/a | n/a | n/a | n/a | n/a | n/a | with elevation: `Runs as root for this plan only · secure prompt required` in warning |
| Disclosure `Why this needs confirmation` | collapsed by default in production; shown expanded in this mock | underline | ring | expanded: reasons `Deletes files (3 directories, 16 files)` (DELETE), `Touches more than 20 inodes (23 > threshold 20)` (BLAST_RADIUS) and `Changes permissions on ~/notes/archive/` (CHMOD); policy line `agent.confirm.destructive = always` | n/a | n/a | n/a | n/a |
| **Edit plan** (secondary, pencil icon, far left) | glass button, 1 px border | tint | ring | pressed `scale(.97)` | disabled while loading | n/a | n/a | n/a |
| **Cancel** (default) | filled accent, white text, visible focus ring | `--pl-accent-hover` `#7472FF` | 3 px accent ring at 55 %, offset 2 px (initial focus) | pressed `scale(.97)` | never disabled | n/a | n/a | n/a |
| **Run plan** (danger) | danger text and 1 px danger border on a subtle red glass tint | red tint layer rises | ring | pressed `scale(.97)`; then a spinner replaces the label while `batch` runs | disabled while loading, on over-quota, or after the 120 s timeout | n/a | `Running… 3 of 5` in the button, then the sheet closes | `batch` rejects: the sheet shows `✗ rejected: EAGAIN changed-since — nothing ran` and **Close** |
| Keyboard hints (`↵ Cancel`, `Ctrl+↵ Run plan`, `E Edit plan`, `Esc Cancel`) | keycaps at 70 % | n/a | n/a | n/a | n/a | n/a | n/a | n/a |
| Footer `Audited in ai log` (link) and `txn pending · ai.agent pid 212 · Claude via gateway` | link in accent text `#A9A8FF`; meta in 56 % | underline | ring; Enter runs `ai log` in a new tab | n/a | n/a | n/a | n/a | n/a |

## Intended animations

Rules from `ui-design-system.md` §3.6: only `transform` and `opacity` animate. Nothing loops. Every duration is a motion token, and all tokens become 0 ms under `prefers-reduced-motion: reduce` or `:root[data-motion="reduce"]` (DSN-05).

Easing tokens (the same as in `terminal-ai/notes.md`):
- `--pl-spring`: `linear(0, 0.048 3%, 0.163 6%, 0.360 10%, 0.557 14%, 0.725 18%, 0.878 23%, 0.973 28%, 1.026 34%, 1.038 42%, 1.021 52%, 1.004 64%, 0.999 80%, 1)`
- `--pl-spring-calm`: `linear(0, 0.035 3%, 0.118 6%, 0.265 10%, 0.420 14%, 0.562 18%, 0.709 23%, 0.819 28%, 0.907 34%, 0.971 42%, 1.001 52%, 1.006 64%, 1.003 80%, 1)`
- `--pl-ease` `cubic-bezier(.2,.8,.2,1)`; `--pl-ease-out` `cubic-bezier(0,0,.2,1)`; `--pl-ease-in` `cubic-bezier(.4,0,1,1)`

| # | Element | Trigger | Properties (transform, opacity) | Duration | Easing | Reduced-motion fallback |
|---|---|---|---|---|---|---|
| 1 | Window scrim | `ai.agent.confirm` opens the sheet | `opacity 0→1` | 200 ms | `--pl-ease-out` | scrim shown instantly |
| 2 | Sheet | open | `translateY(-100%)→0` inside a clip container anchored under the tab strip (it slides out from behind the title bar), `opacity .6→1` | 320 ms | `--pl-spring-calm` | sheet shown instantly at full opacity |
| 3 | Security band (DSN-16) | with the sheet | `translateY(-100%)→0`, `opacity 0→1` | 200 ms | `--pl-ease-out` | shown instantly |
| 4 | Warning icon | 80 ms after the sheet lands | `scale(.8)→scale(1)`, `opacity 0→1`, once | 240 ms | `--pl-spring` | shown instantly |
| 5 | Plan table rows | after the sheet lands, staggered 30 ms per row | `opacity 0→1`, `translateY(4px)→0` | 120 ms each (under 300 ms total) | `--pl-spring-calm` | rows shown at once |
| 6 | Operation badges | with their row | `scale(.9)→scale(1)`, `opacity 0→1` | 120 ms | `--pl-spring` | shown at once |
| 7 | Blast radius tiles | after the table, staggered 40 ms | `scale(.96)→scale(1)`, `opacity 0→1` (numbers never roll or count up, so screen readers read them once) | 200 ms | `--pl-spring` | shown at once |
| 8 | Cancel focus ring | initial focus | ring pseudo-element `scale(1.2)→scale(1)`, `opacity 0→1`, **once** | 320 ms | `--pl-spring` | static ring |
| 9 | Focus ring | Tab or Shift+Tab between buttons | the ring stays on each button; the new ring fades `opacity 0→1` | 120 ms | `--pl-ease-out` | ring moves instantly |
| 10 | Disclosure chevron | toggle | `rotate(0)→rotate(90deg)` | 200 ms | `--pl-spring` | chevron switches instantly |
| 11 | Disclosure content | expand | reasons `opacity 0→1`, `translateY(-4px)→0`, staggered 30 ms; the sheet grows in one step and the button row follows with a FLIP `translateY` | 200 ms | `--pl-spring-calm` | content and buttons move instantly |
| 12 | Buttons | hover | tint pseudo-element `opacity 0→1` (Run plan: red tint layer) | 120 ms | `--pl-ease` | tint switches instantly |
| 13 | Buttons | press | `scale(1)→scale(.97)→scale(1)` | 120 ms | `--pl-spring` | no scale; the pressed tint still shows |
| 14 | Sheet | click on the scrim or the dimmed Terminal (the sheet must be answered) | nudge `translateX(0→6px→-4px→2px→0)` | 240 ms | `--pl-spring` | no nudge; a `role="status"` line `Answer the confirmation first` appears for 3 s |
| 15 | Loading skeleton | dry run still finishing | one highlight sweep `translateX(-100%)→translateX(100%)` on a gradient layer, **one pass**, then static | 600 ms | linear | static skeleton |
| 16 | Run plan progress | after Run plan | label cross-fade `opacity`; a progress bar driven by `transform: scaleX(steps done / 5)` | 120 ms per step | `--pl-ease` | label and bar update without transitions |
| 17 | Sheet | Cancel, Esc or a successful run | `translateY(0)→(-100%)`, `opacity 1→.6`; scrim `opacity 1→0` | 200 ms | `--pl-ease-in` | removed instantly |
| 18 | Terminal result line | after the sheet closes | the `✓ committed …` or `✗ declined — nothing ran` line decoration `opacity 0→1`; the check `scale(.6)→1` | 200 ms | `--pl-spring` | shown instantly |
| 19 | Edit plan hand-off | Edit plan | the sheet retracts (row 17), then the Editor window opens with `scale(.94)→1`, `opacity 0→1` from the button's position | 200 ms + 240 ms | `--pl-ease-in`, then `--pl-spring-calm` | Editor appears instantly |

## Accessibility

- **Role and names:** the sheet is `role="alertdialog"` with `aria-modal="true"`, `aria-labelledby` set to the title `Confirm destructive plan`, and `aria-describedby` pointing to the subtitle and the blast-radius summary, so a screen reader hears `Confirm destructive plan. ai.agent wants to run 5 steps in one transaction. 23 inodes, 3 deletions, 0 overwrites.`
- **Landmarks inside the window:** the Terminal window region `aria-label="Terminal — student — ~"` becomes `inert` while the sheet is open (the menu bar and dock stay usable, because the sheet is window-modal, not app-modal).
- **Table:** a real `<table>` with `<caption class="sr-only">Plan steps</caption>`, `<th scope="col">`; each badge is text (`DELETE`, `MOVE`, `CHMOD`) styled by colour, so colour is never the only signal.
- **Disclosure:** a `<button aria-expanded aria-controls>`; the reasons are a `<ul>`.
- **Buttons and keys:** focus starts on **Cancel** (safe default, DSN-15). Enter activates the focused button; Esc = Cancel; Ctrl+Enter = Run plan (never plain Enter); E = Edit plan when focus is not in a text field. Tab order: disclosure → Edit plan → Cancel → Run plan → Audited in ai log. Focus is trapped while open and returns to the Terminal prompt on close.
- **Live output:** after closing, a `role="status"` region announces `Plan cancelled, nothing ran` or `Committed, transaction 8f2c, undo with ai undo 8f2c`.
- **Timeout:** the kernel treats no answer within 120 s as N. At 100 s a static line `This request will be cancelled in 20 seconds — nothing will run` appears (announced politely), and the user can re-run the command (WCAG 2.2.1 note: re-running is the extension path).
- **Contrast:** all text sits on a tint of at least `rgba(28,28,34,.86)`; danger text `#FF453A` on the red-tinted fill must be checked against the final tint (use `--pl-danger` `#ffb4ab` in dark if `#FF453A` falls under 4.5:1).
- **Forced colours:** badges and buttons get 1 px `CanvasText` borders; the focus ring uses `Highlight`.

## Issues and open points

### Visual review of `reference.png`

- **Layout.** A macOS-style sheet (688 px, bottom corners 18 px) hangs from under the tab strip over a 45 % scrim that dims only the Terminal content. The title bar and the tab strip, with its amber `waiting` state, stay readable. The glass is layered, the shadow large and soft, and the menu bar and dock are the same as on `terminal-ai`.
- **Content.** Every element in the prompt is present: the amber warning icon, the title and subtitle, the 5-row plan table with DELETE (red), MOVE (violet) and CHMOD (amber) badges and mono paths, three blast-radius tiles (23 inodes, 3 deletions, 0 overwrites), the quota chip, `Runs as student (uid 1001) · one transaction · undo token issued`, the expanded `Why this needs confirmation` section with its policy line, `Edit plan` (secondary, far left), **Cancel** as the default (filled violet with a clear focus ring), a danger-tinted `Run plan`, keycap hints, and the footer `Audited in ai log`.
- **Branding.** It uses only Plotinium names and the atom mark, with lucide-style icons and no Apple marks.
- **Contrast** (computed): danger text `#FF6B61` on the Run plan tint is 4.6:1, and on the sheet about 5:1 (plain `#FF453A` would be 4.17:1, so it is not used for text). White on the violet Cancel is 5.06:1. Tertiary text was raised to 56 % white (≥ 4.5:1) after 40 % measured 3.57:1. Badge text on its tints is 6.1:1 or better.
- **Fixes made during review:** tertiary text contrast; the Cancel attention ring is now a one-shot pulse that fades out (it was drawing a double ring).

### Issues and open points

1. **No Stitch screen.** Generation timed out and `list_screens` stayed `{}` for about 25 minutes (17 polls). When Stitch recovers, generate once with the prompt above and compare the result with `reference.png`.
2. **Blocking spec conflict: the sheet is a second way to answer.** `ui-design-system.md` §3.8.15 and C12 say the confirmation is written into the Terminal by the kernel and answered **only** from kernel-owned TTY input, with the compositor's kernel-confirmation strip as the only chrome. A clickable sheet is allowed only if all of the following hold. (a) The compositor renders it on `--pl-z-secure`, like the `su` secure prompt, never in the Terminal app's DOM. (b) Its buttons call the kernel's confirm path directly, and the agent process can neither draw nor click it. (c) The TTY prompt stays active in parallel, and the first answer wins. (d) The same HMAC-token rules apply. This needs a decision record (`specs/15-decisions/`) and a spec update before it is built; until then, treat the sheet as a design exploration for the P4 gate.
3. **The meaning of `3 deletions`.** The prompt counts delete operations (3), but a dry run might count deleted inodes (19). `DryRun` in `agentic-shell.md` §3.12 should say which, and the tile label should follow.
4. **Accent conflict** (the same as in `terminal-ai`): the spec's `--pl-accent` is orbit blue, while the design direction uses violet `#5E5CE6`.
5. **Height.** The sheet is about 640 px tall. In smaller windows the plan table must scroll inside the sheet (`max-height: calc(window height - 96px)`), and the button row must stay pinned.
6. **Timeout.** The kernel treats no answer within 120 s as N. The sheet shows no countdown, only a static warning at 100 s (secure-prompt rule). After a timeout, the Terminal prints `✗ confirmation timed out — nothing ran`.
