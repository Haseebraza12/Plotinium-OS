# Kernel panic: dependency cycle (dark)

- **Stitch project:** 12849137298552292712
- **Stitch screen id:** none — generation timed out and never appeared in `list_screens` (15 polls, ~20 min). Not retried, per run instructions. See `screen.json`.
- **Design system:** Plotinium Glass (Dark), `assets/10121591451242352758`
- **Model:** GEMINI_3_8_FLASH, device DESKTOP (1440 × 900)
- **Files:** `screen.json` (Stitch timeout record), `reference.html` + `reference.png` (hand-built render of the same prompt; NOT a Stitch export). `screen.html` / `screenshot.png` are absent because Stitch returned no screen.
- **Spec sources:** `specs/02-boot/boot-and-services.md` BOOT-04, §3.2 stage 3 "If it fails", §3.4 validation rules V1–V10 (same `[R] [S] [D]` actions for every manifest panic), §5.4 cycle detection and the panic screen text, §6 errors table, BOOT-13; `specs/05-wm/ui-design-system.md` §3.6 motion tokens, DSN-05.

## What this screen is

The framework-free boot-ui screen shown when `svcmgr` finds a cycle while building the service DAG (rule V10). The boot halts before `storage` mounts, so nothing has been written. The page title is `Plotinium kernel panic`. The same layout serves every other kernel panic (V1–V9 manifest errors, an uncaught Worker `error` before `kernel.ready`): only the headline, the code block and the diagram change (V1–V9 show the offending file and rule instead of a graph; a Worker error shows the error and stack).

Actions (spec §5.4):
- **[R] Recovery console**: reboots into Recovery (built-in manifests, so it cannot hit the same cycle). From there M restores default manifests, N reboots normally.
- **[S] Safe mode**: reboots into Safe mode (built-in manifests).
- **[D] Dump diagnostics**: downloads the boot record (`outcome: 'panic'`, `panic.cycle`) and the capability matrix as JSON; the screen stays.

The boot record stores the cycle as found by the DFS; the spec example reads `auth → sync → lockd → auth`, this render starts at `sync` (`sync → lockd → auth → sync`). It is the same cycle; implementation should print it starting from the manifest that was edited most recently, or alphabetically, but consistently in the log, the headline and the diagram.

**Hard constraint (SVC-10):** no `@keyframes`, `animation`, `setTimeout` or `setInterval` in the boot path. The panic screen is also excluded from the stall watchdog (it waits on the user). All motion is one-shot CSS `transition`s entering from `@starting-style` when the panic node is inserted. Nothing pulses or loops; the screen must be calm.

## Final prompt

```text
Plotinium OS — "Kernel panic" screen (1440x900 desktop, dark). Plotinium is an AI-native web operating system; visual language inspired by the latest macOS Liquid Glass era (layered translucent glass, soft large shadows) but with its own identity. Absolutely NO Apple logo, NO Apple app names, NO SF Pro, NO SF Symbols, NO radiation/hazard symbols. Serious but beautiful — never a blank page.

BACKGROUND: full-screen near-black #07070B with a subtle deep red vignette creeping in from the edges (#FF453A at ~10% opacity, darker at the corners), a faint violet haze at the center, soft film grain.

CENTER: one large Liquid Glass card (~720px wide), dark translucent glass (rgba(28,28,34,0.72)) with strong backdrop blur, 1px hairline border in white/10%, an inner top highlight, 28px corner radius and a very large soft shadow. Inside, top to bottom, 40px padding:
1. A round alert icon: a 56px circle filled with danger red #FF453A at 16% with a lucide-style line "alert-triangle" icon in #FF453A, soft red glow.
2. Title "Kernel panic" in Inter 32px semibold, white.
3. Subtitle in Inter 15px grey: "Plotinium stopped during boot because the service graph contains a cycle. Your files are safe; nothing was written."
4. A code block (darker inset, 12px radius, JetBrains Mono 13px):
   line 1 dim grey: "[ 0.021] svc: 18 manifests · 31 edges"
   line 2 red #FF453A semibold: "KERNEL PANIC: dependency cycle detected: sync → lockd → auth → sync"
   line 3 dim grey: "[ 0.022] kernel: halting before storage mount · pid 1 = init"
5. A small graph diagram (about 360x150) drawing the cycle: three rounded glass node pills labelled "sync", "lockd", "auth" in JetBrains Mono arranged as a triangle, connected by curved red #FF453A arrows sync → lockd → auth → sync, each arrow with an arrowhead; the edge "auth → sync" labelled "closes cycle" in tiny red text. Also a greyed-out 4th node "storage" hanging off, with a dashed grey edge, to show unaffected services.
6. Three large keyboard-accessible buttons in a row, each a glass button with a keycap badge on the left: "[R] Recovery console" (primary, filled violet #5E5CE6, white text, with a lucide "terminal" icon), "[S] Safe mode" (secondary glass, lucide "shield" icon), "[D] Dump diagnostics" (secondary glass, lucide "download" icon). The first button shows a visible violet focus ring (2px offset) to show keyboard focus.
7. A small hint line in Inter 12px grey: "Use R, S or D, or Tab to move between options. Safe mode boots only core services (init, sched, vfs, storage)."

FOOTER (pinned bottom, JetBrains Mono 11px dim grey, 24px margin): left "boot id 7f3e·b12c", center "2026-09-24 09:41:07 PKT · uptime 0.022 s", right the small Plotinium logo (an abstract luminous atom: bright nucleus dot with 2–3 thin elliptical violet #5E5CE6 orbits) followed by "Plotinium 0.3.0 · a1f93c2".
```

