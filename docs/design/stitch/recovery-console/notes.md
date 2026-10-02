# Recovery console (dark)

- **Stitch project:** 12849137298552292712
- **Stitch screen id:** **Not returned.** `generate_screen_from_text` timed out on the client, as the tool warns it may. Following the rules, it was not retried. `list_screens` was then polled about 20 times over roughly 20 minutes (20:22–20:43 PKT). It returned `{}` every time, and the project's `updateTime` stayed at 15:22:02Z. Every sibling agent saw the same empty list. So there was no screen id to pass to `get_screen`, and no Stitch `screen.html` or `screenshot.png` exists for this slug. If the generation lands later, match it by the title or prompt below, run `get_screen`, and save the files as `screen.html` and `screenshot.png` next to this note.
- **Design system:** Plotinium Glass (Dark), `assets/10121591451242352758`
- **Model:** GEMINI_3_8_FLASH, device DESKTOP (1440 × 900)
- **Files:** `reference.html` and `reference.png` (hand-built stand-ins, see below); `screen.html` and `screenshot.png` go here once Stitch returns the screen
- **Spec sources:** `specs/02-boot/boot-and-services.md` §3.6 (BOOT-08 recovery screen), §3.8 (SVC-06 recovery console), BOOT-06, BOOT-13; `specs/05-wm/ui-design-system.md` §3.6 motion, §3.7 components, DSN-05, DSN-07.

## What this screen is

The console that opens when the machine boots with `?boot=recovery` (from the boot menu, from `[R]` on the BOOT-08 recovery screen or from `reboot --recovery`). Only `kernel, sched, storage, wm, vfs` run, and `vfs` is mounted read-only. No user is logged in, so the console acts on the local mirror only. Actions are router→kernel `recovery.*` messages, not syscalls. The screen is rendered by the framework-free boot-ui, so it must work when the Solid desktop chunk is the part that failed.


## Stand-in until Stitch delivers

- `reference.html`: a hand-built reference render, **not a Stitch export**. It says so in an HTML comment. It follows the Plotinium Glass (Dark) design-system tokens (colour roles, radii, glass blur, Inter + JetBrains Mono, lucide-style icons, traffic lights) and implements the entrance animations listed below with `prefers-reduced-motion` support.
- `reference.png`: that page rendered by headless Chromium at 1440 × 900, 1.8 s after load, once the animations have settled. I reviewed it visually: the Plotinium names and atom logo are correct, it has no Apple marks, and the text contrast is readable.
- Where the reference differs from the prompt on purpose: the sidebar is 292 px, not 260, so the consequence lines are not truncated. The fifth row reads "Blob refcounts & structure", matching the VFS §5.9 passes. Cycles reads "tree verified · depth 9" rather than "DAG verified". The running pass shows a **determinate** ring instead of a spinner, because ui-design-system §3.6 forbids looping animation and DSN-07 forbids indeterminate progress.

## Final prompt (sent to Stitch, GEMINI_3_8_FLASH, DESKTOP, dark design system)

