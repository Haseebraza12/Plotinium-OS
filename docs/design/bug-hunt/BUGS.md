# Plotinium polish wave: bug list (triage)

One merged list from the 7 bug finders (boot-login, desktop-shell, windows, files-editor, terminal,
apps-settings-a11y, system-services), the qa-setup, logo-stitch and fonts reports, and the triage's
own checks on the QA copy (http://localhost:4718, build of 2026-09-27 09:55, which already contains
the new logo and the D15 fonts). Duplicates are merged under one id. Every bug has exactly one owner.

- **Severity**: blocker, major, minor, cosmetic. **Priority**: P0 = blocker (fix first), P1 = major,
  P2 = minor, P3 = cosmetic. Ids are numbered in priority order.
- **Known issues (a)–(f)** from the wave brief are marked `(known a)` … `(known f)`; see the map at
  the end.
- Evidence paths are relative to the repo root. `bug-hunt/<area>/…` means
  `docs/design/bug-hunt/<area>/…`; `polish/triage/…` means `docs/design/polish/triage/…` (taken by
  the triage).
- Test titles begin with the bug id, for example `UI-014 keeps a single-file selection after the
inspector loads`.

---

## 1. File ownership (who may write what)

Defaults come from the fixer briefs; the triage added the rows marked **(triage)** so that every
file a bug needs has exactly one writer. If a fix needs a file you do not own, do not edit it:
say so in your report (the owner or the verifiers pick it up).

| Fixer                      | Writable paths                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Must not edit                                                                                                           |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **fix-boot-login**         | `ui/src/boot/**` (including the boot-logo _animation_ in `logo.ts` and the logo section of `boot.css`); `ui/src/login/**`; `web/src/boot/**`; `wm/src/shell/Login.tsx`; **(triage)** `wm/src/shell/login-flow.ts`; **(triage)** `web/vite.config.ts` (the `compactCss` function only); `server/src/ratelimit/**` and **(triage)** the `new RateLimiter({…})` call in `server/src/app.ts` (UI-005 only)                                                                                                                                                                                                                                                                                                                                                                                                                                          | `ui/src/icons/**` (the logo artwork), `ui/src/tokens/**`, the identity/CSP/proxy code in `web/vite.config.ts`           |
| **fix-desktop-shell**      | `ui/src/shell/**` except `ui/src/shell/window/**`; `ui/src/overlays/**`; `wm/src/shell/**` except `Login.tsx`, `login-flow.ts`, `WindowLayer*`, `dom.ts`, `menus.ts`, `motion.ts`, `genie.ts`, `layout.ts`; `wm/src/shell/Desktop.tsx` **except the fix-windows regions (contract C1)**; `wm/src/shell/env.ts` except `AppWindowHints`; `wm/src/shell/Shell.module.css` except the `.windows`, `.slot`, `.view` rules; **(triage)** `apps/src/descriptor.ts` functions `toShellPrefs`/`fromShellPrefs` and their exports in `apps/src/index.ts` (UI-040)                                                                                                                                                                                                                                                                                        | the fix-windows regions of `Desktop.tsx`, `menus.ts`                                                                    |
| **fix-windows**            | `wm/src/compositor/**`; `wm/src/shell/WindowLayer*` (new CSS goes in a new `wm/src/shell/WindowLayer.module.css`); `ui/src/shell/window/**` (`WindowFrame*`); **(triage)** `wm/src/shell/dom.ts`, `menus.ts`, `motion.ts`, `genie.ts`, `layout.ts`; the `.windows`, `.slot`, `.view` rules of `Shell.module.css`; the **fix-windows regions of `Desktop.tsx` (C1)**; the `AppWindowHints` interface in `wm/src/shell/env.ts` (additive)                                                                                                                                                                                                                                                                                                                                                                                                         | the rest of `Desktop.tsx` and `env.ts`                                                                                  |
| **fix-files-editor**       | `ui/src/apps/files/**`; `ui/src/apps/editor/**` (includes `DocumentTabs`, which the Terminal also uses; the font comes from the token, do not set one); `apps/files/**` (includes `apps/files/lib/relay.ts` `appProcess`, which Task Manager, Settings and the Editor also use); `apps/editor/**`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `ui/src/primitives/internal/csp-styles.ts` (use its API, do not edit)                                                   |
| **fix-terminal**           | `ui/src/apps/terminal/**`; `apps/terminal/**`; `apps/shell/**`; `apps/coreutils/**`; **(triage)** `ui/src/primitives/internal/csp-styles.ts` and its test (keep the exported API backward compatible: the Editor uses it)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `ui/src/tokens/**` (the mono family is UI-004)                                                                          |
| **fix-apps-settings-a11y** | `ui/src/apps/taskmgr/**`; `ui/src/apps/settings/**`; `ui/src/primitives/**` except `internal/csp-styles.ts` (a11y fixes and the CSP static-style fixes of UI-147; keep props backward compatible); `apps/taskmgr/**`; `apps/settings/**`; `apps/about/**`; **(triage)** `apps/src/notice.tsx`; **(triage)** `ui/src/tokens/**` (accent, mono family, comments; keep DSN-39: `tokens.css` ≤ 5 KB gzip); **(triage)** docs for the logo and font changes: `docs/design/fonts/**`, the "Addendum — D15 Typography" in `specs/15-decisions/stack-decisions.md`, `THIRD_PARTY.md`, `specs/05-wm/visual-language-macos.md`, `specs/05-wm/ui-implementation-guide.md` (D-05 and the typography rules only), `specs/00-product/identity-and-branding.md` §3.6, `docs/design/README.md`, `ui/gallery/pages/tokens.tsx`, the comment in `ui/src/index.ts` | `ui/src/icons/**`                                                                                                       |
| **fix-system-services**    | `services/**`; `kernel/src/core/{io,net,window,fs}/**`; **(triage)** `kernel/src/core/kernel.ts`, `kernel/src/core/proc/**`, `kernel/src/core/mm/**`, `kernel/src/host/**`; `vfs/src/sync/**`, `vfs/src/locks/**`, **(triage)** `vfs/package.json` (exports only); **(triage)** `protocol/src/**` (new syscall schemas, UI-036); **(triage)** `ai/**` (UI-049 only); `web/src/**` except `web/src/boot/**` (includes `sw.ts`, `kernel.worker.ts`, `executor.worker.ts`, `desktop/host.ts`, `main.ts`); **(triage)** `web/build/**`, `ops/caddy/**`; `server/**` except `server/src/ratelimit/**` and the `RateLimiter` call in `server/src/app.ts`; `Dockerfile`, `compose.yaml`, `Caddyfile`; **(triage)** the root `package.json` `start` script, a new `tools/build-id.*` script, and the build-id paragraph of `README.md`                  | `web/vite.config.ts` (its `computeIdentity` already accepts a hex `BUILD_SHA` env var, so UI-008 needs no change there) |

**Nobody edits this wave:** `ui/src/icons/**`, `docs/identity/**`, `web/public/**` and `web/index.html`
(logo and fonts are done; `web/index.html` must keep **no** font preload), `tests/support/**`,
`playwright.config.ts`, existing shared e2e specs. Put new tests in new files named after the bug
or your area (for example `wm/tests/shell/ui-017-restore-focus.test.tsx`,
`tests/e2e/polish-windows.spec.ts`) instead of editing shared test files.

### Cross-owner contracts

- **C1: regions of `wm/src/shell/Desktop.tsx`.** The file is split by section comments of the form
  `// ------------------------------------------------------------------ <name>` (written
  `// ---- <name>` below). fix-windows owns (a) the section `// ---- compositor` (exactly that name,
  ~line 290) up to `// ---- status and notifications` (the `createCompositor` call, animator,
  `overlayFor`); (b) everything from `// ---- layout persistence (WM-06)` through
  `// ---- compositor coarse events` and `// ---- window commands`, up to `// ---- launching`
  (`snapshot`, `saveLayout`, `applyRestore`, `onCoarse`, `onParts`, `onGone`, `focusWindow`,
  `closeWindow`, `animatedSnap`, `windowCommand`; others may call these but not edit them); (c) in
  the view section,
  `winMenuItems`, the `<WindowLayer …/>` element and the window `<Menu open={winMenu() !== null} …/>`.
  fix-desktop-shell owns everything else in the file (MenuBar and Dock JSX, launching, system actions,
  Search, Overview, switcher, keyboard, clock, frame meter, status views, lifecycle, Control Centre,
  notifications). Both: re-read the file right before every edit, stay inside your region, and do not
  run `prettier --write` on the whole file unless its diff is only inside your region.
- **C2: `wm/src/shell/env.ts`.** fix-windows may only add optional `width?: number` and
  `height?: number` to `AppWindowHints` (the runtime objects already carry them: `apps/src/registry.ts`
  passes the whole `AppWindowSpec`). fix-desktop-shell owns the rest (`Prefs` and so on).
- **C3: window preferences through `<html>` data attributes (UI-040 / UI-041).** fix-desktop-shell's
  `applyPrefs` (`wm/src/shell/prefs.ts`) writes `data-title-dblclick="zoom|minimise|none"` and
  `data-minimise-effect="genie|scale"` on the document element from the Settings keys
  `windows.doubleClickTitle` and `dock.minimiseEffect`. fix-windows reads them at the moment of the
  double-click or minimise, defaulting to `zoom` and `genie` when absent. Each side works and is tested
  without the other.
- **C4: `window.setCloseGuard` (UI-036 / UI-037).** Syscall `window.setCloseGuard`, args
  `{ wid: Wid, reason: string | null }` (reason ≤ 256 chars), caps `['window']`, EPERM when the caller
  does not own `wid`, EINVAL for an unknown wid. The kernel posts `{t:'closeGuard', wid, reason}` on the
  compositor port; the shell already turns that into the in-window "Discard unsaved changes" dialog
  (`wm/src/shell/kernel-link.ts`, `Desktop.tsx` `closeGuards`). The Editor calls it with a reason when a
  document becomes dirty and with `null` after a save, a revert or a close; an `ENOSYS` answer is
  treated as "no guard" (no error shown).
- **C5: CSP.** Keep the strict `style-src 'self' 'sha256-…'` policy. Do **not** add `'unsafe-inline'`
  (security-model.md §3.9, SEC-02) without an ADR. The adopted-stylesheet mirror
  (`ui/src/primitives/internal/csp-styles.ts`) stays; violations are removed at their source
  (UI-050, UI-051, UI-091, UI-118, UI-147, UI-137).

### QA rules for every fixer

- Use only the QA copy on 4718 (project `plotinium-qa`). Rebuild with
  `bash $Q/qa-compose.sh up -d --wait --build web app` (Q = the scratchpad `qa/` folder). The plain
  `PLOTINIUM_PORT=4718 docker compose -p plotinium-qa up …` fails with "Pool overlaps" (qa-setup).
  Never `down -v`. Never touch project `plotinium` on 4717.
- A docker build copies the whole working tree, including other fixers' half-done edits. Build only
  when `tsc` is green for the packages you touched.
- Sign in with your own `$Q/state-<fixer>.json`; never log out with it. Guest sign-ins are limited to
  3 per hour for the whole machine until UI-005 lands: mock `/api/auth/guest` with `context.route`.
- Dev server: `PLOTINIUM_API_TARGET=http://127.0.0.1:4718 pnpm --filter @plotinium/web dev --port <p>`
  (ports 5301–5307, see `$Q/README.txt`). It sends no CSP, has no Service Worker and 20x timeouts, so
  confirm CSP, SW and timing results on 4718.
- Screenshots go under `docs/design/polish/<your-fixer-key>/`; read them before you report.

---

## 2. Summary (priority order)

