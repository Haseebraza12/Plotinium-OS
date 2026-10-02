# Unsupported browser (POST failure, dark)

- **Stitch project:** 12849137298552292712
- **Stitch screen id:** **Not returned.** `generate_screen_from_text` timed out on the client, as the tool warns it may. Following the rules, it was not retried. `list_screens` was then polled about 20 times over roughly 20 minutes (20:22–20:43 PKT). It returned `{}` every time, and the project's `updateTime` stayed at 15:22:02Z. Every sibling agent saw the same empty list. So there was no screen id to pass to `get_screen`, and no Stitch `screen.html` or `screenshot.png` exists for this slug. If the generation lands later, match it by the title or prompt below, run `get_screen`, and save the files as `screen.html` and `screenshot.png` next to this note.
- **Design system:** Plotinium Glass (Dark), `assets/10121591451242352758`
- **Model:** GEMINI_3_8_FLASH, device DESKTOP (1440 × 900)
- **Files:** `reference.html` and `reference.png` (hand-built stand-ins, see below); `screen.html` and `screenshot.png` go here once Stitch returns the screen
- **Spec sources:** `specs/02-boot/boot-and-services.md` §3.2 stage 1 POST and §3.2.1 POST capability matrix (SVC-14); `specs/05-wm/ui-design-system.md` §3.6 motion, §3.7 components, BOOT-13, DSN-05.

## What this screen is

Stage 1 (POST) of the boot, painted by the inlined framework-free boot-ui before the kernel bundle is used. It lists each probed capability with a pass/fail/degraded result and a fix line.

**Spec alignment (read before building).** In §3.2.1 the capabilities fall into two classes:
- **Required** (secure context, module workers, IndexedDB, Web Locks, `crypto.subtle`): if any is missing, POST stops on this screen and **there is no Continue button**, only Copy diagnostics and Requirements.
- **Degradable** (cross-origin isolation, OPFS sync access handles, Service Worker, persistent storage, `CompressionStream`, `measureUserAgentSpecificMemory`): the spec only adds a `WARN` line and a `bootlog` note and keeps booting.