## Layout (1440 × 900)

1. **Background**: near-black `#07070B`, red vignette from the edges (`#FF453A` ≈ 10 %), faint violet haze at centre, film grain. Pure decoration (`aria-hidden`).
2. **Panic card** (centre, ≈ 720 px, dark Liquid Glass `rgba(28,28,34,0.72)`, backdrop blur, 1 px hairline `rgba(255,255,255,0.10)`, inner top highlight, 28 px radius, very large soft shadow), 40 px padding, top to bottom:
   1. Alert medallion: 56 px circle, danger `#FF453A` at 16 %, lucide `triangle-alert` line icon in `#FF453A`, soft red glow.
   2. Title `Kernel panic` (Inter 32 semibold).
   3. Explanation (Inter 15, secondary): `Plotinium stopped during boot because the service graph contains a cycle. Your files are safe; nothing was written.`
   4. Code block (inset, 12 px radius, JetBrains Mono 13):
      - `[ 0.021] svc: 18 manifests · 31 edges` (tertiary)
      - `KERNEL PANIC: dependency cycle detected: sync → lockd → auth → sync` (danger, semibold)
      - `[ 0.022] kernel: halting before storage mount · pid 1 = init` (tertiary)
   5. Cycle diagram (≈ 360 × 150): glass node pills `sync`, `lockd`, `auth` in a triangle joined by curved red arrows; `auth → sync` labelled `closes cycle`; a dimmed `storage` node with a dashed grey edge for unaffected services.
   6. Action row: `[R] Recovery console` (primary, violet `#5E5CE6`, lucide `terminal`), `[S] Safe mode` (glass, lucide `shield`), `[D] Dump diagnostics` (glass, lucide `download`). Keycap badge on each.
   7. Hint: `Use R, S or D, or Tab to move between options. Safe mode boots only core services (init, sched, vfs, storage).`
3. **Footer** (mono 11, tertiary, 24 px margins): left `boot id 7f3e·b12c`; centre `2026-09-24 09:41:07 PKT · uptime 0.022 s`; right atom logo + `Plotinium 0.3.0 · a1f93c2`.

## Elements and states

| Element | Default | Hover | Focus | Active / pressed | Disabled | Empty | Loading | Error |
|---|---|---|---|---|---|---|---|---|
| Alert medallion | red tint + glyph, static | – | – | – | – | – | – | – |
| Title / explanation | static text | – | – | – | – | – | – | variant copy per panic type (V1–V9, Worker error) |
| Code block | 3 lines, selectable | – | block is focusable (`tabindex="0"`) so screen-reader and keyboard users can read / copy it; focus ring 3 px accent 55 % | text selection accent 85 % | – | – | – | Worker-error variant adds a collapsible `Stack trace` disclosure (`<details>`) |
| Cycle diagram | 3 red-edged nodes, dim `storage` | node under pointer lifts (`translateY(-1px)`) and its two incident edges brighten | – (diagram is an image with a text alternative; not in tab order) | – | – | – | – | a V1–V9 panic hides the diagram and shows the offending file name in its place |
| `[R] Recovery console` (primary, initial focus) | violet fill, white label, keycap `R` | hover `#7472FF` | 2 px offset focus ring accent 55 % (shown at load because it receives focus) | pressed `scale(0.98)`, keycap depresses | – | – | after activation: label `Rebooting into recovery…`, spinner-free (a static progress glyph), other buttons `aria-disabled` | – |
| `[S] Safe mode` | glass button, keycap `S` | glass lightens to 8 % white | same ring | pressed `scale(0.98)` | disabled while another action is running | – | `Rebooting in safe mode…` | – |
| `[D] Dump diagnostics` | glass button, keycap `D` | glass lightens | same ring | pressed `scale(0.98)` | – | – | `Preparing boot record…` | if the download is blocked: inline message under the row `Couldn't save the file. The boot record is also in /system/log/boot.log after recovery.`; on success a check replaces the icon and the label reads `Saved plotinium-boot-7f3e.json` |
| Hint line | tertiary 12 px | – | – | – | – | – | – | – |
| Footer | tertiary mono | – | – | – | – | – | – | – |