| Id     | Sev      | Owner                  | Title                                                                                                          | Status           |
| ------ | -------- | ---------------------- | -------------------------------------------------------------------------------------------------------------- | ---------------- |
| UI-001 | blocker  | fix-boot-login         | Login re-runs its reset effects every second: password cleared, focus stolen, shake with no error              | VERIFIED-FIXED   |
| UI-002 | blocker  | fix-system-services    | Editor cannot save a file it edited: its own X lease makes the write fail with EBUSY                           | VERIFIED-FIXED   |
| UI-003 | major    | fix-boot-login         | Boot splash mark breaks apart during boot: the electron and shell gap rotate onto the stem (logo regression)   | VERIFIED-FIXED   |
| UI-004 | major    | fix-apps-settings-a11y | Geist Mono renders `r` like `ɪ` at 12–14 px on 1x screens (`drwxɪ-xɪ-x`, `ɪoot`) (font regression)             | VERIFIED-FIXED   |
| UI-005 | major    | fix-boot-login         | (known d) Guest 429/403 gives no feedback; guest back-off blocks password users; guest limit not profile-aware | VERIFIED-FIXED   |
| UI-006 | major    | fix-system-services    | (known c) sync "client not linked": no WebSocket, lockd local-only, ai.agent "requires sync"                   | VERIFIED-FIXED   |
| UI-007 | major    | fix-system-services    | (known c) Service Worker never registered: update degraded, offline boot impossible                            | VERIFIED-FIXED   |
| UI-008 | major    | fix-system-services    | (known e) Build id `0000000`/`unknown` in Docker; web and server identities disagree                           | VERIFIED-FIXED   |
| UI-009 | major    | fix-files-editor       | (known b) Files list header labels overlap ('Date ModSizeKind'), Permissions spills into the inspector         | VERIFIED-FIXED   |
| UI-010 | major    | fix-files-editor       | (known b) Files path bar hides the current folder (last crumb 0 px: '/ › home')                                | VERIFIED-FIXED   |
| UI-011 | major    | fix-windows            | Windows ignore the app manifests' sizes and open at 720×480 (or their minimum)                                 | VERIFIED-FIXED   |
| UI-012 | major    | fix-system-services    | Signed-in user shown as `u<uid>` (prompt, whoami, titles, Files, Settings, Task Manager)                       | VERIFIED-FIXED   |
| UI-013 | major    | fix-boot-login         | Inline boot-CSS compactor removes descendant spaces before `:` and breaks 6 boot selectors                     | VERIFIED-FIXED   |
| UI-014 | major    | fix-files-editor       | Files drops a single-file selection ~150 ms after the click (inspector, Enter, Delete, F2 dead)                | VERIFIED-FIXED   |
| UI-015 | major    | fix-files-editor       | Every window-level Files shortcut is dead (window frame is `role=dialog`); Editor Ctrl+Alt+O too               | VERIFIED-FIXED   |
| UI-016 | major    | fix-files-editor       | Files background context menu never opens                                                                      | VERIFIED-FIXED   |
| UI-017 | major    | fix-windows            | After a restore, focus lands on the Minimise light; Enter minimises again                                      | VERIFIED-FIXED   |
| UI-018 | major    | fix-windows            | Click-to-focus, dock launch, Alt+M and Alt+Q never move keyboard focus into the window                         | VERIFIED-FIXED   |
| UI-019 | major    | fix-windows            | Shrinking a window leaves the content box at its old size (content clipped, no refit)                          | VERIFIED-FIXED   |
| UI-020 | major    | fix-terminal           | Hidden Terminal tabs are resized to 10×4 cells (broken prompt and wrapped output)                              | VERIFIED-FIXED   |
| UI-021 | major    | fix-terminal           | Keyboard focus falls to `<body>` after a Terminal tab closes                                                   | VERIFIED-FIXED   |
| UI-022 | major    | fix-terminal           | Terminal tab shortcuts use Chrome-reserved keys (Ctrl+Shift+W closes the browser window)                       | VERIFIED-FIXED   |
| UI-023 | major    | fix-desktop-shell      | Menu-bar atom/app titles re-mount on every status event: focus lost, menus flicker, label re-animates          | VERIFIED-FIXED   |
| UI-024 | major    | fix-desktop-shell      | Notification banners sit above Control Centre and Overview and swallow clicks                                  | VERIFIED-FIXED   |
| UI-025 | major    | fix-desktop-shell      | Connectivity popover always says "You're offline"; sync chip says "all changes synced" while sync is degraded  | VERIFIED-FIXED   |
| UI-026 | major    | fix-system-services    | Net state is "online" with no sync engine; the shell gets no outbox, so chip and list disagree                 | VERIFIED-FIXED   |
| UI-027 | major    | fix-desktop-shell      | Lock screen does not make the desktop inert (Tab reaches menus; Search stays open after unlock)                | VERIFIED-FIXED   |
| UI-028 | major    | fix-desktop-shell      | System menu has no "Log Out <user>…"                                                                           | VERIFIED-FIXED   |
| UI-029 | major    | fix-desktop-shell      | Overview thumbnails of normal windows are not scaled (cropped 1:1 corner)                                      | VERIFIED-FIXED   |
| UI-030 | major    | fix-boot-login         | Kernel panic screen lacks BOOT-08 recovery features; reason hidden; medal squashed                             | VERIFIED-FIXED   |
| UI-031 | major    | fix-boot-login         | On the halted/takeover screens Enter does nothing; the login stays live underneath                             | VERIFIED-FIXED   |
| UI-032 | major    | fix-system-services    | A boot on a slow network ends in "sched failed: timeout 500 ms"                                                | VERIFIED-FIXED   |
| UI-033 | major    | fix-windows            | Double-clicking the unified toolbar (Files, Settings, Task Manager) never zooms                                | VERIFIED-FIXED   |
| UI-034 | major    | fix-windows            | WM-06 restore loses/reorders windows: compositor does not report geometry, snap and z                          | VERIFIED-FIXED   |
| UI-035 | major    | fix-system-services    | WM-06 restore: kernel mirror drops rect-less windows and SessionIo prefers the stale mirror                    | VERIFIED-FIXED   |
| UI-036 | major    | fix-system-services    | No `window.setCloseGuard` syscall, so no app can guard a close (WMD-12)                                        | VERIFIED-FIXED   |
| UI-037 | major    | fix-files-editor       | Closing a dirty Editor loses the text with no prompt (sets no close guard)                                     | STILL-BROKEN     |
| UI-038 | major    | fix-windows            | No snap preview while dragging into a snap zone (WMD-07)                                                       | VERIFIED-FIXED   |
| UI-039 | major    | fix-apps-settings-a11y | Accent colour setting has no visible effect                                                                    | VERIFIED-FIXED   |
| UI-040 | major    | fix-desktop-shell      | Settings saved but not applied: 24-hour clock, Dock size, magnified size, auto-hide, indicators                | VERIFIED-FIXED   |
| UI-041 | major    | fix-windows            | Settings saved but not applied: title-bar double-click action, minimise effect                                 | VERIFIED-FIXED   |
| UI-042 | major    | fix-apps-settings-a11y | Settings controls with no consumer silently do nothing                                                         | VERIFIED-FIXED   |
| UI-043 | major    | fix-apps-settings-a11y | Task Manager state pill on the selected row is illegible (1.3–2.6:1)                                           | VERIFIED-FIXED   |
| UI-044 | major    | fix-apps-settings-a11y | Task Manager "View as table" collapses the process table to 4 px                                               | VERIFIED-FIXED   |
| UI-045 | major    | fix-system-services    | Search palette has no search provider (files, semantic, commands)                                              | VERIFIED-FIXED   |
| UI-046 | major    | fix-desktop-shell      | Search palette promises file/semantic search that it cannot do                                                 | VERIFIED-FIXED   |
| UI-047 | major    | fix-system-services    | Control Centre memory budget slider always "Not available in this session"                                     | VERIFIED-FIXED   |
| UI-048 | major    | fix-files-editor       | Files search finds nothing in either mode; no keyword fallback or notice                                       | VERIFIED-FIXED   |
| UI-049 | major    | fix-system-services    | ai.indexer never indexes the user's local files ("indexed 0 files")                                            | VERIFIED-FIXED   |
| UI-050 | major    | fix-terminal           | xterm's runtime `<style>` elements still raise 12 CSP violations per Terminal                                  | VERIFIED-FIXED   |
| UI-051 | major    | fix-files-editor       | CodeMirror's style-mod `<style>` raises a CSP violation per Editor                                             | VERIFIED-FIXED   |
| UI-052 | major    | fix-files-editor       | Files view switcher squeezes to 50 px; radios overlap, thumb misplaced                                         | VERIFIED-FIXED   |
| UI-053 | major    | fix-terminal           | `man` has no pages at all                                                                                      | VERIFIED-FIXED   |
| UI-054 | major    | fix-terminal           | `find` and `du` crash ("not available here")                                                                   | VERIFIED-FIXED   |
| UI-055 | major    | fix-terminal           | `ai` always says "agent unavailable (not installed)"                                                           | STILL-BROKEN     |
| UI-056 | major    | fix-terminal           | Processes started in the Terminal never appear in Task Manager (architectural)                                 | STILL-BROKEN     |
| UI-057 | major    | fix-system-services    | Recovery console actions do nothing: the kernel drops `recovery.run`                                           | VERIFIED-FIXED   |
| UI-058 | major    | fix-system-services    | Stage-2 boot-volume read is a stub: no auto-safe boot, manifests never read                                    | VERIFIED-FIXED   |
| UI-059 | major    | fix-windows            | 10-window drag/resize run: p95 33 ms, 73 LoAF > 50 ms (headless; re-measure)                                   | NOT-REPRODUCIBLE |
| UI-060 | minor    | fix-boot-login         | Recovery console says "its report follows" and then nothing, forever                                           | VERIFIED-FIXED   |
| UI-061 | minor    | fix-boot-login         | Splash first paint jumps ~20 px and swaps font mid-boot (boot-ui must use the system stack, D-05)              | VERIFIED-FIXED   |
| UI-062 | minor    | fix-boot-login         | Verbose log stops following after a large batch ("↓ 479 new lines")                                            | VERIFIED-FIXED   |
| UI-063 | minor    | fix-system-services    | Duplicate klog line "storage: WARN persistent storage denied"                                                  | VERIFIED-FIXED   |
| UI-064 | minor    | fix-boot-login         | Login power row and corners differ from D-17 (Sleep, Esc, Forgot password, Accessibility)                      | VERIFIED-FIXED   |
| UI-065 | minor    | fix-boot-login         | Rate-limit countdown is announced every second                                                                 | VERIFIED-FIXED   |
| UI-066 | minor    | fix-boot-login         | Boot menu keys stop working after a click outside the panel                                                    | VERIFIED-FIXED   |
| UI-067 | minor    | fix-boot-login         | "V Verbose log" chip gets out of step with the V key                                                           | VERIFIED-FIXED   |
| UI-068 | minor    | fix-boot-login         | Recovery console layout: list clipped at 1280×800, traffic-light dots, Esc ignored                             | VERIFIED-FIXED   |
| UI-069 | minor    | fix-boot-login         | Unsupported-browser screen hard-codes `http://localhost:4717`                                                  | VERIFIED-FIXED   |
| UI-070 | minor    | fix-boot-login         | Login tile initials below 3:1 contrast                                                                         | VERIFIED-FIXED   |
| UI-071 | minor    | fix-desktop-shell      | AI chip stuck at "AI 100%, indexing"                                                                           | VERIFIED-FIXED   |
| UI-072 | minor    | fix-desktop-shell      | Frame meter HUD covers Control Centre and banners; says "fps" for Hz; counts boot LoAFs                        | VERIFIED-FIXED   |
| UI-073 | minor    | fix-desktop-shell      | Clicking the Control Centre trigger (or clock) again closes and re-opens it                                    | VERIFIED-FIXED   |
| UI-074 | minor    | fix-desktop-shell      | Service "Retry now" sticks at "Retrying…"; row buttons truncated                                               | VERIFIED-FIXED   |
| UI-075 | minor    | fix-system-services    | `svc.retry` is never answered and a degraded service cannot be retried                                         | VERIFIED-FIXED   |
| UI-076 | minor    | fix-desktop-shell      | "About <App>" opens About Plotinium                                                                            | VERIFIED-FIXED   |
| UI-077 | minor    | fix-desktop-shell      | Help items do nothing; Keyboard Shortcuts and the AI chip open the wrong Settings section                      | VERIFIED-FIXED   |
| UI-078 | minor    | fix-desktop-shell      | Dock keyboard: Alt+N lands on Trash; Esc and closing the item menu lose focus                                  | VERIFIED-FIXED   |
| UI-079 | minor    | fix-desktop-shell      | Notification group "+N from <App>" button cannot be clicked                                                    | VERIFIED-FIXED   |
| UI-080 | minor    | fix-desktop-shell      | Repeated notifications are neither rate-limited nor collapsed                                                  | VERIFIED-FIXED   |
| UI-081 | minor    | fix-desktop-shell      | Alt+C does not focus Control Centre; Esc does not return focus                                                 | VERIFIED-FIXED   |
| UI-082 | minor    | fix-desktop-shell      | Notification card: Delete drops focus; Escape deletes the notification                                         | VERIFIED-FIXED   |
| UI-083 | minor    | fix-desktop-shell      | Wallpaper click does not unfocus windows; Overview ignores empty clicks; bars stay in Overview                 | VERIFIED-FIXED   |
| UI-084 | minor    | fix-desktop-shell      | Dock Trash opens Files at home, not the Trash                                                                  | VERIFIED-FIXED   |
| UI-085 | minor    | fix-desktop-shell      | Status items: wrong aria-expanded, duplicate names, no nav landmarks, memory label                             | VERIFIED-FIXED   |
| UI-086 | minor    | fix-desktop-shell      | App menu "Quit <App> Alt+Q" misleads; "Quit Plotinium" is dead                                                 | VERIFIED-FIXED   |
| UI-087 | minor    | fix-desktop-shell      | App menu shortcuts are shown but not bound (Ctrl+1–4, Ctrl+R, Alt+Ctrl+Q)                                      | VERIFIED-FIXED   |
| UI-088 | minor    | fix-desktop-shell      | Global Tab cycle has an invisible `<body>` stop                                                                | VERIFIED-FIXED   |
| UI-089 | minor    | fix-desktop-shell      | Menu-bar chips below 4.5:1 on glass ("4 degraded", "AI 100%")                                                  | VERIFIED-FIXED   |
| UI-090 | minor    | fix-desktop-shell      | Memory meter rounds to "0/256 MB"; formats differ per surface                                                  | VERIFIED-FIXED   |
| UI-091 | minor    | fix-desktop-shell      | Static `style={{…}}` literals in shell/overlays raise CSP style-src-attr errors                                | VERIFIED-FIXED   |
| UI-092 | minor    | fix-desktop-shell      | Test contract: `data-app="taskmgr"` but the contract says `task-manager`                                       | VERIFIED-FIXED   |
| UI-093 | minor    | fix-desktop-shell      | Dock shows no minimised marker and does not say "minimised"                                                    | VERIFIED-FIXED   |
| UI-094 | minor    | fix-windows            | Window menu: Esc loses focus; Overview greyed with no window; no Move/Size/Full screen; no right-click         | VERIFIED-FIXED   |
| UI-095 | minor    | fix-windows            | Restoring a drag-snapped window returns it to the release point, mostly off-screen                             | VERIFIED-FIXED   |
| UI-096 | minor    | fix-windows            | Narrow viewports: snapped/maximised below min sizes, no compact mode, shrink is permanent                      | VERIFIED-FIXED   |
| UI-097 | minor    | fix-files-editor       | Files status bar texts overlap at narrow widths                                                                | VERIFIED-FIXED   |
| UI-098 | minor    | fix-files-editor       | Path bar "…" menu opens at the top-left of the screen                                                          | VERIFIED-FIXED   |
| UI-099 | minor    | fix-files-editor       | Editor toasts never dismiss (Files toast effect has the same pitfall)                                          | VERIFIED-FIXED   |
| UI-100 | minor    | fix-files-editor       | Ctrl+Shift+S runs Save instead of Save As                                                                      | VERIFIED-FIXED   |
| UI-101 | minor    | fix-files-editor       | Editor has no find (DEFERRED: needs `@codemirror/search`, not installed)                                       | STILL-BROKEN     |
| UI-102 | minor    | fix-files-editor       | Save As defaults to a missing `~/Documents/untitled.md` and fails with ENOENT                                  | VERIFIED-FIXED   |
| UI-103 | minor    | fix-files-editor       | After "+ New tab" focus stays on "+"; Space opens another tab                                                  | VERIFIED-FIXED   |
| UI-104 | minor    | fix-files-editor       | Opening an already-open file spawns a second, read-only Editor window                                          | VERIFIED-FIXED   |
| UI-105 | minor    | fix-files-editor       | Files list stays stale after a file's content changes                                                          | VERIFIED-FIXED   |
| UI-106 | minor    | fix-files-editor       | Inspector History and Share show an unrelated toast                                                            | VERIFIED-FIXED   |
| UI-107 | minor    | fix-files-editor       | Trash: no Undo, no Put Back, "Move to Trash" inside the Trash, ".Trash" title, clock icon                      | VERIFIED-FIXED   |
| UI-108 | minor    | fix-files-editor       | Focus falls to `<body>` after sheets and empty-space clicks (Ctrl+A selects the page)                          | VERIFIED-FIXED   |
| UI-109 | minor    | fix-files-editor       | No drop-target highlight on a folder row                                                                       | VERIFIED-FIXED   |
| UI-110 | minor    | fix-files-editor       | Menu-bar File/Go items ignore context and fail silently                                                        | VERIFIED-FIXED   |
| UI-111 | minor    | fix-files-editor       | Columns and Gallery buttons disabled with no explanation                                                       | VERIFIED-FIXED   |
| UI-112 | minor    | fix-files-editor       | Session restore reopens Editor windows as empty "Untitled", and they pile up                                   | STILL-BROKEN     |
| UI-113 | minor    | fix-files-editor       | Files window has two h2 headings with the same name                                                            | VERIFIED-FIXED   |
| UI-114 | minor    | fix-files-editor       | Files list fails axe: aria-required-children (critical), target-size (serious)                                 | VERIFIED-FIXED   |
| UI-115 | minor    | fix-files-editor       | Files labels Home as the user name and compares ownership by name (chmod unreachable)                          | VERIFIED-FIXED   |
| UI-116 | minor    | fix-files-editor       | DocumentTabs: selected tab not scrolled into view; bell labelled "command failed"                              | VERIFIED-FIXED   |
| UI-117 | minor    | fix-files-editor       | Editor status bar says "✓ synced" while sync is not linked                                                     | VERIFIED-FIXED   |
| UI-118 | minor    | fix-files-editor       | Static `style={{…}}` literals in Files/Editor raise CSP style-src-attr errors                                  | VERIFIED-FIXED   |
| UI-119 | minor    | fix-terminal           | `top` header shows the monotonic clock, not the time of day                                                    | VERIFIED-FIXED   |
| UI-120 | minor    | fix-terminal           | Interactive `top` ignores `q`, which later leaks into the shell                                                | VERIFIED-FIXED   |
| UI-121 | minor    | fix-terminal           | Terminal relay polls every 4–100 ms, flooding klog and waking the CPU                                          | STILL-BROKEN     |
| UI-122 | minor    | fix-terminal           | Terminal tab labels are not unique                                                                             | VERIFIED-FIXED   |
| UI-123 | minor    | fix-terminal           | Completion "service unavailable" in every session; flag completion does nothing                                | VERIFIED-FIXED   |
| UI-124 | minor    | fix-terminal           | `semsearch` with no results prints nothing (and `--json` prints nothing)                                       | NOT-REPRODUCIBLE |
| UI-125 | minor    | fix-terminal           | `su` and `lsof` fail with internal developer messages                                                          | VERIFIED-FIXED   |
| UI-126 | minor    | fix-terminal           | Terminal has no Edit menu and no keyboard copy                                                                 | VERIFIED-FIXED   |
| UI-127 | minor    | fix-terminal           | A restored Terminal window shows no previous text                                                              | STILL-BROKEN     |
| UI-128 | minor    | fix-terminal           | Terminal grid is 18 px wider than its viewport (last column clipped)                                           | VERIFIED-FIXED   |
| UI-129 | minor    | fix-terminal           | Open With > Terminal starts in `~`, not the file's folder                                                      | VERIFIED-FIXED   |
| UI-130 | minor    | fix-terminal           | Terminal fallback font constant and manifest size still assume the old mono face                               | VERIFIED-FIXED   |
| UI-131 | minor    | fix-terminal           | (known f) Terminal input end to end: works; lock it in with an e2e test                                        | VERIFIED-FIXED   |
| UI-132 | minor    | fix-apps-settings-a11y | ai.indexer shown as "pid 0"                                                                                    | VERIFIED-FIXED   |
| UI-133 | minor    | fix-system-services    | Memory accounting uncalibrated; per-process resident bytes always 0                                            | STILL-BROKEN     |
| UI-134 | minor    | fix-system-services    | Every boot warns "ai.predictor stopped — ai.runtime is down" (dependency race)                                 | VERIFIED-FIXED   |
| UI-135 | minor    | fix-system-services    | `bootlog` loses the boot timeline (klog ring flooded); `--list` not implemented                                | VERIFIED-FIXED   |
| UI-136 | minor    | fix-system-services    | After a redeploy, opening an app shows "Failed to fetch dynamically imported module"                           | NOT-REPRODUCIBLE |
| UI-137 | minor    | fix-system-services    | Trusted Types report-only: ~150 console messages per session, reported nowhere                                 | VERIFIED-FIXED   |
| UI-138 | minor    | fix-apps-settings-a11y | CPU per executor shows one card while the summary says 11 executors                                            | VERIFIED-FIXED   |
| UI-139 | minor    | fix-apps-settings-a11y | In-app notice toasts cover content and controls                                                                | VERIFIED-FIXED   |
| UI-140 | minor    | fix-apps-settings-a11y | Tab from the Renice popover's Apply drops focus to `<body>`                                                    | VERIFIED-FIXED   |
| UI-141 | minor    | fix-apps-settings-a11y | Misleading status text in Settings and Task Manager                                                            | VERIFIED-FIXED   |
| UI-142 | minor    | fix-apps-settings-a11y | Telemetry "Time" column in UTC                                                                                 | VERIFIED-FIXED   |
| UI-143 | minor    | fix-apps-settings-a11y | Settings > About layout breaks at 880 px                                                                       | VERIFIED-FIXED   |
| UI-144 | minor    | fix-apps-settings-a11y | Missing test ids: `task-manager`, `settings`, `theme-toggle`                                                   | VERIFIED-FIXED   |
| UI-145 | minor    | fix-apps-settings-a11y | Text contrast below 4.5:1 in Task Manager and Settings                                                         | VERIFIED-FIXED   |
| UI-146 | minor    | fix-apps-settings-a11y | Controls that look active but cannot work (pin, Change password, Licences, …)                                  | VERIFIED-FIXED   |
| UI-147 | minor    | fix-apps-settings-a11y | Static `style={{…}}` literals in primitives/Task Manager/Settings raise CSP errors                             | VERIFIED-FIXED   |
| UI-148 | minor    | fix-apps-settings-a11y | Specs and docs still describe the old logo and fonts                                                           | VERIFIED-FIXED   |
| UI-149 | cosmetic | fix-boot-login         | While unlocking, the hint still says "Press Enter to sign in"                                                  | VERIFIED-FIXED   |
| UI-150 | cosmetic | fix-boot-login         | Login clock read digit by digit ("0 9 : 5 5")                                                                  | VERIFIED-FIXED   |
| UI-151 | cosmetic | fix-desktop-shell      | Warning notifications use the Info tile; footer wraps; card shadows clipped                                    | VERIFIED-FIXED   |
| UI-152 | cosmetic | fix-desktop-shell      | (known a) Menu-bar mark: legible now, but 17 px on a half pixel with a 3 px glow is soft                       | VERIFIED-FIXED   |
| UI-153 | cosmetic | fix-desktop-shell      | The About window gets a Dock tile drawn as the bare mark                                                       | VERIFIED-FIXED   |
| UI-154 | cosmetic | fix-windows            | Snapped windows keep 14 px corners on the screen edge (D-24)                                                   | VERIFIED-FIXED   |
| UI-155 | cosmetic | fix-windows            | Cascade wraps after 8 windows (9th and 10th cover the 1st and 2nd)                                             | VERIFIED-FIXED   |
| UI-156 | cosmetic | fix-windows            | Open animation grows from 50% 60%, not from the dock icon                                                      | VERIFIED-FIXED   |
| UI-157 | cosmetic | fix-files-editor       | Search placeholder cut mid-word                                                                                | VERIFIED-FIXED   |
| UI-158 | cosmetic | fix-files-editor       | "Choose…" misaligned in Open With                                                                              | VERIFIED-FIXED   |
| UI-159 | cosmetic | fix-terminal           | Small output errors: kill errno, df unit, ps -p exit code                                                      | VERIFIED-FIXED   |
| UI-160 | cosmetic | fix-apps-settings-a11y | Raw kernel identifiers in the process list (`[sched]`, `svc:ai.predictor`)                                     | VERIFIED-FIXED   |
| UI-161 | cosmetic | fix-apps-settings-a11y | Frame-time card wording contradicts itself                                                                     | VERIFIED-FIXED   |
| UI-162 | cosmetic | fix-apps-settings-a11y | View menu labels differ from the sidebar; Pause never becomes Resume                                           | STILL-BROKEN     |
| UI-163 | cosmetic | fix-apps-settings-a11y | Empty device name accepted; section subtitles cut off                                                          | VERIFIED-FIXED   |
| UI-164 | cosmetic | fix-apps-settings-a11y | About pane keeps stale old-logo CSS and a −30° rotate entrance                                                 | VERIFIED-FIXED   |
| UI-165 | cosmetic | fix-system-services    | Caddy compresses `/models` on the fly, so no Content-Length                                                    | VERIFIED-FIXED   |
| UI-166 | cosmetic | fix-system-services    | WebSocket close reason is always "shutdown"                                                                    | VERIFIED-FIXED   |

Counts: 2 blocker, 57 major, 89 minor, 18 cosmetic (166). Per owner: fix-boot-login 18,
fix-desktop-shell 33, fix-windows 15, fix-files-editor 33, fix-terminal 22, fix-apps-settings-a11y 22,
fix-system-services 23. The 7 finders reported 165 bugs (21 + 26 + 21 + 32 + 22 + 27 + 16); duplicates were merged, cross-owner bugs
were split into one id per owner, and the triage added 3 (UI-003, UI-004, UI-128); see "Sources" in
each entry.

### Status summary (stabilization close-out, 2026-09-30)

The Status column merges the fixers' tables (`status/*.md`) with the independent verifiers' reports
(`verify/verify-a.md`, `verify-b.md`, `verify-c.md`). Where they differ, the verifier's verdict wins.
Every one of the 166 bugs has a verifier verdict, so no row is FIXED-UNVERIFIED. A bug that a verifier
found still broken, fixed, and re-checked on a rebuilt QA copy is VERIFIED-FIXED.

| Severity  | Total | VERIFIED-FIXED | FIXED-UNVERIFIED | STILL-BROKEN | NOT-REPRODUCIBLE | WONTFIX |
| --------- | ----: | -------------: | ---------------: | -----------: | ---------------: | ------: |
| blocker   |     2 |              2 |                0 |            0 |                0 |       0 |
| major     |    57 |             53 |                0 |            3 |                1 |       0 |
| minor     |    89 |             82 |                0 |            5 |                2 |       0 |
| cosmetic  |    18 |             17 |                0 |            1 |                0 |       0 |
| **Total** |   166 |            154 |                0 |            9 |                3 |       0 |

- STILL-BROKEN (9): UI-037, UI-055, UI-056 (major); UI-101, UI-112, UI-121, UI-127, UI-133 (minor);
  UI-162 (cosmetic). UI-056 and UI-101 were deferred by design (the fixers marked them WONTFIX); the
  others are partial fixes that need kernel, wm, web or protocol work (UI-133 also needs calibration
  on lab hardware). All are in the Workflow B backlog; see `docs/design/polish/REPORT.md` §4.
- NOT-REPRODUCIBLE (3): UI-059 (no long frames from our code with a GPU; headless only is noisy),
  UI-124 (semantic search always returns hits, so the "no results" path cannot be reached) and UI-136
  (needs a redeploy between chunk loads). Each is covered by a unit test or a measurement.

---

## 3. Details

### P0: blockers

#### UI-001 · blocker · Login re-runs its reset effects every second

- **Owner:** fix-boot-login · **Area:** login and lock screen · **Sources:** boot-login #1, qa-setup (A)
- **Repro:** Fresh context (no cookie) on 4718, wait for the login screen. (1) Leave it idle; (2) type 1 character every 250 ms; (3) type `abcdef`, click the eye; (4) Tab to Sleep, or ArrowRight to alice, or click Restart and wait 1 s.
- **Expected:** The password stays until submit or a user change; Show password stays on; focus stays where the user put it; the shake plays only after a failed sign-in (ui-implementation-guide §3.4.4).
- **Actual:** On every 1 s clock tick: the pill plays `pl-login-shake` while idle; the typed length goes 1,2,3,0; the eye resets with the field emptied; focus jumps back to "Password for demo" from Sleep, a tile or the Restart confirm. Slow typists cannot sign in; keyboard users cannot reach the power buttons. The lock screen uses the same component.
- **Evidence:** `bug-hunt/boot-login/login-idle-shake-filmstrip.png`, `login-shake.json`, `login-focus.json`, `login-focus-after-tab.png`, `login-eye-revealed.png`, `demo-signin.json`
- **Suspected files:** `wm/src/shell/Login.tsx` (lines ~101–106), `ui/src/login/LoginScreen.tsx` (lines ~216–238)
- **Fix notes:** `retryInS()` reads the 1 s `clock()`; the conditional spreads make Solid's `mergeProps` read every prop through a function that tracks it, and `on(() => local.selectedId)` fires on every notification. Pass plain props (`retryInS={retryInS()}` typed `number | undefined`, and so on) and key the effects on `createMemo(() => local.selectedId)` / `createMemo(() => local.errorKey)`.
- **Done when:** a fake-timer vitest advances ≥ 5 ticks and asserts value, focus and reveal are kept and no shake class is added; a Playwright run types at 1 char/400 ms and signs in; focus on Sleep survives 3 s.

#### UI-002 · blocker · Editor cannot save a file it edited (EBUSY from its own lease)

- **Owner:** fix-system-services · **Area:** Editor save, VFS locks (VFS-09, VFS-10) · **Sources:** files-editor #1
- **Repro:** Sign in as demo, Files > ~/Projects, open `kernel.ts` in the Editor, type a character (chip: "Editing — you hold the lock"), press Ctrl+S.
- **Expected:** "saved v2"; the writer's own lease never blocks its own writes; another process still gets EBUSY.
- **Actual:** Red banner "Not saved: The item is in use or locked by someone else (EBUSY)". Saving works only after releasing your own lock. Files "Lock for Editing" behaves the same.
- **Evidence:** `bug-hunt/files-editor/57-editor-after-save.png`, `61-second-save.png`, `65-editor-A-after-release-save.png`
- **Suspected files:** `kernel/src/core/io/index.ts` (~416 `busy: (ino) => localLocks.holders(ino).some((l) => l.mode === 'X')`), `kernel/src/core/fs/handlers.ts` (~141), `kernel/src/core/fs/kfs.ts`
- **Fix notes:** pass the caller (pid or session) into `isBusy(ino, caller)` and ignore holders that are the caller, as `vfs/src/locks/lockd.ts` (~148–156) already does. Do not weaken VFS-09 for other writers.
- **Done when:** kernel test: acquire X, write from the same pid succeeds, from another pid gets EBUSY; on 4718 edit + Ctrl+S shows "saved v2" twice in a row.

