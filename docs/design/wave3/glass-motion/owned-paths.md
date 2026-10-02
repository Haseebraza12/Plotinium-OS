# glass-motion: owned paths (Workflow B, RFC 0006 parts (b) and (c))

Builder `glass-motion` (the lead's Q8 decision). Taken from RFC 0006 §5.2, §5.3, §10 and §13 ("as in
the draft"), minus every path PLAN.md gives another builder (§2.2, §3.3, §5) and minus the paths the
lead reserved (`ui/src/apps/**`, `ui/src/primitives/sidebar/**`, `apps/**`, `kernel/**`,
`protocol/**`, `server/**`, `wm/src/shell/menus.ts`). Written before any code.

## Edited (existing files)

| Path | Why |
| --- | --- |
| `ui/src/shell/dock/Dock.tsx` | (c) approach band, anchored growth, `expansion` flag, `DockApi.catch`, `glassScheme` |
| `ui/src/shell/dock/DockIcon.tsx` | (c) the catch one-shot on the icon |
| `ui/src/shell/dock/Dock.module.css` | (b) alpha floor; (c) the Dock spring (`linear()`, local custom property) |
| `ui/src/shell/dock/magnify.ts` | (c) `magnifyAnchored`, the approach ramp, the intent gate |
| `ui/src/shell/dock/Dock.test.tsx` | tests |
| `ui/src/shell/menubar/MenuBar.tsx` | (b) `glassScheme` prop (scheme flip) |
| `ui/src/shell/menubar/MenuBar.module.css` | (b) alpha floor |
| `ui/src/shell/menubar/MenuBar.test.tsx` | tests |
| `ui/src/shell/control-centre/ControlCentre.module.css` | (b) alpha floor |
| `ui/src/shell/control-centre/ControlCentre.test.tsx` | tests (if needed) |
| `ui/src/shell/wallpaper/Wallpaper.tsx`, `Wallpaper.module.css` | (b) wallpaper choice (`data-wallpaper`) |
| `ui/src/tokens/tokens.css` | glass section and the reduce-transparency blocks only (DSN-41); motion tokens untouched unless needed |
| `ui/src/tokens/tokens.test.ts` | DSN-41, `COMPONENT_INPUTS`, DSN-39 stays green |
| `ui/src/tokens/motion.css`, `ui/src/tokens/motion.test.ts` | (c) `pl-anim-dock-catch` |
| `wm/src/shell/motion.ts` (+ its test) | (c) the catch callback when a minimise lands |
| `wm/src/shell/genie.ts` (+ its test) | read-only unless the catch needs it |

## New files

| Path | What |
| --- | --- |
| `wm/src/shell/glass/**` | colour maths, the legibility solver, the wallpaper sampler (main thread + `OffscreenCanvas` worker), the controller, their tests |
| `ui/src/shell/dock/magnify.test.ts`, `ui/src/shell/dock/spring.ts`, `ui/src/shell/dock/spring.test.ts` | (c) pure maths and the spring generator (the checked-in fixture) |
| `ui/src/shell/wallpaper/Wallpaper.test.tsx` | tests |
| `web/public/wallpapers/daylight-light.svg`, `daylight-dark.svg`, `eclipse-light.svg`, `eclipse-dark.svg` | (b) the two new bundled wallpapers |
| `tests/performance/frame/dock.spec.ts` | (c) DSN-44 frame trace (10 windows, idle and 3x burn) |
| `tests/a11y/glass-contrast.spec.ts` | (b) DSN-40 contrast over the real rendered desktop |
| `docs/design/wave3/glass-motion/**` | evidence, screenshots, notes, handoffs |

## Not mine (handoffs instead)

- `wm/src/shell/Desktop.tsx` (not listed for glass-motion; the wiring: start the controller, pass
  `glassScheme`, pass the animator's catch callback) -> handoff.
- `apps/src/descriptor.ts` (gdrive-ui): the `DesktopPrefs` keys `appearance.wallpaper`,
  `appearance.adaptiveGlass`, `dock.expansion` and `applyAppearance` writing the root attributes.
- `ui/src/apps/settings/panes/AppearancePane.tsx`: the Wallpaper pop-up button.
- `tests/performance/budgets.json`: the `DSN-44.*` rows.
- `specs/**`, `AI_USAGE.md`, `CHANGELOG.md`, `tools/traceability/ids.ts` (platform): spec text.
- `ui/src/primitives/internal/Floating.module.css`, `ui/src/shell/notifications/**`: popovers are
  not adapted (they already pass 4.5:1 over any backdrop; RFC 0006 §2.2 table), so not touched.