Keyboard shortcuts R, S and D work regardless of focus (no modifier). Enter / Space activate the focused button. Tab / Shift+Tab cycle through code block → R → S → D.

## Intended animations

Tokens: `--pl-motion-fast` 120 ms, `--pl-motion-med` 200 ms, `--pl-motion-slow` 320 ms (all 0 ms under reduced motion, DSN-05). `--pl-ease` = `cubic-bezier(.2, .8, .2, 1)`, `--pl-ease-out` = `cubic-bezier(0, 0, .2, 1)`, `--pl-ease-in` = `cubic-bezier(.4, 0, 1, 1)`. Spring: `--pl-spring` = `linear(0, 0.35 12%, 0.78 26%, 1.02 40%, 1.04 50%, 1.01 65%, 1)`. Only `transform` and `opacity`. Every entrance is a CSS `transition` from `@starting-style`, staggered with `transition-delay`, triggered by inserting the panic node; no keyframes, no timers, no loops (SVC-10, WCAG 2.2.2).

| # | Element | Trigger | Properties | Duration | Easing | Reduced-motion fallback |
|---|---|---|---|---|---|---|
| 1 | Boot layer → panic (splash / verbose log recedes) | `svc.panic` event | outgoing boot layer `opacity 1→0`, `scale 1→0.98` | 200 ms | `--pl-ease-in` | instant cut |
| 2 | Red vignette | panic node inserted | vignette layer `opacity 0→1` | 320 ms | `--pl-ease-out` | appears at full opacity |
| 3 | Panic card | panic node inserted, delay 60 ms | `opacity 0→1`, `transform: translateY(12px) scale(0.96) → none` | 320 ms | `--pl-spring` | instant |
| 4 | Alert medallion | delay 120 ms | `scale 0.7→1`, `opacity 0→1` (one overshoot, then still; no pulse) | 320 ms | `--pl-spring` | instant |
| 5 | Title, explanation, code block | delay 160 / 200 / 240 ms | `opacity 0→1`, `translateY(6px) → 0` | 200 ms | `--pl-ease-out` | instant |
| 6 | Cycle diagram nodes | delay 280 / 320 / 360 ms (sync, lockd, auth) | `opacity 0→1`, `scale 0.9→1` | 200 ms | `--pl-spring` | instant |
| 7 | Cycle diagram edges | delay 400 / 440 / 480 ms, in cycle order | each arrow is an SVG group revealed by a clip rectangle whose `transform: scaleX(0→1)` runs along the edge direction (transform only, no `stroke-dashoffset`), arrowhead `opacity 0→1` at the end | 200 ms each | `--pl-ease` | edges drawn fully, no reveal |
| 8 | `closes cycle` label | after the last edge, delay 560 ms | `opacity 0→1` | 120 ms | linear | instant |
| 9 | Action buttons | delay 400 / 440 / 480 ms | `opacity 0→1`, `translateY(8px) → 0` | 200 ms | `--pl-spring` | instant |
| 10 | Focus ring on `[R]` | initial focus after #9 settles (`transitionend`) | ring `opacity 0→1`, `scale 1.04→1` (ring is a pseudo-element) | 120 ms | `--pl-ease-out` | ring shown immediately |
| 11 | Button hover | pointer enter / leave | glass tint layer `opacity`; icon `translateX(1px)` | 120 ms | `--pl-ease` | tint only, no movement (tokens 0 ms) |
| 12 | Button press / R, S, D key | pointerdown or keydown | button `scale 1→0.98`, keycap `translateY(1px)` | 120 ms | `--pl-ease` | no transform; pressed state shown by tint |
| 13 | Diagram node hover | pointer enter | node `translateY(-1px)`, incident edges `opacity 0.7→1` | 120 ms | `--pl-ease` | opacity only |
| 14 | Action chosen (R or S) | activation | card `opacity 1→0`, `scale 1→0.98`, then `location.replace('/?boot=recovery|safe')` on `transitionend` | 200 ms | `--pl-ease-in` | navigate immediately |
| 15 | `[D]` success check | download started | icon cross-fade `opacity`, check `scale 0.6→1` | 200 ms | `--pl-spring` | instant swap |