```text
Plotinium Recovery Console — a full-screen desktop utility (1440x900) for "Plotinium", an AI-native web operating system. Visual language: the latest macOS "Liquid Glass" era recovery utility, dark mode. Deep near-black backdrop with a very soft blurred violet (#5E5CE6) glow behind a single large rounded (28px radius) translucent frosted-glass window with a thin 1px inner highlight border and a huge soft shadow. Typography: Inter / system sans; monospace is JetBrains Mono. Icons: thin lucide-style line icons only. NO Apple logo, NO Apple app names, NO SF Symbols.

TOP BAR (thin glass strip across the whole screen, 28px tall): left side a tiny luminous atom logo (bright violet nucleus with 2 thin elliptical orbits) + "Plotinium Recovery Console · 0.3.0 (a1f93c2)"; centre a pill badge in amber "Recovery mode — read-only file system" with a small lock icon; right side "Offline · storage 412 MB used" and a clock "14:32".

WINDOW: traffic-light controls at top left (red, amber, green dots, the green one dimmed/disabled). Window title "Recovery".

LEFT SIDEBAR (vibrancy glass, 260px): section header "ACTIONS". A vertical list of actions, each row with a line icon, a label, a one-line grey consequence underneath, and a keyboard shortcut chip on the right:
1. stethoscope/scan icon — "File-system check (fsck)" — "Check the local tree read-only" — key "F" — this row is SELECTED (violet tinted glass pill with focus ring)
2. trash icon — "Clear local cache" — "Outbox exported first, then re-sync" — key "C"
3. rotate-ccw icon — "Reset session" — "Start a clean desktop next boot" — key "S"
4. file-cog icon — "Restore default service manifests" — "Rewrites /system/services/*.json" — key "M"
5. activity icon — "Diagnostics" — "Download boot record + capability matrix" — key "D"
6. power icon — "Reboot" — "Normal (N) or Safe mode (B)" — key "N"
Sidebar footer: small grey text "Services running: kernel · sched · storage · wm · vfs (read-only)" and "Boot 0x7c2e · recovery".

MAIN AREA: Header "File-system check" with a subtitle "fsck / — local mirror · 12,408 inodes · started 14:31:52". A segmented control "Check | Check & repair (Y)" with "Check" active.
A checklist card (glass) with rows, each with an animated circular check mark icon in green, a label and a right-aligned detail:
- ✓ "Every inode reachable from /" — "12,408 / 12,408"
- ✓ "Link counts correct" — "0 mismatches"
- ✓ "No directory cycles" — "DAG verified"
- a spinning violet progress ring — "Quota totals consistent" — "running… student, alice, bob"
- a dim grey pending circle — "Checksums verified (blob store)" — "pending"
A progress bar (thin, rounded, violet gradient fill at 78%) with caption "Stage 4 of 5 · 78% · about 3 s left".
Below, a monospace RESULT PANE (darker inset glass, rounded 14px) showing lines:
"[ 0.012] fsck: pass 1 reachability  12408 inodes ok"
"[ 0.041] fsck: pass 2 link counts   ok"
"[ 0.066] fsck: pass 3 cycles        ok"
"[ 0.090] fsck: pass 4 quota         /home/student 212 MB · /home/alice 96 MB · /home/bob 41 MB"
and a highlighted summary line in green: "0 orphans · 0 dangling links · repaired 0".
Bottom right of the main area: a secondary glass button "Copy report", a secondary button "Boot log (L)", and a primary violet button "Reboot to desktop" (disabled while running, shown slightly dimmed).

Overall: calm, premium, lots of breathing room, soft glows, high readable contrast (white text on dark glass), macOS Recovery aesthetic but with Plotinium's own identity.
```

## Layout

1. **Top bar** (28 px glass strip, `role="banner"`): atom logo + `Plotinium Recovery Console · 0.3.0 (a1f93c2)`; centred amber status pill `Recovery mode — read-only file system` with a lock icon; right side `Offline · storage 412 MB used` and the clock.
2. **Window** (one glass window, radius 12–28 px, focused shadow `0 22px 70px rgb(0 0 0 / .55)`): traffic lights on the left. Close and minimise are inert here (there is no desktop to return to), so they render in the unfocused grey and carry `aria-disabled="true"`; the maximise/zoom control is disabled too.
3. **Sidebar** (vibrancy, 260–292 px; the reference uses 292, `role="navigation"` labelled "Recovery actions"): header `ACTIONS`, six action rows, footer with the running-service set and the boot id.
4. **Main pane** (`role="main"`): header `File-system check`, subtitle with inode count and start time, `Check | Check & repair (Y)` segmented control, the pass checklist, the progress bar, the monospace result pane and the footer buttons.

## Elements and states

