# @plotinium/ui

Presentational SolidJS component library for Plotinium's macOS-inspired (Liquid Glass era) UI, designed in Google Stitch (`docs/design/stitch/`).

- **Owner:** R3 (WM/UI). **Reviewer:** R1.
- **Specs:** `specs/05-wm/visual-language-macos.md`, `specs/05-wm/ui-implementation-guide.md`, `specs/05-wm/ui-design-system.md`.
- **Rule:** components receive all data through props and emit intents through callbacks. They never touch storage, workers or the network (SYS-01). `apps/` and `wm/` wire them to the kernel.
- **Performance:** animate only `transform` and `opacity`; live `backdrop-filter` only on the menu bar, dock and popovers (WM-03, PROC-05).
- **Gallery:** `pnpm --filter @plotinium/ui gallery` previews every component in both themes.