## Accessibility

- Title element text `Plotinium kernel panic`; document language `en`.
- Landmarks: `<main>` wraps the card; footer `role="contentinfo"`. The card itself is `role="alertdialog"`-free on purpose (it is the whole page, not a modal): use `<main aria-labelledby="panic-title" aria-describedby="panic-desc">`.
- On insertion, the headline and the panic line are announced once through a `role="alert"` region: `Kernel panic. Dependency cycle detected: sync, lockd, auth, sync. Boot halted. Press R for recovery console, S for safe mode, D to dump diagnostics.` Arrows are spoken as commas via visually hidden text.
- Initial focus moves to `[R] Recovery console`. Focus is not trapped (there is nothing else on the page), and the visible ring is always shown for keyboard focus (`:focus-visible`).
- Buttons are real `<button>` elements with `aria-keyshortcuts="R"`, `"S"`, `"D"`; the keycap badge is `aria-hidden` so the name stays `Recovery console`. While an action runs, the others get `aria-disabled="true"` and a `role="status"` line says `Rebooting into recovery…`.
- Cycle diagram: inline SVG with `role="img"` and `aria-label="Cycle: sync depends on lockd, lockd depends on auth, auth depends on sync. storage is not part of the cycle."`; red edges also carry arrowheads and the `closes cycle` text, so colour is not the only signal.
- Code block: `<pre>` with `aria-label="Panic log"`, focusable and copyable.
- Contrast: danger `#FF453A` on the card's dark tint is ≥ 4.5:1 for the 13 px semibold panic line; tertiary text at 38 % is only used for 11 px footer metadata and is raised to ≥ 4.5:1 by the opaque tint behind it. Forced-colours: vignette and glass drop out, edges use `CanvasText`, buttons use `ButtonFace` / `ButtonText` with `Highlight` focus.
- Reduced motion: all entrance motion off, the screen appears complete in one frame.

## Review notes (Stitch render)

**No Stitch render exists** for this screen (see `screen.json`). To keep the design reviewable, `reference.html` is a hand-built render of the exact prompt and tokens above, and `reference.png` is its 1440 × 900 Chromium capture (Playwright). It is labelled "NOT a Stitch export" in its source. Reloading `reference.html` plays the full staggered entrance (transitions from `@starting-style` only).

Checked on `reference.png`:
- Red edge vignette + violet centre haze; centred dark glass card (28 px radius, hairline, large shadow). PASS.
- Alert medallion (lucide `triangle-alert`, not a hazard/radiation symbol), title `Kernel panic`, reassurance copy. PASS.
- Code block with the three lines; the panic line in danger red semibold. PASS.
- Cycle diagram: `sync → lockd → auth → sync` with arrowheads, `closes cycle` on `auth → sync`, dimmed dashed `storage` node off `auth`. PASS (first pass had the storage edge floating; fixed).
- `[R] Recovery console` (primary violet, initial focus ring visible), `[S] Safe mode`, `[D] Dump diagnostics`, each with a keycap and a lucide icon. PASS (first pass wrapped "Dump diagnostics" onto two lines; fixed with `nowrap` + auto columns).
- Footer: boot id, time + uptime, atom logo + `Plotinium 0.3.0 · a1f93c2`. No Apple marks. PASS.

Notes for implementation:
- The hint says Safe mode boots "init, sched, vfs, storage". Per the boot spec (§3.7, SVC-05) Safe mode starts every service with `safeMode: true` from the built-in manifests (no AI, no autostart, default theme); it is **Recovery** that starts only `kernel, sched, storage, wm, vfs`. Suggested final hint copy: `Safe mode starts without AI services or autostart apps, using the built-in service list.`
- Cycle rotation: the spec example prints `auth → sync → lockd → auth`; this screen prints `sync → lockd → auth → sync`. Both are the same cycle; pick one canonical rotation rule in `svcmgr` and use it in the log, the headline and the diagram.
- The spec example shows `svc: 18 manifests (volume) · 31 edges` with timestamp `0.060`; this render uses `0.021` to line up with the verbose-log screen. Use whatever the boot record says.

To do when Stitch recovers: generate once with the prompt above, download to `screen.html` / `screenshot.png`, and compare with `reference.png`.