### P1: major

#### UI-003 · major · Boot splash mark breaks apart during boot (logo regression)

- **Owner:** fix-boot-login · **Area:** boot splash logo animation · **Sources:** triage (new; the logo report checked only early frames)
- **Repro:** Fresh context on 4718, light or dark, no reduced motion. Watch the splash mark from 0 to ~1 s (or read the filmstrip).
- **Expected:** The mark stays a clean "Bohr P" at every step: the electron and the shell gap may move, but never onto the stem.
- **Actual:** `.plb-orbit` (shell + electron) rotates `--plb-tick × 12°` while the stem stays still. A normal boot reaches tick 17 (204°), which puts the electron on the stem and opens the shell gap where the stem joins: the settled splash shows a "p" with a lump and a notch on its stem until the login screen.
- **Evidence:** `polish/triage/bootlogo-dark-filmstrip.png`, `polish/triage/bootlogo-light-filmstrip.png` (ticks 0 → 17), `polish/triage/boot-light-500ms-logo-zoom4.png` vs `polish/triage/boot-light-150ms-logo-zoom4.png`
- **Suspected files:** `ui/src/boot/logo.ts`, the logo section of `ui/src/boot/boot.css` (`.plb-orbit` rule ~l.164–166)
- **Fix notes:** keep the artwork (`ui/src/icons/atom-logo.ts`) unchanged. Constrain the motion to a sector that never meets the stem (for example ping-pong the orbit angle within a safe arc computed from `ATOM_SHELL_CENTRE` and the stem geometry), or move only what cannot collide. Reduced motion must keep the mark still.
- **Done when:** a unit test renders ticks 0…40 and asserts the electron and gap never intersect the stem's box; a filmstrip at 1x and 2x in both themes shows a clean mark at every tick, including the settled one.

#### UI-004 · major · Geist Mono renders `r` like `ɪ` at 12–14 px on 1x screens (font regression)

- **Owner:** fix-apps-settings-a11y (owns `ui/src/tokens/**`) · **Area:** typography, Terminal, Files permissions, paths · **Sources:** triage (new), files-editor #29 (permissions column), fonts report
- **Repro:** 4718 at deviceScaleFactor 1: open Terminal, run `ls -la /`; or look at the Files Permissions column or any mono path.
- **Expected:** Mono text is unambiguous at 12–14 px on a 1x screen (the lab machines may be 1x).
- **Actual:** `drwxr-xr-x` reads `drwxɪ-xɪ-x`, `root` reads `ɪoot`, `error` reads `eɪɪoɪ`, `/home/examiner1` reads `examineɪ1`, at 12, 13 and 14 px, weights 400 and 450, light and dark. JetBrains Mono (the D-05 face, runner-up in the D15 scoring) and Google Sans Code render `r` correctly at the same sizes. At 2x all three are fine, which is why the D15 review missed it.
- **Evidence:** `polish/triage/mono-r-compare-1x.png`, `polish/triage/mono-r-compare-14px-zoom3.png`, `polish/triage/terminal-light-r-zoom4.png`, `bug-hunt/files-editor/110-permissions-column-zoom.png`
- **Suspected files:** `ui/src/tokens/fonts.css` (mono `@font-face` blocks), `ui/src/tokens/tokens.css` (`--pl-font-mono`), `docs/design/fonts/DECISION.md`, D15 addendum in `specs/15-decisions/stack-decisions.md`
- **Fix notes:** switch the mono role to **JetBrains Mono Variable** (`@fontsource-variable/jetbrains-mono`, already installed; OFL-1.1; latin + latin-ext `@font-face` like the current blocks) unless a 1x re-test proves another installed face better. Re-score the legibility criterion with 1x evidence and record it in DECISION.md and the D15 addendum. Check `tree` box-drawing glyphs (they may fall back per character; that is acceptable if cells stay aligned). Keep the Terminal re-measure path (`whenFontLoaded` reads the token). Update `THIRD_PARTY.md` in the same change (UI-148). fix-terminal updates its fallback constant separately (UI-130). Do not run `pnpm add`/`install`.
- **Done when:** 1x and 2x screenshots of Terminal `ls -la /`, `tree -L 1 /` and the Files Permissions column in both themes read correctly; DSN-39 (tokens ≤ 5 KB gzip) and the ui token tests pass.

#### UI-005 · major · (known d) Guest 429/403 gives no feedback; back-off blocks other users; guest limit not profile-aware

