# tests/a11y

Accessibility (testing §3.9; ui-design-system §3.11; WM-07, BOOT-13, TST-14).

- `axe.ts`: @axe-core/playwright with tags `wcag2a wcag2aa wcag21a wcag21aa wcag22aa`; four theme passes per screen: light and dark by `emulateMedia`, and each with `data-theme` forced to the opposite scheme. Gate: zero `serious` or `critical` violations; `moderate` and `minor` are reported.
- `screens.spec.ts`: boot splash, boot menu, verbose log, panic, recovery console, login, desktop with three windows, Terminal, File Explorer, Text Editor, Task Manager, Settings; the splash again with reduced motion.
- `keyboard.spec.ts`: boot announcements at most once per 750 ms (stage changes and failures exempt), `Alt+\`` window switch, `Alt+M` then the taskbar by keyboard.
- `announce.ts`: the live-region recorder and the rate check (unit-tested in `a11y.test.ts`).
- **How to run:** `PLT_E2E_UI=1 pnpm exec playwright test -c tests/playwright.config.ts --project=a11y`; the pure helpers run in the Vitest `harness` project.
- **Runs:** pull requests touching `wm/`, `apps/*/view*`, `web/`, `ui/`; `main`; each release.
- **Primary owner:** R5 (harness), R3 (screens). **Reviewer:** R1.

Every test title MUST begin with its requirement ID, for example `DB-02 rm -r with a server fault at node 500 rolls back with zero orphans and unchanged checksum and quota` (C18). `pnpm traceability` builds the requirement-to-test matrix from these titles.
