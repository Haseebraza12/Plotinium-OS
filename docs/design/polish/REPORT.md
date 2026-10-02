# Polish and stabilization: close-out report

| Field   | Value                                                                                                                                                                        |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scope   | The 2026-09-27 polish wave (new logo, D15 fonts, bug hunt, first fix pass) and the Wave 3 stabilize track of 2026-09-30 (7 area fixers, a gate, 3 verifiers, close-out)      |
| Bugs    | 166 in [BUGS.md](../bug-hunt/BUGS.md): 2 blocker, 57 major, 89 minor, 18 cosmetic                                                                                            |
| Result  | **154 VERIFIED-FIXED, 9 STILL-BROKEN, 3 NOT-REPRODUCIBLE, 0 FIXED-UNVERIFIED.** Both blockers are verified fixed.                                                            |
| QA copy | http://localhost:4718 (plotinium-qa, Docker build with the real Caddy CSP), build 5c9f63a of 2026-09-30, left running for Workflow B                                         |
| Status  | Per-bug: the Status column of [BUGS.md §2](../bug-hunt/BUGS.md#2-summary-priority-order). Sources: `docs/design/bug-hunt/status/*.md` and `docs/design/bug-hunt/verify/*.md` |
| Author  | AI agents (disclosed in [AI_USAGE.md](../../../AI_USAGE.md) rows 11–13). No human has reviewed these fixes yet.                                                              |

"Verified" means an independent verifier agent, not the fixer, re-ran the bug on the Docker QA copy under the real CSP. Where the check was a unit test only, that is stated.

## 1. How the work was organised

1. **2026-09-27 polish wave.** Seven bug finders and a triage produced the 166-bug list. A logo designer and a font evaluator produced the two decisions in §3. Seven fixers then edited about 280 files and stopped at a usage limit, before any browser check.
2. **2026-09-30 stabilize track.** The same seven areas were re-assigned with one owner per file. Each fixer:
   - reviewed the earlier edits against the code;
   - finished the fixes;
   - added a regression test titled with the bug id;
   - checked the result on :4718 with a securitypolicyviolation listener.
3. **Gate (stab-gate).** It applied the cross-area handoffs, ran every root check, and ran a browser smoke test.
4. **Three independent verifiers.**
   - verify-a: boot-login, desktop-shell and windows (66 bugs).
   - verify-b: files-editor and terminal (55).
   - verify-c: apps-settings-a11y and system-services (45).
     They fixed 8 residuals or regressions, each with a test that fails without its fix.
5. **Close-out.** Full checks, the status merge, this report, CHANGELOG and AI_USAGE.

## 2. What was fixed, per area

"Before" images are the 2026-09-27 finders' or triage's evidence. "After" images are from :4718 on 2026-09-30.

### 2.1 Boot and login (fix-boot-login): 18 of 18 verified fixed

- **UI-001 (blocker).** The login screen re-ran its reset effects every second. Fixed with plain props and value memos, and checked by a real sign-in typed at one character per 400 ms.
- **Also fixed:**
  - UI-003: boot mark orbit (±60° triangle wave, still under reduced motion).
  - UI-013: boot-CSS compactor (0 '.plb:where' in web/dist).
  - UI-005: guest 429/403 feedback and per-user back-off (production keeps 3 per hour).
  - UI-030: panic screen.
  - UI-031: halted and takeover screens.
  - UI-060 to UI-070, UI-149, UI-150.
- **Extras:**
  - The SW URL now goes through the boot Trusted Types policy.
  - verify-a fixed a soft login-corner logo (size 28 → 32).

| Bug    | Before                                                        | After                                                                                                                          |
| ------ | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| UI-003 | docs/design/polish/triage/bootlogo-light-filmstrip.png        | docs/design/wave3/fix-boot-login/boot-dark-mark-filmstrip.png, docs/design/wave3/verify-a/boot/boot-dark-mark-filmstrip-x3.png |
| UI-030 | docs/design/bug-hunt/boot-login/kernel-fail-light.png         | docs/design/wave3/fix-boot-login/panic-light-_assets_sys_js.png                                                                |
| UI-005 | docs/design/bug-hunt/boot-login/mock-guest403-light-after.png | docs/design/wave3/fix-boot-login/login-dark-guest-429.png                                                                      |
| logo   | docs/design/polish/triage/login-light-corner.png              | docs/design/wave3/verify-a/logo-zoom-login-after.png                                                                           |

### 2.2 Desktop shell (fix-desktop-shell): 33 of 33 verified fixed

- **Fixed:**
  - UI-023: menu-bar re-mounts.
  - UI-024: banners above Control Centre and Overview.
  - UI-025: connectivity popover.
  - UI-027: lock screen inert, plus a Tab wrap.
  - UI-028: Log Out.
  - UI-029: Overview thumbnails scaled.
  - UI-040: Dock and clock settings applied live.
  - UI-071 to UI-093 and UI-151 to UI-153.
- **UI-083:** a desktop click unfocuses windows through the new compositor call focusDesktop().
- **Gate change:** a service's stale "degraded" banners are dropped when it starts.
- **Harness only:** UI-079, UI-080, UI-082 and the UI-151 banners were verified in the shell dev harness (no CSP). QA has no notification source a non-root user can trigger.

| Bug    | Before                                                            | After                                                     |
| ------ | ----------------------------------------------------------------- | --------------------------------------------------------- |
| UI-024 | docs/design/bug-hunt/desktop-shell/05-cc-open-light.png           | docs/design/wave3/verify-a/s1-ui024-cc-open-dark.png      |
| UI-025 | docs/design/bug-hunt/desktop-shell/05-cc-connectivity-popover.png | docs/design/wave3/verify-a/s1-ui025-net-popover-light.png |
| UI-029 | docs/design/bug-hunt/desktop-shell/01-desktop-1440-light.png      | docs/design/wave3/verify-a/s1-ui029-overview-light.png    |

### 2.3 Windows (fix-windows): 14 of 15 verified fixed, 1 not reproducible

- **Fixed:**
  - UI-011: manifest sizes are used.
  - UI-017 and UI-018: keyboard focus moves into the window. The gate added [data-autofocus] targets and made focusIntoWhenReady wait for them.
  - UI-019: content refits on shrink.
  - UI-033: toolbar double-click zooms.
  - UI-034: geometry, snap and z survive a reload (confirmed end to end by verify-a).
  - UI-038: snap preview.
  - UI-041, UI-094, UI-095, UI-154 to UI-156.
- **UI-040 hand-off:** the work area now follows the Dock size live.
- **UI-096:** verify-a also fixed the case where a clamp became permanent after a maximise, snap or full-screen round trip (saveRestoreRect stores wantedRect).
- **UI-059 NOT-REPRODUCIBLE.** Headed Chrome with 10 windows gave p95 16.7 ms, with none of the long frames in window-manager code (docs/design/wave3/fix-windows/ui-059-perf.txt). The spec §8.2 trace harness does not exist yet.

| Bug    | Before                                                     | After                                                          |
| ------ | ---------------------------------------------------------- | -------------------------------------------------------------- |
| UI-011 | docs/design/bug-hunt/windows/01-files-open.png             | docs/design/wave3/verify-a/w-ui011-five-apps-light.png         |
| UI-038 | docs/design/bug-hunt/windows/40-snap-left-holding-1440.png | docs/design/wave3/verify-a/w-ui038-snap-preview-left-light.png |
| UI-034 | docs/design/bug-hunt/windows/101-layout-after-reload.png   | docs/design/wave3/verify-a/w6-ui034-after-reload.png           |
| UI-096 | docs/design/bug-hunt/windows/50-files-min-size.png         | docs/design/wave3/verify-a/w5-ui096-after-roundtrips.png       |

### 2.4 Files and Editor (fix-files-editor): 30 of 33 verified fixed, 3 still broken

- **Files:**
  - UI-009, UI-010, UI-014, UI-015, UI-016, UI-048, UI-052, UI-097, UI-098, UI-105 to UI-111, UI-113 to UI-115, UI-157, UI-158.
  - A missing ~/.Trash now shows as an empty Trash (gate).
  - axe: 0 violations in both themes.
- **Editor:**
  - UI-051: CodeMirror styles are created inside withInertStyles (0 CSP violations).
  - UI-099, UI-100, UI-102, UI-103.
  - UI-104: an already-open file reuses its Editor window.
  - UI-116, UI-117, UI-118.
- **verify-b fixed three residuals:**
  - Alt+←/→ in Files (UI-015).
  - Focus lost after a closing menu (UI-108).
  - An Untitled document that said "saved v0 · synced" now says "not saved".

| Bug            | Before                                                        | After                                                                         |
| -------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| UI-009, UI-010 | docs/design/bug-hunt/files-editor/02-files-default-window.png | docs/design/wave3/verify-b/layout-light-files-projects-720.png                |
| UI-098         | docs/design/bug-hunt/files-editor/45-path-overflow-menu.png   | docs/design/wave3/verify-b/layout-dark-files-path-overflow-menu.png           |
| UI-037         | (no prompt; text lost)                                        | docs/design/wave3/stab-gate/11-editor-close-guard.png (prompt; still no Save) |

### 2.5 Terminal (fix-terminal): 17 of 22 verified fixed, 4 still broken, 1 not reproducible

- **Fixed:**
  - UI-020: hidden tabs keep their size.
  - UI-021: focus after a tab closes.
  - UI-022: tab shortcuts moved to Alt+Shift keys.
  - UI-050: the new ui/src/apps/terminal/csp-rows.ts points xterm's private _addStyle at the CSSOM. A unit test fails loudly if an xterm upgrade renames it. Result: 0 violations on :4718.
  - UI-053: man pages.
  - UI-054: find and du.
  - UI-119, UI-120, UI-122, UI-123, UI-125, UI-126, UI-128 to UI-131, UI-159.
- **UI-131:** the e2e test tests/e2e/polish-terminal.spec.ts passes 2/2 on :4718.
- **Gate:** added bootlog --list.

| Bug    | Before                                              | After                                                         |
| ------ | --------------------------------------------------- | ------------------------------------------------------------- |
| UI-053 | docs/design/bug-hunt/terminal/11-man-ls.png         | docs/design/wave3/fix-terminal/06-man-ls.png                  |
| UI-050 | docs/design/bug-hunt/terminal/26-selection-dark.png | docs/design/wave3/verify-b/termbugs-dark-ui050-select-all.png |
| UI-135 | ('Function not implemented')                        | docs/design/wave3/stab-gate/12-bootlog-list.png               |

### 2.6 Task Manager, Settings, About, a11y (fix-apps-settings-a11y): 21 of 22 verified fixed, 1 still broken

- **Fixed:**
  - UI-004: mono font (§3.2).
  - UI-039: accent colour.
  - UI-042: controls with no consumer are marked unavailable.
  - UI-043 and UI-145: contrast.
  - UI-044: View as table.
  - UI-138 to UI-148, UI-160, UI-161, UI-163, UI-164.
- **UI-147:** the new rule local/no-static-jsx-style, enforced by the gate. Product code has 0 offenders.
- **verify-c fixed:**
  - Duplicate ai.indexer rows (UI-160/UI-132).
  - Settings showing "Last synced never" against "Everything is synced" (UI-141).
  - The UI-042 file-sync note.

| Bug    | Before                                                                    | After                                                       |
| ------ | ------------------------------------------------------------------------- | ----------------------------------------------------------- |
| UI-039 | docs/design/bug-hunt/apps-settings-a11y/set2-appearance-accent-yellow.png | docs/design/wave3/verify-c/set-light-accent-green.png       |
| UI-044 | docs/design/bug-hunt/apps-settings-a11y/kb-dark-02-tm-table-focus.png     | docs/design/wave3/verify-c/tm-light-04-view-as-table.png    |
| UI-004 | docs/design/polish/triage/terminal-light-r-zoom4.png                      | docs/design/wave3/verify-b/fonts-terminal-1x-crop-light.png |

### 2.7 System services (fix-system-services): 21 of 23 verified fixed, 1 still broken, 1 not reproducible

- **UI-002 (blocker).** The Editor could not save a file it had leased (EBUSY). Checked live: saves v11 and v12 were applied by the server.
- **Fixed:**
  - UI-006: sync is LIVE through Caddy (engine factory, home linking, server session claim, content fetched on first read with a SHA-256 check).
  - UI-007: the SW registers, and an offline reload reaches login.
  - UI-008: one build id on every tier.
  - UI-012: user names instead of u<uid>.
  - UI-026.
  - UI-032: slow-network boot, 3/3 at 200 KB/s.
  - UI-035.
  - UI-036: window.setCloseGuard, registered in the spec, protocol and kernel by the gate (120 system calls).
  - UI-045.
  - UI-047: memory slider.
  - UI-049: the AI daemons no longer crash; the kernel lacked sys.subscribe and sys.events.
  - UI-057, UI-058: recovery actions and the boot-volume read.
  - UI-063, UI-075, UI-134, UI-135, UI-137, UI-165, UI-166.
- **Dev tooling:**
  - vite preview sends Caddy's CSP, and vite dev sends it Report-Only.
  - The gate fixed the pnpm dev /ort/ overlay.
- **UI-136 NOT-REPRODUCIBLE** on a single build. It is covered by a unit test and the active SW.

| Bug    | Before                                                            | After                                                  |
| ------ | ----------------------------------------------------------------- | ------------------------------------------------------ |
| UI-002 | (EBUSY on save)                                                   | docs/design/wave3/verify-c/sys2-editor-save2-light.png |
| UI-006 | docs/design/bug-hunt/system-services/settings-network-sync.png    | docs/design/wave3/verify-c/sys-svcctl-light.png        |
| UI-007 | docs/design/bug-hunt/system-services/offline-reload-phase-B.png   | docs/design/wave3/verify-c/sys4-offline-queue.png      |
| UI-075 | docs/design/bug-hunt/system-services/cc-retry-stuck-after-10s.png | docs/design/wave3/verify-c/sys4-retry.png              |

## 3. Logo and font decisions

### 3.1 Logo: the Bohr P

Decision record: [docs/design/logo/DECISION.md](../logo/DECISION.md) (2026-09-27).

- **The mark:** an electron shell around a nucleus, open at 1:30 where the one electron sits. The shell grows a stem, so the atom is also the P of Plotinium.
- **Why it changed:** it replaces the two-orbit atom, which smudged at 16–20 px.
- **Where it lives:** the kit is in docs/identity/ and ui/src/icons/atom-logo.ts.
- **Verified on :4718:** the favicon and icons are byte-identical to docs/identity/, and the mark appears on the boot splash, login, menu bar and About.

### 3.2 Fonts: D15

Decision record: [docs/design/fonts/DECISION.md](../fonts/DECISION.md), with the §9 addendum in specs/15-decisions/stack-decisions.md.

- **UI:** Inter 4 variable with the opsz axis, self-hosted, with no preload.
- **Code:** JetBrains Mono variable since 2026-09-30 (DECISION.md §0).
  - Geist Mono draws r like ɪ at 12–14 px on 1x screens (UI-004).
  - The re-score is 3.85 against 3.70, which the record calls fragile.
  - calt is off.
  - verify-b and verify-c confirmed the r at 12, 13 and 14 px on 1x.
- **Open decision:** CLAUDE.md standing decision 2 still says Geist Mono and needs a decision by the user or lead.

## 4. What is still open, and why

### 4.1 STILL-BROKEN (9)

| Bug    | Sev      | What is left                                                                 | Why                                                            | Next owner               |
| ------ | -------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------ |
| UI-037 | major    | The close prompt appears (no data loss) but has no Save choice               | C4 must let the shell ask the app to save                      | Workflow B: wm + apps    |
| UI-055 | major    | `ai "…"` says the agent is unavailable, while `ai status` says it is running | Must compose ai.agent from web/; wm may not import ai (ARC-01) | Workflow B: web + apps   |
| UI-056 | major    | Terminal processes are not in Task Manager                                   | Deferred: needs the kernel TTY and a new-session spawn         | Workflow B: kernel       |
| UI-101 | minor    | The Editor has no find                                                       | Deferred: needs @codemirror/search                             | Lead, then files-editor  |
| UI-112 | minor    | Restore reopens Editor windows as empty Untitled                             | Needs a restore opt-out for pathless windows                   | Workflow B: kernel       |
| UI-121 | minor    | The relay wakes every 100 ms when idle                                       | Needs an executor wake-up on the display port                  | Workflow B: kernel       |
| UI-127 | minor    | A reloaded Terminal is empty (the Terminal side is done)                     | Nothing saves the snapshot in the layout                       | Workflow B: protocol, wm |
| UI-133 | minor    | Placeholder calibration; the menu bar reads e.g. '128 KB/256 MB'             | Needs measurements on lab hardware                             | R1                       |
| UI-162 | cosmetic | The menu says 'Pause or Resume Live Updates'                                 | Needs dynamic menu labels                                      | Workflow B: wm           |

### 4.2 NOT-REPRODUCIBLE (3)

- UI-059: see §2.3.
- UI-124: every semsearch query returns hits, so the "no results" path cannot be reached. It is unit-tested.
- UI-136: see §2.7.

### 4.3 New findings from verification

- **axe serious findings:**
  - The login `<time>` carries aria-label with no role (aria-prohibited-attr).
  - The Editor status-bar buttons are 17.4 px tall (WCAG 2.5.8).
- **Semantic search** indexes dotfiles, including ~/.sh_history, and has no minimum score. Indexing is slow: about 1 file in 45 s.
- **Missing commands:** head, wc, env, yes, dmesg and framemeter. vmstat and pmap wrap at 84 columns.
- **Missing test id:** editor-lock-banner, so the VFS-09 e2e specs would fail with PLT_E2E_UI=1.
- **Views' sys.subscribe returns ENOSYS,** so Files and the Editor do not refresh live.
- **Revealing a file (UI-104):** the anti-focus-steal rule downgrades the Editor raise. An activation-token RFC is proposed.
- **Empty Trash copy:** the hint suggests Ctrl+Shift+N, and the path shows '.Trash'.
- **Design questions:** the Terminal's 2 px accent focus ring, and the 806 px unsupported-browser card at 1280×800.
- **Branding and packages:** the glyph SVGs are not in web/public/branding, and unshipped @fontsource packages are still installed.
- **QA hygiene:** the QA root password may be in an older synced ~/.sh_history of examiner1. Rotate it.

### 4.4 Not covered

- No human review.
- Mostly 1440×900 and 1280×800, with no 1920×1080 run.
- Only one e2e spec was run (polish-terminal, 2/2).
- The lock-screen unlock was not exercised live.
- Four notification bugs were checked in the harness only.
- :4717 was never touched. Older, non-empty home folders stay unlinked from sync, and that includes :4717 after a rebuild.

## 5. Verification evidence

### 5.1 Close-out run (2026-09-30, full tree after all verifier fixes)

- `pnpm format:check`: exit 0.
- `pnpm lint`: exit 0.
- `pnpm typecheck`: exit 0.
- `env -u DATABASE_URL pnpm test`: exit 0. Test files: 364 passed, 8 skipped. Tests: 4,090 passed, 84 skipped, 1 todo.
- `pnpm --filter @plotinium/web build`: exit 0.
  - Boot-critical JS is 26.27 KB gzip of 60 KB.
  - The inline script and style hashes match csp-hashes.json (2 scripts, 1 style).
  - 0 '.plb:where' and 0 style= attributes.
  - The served CSP has no 'unsafe-inline'.
- `pnpm --filter @plotinium/ui gallery:build`: exit 0.
- QA :4718, build 5c9f63a, which contains every verifier fix:
  - Smoke test: light 23/23 (session and Guest), dark 14/14.
  - 0 CSP violations (enforced and report-only), 0 console errors, 0 failed requests.
  - Evidence: docs/design/wave3/closeout/.

### 5.2 Earlier evidence

- **Gate:**
  - All root checks green: 358 files, 4,071 tests.
  - Smoke test: light 29/29 and dark 14/14. Feature checks: 10/10.
- **verify-a:**
  - 66 bugs, in both themes and at 4 viewports, with reduced motion.
  - 0 CSP violations. wm tests: 257 passed.
- **verify-b:**
  - 55 bugs, 0 CSP violations.
  - e2e 2/2. apps tests: 661 passed. ui tests: 154 passed.
- **verify-c:**
  - 45 bugs.
  - axe on every app in both themes.
  - 18 services running, the SW active, offline reload in 580 ms, and one build id everywhere.
- **Every verifier fix** was mutation-checked.
- **Credential scans:** 0 matches.

Reports: [verify-a.md](../bug-hunt/verify/verify-a.md), [verify-b.md](../bug-hunt/verify/verify-b.md), [verify-c.md](../bug-hunt/verify/verify-c.md). Evidence is in docs/design/wave3/<agent>/.

## 6. What the team must review

See [AI_USAGE.md §12](../../../AI_USAGE.md#12-polish-and-stabilization-waves-what-to-review-before-the-viva).