- **Owner:** fix-boot-login · **Area:** login (guest), server rate limits (BOOT-14, SRV-09) · **Sources:** boot-login #8, system-services #5 and #13, known issue (d)
- **Repro:** Mock `POST /api/auth/guest` with the server's real 429 body `{errno:'EAGAIN',reason:'rate',retryAfterMs:1186400,detail:{class:'guest-ip'}}` + `Retry-After` (and separately a 403). Pick Guest, click "Continue as Guest" twice, then select demo.
- **Expected:** A visible, announced message ("Too many guest sessions from this network. Try again in 20 min"), the button disabled with a countdown; 403 says "Guest accounts are disabled"; the back-off applies only to Guest. In the `local` and `ci` profiles the guest limit is generous (for example 60 per hour); `production` keeps 3 per hour (spec).
- **Actual:** Nothing changes except the static note "Guest files are deleted when you log out."; the button stays enabled; the second click is ignored silently. Selecting demo then shows "Too many attempts. Try again in 1183 s" with the password field disabled. `guest-ip` is 3/hour for every profile, and all browsers on the machine share one key (docker-proxy), so QA and demos hit it constantly.
- **Evidence:** `bug-hunt/boot-login/mock-guest-dark-after.png`, `mock-guest-dark-after-second-click.png`, `mock-guest-dark.json`, `mock-guest403-light.json`, `mock-guest403-light-after.png`; `bug-hunt/system-services/guest-429-after-click-light.png`, `guest-429-second-click-light.png`, `guest-429-then-user-tile-light.png`, `guest-403-after-click-dark.png`
- **Suspected files:** `ui/src/login/LoginScreen.tsx` (guest branch ~457–478, `hint()`), `wm/src/shell/login-flow.ts` (`select()`, global `retryAt`), `wm/src/shell/Login.tsx`, `server/src/ratelimit/classes.ts` (l.26), the `new RateLimiter({…})` call in `server/src/app.ts` (~129–132; `config.envName` is `local|ci|production`)
- **Fix notes:** render the same status line (role=alert for errors, a polite once-only announcement for the wait) in the guest branch; show minutes for waits ≥ 60 s; keep `retryAt` per user id and reset it in `select()`; build the text in the UI from state and `retryAfterMs` (do not edit `kernel/src/core/io/login.ts`, which is fix-system-services'). Make the class table profile-aware through a `RateLimiter` overrides option; keep and extend `server/src/ratelimit/ratelimit.test.ts`. Optionally loosen `login-ip` and `ws-upgrade` for `local` too.
- **Done when:** mocked 429 and 403 show the right text and a disabled/aria-disabled button; demo stays usable after a guest 429; a server test proves production = 3/h and local = the generous value.

#### UI-006 · major · (known c) sync "client not linked": no WebSocket, lockd local-only, ai.agent "requires sync"

- **Owner:** fix-system-services · **Area:** sync, lockd, ai.agent (OFF-01, OFF-04, VFS-09) · **Sources:** system-services #3, qa-setup (D), known issue (c)
- **Repro:** Sign in on 4718, open the "4 degraded" popover or run `svcctl status`; record page WebSockets for the session.
- **Expected:** After desktop-interactive syncd connects to `/ws` (sync LIVE), lockd holds server leases (RUNNING), ai.agent no longer inherits a degradation.
- **Actual:** No socket is ever opened (the server path is healthy: upgrade 6 ms, hello → hello.ok 17 ms through Caddy). sync "sync client not linked", lockd "local advisory locks only", ai.agent "requires sync".
- **Evidence:** `bug-hunt/system-services/services-popover-light.png`, `raw/ss-ws.json`, `raw/ss-session-light.json` (ws: [])
- **Suspected files:** `web/src/kernel.worker.ts` (no `engines`), `kernel/src/core/net/engines.ts` (factory TODO), `kernel/src/core/io/sync.ts` (~79 `noEngineProbe`), `vfs/package.json` (exports), `vfs/src/sync/syncd.ts`, `vfs/src/locks/lockd.ts`, `services/src/system/network.ts`
- **Fix notes:** export `./sync` and `./locks` from `vfs`; implement the EngineFactory (Syncd with StoreSyncStorage, browser socket, fetch SyncHttp, `S2CFrame` decode; Lockd attached to syncd). Check the Origin handling through Caddy. ai.agent should then report its own health (readyz says llm `no-key` on this stack; that is expected).
- **Done when:** on 4718 `svcctl status` shows sync running/LIVE and lockd running; a page WebSocket to `/ws` is open; a local write drains from the outbox; unit tests for the factory.

#### UI-007 · major · (known c) Service Worker never registered: update degraded, offline boot impossible

- **Owner:** fix-system-services · **Area:** update service, SW registration (OFF-05, BOOT-09) · **Sources:** system-services #2, known issue (c)
- **Repro:** Sign in, wait 15 s, `navigator.serviceWorker.getRegistrations()` → `[]`; `context.setOffline(true)` and reload.
- **Expected:** The router registers `/sw.js` after desktop-interactive + idle; update RUNNING "offline-ready"; offline reload boots from the precache.
- **Actual:** Chrome's offline page. With a manual registration the same sw.js activates in 607 ms (161 entries) and an offline reload reaches login in 315 ms, so only the trigger is broken: `kernel/src/host/worker.ts:159` sets `serviceWorker: 'serviceWorker' in nav` using the _dedicated worker's_ navigator (false in Chrome 153), so `updateService` degrades before `port.register()`. Settings/About then claim "up to date".
- **Evidence:** `bug-hunt/system-services/offline-reload-phase-A.png`, `offline-reload-phase-B.png`, `raw/ss-offline-A.json`, `raw/ss-offline-B.json`
- **Suspected files:** `kernel/src/host/worker.ts`, `kernel/src/host/boot-sequence.ts`, `kernel/src/core/io/index.ts` (~518), `kernel/src/core/io/update.ts`, `services/src/system/extras.ts` (~56), `web/src/sw/update.ts`
- **Fix notes:** take SW support from the router's capability matrix already sent in `boot.start` (`msg.caps.serviceWorker`), not the worker navigator.
- **Done when:** e2e on 4718: update service running, one active registration, `setOffline` + reload reaches the login screen.

#### UI-008 · major · (known e) Build id `0000000`/`unknown` in Docker; web and server disagree

- **Owner:** fix-system-services · **Area:** build identity · **Sources:** boot-login #18, system-services #8, known issue (e)
- **Repro:** `curl http://localhost:4718/version.json` and `/api/readyz`; look at the splash, login corner, Control Centre footer, `uname -a`.
- **Expected:** One real build id and date on both tiers.
- **Actual:** web `{version:'0.1.0-dev.0', build:'0000000'}`, readyz `{version:'0.1.0', build:'unknown', date:'unknown'}`, hello.ok `build:'0000000', date:'1970-01-01'`. compose passes no build args; the tree has no `.git`; `.dockerignore` excludes `.git`.
- **Evidence:** `bug-hunt/system-services/control-centre-light.png`, `raw/ss-session-light.json`, `raw/ss-ws.json`; `bug-hunt/boot-login/splash-t0-dark-none-1440.png`, `login-dark-1440x900.png`
- **Suspected files:** `compose.yaml`, `Dockerfile`, root `package.json` (`start`), new `tools/build-id.*`, `server/src/config.ts`, `server/src/util/build.ts`
- **Fix notes:** `pnpm start` exports `BUILD_SHA` (git short SHA when available, else a deterministic hex content hash of the source tree and lockfile, 7–12 hex digits) plus `BUILD_DATE`/`SOURCE_DATE_EPOCH`; compose passes them as build args to web and app. `web/vite.config.ts` already accepts a hex `BUILD_SHA`: do not edit it. Document the scheme in README's build paragraph. The Control Centre footer wrap is UI-151.
- **Done when:** after a QA rebuild, version.json, readyz and hello.ok report the same non-zero id; a test covers the hash script's determinism.

#### UI-009 · major · (known b) Files list header labels overlap

- **Owner:** fix-files-editor · **Area:** Files list header · **Sources:** files-editor #7, known issue (b)
- **Repro:** Files at its default window (or any list pane narrower than ~600 px), list view.
- **Expected:** Labels stay in their columns (ellipsis) or low-priority columns hide; sort-button hit areas never overlap.
- **Actual:** "Date ModSizeKind"; "Permissions" runs into the inspector; cells truncate to "Ar…", "F…". Re-confirmed by the triage on the 09:55 build.
- **Evidence:** `bug-hunt/files-editor/02-files-default-window.png`, `41-default-window-projects.png`, `99-fresh-default-window-1440.png`; `polish/triage/files-default-light.png`
- **Suspected files:** `ui/src/apps/files/FileList.module.css`, `ui/src/apps/files/FileList.tsx`
- **Fix notes:** proper column widths with truncation (label `overflow:hidden; text-overflow:ellipsis`, chevron outside), a Name minimum, container queries that hide Kind/Permissions first. Must hold even after UI-011 makes the default window larger (the user can still shrink it).
- **Done when:** screenshots at 640, 720, 960 px wide windows show no overlap; a unit/DOM test asserts header cells do not overflow.

#### UI-010 · major · (known b) Files path bar hides the current folder

- **Owner:** fix-files-editor · **Area:** Files path bar · **Sources:** files-editor #8, known issue (b)
- **Repro:** Files at the default size in /home/demo, ~/Projects, or a long-named folder.
- **Expected:** The full breadcrumb when it fits; when narrow it collapses with a middle ellipsis ("/ › … › Projects"), and the current segment is always visible (ellipsised last).
- **Actual:** The last crumb measures 0 px ("/ › home" with no "demo"); in a long folder only "/" is left.
- **Evidence:** `bug-hunt/files-editor/02-files-default-window.png`, `42-default-window-long-folder.png`; `polish/triage/files-default-light.png`
- **Suspected files:** `ui/src/apps/files/Files.module.css` (`.pathBar`, `.crumb`), `ui/src/apps/files/PathBar.tsx`, `ui/src/apps/files/FilesToolbar.tsx`
- **Fix notes:** measure (ResizeObserver) and fold middle crumbs into "…" before the current one shrinks; give the current crumb a min width. The overflow menu anchor bug is UI-098.
- **Done when:** screenshots at 3 widths × 3 depths show the current folder; test for the folding logic.

#### UI-011 · major · Windows ignore the manifests' sizes and open at 720×480

- **Owner:** fix-windows · **Area:** window creation · **Sources:** windows #9, files-editor #6, terminal #13, apps-settings-a11y #1
- **Repro:** Open each app from the Dock at 1440×900 and 1920×1080.
- **Expected:** Files 960×600, Editor 900×640, Terminal 760×480, Task Manager 1160×700, Settings 880×620, About 780×700 (`AppWindowSpec`), cascaded and clamped to the work area.
- **Actual:** Files/Editor/Terminal/About 720×480, Task Manager 1080×520 (its minimum), Settings 880×620 (its minimum). This cramps Files (feeds known issue b), Task Manager (5 rows) and About (cut at "Host").
- **Evidence:** `bug-hunt/windows/01-files-open.png`, `110-four-apps-1920.png`; `bug-hunt/apps-settings-a11y/tm-02-processes-default-dark.png`, `about-01-dialog-dark.png`; `bug-hunt/files-editor/99-fresh-default-window-1440.png`; `bug-hunt/terminal/35-open-dark-1920x1080.png`
- **Suspected files:** `wm/src/compositor/model.ts` (`create`, `DEFAULT_SIZE`), `wm/src/compositor/compositor.ts` (`case 'create'`), `wm/src/shell/env.ts` (`AppWindowHints`, contract C2), the compositor region of `Desktop.tsx` (C1)
- **Fix notes:** keep it inside wm: add an optional default-size lookup to the compositor options (from `env.apps.get(app)?.window` width/height), used only when the kernel sends no `rect` (restores keep their rect). Do not edit `apps/files/lib/relay.ts`, `apps/terminal/proc.ts` or `apps/src/descriptor.ts`.
- **Done when:** compositor unit test (size used, cascade kept, clamped at 1280×800); screenshots of all six apps at 1440×900.

#### UI-012 · major · Signed-in user shown as `u<uid>`

- **Owner:** fix-system-services · **Area:** kernel user directory · **Sources:** terminal #3, windows #21, files-editor #5 (kernel part), apps-settings-a11y #6, system-services #6
- **Repro:** Sign in as alice: Terminal prompt `u1100@plotinium`, `whoami` → u1100, `id` → `uid=1100(u1100)`; Settings account card, About "Signed in", Task Manager User column, Files Favourites and status bar, Editor lock text. `ls -l /home` correctly says alice.
- **Expected:** The account name everywhere, and group names resolved.
- **Actual:** `u<uid>` wherever `kernel.users.nameOf` is used, also after a reload.
- **Evidence:** `bug-hunt/system-services/whoami-first-boot.png`, `whoami-after-reload.png`; `bug-hunt/terminal/02-whoami-id-light.png`, `03-ls-la-root-light.png`; `bug-hunt/files-editor/01-files-open-1440.png`; `bug-hunt/apps-settings-a11y/set-dark-07-users-groups.png`
- **Suspected files:** `kernel/src/core/kernel.ts` (~178 `opts.users ?? new StaticUserDirectory()`), `kernel/src/host/boot-sequence.ts` (~218 `createKernel` without `users`), `kernel/src/core/io/index.ts` (~399 `ConsoleUsers`), `kernel/src/core/proc/syscalls.ts` (~175–190), `kernel/src/core/proc/users.ts`
- **Fix notes:** give the kernel the fs-backed ConsoleUsers (pass one instance to `createKernel` and `VfsIo`, or bind it at mount). The Files-side label/ownership work is UI-115.
- **Done when:** kernel test: `whoami` after a cookie-resumed login prints the username; screenshots of prompt, Settings and Task Manager show the name.

#### UI-013 · major · Inline boot-CSS compactor breaks descendant selectors

- **Owner:** fix-boot-login · **Area:** every boot screen · **Sources:** boot-login #5, logo report (problem 2)
- **Repro:** `curl -s http://localhost:4718/ | grep -o '.plb:where(h1,h2,p,ul,ol,pre)'` matches; compare the splash with `docs/design/stitch/boot-splash/reference.png`.
- **Expected:** Descendant combinators survive: `.plb :where(h1…)`, `.plb-splash[data-verbose] :is(…)`, `.plb-splash[data-exit] :is(…)`, `.plb-row:not([data-l='info']) :is(…)`, `.plb-rec :is(…)`.
- **Actual:** `/\s*([{};:,>])\s*/g` turns `.plb :where(` into `.plb:where(`. UA margins return (splash wordmark-to-version gap 82 px vs 39 px; the triage screenshot shows it), verbose step/count stay over the log, the hand-over fade never runs (the column jumps), WARN/FAIL rows lose colour, the unsupported card is 965 px tall.
- **Evidence:** `bug-hunt/boot-login/verbose-url-dark-1440-3.png`, `verbose-url-dark-1440.json`, `menu-verbose-session-7.png`, `splash-t0-dark-none-1440.png`, `unsupported-dark.png`, `kernel-fail-light.png`; `polish/triage/boot-light-150ms.png`
- **Suspected files:** `web/vite.config.ts` (`compactCss`, ~129–134), `ui/src/boot/boot.css`
- **Fix notes:** stop stripping whitespace around `:` (compact only `{};,>`), then collapse `: ` inside declarations safely; add a build test that parses the source and compacted selector lists and asserts they are equal. Re-check the CSP hashes of the inlined boot CSS after the change (they are generated at build).
- **Done when:** the grep above no longer matches; splash, verbose, panic, unsupported and recovery screenshots match the Stitch references; the web build test passes.

#### UI-014 · major · Files drops a single-file selection ~150 ms after the click

- **Owner:** fix-files-editor · **Area:** Files selection/inspector · **Sources:** files-editor #2
- **Repro:** Files > ~/Projects, click `kernel.ts`, wait 0.5 s, press Enter / Delete / right-click > Get Info.
- **Expected:** The row stays selected; inspector shows its info; the keys act on it.
- **Actual:** Selection drops after ~150 ms; inspector says "Select a file to see its info"; Enter/Delete after 600 ms do nothing; new or renamed items are never left selected.
- **Evidence:** `bug-hunt/files-editor/30-inspector-file-40ms.png`, `22-inspector-file-860ms-selection-lost.png`, `25-get-info.png`, `11-after-new-folder.png`
- **Suspected files:** `apps/files/view.tsx` (~170–177 `on(() => state().path, …)`), `apps/files/lib/controller.ts` (`inspect` ~698–723)
- **Fix notes:** key on `createMemo(() => state().path)`; audit the title effect (~163–168) and toast effect (~200–213) for the same pitfall.
- **Done when:** vitest: select a file, let inspect resolve, selection is kept; Enter after 1 s opens the file on 4718.

#### UI-015 · major · Every window-level Files shortcut is dead

- **Owner:** fix-files-editor · **Area:** Files/Editor keyboard · **Sources:** files-editor #3
- **Repro:** Files > ~/Projects, click a row, press Ctrl+Shift+N, Ctrl+X, Alt+↑, Backspace, Alt+←, Ctrl+Shift+., Alt+Enter. In the Editor press Ctrl+Alt+O.
- **Expected:** The File/Edit/View/Go shortcuts work (the empty state and toasts even advertise Ctrl+Shift+N and Ctrl+V).
- **Actual:** Nothing happens. `isTyping()` matches `[role="dialog"]`, and every WM window frame is `<section role="dialog" aria-modal="false">` (verified: `ui/src/shell/window/WindowFrame.tsx:228`).
- **Evidence:** `bug-hunt/files-editor/17-row-context-menu-keyboard.png`; `polish/triage/files-default-light.png` (empty state advertising Ctrl+Shift+N)
- **Suspected files:** `apps/files/view.tsx` (~71–78, ~353), `apps/editor/view.tsx` (~151)
- **Fix notes:** treat only modal dialogs (`[role=dialog][aria-modal=true]`, `[role=alertdialog]`) or dialogs inside the app root as "typing". Do not change the frame's role.
- **Done when:** DOM test inside a `role=dialog` frame proves each shortcut dispatches; Playwright on 4718 runs Ctrl+Shift+N → sheet.

#### UI-016 · major · Files background context menu never opens

- **Owner:** fix-files-editor · **Area:** Files context menu · **Sources:** files-editor #4
- **Repro:** Right-click the empty list area below the rows (or an empty folder).
- **Expected:** The background menu (New Folder, New File, Paste, Show Hidden Files, Show Inspector, Refresh, Open in Terminal, Empty Trash… in the Trash).
- **Actual:** No menu; the native page menu appears in real Chrome. "Open in Terminal" is unreachable anywhere.
- **Evidence:** `bug-hunt/files-editor/06-background-context-menu.png`
- **Suspected files:** `apps/files/view.tsx` (`onContextMenu` ~421–432)
- **Fix notes:** same root cause as UI-015 (`closest('[role="dialog"]')` hits the frame).
- **Done when:** test + screenshot of the menu at the pointer.

#### UI-017 · major · After a restore, focus lands on the Minimise light

- **Owner:** fix-windows · **Area:** focus (WM-02, WM-07) · **Sources:** windows #1
- **Repro:** Open Terminal, click the yellow light, restore from the Dock (or Alt+`, Alt+J, Alt+K), type `ls` + Enter.
- **Expected:** Focus returns to the app content (last focused content element; window-manager.md §3.4 rule 3).
- **Actual:** `document.activeElement` is "Minimise Terminal"; Enter minimises again.
- **Evidence:** `bug-hunt/windows/22-enter-after-restore-reminimises.png`
- **Suspected files:** `Desktop.tsx` `onParts` focusin listener and `focusWindow` (C1), `wm/src/shell/dom.ts` (`focusInto`)
- **Fix notes:** never record chrome controls (traffic lights, title bar) as `lastFocus`, and make `focusInto` skip them.
- **Done when:** test: minimise via the light, restore, active element is inside `[data-wm-view]`; Playwright types `ls` after a restore.

#### UI-018 · major · Focus changes never move keyboard focus into the window

- **Owner:** fix-windows · **Area:** focus (WM-02, WMD-22) · **Sources:** windows #2, apps-settings-a11y #14c
- **Repro:** (a) Click inside Terminal, then click the Editor title bar and type. (b) With Terminal open, click the Editor Dock icon and type. (c) Alt+M or Alt+Q the focused window and type.
- **Expected:** focus(wid) raises and moves DOM focus into the window (§3.4 rule 3).
- **Actual:** The window is marked focused but `activeElement` stays `<body>` or the Dock button; keystrokes are lost.
- **Evidence:** `bug-hunt/windows/24-focus-title-click.png`; `bug-hunt/apps-settings-a11y/kb-dark-00-dock-focus-taskmgr.png`
- **Suspected files:** `wm/src/shell/WindowLayer.tsx` (`onFocusRequest`), `Desktop.tsx` `onCoarse` `'focused'`/`'opened'` (C1), `wm/src/compositor/model.ts`, `ui/src/shell/window/WindowFrame.tsx`
- **Fix notes:** on user-caused focus (chrome pointerdown on a non-focusable target, launch after the view mounts, minimise/close hand-off) call `focusInto(section, lastFocus)`. Do not steal focus from a control the user just clicked.
- **Done when:** tests for each path; Playwright types after each action.

#### UI-019 · major · Shrinking a window leaves the content box at its old size

- **Owner:** fix-windows · **Area:** resize (WM-04, §3.5) · **Sources:** windows #3, terminal #7
- **Repro:** Drag the Terminal se handle up-left by 200×100 and release (or Files to 640×400).
- **Expected:** At gesture end the content box equals the frame; the app gets one resize (xterm refits, SIGWINCH).
- **Actual:** Frame 520×380, `[data-wm-view]` still 720×442; the Terminal status strip and prompt are clipped; grid stays 84 cols.
- **Evidence:** `bug-hunt/windows/52-terminal-after-shrink.png`, `52-editor-after-shrink.png`, `50-files-min-size.png`; `bug-hunt/terminal/59-rebuilt-shrink-clipped.png`
- **Suspected files:** `wm/src/compositor/model.ts` (`setRectOf`), `wm/src/compositor/gestures.ts` (~169–174), `wm/src/compositor/flush.ts`
- **Fix notes:** `setRect(wid, sameRect, {cw, ch})` finds nothing dirty because `setRectOf` already assigned cw/ch; mark `DIRTY.CONTENT` at gesture end.
- **Done when:** unit test (shrink → content = frame); screenshot of a shrunk Terminal with a correct strip.

#### UI-020 · major · Hidden Terminal tabs are resized to 10×4 cells

- **Owner:** fix-terminal · **Area:** Terminal tabs + fit · **Sources:** terminal #2
- **Repro:** `cd /tmp`, `sleep 2 && echo <long text>`, immediately click "+", wait 3 s, return to tab 1 (also after closing a tab).
- **Expected:** Background tabs keep their real size; the prompt stays on one line.
- **Actual:** The hidden panel (`display:none`) fits to ~10×4 and the shell gets SIGWINCH; the prompt shows as `u1100@plot` / `inium:/tmp` / `$`.
- **Evidence:** `bug-hunt/terminal/58-rebuilt-background-tab-prompt-broken.png`, `48-background-tab-output-wrapped-10-cols.png`, `20-tab-switch-truncated-prompt.png`
- **Suspected files:** `ui/src/apps/terminal/TerminalHost.tsx` (fit/scheduleFit), `ui/src/apps/terminal/Terminal.module.css`, `apps/terminal/controller.ts`
- **Fix notes:** skip fitting when the host has no layout box (`clientWidth === 0` / not connected), or hide inactive panels with `visibility:hidden` so they keep their size.
- **Done when:** test with a hidden host: no resize is sent; Playwright repro shows an intact prompt.

#### UI-021 · major · Keyboard focus falls to `<body>` after a Terminal tab closes

- **Owner:** fix-terminal · **Area:** Terminal tabs (WCAG 2.4.3) · **Sources:** terminal #9
- **Repro:** 5 tabs, press the close-tab shortcut 4 times (or ×, `exit`, Ctrl-D); also Shell > Clear Scrollback.
- **Expected:** Focus moves into the newly selected tab's terminal; after a menu command focus returns to the terminal.
- **Actual:** `activeElement` is BODY; the next shortcut and typing go nowhere.
- **Evidence:** `bug-hunt/terminal/58-rebuilt-background-tab-prompt-broken.png`, `20-tab-switch-truncated-prompt.png`
- **Suspected files:** `ui/src/apps/terminal/TerminalApp.tsx`, `apps/terminal/controller.ts`, `apps/terminal/view.tsx`
- **Done when:** test: close the active tab, focus is in the next xterm textarea; same after `exit`.

#### UI-022 · major · Terminal tab shortcuts use Chrome-reserved keys

- **Owner:** fix-terminal · **Area:** Terminal keyboard (D-11, WMD-08, UIG-21) · **Sources:** terminal #8
- **Repro:** In a normal Chrome window focus the terminal and press Ctrl+Shift+W (menu: "Close Tab Ctrl+Shift+W"), Ctrl+Shift+T or Ctrl+PageDown.
- **Expected:** Shortcuts a page can receive.
- **Actual:** Automation (CDP) receives them, so they look fine in tests, but Chromium reserves close-window (Ctrl+Shift+W on Linux/Windows), restore-tab (Ctrl+Shift+T) and select-next/previous-tab (Ctrl+PageUp/PageDown, Ctrl+Tab) outside app/fullscreen mode (`BrowserCommandController::IsReservedCommandOrKey`). A user following the menu hint closes the browser window and the whole OS session. The triage confirmed the reserved list from Chromium's source; it cannot be reproduced headless.
- **Evidence:** `bug-hunt/terminal/22-menu-shell.png`, `22-menu-view.png`
- **Suspected files:** `apps/terminal/manifest.ts` (~111–123), `ui/src/apps/terminal/TerminalApp.tsx`, `apps/shell/builtins/help.ts`
- **Fix notes:** choose chords that are neither Chrome-reserved nor listed in window-manager.md §3.9 (note: Shift+Alt+T is used by Chrome) nor bound in `wm/src/shell/keys.ts` `DEFAULT_BINDINGS` (Alt+T/W/Q/M/N/B/O/C/S/L/J/K and Alt+Shift+arrows are taken). Update menu hints, `help` and the component doc. Keep the menu items as the discoverable path.
- **Done when:** a unit test checks the new chords against a reserved list and `DEFAULT_BINDINGS`; menus show the new keys.

#### UI-023 · major · Menu-bar titles re-mount on every status event

- **Owner:** fix-desktop-shell · **Area:** menu bar · **Sources:** desktop-shell #8, qa-setup (B)
- **Repro:** Reload and sign in; press Alt+B right away and watch `activeElement`; or open the atom menu in the first 2 s.
- **Expected:** Titles and open menus stay mounted; the app label animates only when the focused app changes.
- **Actual:** Both "Plotinium" titles are re-created ~22 times in 5 s; focus on the atom falls to BODY at ~1.8 s; an open menu is replaced 4 times in 2 s; the app label replays its animation (missing or grey in screenshots).
- **Evidence:** `bug-hunt/desktop-shell/25-menubar-first-4s-strip.png`, `26-atom-menu-early-3.png`
- **Suspected files:** `wm/src/shell/Desktop.tsx` (MenuBar JSX: `{...(env.ai===false?{}:{ai:…})}`, `{...(status().memory===undefined?…)}`), `ui/src/shell/menubar/MenuBar.tsx` (`entries()` + `<For>` by reference)
- **Fix notes:** plain props (`ai={env.ai === false ? undefined : …}`, `memory={status().memory}`); key the title `<For>` by id or memo `appName`/`appMenu`.
- **Done when:** test: status events do not re-create the title nodes; focus stays on the atom after 5 s.

#### UI-024 · major · Notification banners sit above Control Centre and Overview

- **Owner:** fix-desktop-shell · **Area:** notifications, Control Centre, Overview · **Sources:** desktop-shell #1
- **Repro:** Right after sign-in (4 degraded banners), open Control Centre and click "Dark" in Appearance; press F3 with banners visible.
- **Expected:** Opening the centre moves/hides banners (ToastStack spec: a visible toast FLIPs into the first slot); nothing covers CC, Overview or dialogs.
- **Actual:** Banners (`--pl-z-notify` 10100) sit over CC (10050); `elementFromPoint` at the Dark radio is a toast `<li>`; hover pauses them so they never leave; the "Alt+O Overview" chip overlaps the first banner; unread dots stay after CC marks items read.
- **Evidence:** `bug-hunt/desktop-shell/07-toasts-cover-control-centre.png`, `31-after-toast-click.png`, `05-cc-open-light.png`, `16-overview-empty.png`, `16-overview-3-windows.png`
- **Suspected files:** `wm/src/shell/Desktop.tsx`, `ui/src/shell/notifications/NotificationToasts.tsx`, `ui/src/shell/notifications/Notifications.module.css`
- **Fix notes:** hand banners off when CC/NC opens and hide them while Overview or Search is open. Do not change z tokens in `ui/src/tokens` (not yours).
- **Done when:** Playwright: open CC with banners, click Dark, theme changes; screenshot.

#### UI-025 · major · Connectivity popover always "You're offline"; chip claims "all synced" while sync is degraded (UI side)

- **Owner:** fix-desktop-shell · **Area:** status: sync/degraded · **Sources:** desktop-shell #2 and #24, system-services #4 (UI part)
- **Repro:** Click the cloud chip ("Sync: Online, all changes synced"), the "4 degraded" pill, or the CC Connectivity tile.
- **Expected:** The header follows the real net state (Online · synced / Syncing N / Offline · N queued / Sign in to sync / Sync unavailable); opened from "N degraded" it is titled "Degraded services"; the chip never says "synced" while the sync service is degraded or not linked.
- **Actual:** Hard-coded "You're offline — Changes are saved on this device and queued." under an Online menu bar and above "Nothing queued"; green "Online · All changes synced" next to "sync — sync client not linked"; reasons ellipsised with no tooltip.
- **Evidence:** `bug-hunt/desktop-shell/05-cc-connectivity-popover.png`, `32-dark-degraded-popover.png`, `09-status-degraded.png`, `05-cc-dark.png`; `bug-hunt/system-services/services-popover-light.png`, `sync-after-local-write-dark.png`
- **Suspected files:** `ui/src/overlays/offline/OfflinePopover.tsx`, `wm/src/shell/Desktop.tsx`, `wm/src/shell/status.ts`, `ui/src/shell/menubar/StatusItems.tsx`, `ui/src/shell/format.ts`
- **Fix notes:** add a `net` prop to OfflinePopover (text from `connectivityText`/`connectivityDetail`); derive a warning state from the `sync` service health. The data side (NetMonitor state without an engine, outbox) is UI-026; this must be correct with or without it.
- **Done when:** component tests for each net state; screenshots of chip + popover.

#### UI-026 · major · Net state "online" with no sync engine; no outbox for the shell (data side)

- **Owner:** fix-system-services · **Area:** net monitor, host wiring · **Sources:** system-services #4 (data part)
- **Repro:** Before UI-006 lands: run `echo qa > f.txt` in Terminal; the chip shows "Syncing 5 ops" forever while the popover lists 0 queued; Settings › Network & Sync says Online · Last synced never.
- **Expected:** With no engine the monitor publishes a non-online state (for example `unlinked`); the shell's queued list and the chip count agree.
- **Actual:** `kernel/src/core/net/monitor.ts` maps reachability to "online" without an engine; `web/src/desktop/host.ts` provides no `outbox`.
- **Evidence:** `bug-hunt/system-services/sync-after-local-write-dark.png`, `settings-network-sync.png`, `raw/ss-retry-dark.json`
- **Suspected files:** `kernel/src/core/net/monitor.ts`, `web/src/desktop/host.ts`
- **Done when:** unit test for the monitor; the chip count equals the popover list on 4718.

#### UI-027 · major · Lock screen does not make the desktop inert

- **Owner:** fix-desktop-shell · **Area:** lock · **Sources:** desktop-shell #4
- **Repro:** Atom menu > Lock Screen; press Tab repeatedly; Enter on "Plotinium" or "Search"; unlock.
- **Expected:** Nothing of the session is focusable or exposed while locked; open menus/palettes close on lock; focus returns to the last window after unlock.
- **Actual:** Tab reaches the atom menu and every status item; menus and Search open under the lock and Search is still open after unlock; window text is in the a11y tree; focus is BODY after unlock.
- **Evidence:** `bug-hunt/desktop-shell/19-lock-screen.png`, `20-lock-menu-opened-behind-lock.png`, `21-after-unlock-terminal-was-opened-while-locked.png`
- **Suspected files:** `wm/src/shell/mount.tsx`, `wm/src/shell/Desktop.tsx`, `wm/src/shell/Shell.module.css`
- **Done when:** test: while locked the desktop root (and portalled layers) is `inert` + `aria-hidden`; Playwright Tab walk stays in the lock screen.

#### UI-028 · major · System menu has no "Log Out <user>…"

- **Owner:** fix-desktop-shell · **Area:** atom menu · **Sources:** desktop-shell #5
- **Repro:** Click the Plotinium mark.
- **Expected:** About Plotinium, Settings…, Lock Screen, Log Out <user>…, Restart…, Shut Down… (ui-implementation-guide §3.4.2).
- **Actual:** No Log Out (verified in `ui/src/shell/menubar/MenuBar.tsx` `SYSTEM_ITEMS`); nobody, including a Guest, can end the session from the desktop.
- **Evidence:** `bug-hunt/desktop-shell/02-menu-desktop-0-Plotinium.png`, `32-dark-atom-menu.png`
- **Suspected files:** `ui/src/shell/menubar/MenuBar.tsx`, `ui/src/shell/types.ts`, `wm/src/shell/Desktop.tsx`
- **Fix notes:** the host already posts `{t:'power', action:'logout'}` (`web/src/desktop/host.ts`); confirm with a dialog like Restart, save the layout first. Use your own session file; logging out revokes it.
- **Done when:** test for the item and dispatch; Playwright with a freshly minted session reaches the login screen.

#### UI-029 · major · Overview thumbnails are not scaled

- **Owner:** fix-desktop-shell · **Area:** Overview · **Sources:** desktop-shell #3
- **Repro:** Open Files, Terminal, Editor (no reduced motion), press F3.
- **Expected:** Each tile shows the whole window scaled (~0.61 for a 440 px tile), as reduced motion already does.
- **Actual:** Normal windows get `scale(1)`: a cropped top-left corner.
- **Evidence:** `bug-hunt/desktop-shell/16-overview-3-windows.png`, `32-dark-overview.png`, `16-overview-with-minimised.png`, `28-reduced-overview.png`
- **Suspected files:** `ui/src/overlays/overview/Overview.tsx` (`reportLayout` measures during the zoom-in FLIP), `wm/src/shell/Desktop.tsx` (Overview section)
- **Done when:** test: the reported slot rect ignores transforms; screenshot.

#### UI-030 · major · Kernel panic screen lacks the BOOT-08 recovery features

- **Owner:** fix-boot-login · **Area:** kernel panic screen · **Sources:** boot-login #4
- **Repro:** Trigger a critical failure (slow-network boot, UI-032) at 1440×900.
- **Expected:** Boot spec §3.6: "Plotinium could not start / sched failed: <reason>" with [T] Retry, [S] Safe mode, [R] Recovery console, [D] Diagnostics; the failing line visible.
- **Actual:** "Kernel panic" title, no Retry, the log scrolled to the top (reason hidden), the 56 px medal squashed to 56×26, "boot id pending" and a US-format time.
- **Evidence:** `bug-hunt/boot-login/slow200-100-end.png`, `login-after-boot-light-slow-1440.png`, `panic-dark-1440.png`, `panic-dark-1440.json`, `slow60-cache.json`
- **Suspected files:** `web/src/boot/driver.ts`, `ui/src/boot/panic.ts`, `ui/src/boot/boot.css`
- **Fix notes:** add T Retry (a reboot is acceptable), scroll `.plb-code` to the end, `flex:none` on `.plb-medal`, en-GB 24 h time like the rest of the OS.
- **Done when:** unit tests for the panic view; screenshots in both themes.

#### UI-031 · major · Halted/takeover screens: Enter does nothing; the login stays live underneath

- **Owner:** fix-boot-login · **Area:** boot message screens · **Sources:** boot-login #2
- **Repro:** Login > Shut Down > confirm, wait 1 s, press Enter. Or a second-tab takeover, then Enter in tab 1.
- **Expected:** The screen's primary action ("↵ Start", "Reload") has focus and Enter runs it; nothing underneath is reachable.
- **Actual:** The hidden login keeps ticking and pulls focus into its password input (UI-001), and `messageScreen` ignores keys from inputs.
- **Evidence:** `bug-hunt/boot-login/power-shutdown-dark-end.png`, `power-shutdown-dark-after-enter.png`, `power-shutdown-dark.json`, `takeover-dark.json`, `takeover-dark-tab1-after.png`
- **Suspected files:** `web/src/boot/driver.ts`, `web/src/boot/screens.ts`, `wm/src/shell/Login.tsx`
- **Fix notes:** when any message screen mounts, make `#plt-desktop` inert (from the boot side) or dispose the shell. Also reword "your session was saved" when shutting down from the login screen.
- **Done when:** Playwright: Shut Down → Enter starts the system; takeover → Enter reloads.

#### UI-032 · major · A boot on a slow network ends in "sched failed: timeout 500 ms"

- **Owner:** fix-system-services · **Area:** service start (ARC-08) · **Sources:** boot-login #3
- **Repro:** Fresh profile, throttle 200 KB/s + 100 ms latency (CDP `Network.emulateNetworkConditions`), open 4718.
- **Expected:** Slower boot that still reaches login; critical timeouts do not depend on network speed.
- **Actual:** KERNEL PANIC at ~3.2 s in 4/5 runs at 200 KB/s (every run at 60 KB/s). `executor.worker` statically imports every program module while the page also fetches the desktop chunk, fonts and `/branding/*` seed files.
- **Evidence:** `bug-hunt/boot-login/slow200-100-end.png`, `slow200-100.json`, `rep200-1.json`…`rep200-4.json`, `slow60-cache.json`
- **Suspected files:** `services/manifests/sched.json`, `web/src/executor.worker.ts`, `kernel/src/host/services.ts`, `web/src/kernel.worker.ts`
- **Fix notes:** lazy-load program modules on spawn, or start sched's timeout only once the executor script has loaded; defer the branding seed until after desktop-interactive.
- **Done when:** a throttled (200 KB/s) boot e2e reaches the login screen 3 runs out of 3.

#### UI-033 · major · Double-clicking the unified toolbar never zooms

- **Owner:** fix-windows · **Area:** title-bar double-click (WM-04 §3.8) · **Sources:** windows #4
- **Repro:** Files/Settings/Task Manager: double-click an empty toolbar spot (target = the toolbar div).
- **Expected:** Maximise; again restores.
- **Actual:** No change: `dblclick` targets `.content` (the pointer-capture target), so `fromDragRegion(event)` fails (verified in `WindowFrame.tsx` ~212–322).
- **Evidence:** windows finder script `t18-dblregion.mjs` output (in the report); re-verified on the rebuilt QA
- **Suspected files:** `ui/src/shell/window/WindowFrame.tsx`, `wm/src/shell/WindowLayer.tsx`
- **Fix notes:** remember that the last pointerdown began in a drag region, or capture on the drag-region element. The Settings "double-click action" preference is UI-041.
- **Done when:** test + Playwright on Files toolbar.

#### UI-034 · major · WM-06 restore: the compositor does not report geometry, snap and z

- **Owner:** fix-windows · **Area:** layout persistence (WM-06, I-WM8) · **Sources:** windows #5 (compositor part)
- **Repro:** (1) Open Terminal and Editor, leave Terminal untouched, maximise Editor, wait 1.5 s, reload. (2) Terminal×2, Editor, Files: maximise one, minimise Files, snap Editor right, move/resize Terminal 1; reload. (3) Snap left, reload, Alt+Shift+Down.
- **Expected:** Every window comes back with rect, state, snap, z and focus (window-manager.md §3.15).
- **Actual:** The untouched Terminal is lost; the un-maximise rect is lost (stays 1440×788); the minimised Files is lost; z-order changes (snapped Editor above the maximised Terminal); snap is lost (Alt+Shift+Down minimises).
- **Evidence:** `bug-hunt/windows/100-layout-before-reload.png`, `101-layout-after-reload.png`, `102-restore-untouched-and-maximised.png`, `103-unmaximise-after-reload.png`
- **Suspected files:** `wm/src/compositor/compositor.ts`, `wm/src/compositor/model.ts`, `wm/src/shell/layout.ts`, `Desktop.tsx` layout-persistence region (C1)
- **Fix notes:** post `geometry` (with snap, z and the restore rect) on create/attach, focus/raise, minimise, restore and snap, and keep the `{t:'layout'}` snapshot complete. The kernel side is UI-035; each half must be safe alone.
- **Done when:** e2e "WM-06 after reboot the positions, sizes, states and z-order equal the saved layout" with an untouched, a minimised and a snapped window.

#### UI-035 · major · WM-06 restore: kernel mirror drops rect-less windows; SessionIo prefers it

- **Owner:** fix-system-services · **Area:** kernel window mirror, session · **Sources:** windows #5 (kernel part)
- **Repro:** As UI-034.
- **Expected:** The saved layout is complete.
- **Actual:** `kernel/src/core/window/service.ts` keeps `rect=null` until a `geometry` message and `layoutWindows()` filters those out; z and snap are not tracked; `SessionIo.current()` prefers this mirror over the compositor's own layout.
- **Suspected files:** `kernel/src/core/window/service.ts` (~620–626), `kernel/src/core/io/session.ts`
- **Fix notes:** prefer the compositor's `{t:'layout'}` snapshot when present; never drop a window because its mirror rect is null.
- **Done when:** kernel unit tests for both cases.

#### UI-036 · major · No `window.setCloseGuard` syscall

- **Owner:** fix-system-services · **Area:** close guard (WMD-12) · **Sources:** windows #6 (kernel part)
- **Repro:** grep: nothing in `apps/` or `kernel/` produces `closeGuard`; the shell already handles it (`wm/src/shell/kernel-link.ts`).
- **Expected / contract:** C4 above.
- **Suspected files:** `protocol/src/sys/registry.ts`, `protocol/src/sys/win.ts`, `protocol/src/sys/names.ts`, `kernel/src/core/window/syscalls.ts`, `kernel/src/core/window/service.ts`
- **Done when:** protocol + kernel tests (owner check, message posted, `null` clears).

#### UI-037 · major · Closing a dirty Editor loses the text with no prompt

- **Owner:** fix-files-editor · **Area:** Editor close guard (WMD-12) · **Sources:** windows #6 (app part)
- **Repro:** Editor, type "unsaved text here" (title "Untitled — Edited"), click the red light or Alt+Q.
- **Expected:** "Discard unsaved changes to …?" with Save and close / Discard / Cancel.
- **Actual:** Closes at once; the text is gone.
- **Evidence:** `bug-hunt/windows/132-editor-dirty-before-close.png`, `130-close-guard.png`
- **Suspected files:** `apps/editor/view.tsx`, `apps/editor/proc.ts`, `apps/editor/lib/controller.ts`, `apps/files/lib/relay.ts` (relay list)
- **Fix notes:** call `window.setCloseGuard` per contract C4 (ENOSYS → no-op, so this lands safely before or after UI-036).
- **Done when:** unit test of the guard calls; with UI-036 in the build, e2e "WMD-12 closing an Editor with unsaved changes asks first".

#### UI-038 · major · No snap preview while dragging into a snap zone

- **Owner:** fix-windows · **Area:** snapping (WMD-07) · **Sources:** windows #7
- **Repro:** Drag Terminal to within 8 px of the left, right or top edge and hold.
- **Expected:** A preview rectangle on `--pl-z-snap-preview`, fading in on `--pl-motion-fast` (instant with reduced motion); leaving the zone cancels it.
- **Actual:** Nothing until release; `createCompositor()` passes no `preview` callback.
- **Evidence:** `bug-hunt/windows/40-snap-left-holding-1440.png`, `42-snap-top-holding-1440.png`
- **Suspected files:** `wm/src/compositor/compositor.ts`, `wm/src/compositor/gestures.ts`, `wm/src/shell/WindowLayer.tsx` (+ new `WindowLayer.module.css`)
- **Fix notes:** animate only transform and opacity; no backdrop-filter on the preview.
- **Done when:** unit test of the preview hook; screenshot mid-drag.

#### UI-039 · major · Accent colour setting has no visible effect

- **Owner:** fix-apps-settings-a11y · **Area:** Settings > Appearance, tokens · **Sources:** apps-settings-a11y #3
- **Repro:** Settings > Appearance > click Blue/Yellow/Green/Graphite.
- **Expected:** Selections, switches and focus rings take the accent.
- **Actual:** `<html data-accent>` changes but no CSS reads it (verified: no `data-accent` rule in `ui/src`); `--pl-accent` stays `#5e5ce6`.
- **Evidence:** `bug-hunt/apps-settings-a11y/set2-appearance-accent-yellow.png`, `kb-dark-12-accent-focus.png`
- **Suspected files:** `ui/src/tokens/tokens.css`
- **Fix notes:** `:root[data-accent='…']` overrides of `--pl-accent`, `-hover`, `-pressed`, `-text`, `-subtle`, `-glow` for both themes; `--pl-accent-text` ≥ 4.5:1 and focus ring ≥ 3:1 on every accent; stay under the DSN-39 budget.
- **Done when:** token test per accent (contrast computed); screenshots of 3 accents × 2 themes.

#### UI-040 · major · Settings saved but not applied: clock and Dock

- **Owner:** fix-desktop-shell · **Area:** Settings → shell prefs · **Sources:** apps-settings-a11y #4 (shell part)
- **Repro:** General: 24-hour time off; Desktop & Dock: Size 40/80 px, Magnified size 180 %, Automatically hide, Show indicators off.
- **Expected:** Immediate effect.
- **Actual:** Clock stays "09:57"; Dock items stay 52 px; magnification stays 1.5×; the Dock never hides; running dots stay. Only the magnification on/off switch works (`toShellPrefs` bridges only theme, reduced motion and magnification).
- **Evidence:** `bug-hunt/apps-settings-a11y/set2-general-24h-off.png`, `set3-dock-size-80.png`, `set3-dock-autohide-on.png`, `set3-dock-indicators-off.png`
- **Suspected files:** `apps/src/descriptor.ts` (`toShellPrefs`/`fromShellPrefs`), `wm/src/shell/prefs.ts`, `wm/src/shell/env.ts` (`Prefs`), `ui/src/shell/format.ts` (`formatClock` always `h23`), `ui/src/shell/dock/*`
- **Fix notes:** also write the two window attributes of contract C3 in `applyPrefs`. Dock auto-hide must animate transform/opacity only and stay reachable by keyboard (Alt+N).
- **Done when:** unit tests per key; screenshots.

#### UI-041 · major · Settings saved but not applied: title-bar double-click, minimise effect

- **Owner:** fix-windows · **Area:** windows prefs · **Sources:** apps-settings-a11y #4 (window part)
- **Repro:** Desktop & Dock > Double-click title bar: Minimise; double-click a title bar. Minimise effect: Scale; minimise.
- **Expected:** The chosen action/effect.
- **Actual:** Always zoom / genie.
- **Evidence:** `bug-hunt/apps-settings-a11y/set3-dblclick-title-minimise.png`
- **Suspected files:** `ui/src/shell/window/WindowFrame.tsx`, `wm/src/shell/WindowLayer.tsx`, `wm/src/shell/genie.ts`, `wm/src/shell/motion.ts`
- **Fix notes:** read `data-title-dblclick` / `data-minimise-effect` from the document element (contract C3); defaults zoom/genie.
- **Done when:** tests with each attribute value; Playwright once UI-040 is in the build.

#### UI-042 · major · Settings controls with no consumer silently do nothing

- **Owner:** fix-apps-settings-a11y · **Area:** Settings · **Sources:** apps-settings-a11y #4 (remaining keys)
- **Repro:** Change Language, Device name, Show suggestions, Sync files, Swap write-behind, Updates auto/channel.
- **Expected:** Each control either works or carries a short, honest note ("Not available in this build") and is disabled.
- **Actual:** Saved, no effect anywhere (no consumer outside Settings).
- **Suspected files:** `ui/src/apps/settings/panes/*`, `apps/settings/model.ts`, `apps/settings/controller.ts`
- **Fix notes:** leave the keys UI-040/UI-041 implement (clock, dock size/scale/autohide/indicators, double-click, minimise effect) enabled.
- **Done when:** a test lists every Settings key with its consumer or its disabled note.

#### UI-043 · major · Task Manager state pill on the selected row is illegible

- **Owner:** fix-apps-settings-a11y · **Area:** Task Manager (WCAG 1.4.3) · **Sources:** apps-settings-a11y #5
- **Repro:** Select a BLOCKED row (init, [sched]) in both themes.
- **Expected:** ≥ 4.5:1 for all text on the selected row.
- **Actual:** "BLOCKED" 1.35:1 and "wait" 1.33:1 (light), 2.59:1/2.36:1 (dark); muted cells 4.0:1; the "/" in "Priority / Nice" 2.66:1.
- **Evidence:** `bug-hunt/apps-settings-a11y/tm-selected-row-light.png`, `tm-selected-row-dark.png`, `tm-16-init-end-disabled-tooltip.png`
- **Suspected files:** `ui/src/apps/taskmgr/StatePill.module.css`, `ui/src/primitives/table/Table.module.css`, `ui/src/apps/taskmgr/ProcessesPanel.module.css`
- **Done when:** measured contrast ≥ 4.5:1 in both themes.

#### UI-044 · major · "View as table" collapses the process table

- **Owner:** fix-apps-settings-a11y · **Area:** Task Manager frame card · **Sources:** apps-settings-a11y #7
- **Repro:** Processes > FRAME TIME P95 > "View as table".
- **Expected:** A compact or scrollable table in the card; the process list stays visible.
- **Actual:** The process table shrinks from 197 px to 4 px.
- **Evidence:** `bug-hunt/apps-settings-a11y/tm-18-frame-as-table.png`, `reverify-tm-view-as-table.png`
- **Suspected files:** `ui/src/apps/taskmgr/ProcessesPanel.tsx`, `ui/src/apps/taskmgr/ProcessesPanel.module.css`
- **Done when:** DOM test/screenshot: table height unchanged after toggling.

#### UI-045 · major · Search palette has no search provider

- **Owner:** fix-system-services · **Area:** host wiring (Search) · **Sources:** desktop-shell #6 (provider part)
- **Repro:** Ctrl+Space, type "home" or a file name.
- **Expected:** Keyword + semantic results for files, apps and commands, with preview, open and reveal.
- **Actual:** Only apps; `web/src/desktop/host.ts` builds the DesktopEnv without `search`, so `Desktop.runSearch` falls back to `appResults()`.
- **Evidence:** `bug-hunt/desktop-shell/15-search-no-results.png`
- **Suspected files:** `web/src/desktop/host.ts`, `wm/src/shell/env.ts` (read the `search` interface; do not edit it)
- **Fix notes:** implement `env.search` over the existing search/semsearch path; keyword file results must work even with an empty semantic index.
- **Done when:** unit test of the provider; Playwright: typing an existing file name lists it.

#### UI-046 · major · Search palette promises what it cannot do

- **Owner:** fix-desktop-shell · **Area:** Search palette · **Sources:** desktop-shell #6 (UI part)
- **Repro:** Open Search with no provider.
- **Expected:** With no provider: placeholder "Search apps", no Semantic pill, no "Ctrl+Enter reveal in Files", no "file name" hint; an app result's preview is not a large empty panel.
- **Actual:** "Search files, apps and commands", a Semantic pill, "source: apps", an empty "Application" preview, Tab moves to the esc button.
- **Evidence:** `bug-hunt/desktop-shell/15-search-open-empty.png`, `15-search-no-results.png`, `29-search-1024x700-dark.png`
- **Suspected files:** `ui/src/overlays/search/SearchPalette.tsx`, `wm/src/shell/Desktop.tsx` (Search section)
- **Done when:** component tests with and without a provider.

#### UI-047 · major · Control Centre memory budget slider always disabled

- **Owner:** fix-system-services · **Area:** host wiring (MEM-01) · **Sources:** desktop-shell #7, system-services #10
- **Repro:** Open Control Centre; try the Memory budget slider. Compare Settings > Memory (editable).
- **Expected:** 128 MB–1 GB, step 64, commits on release; read-only only for guests.
- **Actual:** Disabled, "Not available in this session": host.ts provides no `setMemoryBudget` (also no `retryService`, `outbox`, `notificationAction`).
- **Evidence:** `bug-hunt/desktop-shell/05-cc-dark.png`; `bug-hunt/system-services/control-centre-light.png`, `settings-memory.png`
- **Suspected files:** `web/src/desktop/host.ts`, `kernel/src/core/window/service.ts` / `kernel/src/core/proc/sysctl.ts`
- **Fix notes:** use the same kernel path Settings uses; resolve with the kernel's refusal text. Wire `retryService` for UI-075 and `outbox` for UI-026 while there.
- **Done when:** Playwright: slider enabled, a change shows in the menu bar.

#### UI-048 · major · Files search finds nothing; no keyword fallback

- **Owner:** fix-files-editor · **Area:** Files search (RAG-06) · **Sources:** files-editor #11 (app part)
- **Repro:** ~/Projects, search "plan" + Enter, "scheduler", then Keyword mode.
- **Expected:** Semantic results, or keyword matches with the spec notice ("semantic model loading — showing keyword matches" / "Semantic search unavailable — showing keyword matches"); Keyword mode finds by name or content.
- **Actual:** "Semantic results · 0 files", "No matches"; Keyword mode sends `ai.semsearch({mode:'keyword'})` to the same empty index; the local walk runs only when the call throws.
- **Evidence:** `bug-hunt/files-editor/82-semantic-search-results-light.png`, `83-semantic-search-scheduler-light.png`, `84-keyword-search-light.png`, `97-dark-search-empty.png`
- **Suspected files:** `apps/files/lib/controller.ts` (~787–812), `apps/files/lib/ops.ts`
- **Done when:** unit tests: empty index → local keyword results + notice; Keyword mode finds plan.md.

#### UI-049 · major · ai.indexer never indexes the user's local files

- **Owner:** fix-system-services · **Area:** AI indexer · **Sources:** files-editor #11 (indexer part)
- **Repro:** Sign in, wait for "AI 100%", Files status bar "indexed 0 files".
- **Expected:** Home files are indexed after the model loads.
- **Actual:** 0 files indexed.
- **Suspected files:** `services/**` (ai.indexer manifest), `ai/src/**` (indexer, kernel install), `kernel/src/core/io/**`
- **Fix notes:** root-cause first; if the cause is sync-dependent, say so and link UI-006.
- **Done when:** after sign-in the index reports > 0 files for demo's ~/Projects.

#### UI-050 · major · xterm's runtime `<style>` elements still raise 12 CSP violations per Terminal

- **Owner:** fix-terminal · **Area:** Terminal, CSP (SEC-02) · **Sources:** terminal #1, system-services #1 (Terminal part), boot-login #21, windows #20, apps-settings-a11y #23 (Terminal part)
- **Repro:** On 4718 open Terminal with a `securitypolicyviolation` listener.
- **Expected:** No violation (security-model §3.9: CI fails on any).
- **Actual:** Rendering is fixed (Geist Mono 14 px, colours, cursor, selection; triage-verified) by the adopted-stylesheet mirror, but 12 `style-src-elem` violations are still logged per open (15 console errors in the triage's About + Terminal + Files run).
- **Evidence:** `bug-hunt/terminal/52-rebuilt-light-colours.png`, `31-CONTROL-bypassCSP-dark.png`; `bug-hunt/system-services/raw/ss-csp.json`; `polish/triage/t1-light.json` (`errors1`)
- **Suspected files:** `ui/src/apps/terminal/TerminalHost.tsx`, `ui/src/primitives/internal/csp-styles.ts`
- **Fix notes:** stop the refused `<style>` from ever being connected/applied (for example keep xterm's style elements out of the document and mirror their text), without weakening the CSP (C5). No new packages (no WebGL addon is installed).
- **Done when:** e2e on the docker build fails on any `securitypolicyviolation` while a Terminal is open and passes; rendering screenshots unchanged.

#### UI-051 · major · CodeMirror's style-mod `<style>` raises a CSP violation per Editor

- **Owner:** fix-files-editor · **Area:** Editor, CSP · **Sources:** system-services #1 (Editor part), files-editor #32 (style-src-elem part)
- **Repro:** Open the Editor on 4718 with a violation listener.
- **Expected:** No violation.
- **Actual:** 1 `style-src-elem` violation (layout is correct thanks to the mirror).
- **Suspected files:** `ui/src/apps/editor/CodeEditor.tsx`
- **Fix notes:** use `csp-styles.ts` as-is (fix-terminal owns it); do not weaken the CSP (C5).
- **Done when:** the same e2e as UI-050 with an Editor open.

#### UI-052 · major · Files view switcher squeezes to 50 px

- **Owner:** fix-files-editor · **Area:** Files toolbar · **Sources:** files-editor #9
- **Repro:** Files at 720×480 or in a long-named folder.
- **Expected:** The segmented control keeps 4 × 28 px; other items give way.
- **Actual:** 50 px wide, radios overlap, thumb between List and Columns (triage screenshot shows it too).
- **Evidence:** `bug-hunt/files-editor/99-fresh-default-window-1440.png`, `41-default-window-projects.png`, `42-default-window-long-folder.png`; `polish/triage/files-default-light.png`
- **Suspected files:** `ui/src/apps/files/FilesToolbar.tsx`, `ui/src/apps/files/Files.module.css`
- **Fix notes:** `flex: none` for the control inside Files CSS; do not edit `ui/src/primitives/segmented-control` (not yours).
- **Done when:** screenshots at 3 widths.

#### UI-053 · major · `man` has no pages

- **Owner:** fix-terminal · **Area:** Terminal man · **Sources:** terminal #4
- **Repro:** `man ls`, `man man`, `man -k ls`, `ls /usr/share/man`.
- **Expected:** The page from `apps/coreutils/man/ls.md` in the pager; the banner and usage errors say "Try 'man X'".
- **Actual:** "no manual entry" for everything; /usr/share/man is empty.
- **Evidence:** `bug-hunt/terminal/11-man-ls.png`, `51-recheck-after-qa-rebuild.png`
- **Suspected files:** `apps/coreutils/cmd/man.ts`, `apps/terminal/host/programs.ts`
- **Fix notes:** serve the bundled pages read-only from the terminal host overlay (as `/bin` is served) instead of the kernel seed (which is fix-system-services'); keep `man -k` working.
- **Done when:** test: `man ls` renders; Playwright screenshot.

#### UI-054 · major · `find` and `du` crash

- **Owner:** fix-terminal · **Area:** coreutils · **Sources:** terminal #5
- **Repro:** `find /tmp -name "*.md"`, `du -sh ~`.
- **Expected:** Results.
- **Actual:** "crashed: find: not available here" (the kernel has no find/du syscalls: ENOSYS).
- **Evidence:** `bug-hunt/terminal/05-find-du-df-quota-free.png`, `04-redirect-grep-find-tree-stat-chmod.png`
- **Suspected files:** `apps/coreutils/lib/fs.ts`, `apps/coreutils/cmd/find.ts`, `apps/coreutils/cmd/du.ts`
- **Fix notes:** on ENOSYS fall back to a readdir walk (as `grep -r`/`tree` do); never crash on ENOSYS.
- **Done when:** tests with an ENOSYS delegate; Playwright run of both commands.

#### UI-055 · major · `ai` always says "agent unavailable (not installed)"

- **Owner:** fix-terminal · **Area:** agentic shell · **Sources:** terminal #6
- **Repro:** `ai "list my files"`, `ai status`.
- **Expected:** A plan and confirmation, or a truthful fallback ("AI unavailable · plain shell", "ai.agent is degraded (requires sync)"); the status strip shows the agent state.
- **Actual:** "not installed" (manifest path `/bin/lib/ai.agent.json` vs seeded `/bin/ai-agent.json`; the Terminal mount is given no `programs`).
- **Evidence:** `bug-hunt/terminal/15-ai-list-my-files.png`, `17-ai-status-semsearch.png`
- **Suspected files:** `apps/coreutils/cmd/ai.ts`, `apps/coreutils/lib/ai.ts`, `apps/terminal/view.tsx`, `apps/terminal/host/programs.ts`
- **Done when:** tests for each agent state's message; Playwright screenshot.

#### UI-056 · major · Terminal-started processes never appear in Task Manager (architectural)

- **Owner:** fix-terminal · **Area:** Terminal process host (PROC-08) · **Sources:** apps-settings-a11y #2
- **Repro:** `burn --ms 600000 &`, `ps`; open Task Manager, search "burn".
- **Expected:** burn and sh listed, endable, CPU visible.
- **Actual:** Only kernel processes; the Terminal runs its shell in a view-local host (pids ≥ 300; `apps/terminal/host/host.ts` "TODO(R1)").
- **Evidence:** `bug-hunt/apps-settings-a11y/tm-00-terminal-burn.png`, `reverify-tm-search-burn.png`
- **Suspected files:** `apps/terminal/host/host.ts`, `apps/terminal/session.ts`
- **Fix notes:** fix only if it fits inside your files without kernel changes; otherwise document the limitation and the R1 plan in your report (do not hack Task Manager, which is not yours).
- **Done when:** fixed with a test, or explicitly deferred with reasons.

#### UI-057 · major · Recovery console actions do nothing: the kernel drops `recovery.run`

- **Owner:** fix-system-services · **Area:** recovery console (SVC-06, BOOT-04) · **Sources:** boot-login #6 (kernel part)
- **Repro:** `/?boot=recovery`, press F, L, M → Yes, S → Yes; wait 8 s.
- **Expected:** F prints the fsck report, L the last 20 boot records; M/S/Y/C act and report.
- **Actual:** Only "<action>: sent to the kernel; its report follows". `kernel/src/host/boot-sequence.ts` (~174–179) returns early on `recovery.run` (verified).
- **Evidence:** `bug-hunt/boot-login/recovery-actions.json`, `recovery-dark-1440-fsck.png`
- **Suspected files:** `kernel/src/host/boot-sequence.ts`
- **Fix notes:** answer through the message contract `web/src/boot/recovery-console.ts` already understands; list any contract gap in your report (the console is fix-boot-login's, UI-060).
- **Done when:** kernel tests per action; Playwright F shows a report.

#### UI-058 · major · Stage-2 boot-volume read is a stub

- **Owner:** fix-system-services · **Area:** boot menu, safe mode (§3.7(2), BOOT-04) · **Sources:** boot-login #7
- **Repro:** Open `/?boot=recovery` twice, then `/`; read the verbose "svc:" line.
- **Expected:** After 2 failed boots the menu opens with Safe preselected; normal mode reads /system/services.
- **Actual:** Straight to login; "svc: 18 manifests (builtin)"; `kernel/src/host/worker.ts` (~253) posts `{bootFlags:{}, recentBoots:[], volumeOk:false}` (verified, TODO(R2)).
- **Evidence:** `bug-hunt/boot-login/autosafe-recovery.json`, `verbose-url-dark-1440-3.png`
- **Suspected files:** `kernel/src/host/worker.ts`
- **Done when:** e2e: 2 recovery boots → menu with Safe preselected.

#### UI-059 · major · 10-window drag/resize run misses the frame budget (headless; re-measure)

- **Owner:** fix-windows · **Area:** performance (WM-03) · **Sources:** windows #13
- **Repro:** §8.2 script: 10 windows, drag each along an ellipse, resize se/nw ±200 px, frame meter on.
- **Expected:** p95 ≤ 16.7 ms, 0 LoAF > 50 ms from our origin.
- **Actual (headless, no GPU; indicative only):** drag alone OK (p95 16.7); with resizes p95 33.3, 10.3 % dropped, 73 LoAF > 50 ms (161 ms in the Terminal view chunk, 80 ms in the Files view chunk).
- **Evidence:** `bug-hunt/windows/93-frame-meter-after-trace-script.png`, `92-frame-meter-after-10-window-drag-light.png`
- **Suspected files:** `wm/src/compositor/gestures.ts`
- **Fix notes:** re-measure first (headful Chrome if possible). If it reproduces: freeze the content box for the whole gesture (§3.5), publish the `interactive` hint that apps can use to throttle. Do not edit app views (not yours).
- **Done when:** a measured before/after with the method stated; never a claim without a measurement.

### P2: minor

#### UI-060 · minor · Recovery console says "its report follows" and then nothing

- **Owner:** fix-boot-login · **Sources:** boot-login #6 (UI part) · **Files:** `web/src/boot/recovery-console.ts`
- **Actual / expected:** Until a kernel answer arrives the console claims a report; add a timeout ("No answer from the kernel") and only claim what is true. Works with or without UI-057. **Evidence:** `bug-hunt/boot-login/recovery-actions.json`

#### UI-061 · minor · Splash first paint jumps ~20 px and swaps font mid-boot

- **Owner:** fix-boot-login · **Sources:** boot-login #9, fonts
- **Repro:** Record `.plb-mark`/`.plb-word` positions per frame on a fast network; throttle to 60 KB/s.
- **Expected:** BOOT-01 stable from the first frame; D-05: "the boot-ui uses the system stack … no font request before the login screen".
- **Actual:** `.plb-count` un-hides at ~300 ms and the column jumps ~20 px; the text paints in a fallback and swaps to Inter 250–320 ms later (fonts arrive with the lazily loaded host CSS; `--pl-font-ui` puts Inter first); at 60 KB/s the splash stays in the fallback for 13 s; tabular-nums widens the version hyphen.
- **Evidence:** `bug-hunt/boot-login/fout-compare-crop.png`, `shift-probe-1440.json`, `splash-first-dark-none-1440.png`, `fonts-probe.json`
- **Files:** `ui/src/boot/splash.ts`, `ui/src/boot/boot.css`
- **Fix notes:** reserve the count line from the first paint (visibility/opacity, not `[hidden]`); give `.plb` a boot-only system font stack in `boot.css` (do not edit `ui/src/tokens`, `web/index.html` or add a preload).

#### UI-062 · minor · Verbose log stops following after a large batch

- **Owner:** fix-boot-login · **Sources:** boot-login #10 · **Files:** `ui/src/boot/log.ts` (`onScroll` ~222–227)
- **Repro / actual:** Signed-in `/?boot=menu` → 4: scrollTop stays 122 while scrollHeight jumps to 10 544 ("↓ 479 new lines"). Compare with painted rows or ignore programmatic scrolls. **Evidence:** `bug-hunt/boot-login/menu-verbose-session-7.png`, `term-reboot-menu-verbose-1.png`

#### UI-063 · minor · Duplicate klog "storage: WARN persistent storage denied"

- **Owner:** fix-system-services · **Sources:** boot-login #11 · **Files:** `kernel/src/host/boot-sequence.ts` (~157–162), `kernel/src/core/io/index.ts` (~664–669)
- **Actual:** logged twice at the same timestamp plus a near-identical third line. Log once. **Evidence:** `bug-hunt/boot-login/verbose-url-dark-1440-3.png`

#### UI-064 · minor · Login power row and corners differ from D-17 / §3.4.4

- **Owner:** fix-boot-login · **Sources:** boot-login #12 · **Files:** `ui/src/login/LoginScreen.tsx`, `wm/src/shell/Login.tsx`
- **Actual:** Sleep shown and dead (D-17 drops it; triage screenshot still shows Sleep); Esc does not cancel "Shut Down?"; no "Forgot password?" popover; no Accessibility button (wire `onA11y` to reduce motion / reduce transparency). **Evidence:** `bug-hunt/boot-login/power-sleep-dark.png`, `power-esc-dark-confirm.png`, `login-dark-1440x900.png`; `polish/triage/login-light.png`
- **Note:** `wm/src/shell/mount.tsx` (lock → power) is fix-desktop-shell's; removing Sleep needs no change there.

#### UI-065 · minor · Rate-limit countdown announced every second

- **Owner:** fix-boot-login · **Sources:** boot-login #13 · **Files:** `ui/src/login/LoginScreen.tsx` (~539–547)
- **Actual:** role=alert on text that changes each second. Announce once politely; keep the ticking number out of the live region. **Evidence:** `bug-hunt/boot-login/mock-login-dark.json`

#### UI-066 · minor · Boot menu keys stop after a click outside the panel

- **Owner:** fix-boot-login · **Sources:** boot-login #14 · **Files:** `ui/src/boot/menu.ts`
- **Actual:** focus goes to BODY and arrows/Enter/Esc do nothing (countdown already stopped). Handle keys at the menu root/document while open. **Evidence:** `bug-hunt/boot-login/menu-url-light-click-1440.json`, `menu-url-light-click-1440-clicked.png`

#### UI-067 · minor · "V Verbose log" chip out of step with the V key

- **Owner:** fix-boot-login · **Sources:** boot-login #15 · **Files:** `web/src/boot/driver.ts`, `ui/src/boot/splash.ts`
- **Actual:** the chip toggles only the splash; the first V press then does nothing. Pass `onToggleVerbose`. **Evidence:** `bug-hunt/boot-login/vchip-desync.txt`

#### UI-068 · minor · Recovery console layout

- **Owner:** fix-boot-login · **Sources:** boot-login #16 · **Files:** `ui/src/boot/recovery.ts`, `ui/src/boot/boot.css`
- **Actual:** at 1280×800 the list pushes out the heading and clips the last row with no scroll; three traffic-light dots (D-19 forbids); awkward wraps ("Clear local cache and re-/sync"); Esc does not cancel a confirmation. **Evidence:** `bug-hunt/boot-login/recovery-light-1280-open.png`, `recovery-dark-1440-repair-confirm.png`, `recovery-dark-1440.json`

#### UI-069 · minor · Unsupported-browser screen hard-codes `http://localhost:4717`

- **Owner:** fix-boot-login · **Sources:** boot-login #17 · **Files:** `ui/src/boot/unsupported.ts` (~75), `web/src/boot/probe.ts` (~78)
- **Fix:** build the text from `location.origin`. **Evidence:** `bug-hunt/boot-login/unsupported-dark.png`

#### UI-070 · minor · Login tile initials below 3:1

- **Owner:** fix-boot-login · **Sources:** apps-settings-a11y #19 (login part) · **Files:** `ui/src/login/*.module.css`
- **Actual:** 48 px initials 1.78–2.53:1 (large text needs 3:1). **Evidence:** `bug-hunt/apps-settings-a11y/axe-light-login.png`; `polish/triage/login-light.png`

#### UI-071 · minor · AI chip stuck at "AI 100%, indexing"

- **Owner:** fix-desktop-shell · **Sources:** desktop-shell #9, system-services #12 · **Files:** `wm/src/shell/status.ts` (`aiFrom`)
- **Actual:** on `ai.model` ready it keeps prev "indexing" at 100 % forever (triage screenshots too). Go idle unless an `ai.index.progress` with pending > 0 arrived. (`ai/src/kernel/install.ts` publishing `pending: 0` is not yours; do not depend on it.) **Evidence:** `bug-hunt/desktop-shell/01-desktop-1440-light.png`; `polish/triage/about-light.png`

#### UI-072 · minor · Frame meter HUD overlaps; "fps" for Hz; boot LoAFs counted

- **Owner:** fix-desktop-shell · **Sources:** desktop-shell #10, windows #12 · **Files:** `wm/src/shell/Desktop.tsx` (frame meter section), `ui/src/overlays/frame-meter/FrameMeterHUD.tsx`/`.module.css`, `wm/src/shell/frame-sampler.ts`
- **Actual:** HUD (z 10150, x 1172–1428) covers CC tiles and the first banner (D-22: shift left of an open popover); headline "60 fps" is the refresh rate ("p95 33.3 ms · 60 fps"); `buffered:true` counts boot frames. **Evidence:** `bug-hunt/desktop-shell/05-cc-frame-meter-on.png`, `34-frame-meter-over-toasts.png`; `bug-hunt/windows/150-hud-with-control-centre-dark.png`, `91-frame-meter-idle-light.png`

#### UI-073 · minor · CC trigger (or clock) second click closes and re-opens

- **Owner:** fix-desktop-shell · **Sources:** desktop-shell #11 · **Files:** `wm/src/shell/Desktop.tsx`, `ui/src/shell/control-centre/ControlCentre.tsx`
- **Fix:** pass the triggers as the dismissable layer's inside list/anchor. **Evidence:** `bug-hunt/desktop-shell/05-cc-after-second-click.png`, `10-clock-second-click.png`

#### UI-074 · minor · "Retry now" sticks at "Retrying…"; row buttons truncated

- **Owner:** fix-desktop-shell · **Sources:** desktop-shell #12, system-services #7 (UI part) · **Files:** `wm/src/shell/Desktop.tsx` (`retryService`), `ui/src/shell/control-centre/ControlCentre.tsx`/`.module.css`, `ui/src/overlays/offline/OfflinePopover.tsx`
- **Actual:** cleared only on svc events that never come; "Retry …", "Retr…"; reasons ellipsised with no tooltip. Clear on the answer or after a timeout with "Could not retry"; `flex-shrink:0; white-space:nowrap` on the button. Works with or without UI-075. **Evidence:** `bug-hunt/desktop-shell/27-cc-retry-stuck-30s.png`; `bug-hunt/system-services/cc-retry-stuck-after-10s.png`, `cc-services-expanded.png`

#### UI-075 · minor · `svc.retry` never answered; degraded services cannot be retried

- **Owner:** fix-system-services · **Sources:** system-services #7 (kernel part) · **Files:** `services/src/svcmgr.ts` (`retry`), `kernel/src/core/io/system.ts`, `kernel/src/core/io/index.ts`, `web/src/desktop/host.ts` (`retryService`)
- **Actual:** "retry lockd: not retryable now" in klog, no event. Restart a degraded service or report "not self-healing", and always answer.

#### UI-076 · minor · "About <App>" opens About Plotinium

- **Owner:** fix-desktop-shell · **Sources:** desktop-shell #13 · **Files:** `wm/src/shell/Desktop.tsx` (`onMenuSelect`), `ui/src/shell/menubar/MenuBar.tsx`
- **Fix:** route to the app (`viewHost.menuCommand`) or an app about sheet; fall back only on the desktop. **Evidence:** `bug-hunt/desktop-shell/14-about-files.png`

#### UI-077 · minor · Help items do nothing; wrong Settings sections

- **Owner:** fix-desktop-shell · **Sources:** desktop-shell #14, terminal #19 (Help part), apps-settings-a11y #12 · **Files:** `wm/src/shell/Desktop.tsx`, `apps/settings/model.ts` (read only: `sectionFromArgv`)
- **Actual:** "<App> Help" (`app-help`) unhandled; Keyboard Shortcuts launches settings `['keyboard']` (no such section); the AI chip launches `['ai']` (only `privacy`/`privacy-ai` accepted); a running Settings ignores argv. Implement `app-help` and a shortcuts sheet from `keys.ts` `DEFAULT_BINDINGS` in the shell; launch `['privacy']`; forward argv to a running singleton. Do not remove the menu items (`menus.ts` is fix-windows'). **Evidence:** `bug-hunt/desktop-shell/14-files-help.png`, `14-help-keyboard-shortcuts.png`, `36-ai-chip-opens-settings-general.png`; `bug-hunt/terminal/23-help-terminal-help.png`; `bug-hunt/apps-settings-a11y/set5-help-keyboard-shortcuts.png`

#### UI-078 · minor · Dock keyboard: Alt+N lands on Trash; Esc/menu close lose focus

- **Owner:** fix-desktop-shell · **Sources:** desktop-shell #15, windows #11 (dock part) · **Files:** `ui/src/shell/dock/Dock.tsx`, `wm/src/shell/Desktop.tsx`
- **Fix:** initial tab stop = first app; restore focus to the icon when its menu closes; Esc returns to the focused window (§3.9). **Evidence:** `bug-hunt/desktop-shell/24-altN-dock-focus.png`

#### UI-079 · minor · "+N from <App>" button cannot be clicked

- **Owner:** fix-desktop-shell · **Sources:** desktop-shell #16 · **Files:** `ui/src/shell/notifications/Notifications.module.css`, `NotificationCenter.tsx`
- **Fix:** `.slab { pointer-events:none }` and/or lift `.more`. **Evidence:** `bug-hunt/desktop-shell/37-nc-grouped-stack.png`, `38-nc-plus-from-click.png`

#### UI-080 · minor · Repeated notifications not collapsed

- **Owner:** fix-desktop-shell · **Sources:** desktop-shell #17 · **Files:** `wm/src/shell/Desktop.tsx`, `wm/src/shell/status.ts`, `ui/src/shell/notifications/NotificationToasts.tsx`
- **Fix:** ≤ 1 banner per source per 2 s; merge identical ones with a count. **Evidence:** `bug-hunt/desktop-shell/37-taskmgr-notifications-toasts.png`

#### UI-081 · minor · Alt+C does not focus Control Centre; Esc does not return focus

- **Owner:** fix-desktop-shell · **Sources:** desktop-shell #18 · **Files:** `wm/src/shell/Desktop.tsx`, `ui/src/shell/control-centre/ControlCentre.tsx`
- **Evidence:** `bug-hunt/desktop-shell/24-status-focus-ring.png`

#### UI-082 · minor · Notification card: Delete drops focus; Escape deletes

- **Owner:** fix-desktop-shell · **Sources:** desktop-shell #19 · **Files:** `ui/src/shell/notifications/NotificationCard.tsx`, `NotificationCenter.tsx`
- **Fix:** Escape never dismisses; move focus to the next card before removal. **Evidence:** `bug-hunt/desktop-shell/11-nc-card-focus.png`

#### UI-083 · minor · Wallpaper click does not unfocus; Overview ignores empty clicks; bars stay in Overview

- **Owner:** fix-desktop-shell · **Sources:** desktop-shell #20 · **Files:** `wm/src/shell/Desktop.tsx`, `ui/src/shell/wallpaper/Wallpaper.tsx`, `ui/src/overlays/overview/Overview.tsx`
- **Note:** focusing "the desktop" needs a compositor call; use the existing public compositor API (`cmp`), and if a new one is needed, list it for fix-windows instead of editing `wm/src/compositor`. **Evidence:** `bug-hunt/desktop-shell/31-after-wallpaper-click.png`, `16-overview-3-windows.png`

#### UI-084 · minor · Dock Trash opens Files at home

- **Owner:** fix-desktop-shell · **Sources:** desktop-shell #21 · **Files:** `wm/src/shell/Desktop.tsx` (Dock `onTrash`)
- **Fix:** pass the Trash path (the one Files' Go > Trash uses); forward to a running Files. **Evidence:** `bug-hunt/desktop-shell/12-dock-trash-click.png`

#### UI-085 · minor · Status items a11y

- **Owner:** fix-desktop-shell · **Sources:** desktop-shell #22 · **Files:** `wm/src/shell/Desktop.tsx`, `ui/src/shell/menubar/StatusItems.tsx`, `MenuBar.tsx`, `ui/src/shell/dock/Dock.tsx`
- **Actual:** "4 degraded" and the clock keep `aria-expanded=false` while open; atom and desktop app menu both named "Plotinium"; no `<nav aria-label="Menu bar">`/`"Dock"` (Dock labelled "Taskbar"); memory label "0/256 MB memory used". **Evidence:** `bug-hunt/desktop-shell/09-status-degraded.png`

#### UI-086 · minor · App menu "Quit <App> Alt+Q" misleads; "Quit Plotinium" dead

- **Owner:** fix-desktop-shell · **Sources:** desktop-shell #23 (app-menu part) · **Files:** `ui/src/shell/menubar/MenuBar.tsx` (`defaultAppMenu`), `wm/src/shell/Desktop.tsx`
- **Actual:** Alt+Q closes the window, not the app; Quit on the bare desktop does nothing (hide it). The Window-menu part is UI-094. **Evidence:** `bug-hunt/desktop-shell/02-menu-desktop-1-Plotinium.png`, `13-menu-files-1-Files.png`

#### UI-087 · minor · App menu shortcuts shown but not bound

- **Owner:** fix-desktop-shell · **Sources:** apps-settings-a11y #11 · **Files:** `wm/src/shell/Desktop.tsx` (keyboard section), `wm/src/shell/keys.ts`
- **Actual:** Task Manager Ctrl+1–4, Ctrl+R, Alt+Ctrl+Q do nothing (descriptor shortcuts are display-only). Dispatch a focused app's menu shortcut to `onMenuSelect` **only if the app did not handle the key** (`defaultPrevented`), so apps with their own handlers (Terminal, Editor) do not double-fire. The shell's existing `onKeyDown` is a _capture_ listener on the window (`Desktop.tsx` ~1461), which runs before the app; add the menu-shortcut dispatch as a separate bubble-phase listener so it sees the app's `preventDefault`. **Evidence:** `bug-hunt/apps-settings-a11y/menu-tm-view.png`, `tm-08-end-menu.png`

#### UI-088 · minor · Global Tab cycle has an invisible `<body>` stop

- **Owner:** fix-desktop-shell · **Sources:** apps-settings-a11y #14b · **Files:** `wm/src/shell/Desktop.tsx`, `wm/src/shell/Shell.module.css`
- **Actual:** window → Dock item → BODY (no visible focus) → menu bar. **Evidence:** `bug-hunt/apps-settings-a11y/kb-dark-00-dock-focus-taskmgr.png`

#### UI-089 · minor · Menu-bar chips below 4.5:1 on glass

- **Owner:** fix-desktop-shell · **Sources:** apps-settings-a11y #19 (menu-bar part) · **Files:** `ui/src/shell/menubar/*`
- **Actual:** "4 degraded" 4.33:1, "AI 100%" 4.30:1 (light). **Evidence:** numbers in the apps-settings-a11y report; `polish/triage/about-light.png`

#### UI-090 · minor · Memory meter rounds to "0/256 MB"

- **Owner:** fix-desktop-shell · **Sources:** system-services #9 (display part) · **Files:** `ui/src/shell/format.ts` (`memoryText`, `formatMb`)
- **Fix:** KB or one decimal below 10 MB, one format for menu bar and Control Centre. The data source is UI-133. **Evidence:** `bug-hunt/system-services/control-centre-light.png`

#### UI-091 · minor · Static `style={{…}}` literals in shell/overlays raise CSP errors

- **Owner:** fix-desktop-shell · **Sources:** desktop-shell #25, system-services #15 (attr part) · **Files:** `ui/src/shell/control-centre/ControlCentre.tsx` (stagger 0,1,3,4,7), `ui/src/shell/notifications/NotificationCenter.tsx`, audit `ui/src/overlays/**`, `ui/src/shell/**`
- **Fix:** Solid inlines _literal_ style objects into template HTML (`style-src-attr` violation); use classes/data attributes or non-literal values. C5 applies. **Evidence:** `bug-hunt/desktop-shell/05-cc-open-light.png`; `bug-hunt/system-services/raw/ss-csp.json`
- **Done when:** 0 `style-src-attr` violations opening CC, NC, Search, Overview, switcher on 4718.

#### UI-092 · minor · `data-app="taskmgr"` vs contract `task-manager`

- **Owner:** fix-desktop-shell · **Sources:** qa-setup (C), apps-settings-a11y #18 (data-app part) · **Files:** `wm/src/shell/testids.ts`
- **Fix:** map the app id to the contract id in the test attributes only (`tests/e2e/offline-boot.spec.ts` uses `task-manager`); do not rename the app id. Tell the other fixers in your report (their scripts use `taskmgr`).

#### UI-093 · minor · Dock shows no minimised marker

- **Owner:** fix-desktop-shell · **Sources:** windows #16 · **Files:** `ui/src/shell/dock/Dock.tsx`, `DockIcon.tsx`, `wm/src/shell/dock-logic.ts`
- **Fix:** a marker and ", 1 minimised" in the label (UIG §3.5.3). **Evidence:** `bug-hunt/windows/11-terminal-minimised-m.png`, `11-terminal-minimised-rm.png`

#### UI-094 · minor · Window menu gaps

- **Owner:** fix-windows · **Sources:** windows #10 and #11 (menu part), desktop-shell #23 (Overview part) · **Files:** `wm/src/shell/menus.ts`, `Desktop.tsx` window-menu elements (C1), `ui/src/shell/window/WindowFrame.tsx`, `wm/src/compositor/*`
- **Actual:** Esc after Shift+F10 leaves focus on BODY; with no focused window every Window-menu item is disabled including Overview; no Move/Size (keyboard move/resize: arrows 16 px, Shift 1 px, Enter commits, Esc reverts, announced) or Full screen (WCAG 2.5.7); right-clicking a title bar opens nothing (D-02). **Evidence:** `bug-hunt/windows/70-alt-w-window-menu.png`, `120-right-click-title-bar.png`; `bug-hunt/desktop-shell/02-menu-desktop-4-Window.png`

#### UI-095 · minor · Restoring a drag-snapped window returns it to the release point

- **Owner:** fix-windows · **Sources:** windows #8 · **Files:** `wm/src/compositor/gestures.ts`, `model.ts`
- **Actual:** {40,68} → snapped → restore to {-297,436}. Record the pre-drag rect as `restoreRect`. **Evidence:** `bug-hunt/windows/145-restore-after-drag-snap.png`

#### UI-096 · minor · Narrow viewports

- **Owner:** fix-windows · **Sources:** windows #14 · **Files:** `wm/src/compositor/model.ts` (`setWorkArea` TODO(R3)), `geometry.ts`
- **Actual:** snapped Editor 380 px at 760 (min 560); Settings maximised below its min; no compact mode below 800; a clamped height stays clamped after the viewport grows. **Evidence:** `bug-hunt/windows/111-viewport-1024x700.png`, `111-viewport-760x560.png`, `111-viewport-1920x1080.png`

#### UI-097 · minor · Files status bar texts overlap

- **Owner:** fix-files-editor · **Sources:** files-editor #10 · **Files:** `ui/src/apps/files/Files.module.css`, `FilesStatusBar.tsx`
- **Evidence:** `bug-hunt/files-editor/42-default-window-long-folder.png`

#### UI-098 · minor · Path bar "…" menu opens at the top-left

- **Owner:** fix-files-editor · **Sources:** files-editor #12 · **Files:** `ui/src/apps/files/PathBar.tsx` (~39/93/116)
- **Fix:** store the button in a signal so the Menu anchor updates. **Evidence:** `bug-hunt/files-editor/45-path-overflow-menu.png`, `111-path-overflow-menu-recheck.png`

#### UI-099 · minor · Editor toasts never dismiss

- **Owner:** fix-files-editor · **Sources:** files-editor #13 · **Files:** `apps/editor/view.tsx` (~287–300), `apps/files/view.tsx` (~200–213)
- **Fix:** key on `createMemo(() => state().toast?.id)`. **Evidence:** `bug-hunt/files-editor/74-editor-toast-stuck-15s.png`

#### UI-100 · minor · Ctrl+Shift+S runs Save

- **Owner:** fix-files-editor · **Sources:** files-editor #14 · **Files:** `ui/src/apps/editor/CodeEditor.tsx`, `apps/editor/view.tsx` (~410)
- **Evidence:** `bug-hunt/files-editor/104-editor-ctrl-f.png`

#### UI-101 · minor · Editor has no find (DEFERRED)

- **Owner:** fix-files-editor · **Sources:** files-editor #15
- **Status:** needs `@codemirror/search`, which is **not installed** (checked `node_modules/.pnpm`), and this wave forbids `pnpm add`. Do not hand-roll a search panel. Record it as deferred in your report. **Evidence:** `bug-hunt/files-editor/104-editor-ctrl-f.png`

#### UI-102 · minor · Save As defaults to a missing `~/Documents/untitled.md`

- **Owner:** fix-files-editor · **Sources:** files-editor #16 · **Files:** `apps/editor/view.tsx` (~319–324), `apps/editor/lib/controller.ts`
- **Fix:** default to the shown folder or home, extension from the language; name a missing folder in the error. **Evidence:** `bug-hunt/files-editor/59-save-as-sheet.png`, `81-save-as-default-path-light.png`

#### UI-103 · minor · After "+ New tab" focus stays on "+"

- **Owner:** fix-files-editor · **Sources:** files-editor #17 · **Files:** `apps/editor/view.tsx` (~466), `ui/src/apps/editor/DocumentTabs.tsx`

#### UI-104 · minor · Opening an already-open file spawns a second, read-only window

- **Owner:** fix-files-editor · **Sources:** files-editor #18 · **Files:** `apps/files/lib/controller.ts` (`openWith` ~533), `apps/editor/*`
- **Fix:** focus the window/tab that already has the path. **Evidence:** `bug-hunt/files-editor/62-two-editor-windows.png`, `63-two-editors-lock.png`

#### UI-105 · minor · Files list stale after a content change

- **Owner:** fix-files-editor · **Sources:** files-editor #19 · **Files:** `apps/files/lib/controller.ts` (`poll` ~440–457)
- **Evidence:** `bug-hunt/files-editor/114-files-stale-after-editor-save.png`

#### UI-106 · minor · Inspector History and Share show an unrelated toast

- **Owner:** fix-files-editor · **Sources:** files-editor #20 · **Files:** `apps/files/view.tsx` (~634–647), `ui/src/apps/files/Inspector.tsx`
- **Evidence:** `bug-hunt/files-editor/36-inspector-history-click.png`

#### UI-107 · minor · Trash gaps

- **Owner:** fix-files-editor · **Sources:** files-editor #21 · **Files:** `ui/src/apps/files/menu.ts`, `apps/files/lib/model.ts` (~320), `apps/files/lib/controller.ts`, `ui/src/apps/files/FilesSidebar.tsx`
- **Actual:** no Undo toast action; no Put Back / Delete Immediately; "Move to Trash" inside the Trash; ".Trash" title; clock icon. **Evidence:** `bug-hunt/files-editor/37-after-move-to-trash.png`, `38-trash-view.png`, `39-trash-context-menu.png`

#### UI-108 · minor · Focus falls to `<body>` after sheets and empty-space clicks

- **Owner:** fix-files-editor · **Sources:** files-editor #23 · **Files:** `apps/files/view.tsx`, `ui/src/apps/files/FileList.tsx`, `FileGrid.tsx`
- **Evidence:** `bug-hunt/files-editor/06-background-context-menu.png`

#### UI-109 · minor · No drop-target highlight

- **Owner:** fix-files-editor · **Sources:** files-editor #24 · **Files:** `apps/files/view.tsx`, `ui/src/apps/files/FileList.tsx`/`.module.css`
- **Evidence:** `bug-hunt/files-editor/87-drag-row-over-folder.png`

#### UI-110 · minor · Menu-bar File/Go items ignore context

- **Owner:** fix-files-editor · **Sources:** files-editor #25 · **Files:** `apps/files/manifest.ts`, `apps/files/view.tsx`, `apps/files/lib/controller.ts`
- **Fix:** feedback toasts (menus are static descriptors). **Evidence:** `bug-hunt/files-editor/09-menubar-file-menu.png`

#### UI-111 · minor · Columns and Gallery disabled with no explanation

- **Owner:** fix-files-editor · **Sources:** files-editor #26 · **Files:** `ui/src/apps/files/FilesToolbar.tsx`
- **Evidence:** `bug-hunt/files-editor/53-columns-hover.png`

#### UI-112 · minor · Session restore reopens Editor windows as "Untitled"

- **Owner:** fix-files-editor · **Sources:** files-editor #27 · **Files:** `apps/editor/view.tsx`, `apps/editor/lib/controller.ts`
- **Fix:** persist open paths with the restore key, or skip pathless Editor windows.

#### UI-113 · minor · Files window has two h2 headings

- **Owner:** fix-files-editor · **Sources:** files-editor #28 · **Files:** `ui/src/apps/files/FilesView.tsx`, `apps/files/view.tsx`
- **Fix:** make the toolbar title a non-heading (the frame's sr-only h2 is fix-windows' and stays).

#### UI-114 · minor · Files list fails axe

- **Owner:** fix-files-editor · **Sources:** apps-settings-a11y #24 · **Files:** `ui/src/apps/files/FileList.tsx`
- **Actual:** critical aria-required-children (the empty-state `<h3>` inside `role=grid/rowgroup`); serious target-size (sort buttons 13.5×21.4 px).
- **Done when:** axe (wcag2a/aa, 21a/aa, 22aa) reports 0 serious/critical on Files in both themes.

#### UI-115 · minor · Files labels Home as the user name and compares ownership by name

- **Owner:** fix-files-editor · **Sources:** files-editor #5 (app part) · **Files:** `apps/files/lib/model.ts` (~312), `ui/src/apps/files/menu.ts` (`denyReason`), `ui/src/apps/files/Inspector.tsx` (`canChmod`)
- **Actual:** Favourites shows "u1000"; Change Permissions disabled on your own files and the inspector "Change…" hidden. Label the place "Home" (D-18) and compare by uid, so it works regardless of UI-012. **Evidence:** `bug-hunt/files-editor/01-files-open-1440.png`, `23-row-context-menu-build-sh.png`, `28-inspector-folder.png`

#### UI-116 · minor · DocumentTabs: selected tab not scrolled into view; bell labelled "command failed"

- **Owner:** fix-files-editor (owns `DocumentTabs`) · **Sources:** terminal #15 (scroll part), terminal #22 (bell part) · **Files:** `ui/src/apps/editor/DocumentTabs.tsx` (~50), `DocumentTabs.module.css`
- **Actual:** with 8 tabs the selected one is off-screen (scrollLeft 0); a bell reads "command failed". **Evidence:** `bug-hunt/terminal/20-tab-switch-truncated-prompt.png`, `47-background-bell.png`

#### UI-117 · minor · Editor status bar says "✓ synced" while sync is not linked

- **Owner:** fix-files-editor · **Sources:** system-services #4 (Editor part) · **Files:** `apps/editor/*`, `ui/src/apps/editor/*`
- **Evidence:** `bug-hunt/system-services/fonts-terminal-editor.png`

#### UI-118 · minor · Static `style={{…}}` literals in Files/Editor raise CSP errors

- **Owner:** fix-files-editor · **Sources:** files-editor #32, system-services #15 (attr part) · **Files:** `apps/editor/view.tsx`, `apps/files/view.tsx`, `apps/files/dialogs.tsx`, `apps/files/toast.tsx`, `ui/src/apps/files/*`
- **Done when:** 0 `style-src-attr` violations opening Files and the Editor.

#### UI-119 · minor · `top` header shows the monotonic clock

- **Owner:** fix-terminal · **Sources:** terminal #10 · **Files:** `apps/coreutils/cmd/top.ts`
- **Evidence:** `bug-hunt/terminal/06-ps-top.png`

#### UI-120 · minor · Interactive `top` ignores `q`

- **Owner:** fix-terminal · **Sources:** terminal #11 · **Files:** `apps/coreutils/cmd/top.ts`
- **Fix:** raw mode, read keys between frames, `q` quits, flush input on exit. **Evidence:** `bug-hunt/terminal/33-top-interactive-dark.png`

#### UI-121 · minor · Terminal relay polls every 4–100 ms

- **Owner:** fix-terminal · **Sources:** terminal #12 (terminal part), system-services #14 (poll part) · **Files:** `apps/terminal/proc.ts` (`RELAY_BUSY_SLEEP_MS`/`RELAY_QUIET_SLEEP_MS`), `apps/terminal/controller.ts`
- **Fix:** block on the display port instead of sleeping. The kernel `bootlog` part is UI-135.

#### UI-122 · minor · Terminal tab labels are not unique

- **Owner:** fix-terminal · **Sources:** terminal #15 (label part) · **Files:** `apps/terminal/controller.ts`
- **Fix:** add a number ("sh — 1", Stitch). **Evidence:** `bug-hunt/terminal/20-tab-switch-truncated-prompt.png`

#### UI-123 · minor · Completion "service unavailable"; flag completion does nothing

- **Owner:** fix-terminal · **Sources:** terminal #16 · **Files:** `apps/shell/complete.ts`, `apps/terminal/host/host.ts`, `apps/shell/builtins/help.ts`
- **Note:** flags come from the man index (UI-053). `kernel/src/core/io/complete.ts` is fix-system-services'. **Evidence:** `bug-hunt/terminal/12-tab-completion.png`, `13-svcctl-status.png`

#### UI-124 · minor · `semsearch` with no results prints nothing

- **Owner:** fix-terminal · **Sources:** terminal #17 · **Files:** `apps/coreutils/cmd/semsearch.ts`
- **Evidence:** `bug-hunt/terminal/17-ai-status-semsearch.png`

#### UI-125 · minor · `su` and `lsof` fail with developer messages

- **Owner:** fix-terminal · **Sources:** terminal #18 · **Files:** `apps/coreutils/cmd/su.ts`, `apps/coreutils/cmd/lsof.ts`, `apps/terminal/host/host.ts`
- **Evidence:** `bug-hunt/terminal/41-su-secure-prompt.png`

#### UI-126 · minor · Terminal has no Edit menu and no keyboard copy

- **Owner:** fix-terminal · **Sources:** terminal #19 (Edit part) · **Files:** `apps/terminal/manifest.ts`, `apps/terminal/view.tsx`, `ui/src/apps/terminal/TerminalHost.tsx`
- **Fix:** Edit > Copy/Paste; a copy chord that is not Chrome-reserved; Ctrl+V paste if safe. **Evidence:** `bug-hunt/terminal/22-menu-help.png`, `22-menu-shell.png`

#### UI-127 · minor · A restored Terminal window shows no previous text

- **Owner:** fix-terminal · **Sources:** terminal #20 · **Files:** `apps/terminal/proc.ts`, `apps/terminal/view.tsx`, `ui/src/apps/terminal/TerminalApp.tsx`
- **Evidence:** `bug-hunt/terminal/45-after-reload.png`

#### UI-128 · minor · Terminal grid 18 px wider than its viewport

- **Owner:** fix-terminal · **Sources:** triage (verified), windows #19 (width part)
- **Actual:** `.xterm-screen` 706 px inside a 688 px viewport with "84×17" (84 × 8.4 px); the 84th column sits in the host padding and is cut ~2 px at the window edge.
- **Evidence:** `polish/triage/terminal-width-light.png`, `polish/triage/t1-light.json` (`terminal`)
- **Files:** `ui/src/apps/terminal/TerminalHost.tsx` (fit), `Terminal.module.css`
- **Fix:** fit to the content box (padding and scrollbar) after the web font's re-measure.

#### UI-129 · minor · Open With > Terminal starts in `~`

- **Owner:** fix-terminal · **Sources:** files-editor #22 · **Files:** `apps/terminal/proc.ts`
- **Fix:** honour argv[0] as the working directory. **Evidence:** `bug-hunt/files-editor/106-open-with-terminal.png`

#### UI-130 · minor · Terminal fallback font constant and manifest size assume the old mono face

- **Owner:** fix-terminal · **Sources:** triage, fonts report · **Files:** `ui/src/apps/terminal/theme.ts` (~216–218 fallback), `apps/terminal/manifest.ts` (~87 comment, `TERMINAL_WINDOW`: 24 rows × 21 px + chrome needs ~610 px)
- **Fix:** keep the fallback equal to the family UI-004 puts in `--pl-font-mono` (JetBrains Mono Variable unless UI-004 records otherwise).

#### UI-131 · minor · (known f) Terminal input end to end: lock it in

- **Owner:** fix-terminal · **Sources:** known issue (f), terminal and system-services checked_ok
- **Status:** verified working by two finders and the triage (typed commands run: `ls -la /`, pipes, redirection, job control). Add a Playwright e2e on the docker build that clicks the terminal, types `echo hi | cat`, `cd /tmp && pwd`, and asserts the output, so no fix in this wave regresses it.

#### UI-132 · minor · ai.indexer shown as "pid 0"

- **Owner:** fix-apps-settings-a11y · **Sources:** apps-settings-a11y #8 · **Files:** `apps/taskmgr/model.ts`, `apps/settings/controller.ts`
- **Fix:** strip `[]` from kernel-thread names when matching. **Evidence:** `bug-hunt/apps-settings-a11y/tm-1440x900-max-tab-ai.png`, `set-dark-06-privacy-ai.png`

#### UI-133 · minor · Memory accounting uncalibrated; per-process resident bytes 0

- **Owner:** fix-system-services · **Sources:** system-services #9, apps-settings-a11y #9 · **Files:** `kernel/src/core/mm/params.ts`, `accounting.ts`, `calibration.json`, `mm.ts`, `kernel/src/core/proc/info.ts`
- **Actual:** 64 KiB per process, calibration never loaded, views never charged; `ProcInfo.residentBytes` never updated (Processes tab 0 B for all). **Evidence:** `bug-hunt/system-services/mem-taskmgr.png`, `mem-vmstat-terminal.png`; `bug-hunt/apps-settings-a11y/tm-1440x900-max-tab-processes.png`

#### UI-134 · minor · Every boot warns "ai.predictor stopped — ai.runtime is down"

- **Owner:** fix-system-services · **Sources:** system-services #11 · **Files:** `services/manifests/ai.predictor.json`, `kernel/src/core/io/index.ts`
- **Fix:** add `ai.runtime` to requires (and the §3.3 table), or treat starting as wait. **Evidence:** `bug-hunt/system-services/desktop-settled-light.png`

#### UI-135 · minor · `bootlog` loses the boot timeline; `--list` not implemented

- **Owner:** fix-system-services · **Sources:** system-services #14, terminal #12 (kernel part) · **Files:** `kernel/src/core/io/bootlog.ts`, `kernel/src/core/io/system.ts`
- **Fix:** answer the current boot from the record frozen at desktop-interactive; log proc transitions and traces at debug level; implement `--list`. **Evidence:** `bug-hunt/system-services/term-cmd-0.png`, `term-cmd-1.png`, `term-cmd-2.png`; `bug-hunt/terminal/09-bootlog-critical-path.png`

#### UI-136 · minor · After a redeploy, opening an app shows "Failed to fetch dynamically imported module"

- **Owner:** fix-system-services · **Sources:** terminal #21 · **Files:** `web/src/sw.ts` (precache, UI-007), `web/src/desktop/host.ts`
- **Fix:** with the SW active, old chunks keep being served; otherwise catch the import error and offer "Restart to update". **Evidence:** `bug-hunt/terminal/49-about-terminal.png`

#### UI-137 · minor · Trusted Types report-only noise

- **Owner:** fix-system-services · **Sources:** system-services #15 (TT part) · **Files:** `Caddyfile`, `web/src/main.ts`
- **Actual:** 26 messages at boot, 149 after the five apps, no report-to. Either report it to an endpoint or register a narrow default policy; C5 applies. **Evidence:** `bug-hunt/system-services/raw/ss-csp.json`

#### UI-138 · minor · CPU per executor shows one card while the summary says 11

- **Owner:** fix-apps-settings-a11y · **Sources:** apps-settings-a11y #10 · **Files:** `apps/taskmgr/model.ts`, `apps/taskmgr/controller.ts`, `ui/src/apps/taskmgr/ProcessesPanel.tsx`
- **Evidence:** `bug-hunt/apps-settings-a11y/tm-1440x900-tab-scheduler.png`

#### UI-139 · minor · In-app notice toasts cover content and controls

- **Owner:** fix-apps-settings-a11y · **Sources:** apps-settings-a11y #13 · **Files:** `apps/src/notice.tsx`, `apps/taskmgr/view.tsx`, `apps/settings/view.tsx`
- **Evidence:** `bug-hunt/apps-settings-a11y/tm-12-after-renice.png`, `set4-scheduler-tage-max.png`, `set-dark-10d-system-report.png`

#### UI-140 · minor · Tab from the Renice popover drops focus to `<body>`

- **Owner:** fix-apps-settings-a11y · **Sources:** apps-settings-a11y #14a · **Files:** `ui/src/primitives/popover/Popover.tsx`, `ui/src/apps/taskmgr/ProcessActions.tsx`
- **Evidence:** `bug-hunt/apps-settings-a11y/kb-dark-05-renice-kb.png`

#### UI-141 · minor · Misleading status text in Settings and Task Manager

- **Owner:** fix-apps-settings-a11y · **Sources:** apps-settings-a11y #15 · **Files:** `apps/settings/controller.ts`, `apps/settings/model.ts`, `apps/taskmgr/model.ts`, `ui/src/apps/settings/panes/PrivacyPane.tsx`
- **Actual:** "Everything is synced" with Last synced never; "up to date" with the update service degraded; "Model loading … (loading 100%)"; amber "0 chunks pending"; "$0.00 of $0.00" and amber "Slow responses" with 0 requests. **Evidence:** `bug-hunt/apps-settings-a11y/set4-network-sync-now.png`, `set-dark-06-privacy-ai.png`, `set5-updates-check.png`, `tm-1440x900-tab-ai.png`

#### UI-142 · minor · Telemetry "Time" column in UTC

- **Owner:** fix-apps-settings-a11y · **Sources:** apps-settings-a11y #16 · **Files:** `ui/src/apps/settings/panes/PrivacyPane.tsx`, `apps/settings/model.ts`
- **Evidence:** `bug-hunt/apps-settings-a11y/set-dark-06-privacy-ai.png`

#### UI-143 · minor · Settings > About layout breaks at 880 px

- **Owner:** fix-apps-settings-a11y · **Sources:** apps-settings-a11y #17 · **Files:** `ui/src/apps/settings/panes/AboutPane.tsx`/`.module.css`
- **Note:** `docs/identity/identity.json` (placeholder names) is not editable this wave. **Evidence:** `bug-hunt/apps-settings-a11y/set-dark-10-about.png`, `set-dark-10c-about-bottom.png`, `size-1280x800-settings-about.png`

#### UI-144 · minor · Missing test ids

- **Owner:** fix-apps-settings-a11y · **Sources:** apps-settings-a11y #18 (testid part) · **Files:** `ui/src/apps/taskmgr/TaskManagerView.tsx`, `ui/src/apps/settings/SettingsView.tsx`, `ui/src/apps/settings/panes/AppearancePane.tsx`
- **Fix:** add `data-testid="task-manager"`, `"settings"`, `"theme-toggle"` (tests/e2e/SELECTORS.md). The data-app part is UI-092.

#### UI-145 · minor · Text contrast below 4.5:1 in Task Manager and Settings

- **Owner:** fix-apps-settings-a11y · **Sources:** apps-settings-a11y #19 (app part) · **Files:** `ui/src/apps/taskmgr/StatePill.module.css`, `MemoryPanel.module.css`, `PredictionsPanel.module.css`, `SchedulerPanel.module.css`, `ui/src/apps/settings/panes/PrivacyPane.module.css`, avatar styles
- **Actual:** reason text 4.06–4.23; "0% · healthy" 4.06; "exec-1" 2.68 (light)/3.61 (dark); "Clear telemetry" 4.12 (dark); avatars "R"/"B" ~2.5. Axe marks glass "incomplete", so measure pixels. **Evidence:** `bug-hunt/apps-settings-a11y/tm-1440x900-light-max-tab-processes.png`, `tm-1440x900-light-tab-scheduler.png`, `set-dark-07-users-groups.png`

#### UI-146 · minor · Controls that look active but cannot work

- **Owner:** fix-apps-settings-a11y · **Sources:** apps-settings-a11y #20 · **Files:** `apps/taskmgr/controller.ts`, `apps/settings/controller.ts`, `apps/about/view.tsx`, `ui/src/apps/taskmgr/MemoryPanel.tsx`
- **Actual:** Pin bounces back; Change password / Forget this device only explain; Licences points at the repo; "Open ai log…" opens an empty Terminal; "View all…" does nothing. Disable with a reason, or make them work. **Evidence:** `bug-hunt/apps-settings-a11y/tm4-ai-open-log.png`, `set5-users-change-password.png`, `set-dark-10e-licences.png`, `set4-privacy-view-all.png`

#### UI-147 · minor · Static `style={{…}}` literals in primitives/Task Manager/Settings raise CSP errors

- **Owner:** fix-apps-settings-a11y · **Sources:** apps-settings-a11y #23, system-services #15 (attr part) · **Files:** `ui/src/primitives/icon-button/IconButton.tsx` (`display:contents`), `ui/src/primitives/tabs/Tabs.tsx`, `ui/src/primitives/search-field/*`, `apps/taskmgr/view.tsx`, `apps/settings/view.tsx`, `apps/src/notice.tsx`, `apps/about/view.tsx`, audit `ui/src/apps/{taskmgr,settings}/**`
- **Done when:** 0 `style-src-attr` violations opening Task Manager, Settings and About; primitive props unchanged.

#### UI-148 · minor · Specs and docs still describe the old logo and fonts

- **Owner:** fix-apps-settings-a11y · **Sources:** logo report (problem 3), fonts report (problem 1)
- **Files:** `specs/05-wm/visual-language-macos.md` §3.5/DSN-27 (fonts, `'cv11','ss01'`) and §3.6.2 (mark), `specs/05-wm/ui-implementation-guide.md` D-05 and the typography rules (`document.fonts.load('14px "JetBrains Mono"')`, fonts per UI-004), `specs/00-product/identity-and-branding.md` §3.6, `docs/design/README.md` ("luminous atom mark"), `THIRD_PARTY.md` §2.2 (licences of the faces actually shipped), `ui/gallery/pages/tokens.tsx`, `ui/src/index.ts` line 8, `ui/src/tokens/fonts.css` header ("web/index.html preloads …": no longer true)
- **Fix notes:** use `docs/design/logo/DECISION.md` §4 for the mark text; write the fonts text after UI-004 settles the mono face. Do not remove font packages (no pnpm this wave); list the unused ones in your report.

### P3: cosmetic

#### UI-149 · cosmetic · While unlocking the hint says "Press Enter to sign in"

- **Owner:** fix-boot-login · **Sources:** boot-login #19 · **Files:** `ui/src/login/LoginScreen.tsx` (`hint()` ~317–325) · **Evidence:** `bug-hunt/boot-login/demo-signin-verifying.png`

#### UI-150 · cosmetic · Login clock read digit by digit

- **Owner:** fix-boot-login · **Sources:** boot-login #20 · **Files:** `ui/src/login/LoginScreen.tsx` · **Fix:** `aria-label` on `<time>`, digits aria-hidden. **Evidence:** `bug-hunt/boot-login/login-aria-snapshot.txt`

#### UI-151 · cosmetic · Notification cosmetics

- **Owner:** fix-desktop-shell · **Sources:** desktop-shell #26 · **Files:** `ui/src/shell/notifications/NotificationCard.tsx`, `Notifications.module.css`, `ui/src/shell/control-centre/ControlCentre.module.css`, `wm/src/shell/status.ts`
- **Actual:** warnings use the Info "i" tile (triage screenshot too); raw ids in titles ("ai.agent is degraded"); the CC footer wraps "0000000"; Connectivity tile wraps over 3 lines; card shadows clipped by the scroller. **Evidence:** `bug-hunt/desktop-shell/05-cc-dark-zoom-column.png`, `05-cc-light-zoom-column.png`; `polish/triage/about-light.png`

#### UI-152 · cosmetic · (known a) Menu-bar mark: legible now, soft at 17 px on a half pixel

- **Owner:** fix-desktop-shell · **Sources:** known issue (a), logo report (problem 4), triage check
- **Status of (a):** fixed by the logo agent: at 1x the menu-bar mark reads as a P with nucleus and electron (was a double-orbit smudge); the favicon is redrawn on a 16 px grid.
- **Remaining:** the mark is 17×17 at y = 5.5 with a 3 px drop-shadow glow, so its edges blur at 1x.
- **Evidence:** `polish/triage/menubar-light-1x-logo-zoom10.png`, `polish/triage/menubar-light-1x.png`, `polish/triage/t1-light.json` (`logoBox1`); `polish/logo-stitch/menubar-1x-zoom4.png`
- **Files:** `ui/src/shell/menubar/MenuBar.tsx`, `MenuBar.module.css` (`.atom`)
- **Fix:** 16 px on a whole-pixel offset (the 24-unit drawing aligns at 16 px), glow ≤ 1–2 px. Do not edit `ui/src/icons`.

#### UI-153 · cosmetic · The About window gets a Dock tile drawn as the bare mark

- **Owner:** fix-desktop-shell · **Sources:** apps-settings-a11y #26, triage check · **Files:** `wm/src/shell/dock-logic.ts`, `wm/src/shell/Desktop.tsx` (Dock data)
- **Actual:** About (`dock: false`, icon `atom`) shows a running Dock item with the mark on a pale tile, unlike every other squircle icon. Do not show Dock items for `dock:false` system windows (macOS gives "About" no Dock tile). **Evidence:** `polish/triage/about-light.png`; `bug-hunt/apps-settings-a11y/about-01-dialog-dark.png`

#### UI-154 · cosmetic · Snapped windows keep 14 px corners on the screen edge

- **Owner:** fix-windows · **Sources:** windows #15 · **Files:** `WindowLayer.tsx` (`WinView.snap`), `Desktop.tsx` coarse events (C1), `ui/src/shell/window/WindowFrame.tsx`/`.module.css` · **Evidence:** `bug-hunt/windows/41-snap-left-1440.png`

#### UI-155 · cosmetic · Cascade wraps after 8 windows

- **Owner:** fix-windows · **Sources:** windows #17 · **Files:** `wm/src/compositor/model.ts` · **Evidence:** `bug-hunt/windows/90-ten-windows-light.png`

#### UI-156 · cosmetic · Open animation grows from 50% 60%, not the dock icon

- **Owner:** fix-windows · **Sources:** windows #18 · **Files:** `wm/src/shell/motion.ts`, `wm/src/compositor/compositor.ts`

#### UI-157 · cosmetic · Search placeholder cut mid-word

- **Owner:** fix-files-editor · **Sources:** files-editor #30 · **Files:** `ui/src/apps/files/FilesToolbar.tsx`, `Files.module.css` · **Evidence:** `bug-hunt/files-editor/15-files-zoomed-light-1440.png`; `polish/triage/files-max-light.png`

#### UI-158 · cosmetic · "Choose…" misaligned in Open With

- **Owner:** fix-files-editor · **Sources:** files-editor #31 · **Files:** `ui/src/apps/files/menu.ts` · **Evidence:** `bug-hunt/files-editor/24-open-with-submenu.png`

#### UI-159 · cosmetic · Terminal output errors

- **Owner:** fix-terminal · **Sources:** terminal #22 (2–4) · **Files:** `apps/coreutils/cmd/kill.ts` (ESRCH text), `df.ts` (unit on Used), `ps.ts` (exit 1 for an unknown pid) · **Evidence:** `bug-hunt/terminal/05-find-du-df-quota-free.png`

#### UI-160 · cosmetic · Raw kernel identifiers in the process list

- **Owner:** fix-apps-settings-a11y · **Sources:** apps-settings-a11y #21 · **Files:** `apps/taskmgr/model.ts` (`WAIT_TEXT` has no `svc`) · **Evidence:** `bug-hunt/apps-settings-a11y/tm-02-processes-default-dark.png`

#### UI-161 · cosmetic · Frame-time card wording contradicts itself

- **Owner:** fix-apps-settings-a11y · **Sources:** apps-settings-a11y #22 · **Files:** `ui/src/apps/taskmgr/format.ts`, `ProcessesPanel.tsx` · **Evidence:** `bug-hunt/apps-settings-a11y/tm-12-after-renice.png`, `tm-21-after-end-editor.png`

#### UI-162 · cosmetic · View menu labels differ from the sidebar; Pause never becomes Resume

- **Owner:** fix-apps-settings-a11y · **Sources:** apps-settings-a11y #25 · **Files:** `apps/settings/index.ts`, `apps/taskmgr/index.ts` · **Evidence:** `bug-hunt/apps-settings-a11y/menu-settings-view.png`, `menu-tm-view.png`

#### UI-163 · cosmetic · Empty device name accepted; section subtitles cut off

- **Owner:** fix-apps-settings-a11y · **Sources:** apps-settings-a11y #27 · **Files:** `ui/src/apps/settings/panes/GeneralPanes.tsx`, `ui/src/apps/settings/SettingsView.module.css` · **Evidence:** `bug-hunt/apps-settings-a11y/set2-general-device-name-empty.png`, `set-dark-03-memory.png`

#### UI-164 · cosmetic · About pane keeps stale old-logo CSS

- **Owner:** fix-apps-settings-a11y · **Sources:** logo report (problem 4) · **Files:** `ui/src/apps/settings/panes/AboutPane.module.css` (~44–56)
- **Actual:** `.atom :is(ellipse, path) { stroke-width: 0.55 }` targets the old stroked orbits (the new mark is fill-only), and the entrance "orbits settle from −30°" rotates the whole P. Remove the dead rule; keep the entrance to scale/opacity (reduced motion unchanged).

#### UI-165 · cosmetic · Caddy compresses `/models` on the fly

- **Owner:** fix-system-services · **Sources:** system-services #16 · **Files:** `Caddyfile`
- **Fix:** exclude `/models/*` from `encode` (no Content-Length today, 2 warnings from the embed worker). **Evidence:** `bug-hunt/system-services/raw/ss-session-light.json`

#### UI-166 · cosmetic · WebSocket close reason is always "shutdown"

- **Owner:** fix-system-services · **Sources:** system-services checked_ok note · **Files:** `server/src/engine/sync/router.ts` (~357)
- **Fix:** echo the client's `bye` reason (for example "logout").

---

## 4. Dropped, already fixed, or not a bug

| Finding                                                                                                                           | Decision                                              | Why                                                                                                                                                                                                                                                                                   |
| --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Terminal 3 px black bar below the rows (fonts, windows #19, terminal #14)                                                         | **Fixed; dropped**                                    | `ui/src/apps/terminal/Terminal.module.css` now sets `.xterm .xterm-viewport { background-color: transparent }` (09:54). Triage verified on the 09:55 QA build: viewport background `rgba(0,0,0,0)`, no bar (`polish/triage/terminal-light.png`). The grid-width part stays as UI-128. |
| Terminal/Editor unstyled under CSP: proportional font, invisible cursor, stacked gutter (system-services #1 blocker, terminal #1) | **Rendering fixed; violations kept as UI-050/UI-051** | `ui/src/primitives/internal/csp-styles.ts` mirrors refused `<style>` into adopted sheets. Triage verified Geist Mono 14 px, colours and cursor in the Terminal; files-editor verified the CodeMirror layout on the 09:47+ builds.                                                     |
| "Allow `style-src 'unsafe-inline'`" (system-services #1 suggested fix)                                                            | **Rejected**                                          | Weakens SEC-02 without an ADR; the mirror already restores rendering (C5).                                                                                                                                                                                                            |
| Login build label renders JetBrains Mono (boot-login checked_ok)                                                                  | **Outdated**                                          | After D15 the label is Geist Mono (triage `t1-light.json`); the mono family itself is UI-004.                                                                                                                                                                                         |
| Font preload in `web/index.html`                                                                                                  | **Not a bug**                                         | Removed on purpose by the fonts agent (it broke `pnpm dev` and gave no benefit). Keep it out.                                                                                                                                                                                         |
| Memory "0/256 MB" is only rounding (desktop-shell checked_ok)                                                                     | **Superseded**                                        | system-services showed the data is uncalibrated as well: UI-133 (data) and UI-090 (display).                                                                                                                                                                                          |
| Closing a Terminal window with a background job SIGHUPs without a prompt                                                          | **Not a bug**                                         | Matches shell-and-terminal.md ("SIGHUP to the session; jobs end").                                                                                                                                                                                                                    |
| Toasts overlay the top-right window corner until they clear (windows checked_ok)                                                  | **Not a bug**                                         | Expected banner placement; the real problem (over CC/Overview) is UI-024.                                                                                                                                                                                                             |
| Settings not resizable, zoom disabled                                                                                             | **By design**                                         | Descriptor says `resizable:false`, `maximizable:false`.                                                                                                                                                                                                                               |
| `printf: command not found` (seen by the triage)                                                                                  | **Not listed**                                        | `printf` is not in the required command set; not a regression.                                                                                                                                                                                                                        |
| 10-window perf (UI-059)                                                                                                           | **Kept, flagged**                                     | Headless without GPU; the owner must re-measure before changing code.                                                                                                                                                                                                                 |

## 5. Known issues (a)–(f)

| Known issue                                       | Id(s)                                            | Owner                                  | Status                                                                                                                        |
| ------------------------------------------------- | ------------------------------------------------ | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| (a) Logo illegible at menu-bar and favicon size   | UI-152 (+ UI-003 boot animation, UI-153, UI-164) | fix-desktop-shell (UI-152)             | Legibility fixed by logo-stitch and verified by the triage at 1x; remaining softness and the boot-animation regression listed |
| (b) Files header overlap and path bar truncation  | UI-009, UI-010 (+ UI-011, UI-052, UI-097)        | fix-files-editor (UI-011: fix-windows) | Open; re-confirmed on 09:55 build                                                                                             |
| (c) sync, lockd, ai.agent, update degraded        | UI-006, UI-007 (+ UI-026, UI-025)                | fix-system-services                    | Open; root causes identified                                                                                                  |
| (d) Guest limit 3/h per IP and no feedback on 429 | UI-005                                           | fix-boot-login                         | Open                                                                                                                          |
| (e) `dev build 0000000` in Docker                 | UI-008                                           | fix-system-services                    | Open                                                                                                                          |
| (f) Terminal input not verified end to end        | UI-131                                           | fix-terminal                           | Verified working; e2e to be added                                                                                             |

## 6. What the triage verified itself (QA 4718, build 2026-09-27 09:55)

- **Logo:** menu bar at 1x/2x, system menu, About, login corner, boot splash frame by frame in both
  themes. New finding UI-003 (malformed settled splash mark: `--plb-tick` reached 17 = 204° in both the
  light and the dark run). Menu-bar mark is 17×17 at y 5.5 with `drop-shadow(… 3px)` (UI-152). About Dock tile (UI-153).
  Served identity assets match the tree except `maskable-icon.svg` (regenerated after the build).
- **Fonts:** computed families (login clock/footer Inter Variable, build label and Terminal Geist
  Mono Variable 14 px; `document.fonts.check` true for both). New finding UI-004 from a 1x
  specimen of Geist Mono vs JetBrains Mono vs Google Sans Code built from the installed woff2 files.
  Terminal bar fixed (dropped); grid overflow UI-128.
- **Known (b):** Files at the default size shows "Date ModSizeKind", "/ › home" and the squeezed
  view switcher (`polish/triage/files-default-light.png`).
- **CSP:** 15 console `style-src` errors after opening About, Terminal and Files (`t1-light.json`).
- **Code-level confirmations:** `isTyping` matches the frame's `role="dialog"` (UI-015/016);
  no `data-accent` rule anywhere in `ui/src` (UI-039); `SYSTEM_ITEMS` has no logout (UI-028);
  `recovery.run` returns early (UI-057); the boot-volume stub (UI-058); the worker-navigator
  `serviceWorker` probe (UI-007); `busy()` ignores the caller (UI-002); `fromDragRegion` tests the
  dblclick target (UI-033); `window.create` supports `rect` but no caller passes a size, and
  `AppEntry.window` already carries the spec's width/height at run time (UI-011);
  `@codemirror/search` and any xterm renderer addon are not installed (UI-101, UI-050).
- **Reserved keys (UI-022):** confirmed from Chromium's `IsReservedCommandOrKey` list; not
  reproducible under CDP automation.
- Scripts: scratchpad `triage/t1-logo-fonts.mjs`, `t2-bootlogo.mjs`, `t3-termwidth.mjs`, `mono.mjs`.
  Session used: `state-examiner1.json` (no logout); no guest sign-in; the user's 4717 stack untouched.