The mock shows the case the prompt asked for: every required capability passes, while OPFS is missing and cross-origin isolation is degraded. That is the degradable-only case, so **Continue in degraded mode** is correct. The build should use two title variants, though:
- **fatal** (a required capability failed): the identity string from `specs/00-product/identity-and-branding.md` row 6, "Plotinium cannot start in this browser" (the mock's "This browser can't run Plotinium" is a copy variant; PLT-ID-08 checks the spec string, so the build uses the spec wording). No Continue.
- **degraded** (only degradable capabilities failed): "Plotinium will run with reduced features" + Continue. A degradable-only result should normally not stop the boot at all; if the team keeps this card, show it only when `?boot=verbose` is set, or once per browser profile (remembered in `localStorage`) and then fall back to the spec's WARN line.

The mock keeps the prompt's title for the design review. The two variants are listed in "Elements and states" below.


## Stand-in until Stitch delivers

- `reference.html`: a hand-built reference render, **not a Stitch export**. It says so in an HTML comment. It follows the Plotinium Glass (Dark) design-system tokens (colour roles, radii, glass blur, Inter + JetBrains Mono, lucide-style icons, traffic lights) and implements the entrance animations listed below with `prefers-reduced-motion` support.
- `reference.png`: that page rendered by headless Chromium at 1440 × 900, 1.8 s after load, once the animations have settled. I reviewed it visually: the Plotinium names and atom logo are correct, it has no Apple marks, and the text contrast is readable.
- Where the reference differs from the prompt on purpose: the secure-context detail reads `localhost:4717` (plain http on localhost is already a secure context), and the paragraph says "paging" where the prompt said "swapping", which is the spec's term. For the fatal-variant title, see the Spec alignment section above.

## Final prompt (sent to Stitch, GEMINI_3_8_FLASH, DESKTOP, dark design system)

```text
Plotinium "Unsupported browser" POST failure screen — a full-screen desktop page (1440x900) for "Plotinium", an AI-native web operating system that runs in Chrome. Visual language: the latest macOS "Liquid Glass" era, dark mode. Background: deep near-black with a very soft, blurred violet (#5E5CE6) and indigo aurora glow, subtle grain. NO Apple logo, NO Apple app names, NO SF Symbols. Typography: Inter / system sans, monospace JetBrains Mono. Thin lucide-style line icons.

CENTRED GLASS CARD (560px wide, 28px radius, frosted translucent glass, 1px inner highlight border, huge soft shadow):
- At top, the Plotinium logo: an abstract luminous atom (a bright nucleus with 2 thin elliptical orbits) in violet #5E5CE6, shown DIMMED at 40% with a faint glow, 64px.
- Small grey overline "POWER-ON SELF TEST".
- Title (28px, semibold, white): "This browser can't run Plotinium".
- Subtitle (grey): "Plotinium 0.3.0 · build a1f93c2 · Chrome 128 on Linux".
- A CAPABILITY CHECKLIST inside an inset glass list with hairline separators. Each row: a status icon on the left (green circle-check for pass, red circle-x for missing, amber triangle-alert for degraded), a capability name, and a right-aligned status tag:
  ✓ "Secure context" — "https · localhost:4717" (green tag "Pass")
  ✓ "Web Workers" — green "Pass"
  ✓ "Module workers" — green "Pass"
  ✓ "IndexedDB" — green "Pass"
  ✗ "Origin Private File System" — red tag "Missing" with a grey fix line under it: "Swap falls back to IndexedDB (plotinium-swap)"
  ✓ "WebCrypto (crypto.subtle)" — green "Pass"
  ✗ "Cross-origin isolation" — amber tag "Degraded" with grey fix line: "Pre-emption falls back to messages · AI search runs single-threaded"
- An explanation paragraph (grey, 15px, readable): "Plotinium runs its kernel and apps in browser workers and keeps your files in local storage. Two features it relies on are unavailable here. You can continue in degraded mode — everything works, but swapping and scheduling will be slower. For the full experience, open Plotinium in the latest Chrome at http://localhost:4717, not a LAN IP."
- Buttons row: a primary violet pill button "Continue in degraded mode" (with arrow-right icon, focus ring visible), a secondary glass button "Copy diagnostics" (with clipboard icon).
- Beneath, a small violet text link "Requirements" with an external-link icon, and a tiny grey hint on the right "Press Enter to continue · D to copy diagnostics".

Very small footer at the bottom of the screen, centred, grey: "Plotinium 0.3.0 · build a1f93c2".
Mood: calm and helpful, not alarming; premium, lots of breathing room, high contrast readable text.
```

## Layout

A full-screen dark aurora backdrop with one centred glass card, 560 px wide and radius 28 px. From the top, the card holds: the dimmed atom logo (40 % opacity, 64 px), the overline `POWER-ON SELF TEST`, the title, the subtitle `Plotinium 0.3.0 · build a1f93c2 · Chrome 128 on Linux`, the capability checklist (an inset glass list with hairline separators), the explanation paragraph, the button row (**Continue in degraded mode** as the primary button and **Copy diagnostics** as the secondary), the `Requirements` link and a keyboard hint. A small footer below the card shows the version line.

## Elements and states

| Element | States |
|---|---|
| Atom logo | dimmed 40 % in the failure state; on Continue it brightens to 100 % as the card hands off to the boot screen |
| Title | fatal variant / degraded variant (see above); it is the `h1` and the dialog's accessible name |
| Subtitle (version, build, UA) | static; UA from `navigator.userAgentData` brands when available, else a short parse of `userAgent` |
| Capability rows (Secure context, Web Workers, Module workers, IndexedDB, Origin Private File System, WebCrypto, Cross-origin isolation; optional extra rows for Web Locks, Service Worker, Persistent storage) | **checking** (grey hollow circle, "Checking…", only while the probe has not answered, usually under 50 ms), **pass** (green circle-check + "Pass"), **missing** (red circle-x + "Missing" + grey fix line), **degraded** (amber triangle + "Degraded" + grey fix line). The tag is always text as well as colour. Rows with a fix line are expandable (`aria-expanded`) to show the probe detail, e.g. `crossOriginIsolated = false · SharedArrayBuffer undefined` |
| Fix lines | OPFS: "Swap falls back to IndexedDB (plotinium-swap)". Cross-origin isolation: "Pre-emption falls back to messages · AI search runs single-threaded". Fatal examples: "Open http://localhost:4717, not a LAN IP" (secure context); "Storage disabled or private mode blocks IndexedDB" |
| Explanation paragraph | text changes with the variant; max 70 characters per line |
| Primary: Continue in degraded mode | default (accent #5E5CE6), hover (#7472FF), focus (3 px accent ring at 55 %, 2 px offset), active (pressed scale .97), **loading** (after click: the label becomes "Starting…" and a determinate boot bar replaces the button row once the kernel reports progress), **hidden** in the fatal variant (hidden, not just disabled, so no one waits on a dead button) |
| Secondary: Copy diagnostics | default / hover (glass +6 % white) / focus / active / **success** (label swaps to "Copied" with a check for 1.5 s) / **error** (clipboard denied: label "Couldn't copy" and a Download JSON fallback link appears) |
| Requirements link | default violet, hover underline, focus ring, visited = same colour; opens the requirements doc in a new tab (`rel="noopener"`), with the external-link icon `aria-hidden` and "(opens in a new tab)" visually hidden |
| Keyboard hint `Press Enter to continue · D to copy diagnostics` | hidden in the fatal variant (Enter then focuses Copy diagnostics) |
| Footer version line | static |
| Empty state | not applicable: POST always has at least the required rows |

## Intended animations

Only `transform` and `opacity` animate. Easings: spring-like `--pl-spring: linear(0, 0.25 8%, 0.65 18%, 0.94 30%, 1.03 40%, 1.01 55%, 1)`, `--pl-ease: cubic-bezier(.2,.8,.2,1)`, `--pl-ease-out: cubic-bezier(0,0,.2,1)`, `--pl-ease-in: cubic-bezier(.4,0,1,1)`. There are no loops, so the aurora is **static** (WCAG 2.2.2, ui-design-system §3.6). Under `prefers-reduced-motion: reduce` or `data-motion="reduce"`, every motion token is 0 ms (DSN-05) and the end state appears at once. This page is in the inlined POST HTML, so the CSS must sit inline and stay tiny: no animation library.

| # | Element | Trigger | Properties | Duration | Easing | Reduced motion |
|---|---|---|---|---|---|---|
| 1 | Card | POST result ready (not before, so a passing boot never flashes it) | `opacity 0→1`, `transform: translateY(12px) scale(.97)→none` | 320 ms | `--pl-spring` | appears in place |
| 2 | Logo dim | card entrance | logo `opacity 1→.4`, `scale(1)→scale(.96)` (it was the boot logo, now "powering down") | 320 ms | `--pl-ease` | shown at .4 |
| 3 | Capability rows | card entrance | `opacity 0→1`, `translateY(6px)→0`, staggered 40 ms per row in probe order | 200 ms each | `--pl-spring` | all rows at once |
| 4 | Pass icon | row appears | icon `scale(.6)→1`, `opacity 0→1` (the check glyph is revealed by a clip layer translating in) | 240 ms | `--pl-spring` | shown |
| 5 | Missing / degraded icon | row appears | icon `scale(.6)→1.08→1` (one gentle overshoot, never a shake), `opacity 0→1`; fix line `opacity 0→1`, `translateY(-4px)→0` after 80 ms | 280 ms | `--pl-spring` | shown |
| 6 | Row expand (probe detail) | click / Enter on an expandable row | detail block `opacity 0→1`, `translateY(-4px)→0`; chevron `rotate(0→90deg)` | 200 ms | `--pl-spring` | instant toggle |
| 7 | Primary button | hover / press | press `scale(.97)`, release back with a spring; the hover colour switches (it is not animated) | 120 ms | `--pl-spring` | no scale |
| 8 | Copy diagnostics → Copied | clipboard success | old label `opacity 1→0`, new label `opacity 0→1` + `translateY(4px)→0`; check icon `scale(.6)→1` | 200 ms | `--pl-spring` | instant swap |
| 9 | Continue hand-off | Continue clicked | checklist and paragraph `opacity 1→0`, card `scale(1)→scale(.98)`; logo `opacity .4→1`, `scale(.96)→1`, then the boot screen takes over at the same logo position | 240 ms | `--pl-ease-in` then `--pl-spring` for the logo | cross-cut to the boot screen |
| 10 | Keyboard hint | 1.2 s after the card settles (once) | `opacity 0→.6` | 200 ms | `--pl-ease-out` | shown at .6 immediately |

## Accessibility

- **Landmarks:** `main` wraps the card. The card is a `section` with `aria-labelledby` pointing at the `h1`. It is not a modal dialog, because nothing sits behind it. `footer` holds the version line.
- **Announce:** on reveal, a visually hidden `role="alert"` (fatal) or `role="status"` (degraded) reads the title plus "2 features unavailable: Origin Private File System, cross-origin isolation".
- **Checklist:** `ul` with `aria-label="Browser capabilities"`; each `li` reads "Origin Private File System, missing. Swap falls back to IndexedDB." Icons are `aria-hidden`; the status is text, never colour alone.
- **Focus:** initial focus goes to Continue (degraded) or Copy diagnostics (fatal); tab order is Continue → Copy diagnostics → Requirements → expandable rows. `Enter` and `D` shortcuts are declared with `aria-keyshortcuts`.
- **Contrast:** text sits on ≥ 78 % opaque glass; the grey fix lines are 60 % white (≥ 4.5:1 on #1C1C1E). The red and amber tags pair their colour with a label.
- **Forced colours:** the card becomes `Canvas` with a 1 px `CanvasText` border; the status icons keep their glyph shapes (check, x, triangle) so they stay distinct without colour.
- **No JS dependency:** the screen must render from the inlined HTML and CSS if the capability probe throws. In that case every row shows "Unknown", and Copy diagnostics still works because it uses `document.execCommand('copy')` as a fallback.