### Top bar
| Element | States |
|---|---|
| Logo + product line | static; logo is decorative (`aria-hidden`), text is the accessible name of the banner |
| Status pill "Recovery mode — read-only file system" | static amber (`--warning` #FF9F0A on a 14 % tint); after a repair run completes it gains a second line "local repairs are not synced until next login" |
| Network/storage text | Online / Offline; storage figure updates after "Clear local cache" |
| Clock | updates each minute; `aria-hidden` (not useful to announce) |

### Sidebar action rows
Rows: File-system check (fsck) `F` · Clear local cache (outbox exported first) `C` · Reset session `S` · Restore default service manifests `M` · Diagnostics `D` · Reboot `N` / `B` (safe). A seventh row "Boot log `L`" is reachable from the footer button and the `L` key.

| State | Look |
|---|---|
| Default | transparent row, 60 % secondary line, key chip in 38 % label |
| Hover | `rgb(255 255 255 / .06)` fill, chip brightens to 60 % |
| Focus (keyboard) | 3 px accent ring at 55 % inside the row radius; roving tabindex, one tab stop for the whole list |
| Selected / active | accent tinted glass pill (`#5E5CE6` at 85 %), white text, chip inverted |
| Running | row shows a small determinate ring at the right in place of the chip; `aria-busy="true"` on the main pane |
| Disabled | while an action runs, every *other* destructive row (Clear cache, Reset session, Restore manifests, Reboot) is `aria-disabled="true"` at 38 % label; Diagnostics stays enabled |
| Confirm | Clear cache, Reset session and Restore manifests open an inline confirm sheet (`role="alertdialog"`) that names the consequence and defaults focus to **Cancel** (danger action never the default) |
| Error | if the kernel rejects a `recovery.*` message, the row gets a red dot and the main pane shows an error banner (`role="alert"`) with the reason and a Retry button |

### Main pane: fsck
| Element | States |
|---|---|
| Header + subtitle `fsck / — local mirror · 12,408 inodes · started 14:31:52` | idle subtitle reads "Not run yet this boot" |
| Segmented control `Check` / `Check & repair (Y)` | Check selected by default; Repair selected shows an amber note "Repairs are local-only; the next online login re-converges from the server"; disabled while a run is in progress |
| Checklist rows (the four VFS-11 invariants the spec names, plus a blob/structure row; `specs/04-vfs/virtual-file-system.md` §3.21 and §5.9 run 5 chunked passes: inodes → dentries → reachability → counts (nlink I4, quota I6, refcount I7) → structure (I9–I12), so the UI rows map to invariant groups, not 1:1 to passes) | **pending** (grey hollow circle, 38 % label) → **running** (violet determinate ring filling with that pass's progress, label 92 %) → **passed** (green check, detail on the right) → **failed** (red x, detail such as `2 orphans`, row expandable to list inode ids) → **repaired** (amber wrench, `repaired 2`) |
| Progress bar (6 px in-window variant, violet fill) | idle 0 %, running with the true value, complete 100 % turns green for 600 ms then settles back to accent; never indeterminate (DSN-07) |
| Caption `Stage 4 of 5 · 78% · about 3 s left` | updates per pass; "about" estimate hidden until two passes have completed |
| Result pane (monospace, `role="log"`, `aria-live="polite"`) | empty state: "Run a check to see its report here."; loading: lines append as each pass reports; success summary line green `0 orphans · 0 dangling links · repaired 0`; error summary red with counts; scrollable with the last line kept in view |
| Buttons: `Copy report` (secondary), `Boot log (L)` (secondary), `Reboot to desktop` (primary) | default / hover (primary goes to #7472FF) / focus ring / active (pressed scale .97) / disabled while a run is in progress (38 %, `aria-disabled`) / copy success swaps the label to "Copied" with a check for 1.5 s |

### Other action panes (same main-pane frame)
- **Clear local cache:** step list `Export outbox → Delete plotinium-fs → Delete plotinium-swap → Reboot`, each with the same pending/running/done states; the export step shows the saved file name `outbox-2026-09-24T14-33.json`.
- **Reset session:** preview of what moves: `os_session 7f3a… → 7f3a….recovery-0x7c2e`.
- **Restore default manifests:** a diff list of `/system/services/*.json` (18 built-in, extra files marked for deletion).
- **Diagnostics:** capability matrix table + "Download JSON".
- **Reboot:** two large choices `Normal (N)` and `Safe mode (B)`.

## Intended animations

Only `transform` and `opacity` animate (the progress fill uses `transform: scaleX()` rather than `width`). Easings: spring-like `--pl-spring: linear(0, 0.25 8%, 0.65 18%, 0.94 30%, 1.03 40%, 1.01 55%, 1)` for entrances and selection moves; `--pl-ease: cubic-bezier(.2,.8,.2,1)` for small state changes; `--pl-ease-in: cubic-bezier(.4,0,1,1)` for exits. There is **no looping animation** (ui-design-system §3.6, WCAG 2.2.2): the running pass uses a determinate ring, not a spinner. Under `prefers-reduced-motion: reduce` or `data-motion="reduce"` every duration token is 0 ms (DSN-05), so each fallback below is the end state shown instantly, with any cross-fade limited to opacity at 0 ms.

| # | Element | Trigger | Properties | Duration | Easing | Reduced motion |
|---|---|---|---|---|---|---|
| 1 | Console window | console mounts after boot | `opacity 0→1`, `transform: scale(.94)→scale(1)` | 240 ms | `--pl-spring` | appears at full size and opacity |
| 2 | Top bar | console mounts | `opacity 0→1`, `translateY(-6px)→0` | 200 ms, 60 ms delay | `--pl-ease-out` | appears |
| 3 | Sidebar rows | console mounts | `opacity 0→1`, `translateX(-8px)→0`, staggered 30 ms per row (6 rows) | 200 ms each | `--pl-spring` | all rows appear together |
| 4 | Selection pill | selected row changes (click, arrow keys, shortcut key) | pill element moves with `translateY(Δrow)`; old/new label colour cross-fades via two stacked labels' `opacity` | 200 ms | `--pl-spring` | pill jumps to the new row |
| 5 | Main pane content | action changes | outgoing `opacity 1→0` + `translateX(0→-12px)`; incoming `opacity 0→1` + `translateX(12px→0)` | 120 ms out, 200 ms in | `--pl-ease-in` / `--pl-spring` | instant swap |
| 6 | Checklist check mark | a pass completes | circle `scale(.6)→scale(1)` with `opacity 0→1`; the tick is an SVG path revealed by a clip layer that translates (`translateX(-100%)→0`) | 280 ms | `--pl-spring` (slight overshoot) | tick shown at full size |
| 7 | Running pass ring | pass progress event | ring is a rotated half-disc mask pair driven by `transform: rotate(progress*360deg)`; moves only when real progress arrives, never on a timer | 120 ms per update | `--pl-ease` | ring snaps to value |
| 8 | Row status transition (running → passed/failed) | pass result | old icon `opacity 1→0` + `scale(1→.8)`, new icon per #6; detail text `opacity 0→1`, `translateY(4px)→0` | 200 ms | `--pl-ease` | instant swap |
| 9 | Progress bar fill | aggregate progress event | `transform: scaleX(p)` with `transform-origin: left` | 120 ms | `--pl-ease` | snaps |
| 10 | Progress bar completion glint | reaches 100 % (once) | a narrow highlight bar `translateX(-100%)→translateX(100%)` with `opacity 0→.6→0` | 600 ms | `linear` | no glint; bar turns green instantly |
| 11 | Result pane lines | each new log line | `opacity 0→1`, `translateY(4px)→0` | 120 ms | `--pl-ease-out` | appears |
| 12 | Summary line | run finishes | `opacity 0→1`, `scale(.98)→1` | 200 ms | `--pl-spring` | appears |
| 13 | Buttons | hover / press | hover: none beyond colour (colour is not animated; it switches); press: `scale(1)→scale(.97)` and back | 120 ms | `--pl-ease` | no scale |
| 14 | Confirm sheet (alertdialog) | destructive action chosen | sheet `translateY(-12px)→0` + `opacity 0→1`; scrim `opacity 0→1` | 200 ms in, 120 ms out | `--pl-spring` / `--pl-ease-in` | appears/disappears |
| 15 | Copy report → "Copied" | clipboard write succeeds | label cross-fade (`opacity`), check icon `scale(.6)→1` | 200 ms | `--pl-spring` | instant label swap |
| 16 | Reboot | reboot chosen | window `opacity 1→0`, `scale(1)→scale(.98)` before `location.replace` | 200 ms | `--pl-ease-in` | immediate navigation |

## Accessibility

- **Landmarks:** `header role="banner"` (top bar), `nav aria-label="Recovery actions"` (sidebar), `main` (action pane), `footer` inside main for the button row.
- **Sidebar list:** `role="listbox"` with `aria-activedescendant`, or a `menu` per the WAI-ARIA APG; Up/Down/Home/End move, Enter runs; each option's accessible description is its consequence line; single-key shortcuts (`F C S M L D N B Y`) are announced through `aria-keyshortcuts` and only fire when focus is not in a text field.
- **Checklist:** `ol` with `aria-label="fsck passes"`; each item has a text status ("passed", "running, 60 percent", "pending"), never colour alone.
- **Progress:** `role="progressbar"` with `aria-valuenow`, `aria-valuemin="0"`, `aria-valuemax="100"`, `aria-valuetext="Stage 4 of 5, quota totals, 78 percent"`.
- **Result pane:** `role="log"`, `aria-live="polite"`; the final summary is also announced once through a visually hidden `role="status"`.
- **Status pill:** plain text in the banner, not an alert (it is known state, not news).
- **Confirm sheets:** `role="alertdialog"`, `aria-labelledby`/`aria-describedby`, focus trapped, initial focus on Cancel, Esc cancels and restores focus.
- **Contrast:** label text 92 % white on a ≥ 78 % opaque dark glass; the amber pill text is #FFB340-ish on a dark tint to keep ≥ 4.5:1; key chips at 60 % not 38 % when they carry information.
- **Forced colours:** glass and shadows become `Canvas` with 1 px `CanvasText` borders; the selected row uses `Highlight`/`HighlightText`.
