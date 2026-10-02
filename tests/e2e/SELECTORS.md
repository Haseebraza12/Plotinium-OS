# Selector and test-hook contract

The e2e, a11y, perf and visual suites find the OS on the page only through what this file lists. The boot-ui, `wm/shell`, the compositor and the apps MUST render these attributes; changing one is a breaking change that updates this file, `tests/support/selectors.ts` and the suites in the same pull request. Tests never select by CSS class, by DOM position or by the text of a string that may be translated.

- **Code:** [`tests/support/selectors.ts`](../support/selectors.ts) (`TID`, `sel`), [`tests/support/hooks.ts`](../support/hooks.ts) (`window.__plt`), [`tests/support/os.ts`](../support/os.ts) (boot, login, reboot helpers).
- **Owners:** boot-ui and bootlog R5, window manager and shell R3, apps their owners, hooks as listed below. The harness (R5) owns this file.
- **Gate:** the suites are `test.fixme` until `PLT_E2E_UI=1` (set on `main` once boot-ui, login and the desktop implement this contract).

## 1. `data-testid` values

Playwright's default test-id attribute. One element per id unless the row says "many".

| `data-testid`                                        | Element                                                                                                                                 | Owner                 | Used by                      |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | ---------------------------- |
| `boot-screen`                                        | root of the inlined boot screen (splash, bar and status)                                                                                | R5 / R3               | a11y, boot                   |
| `boot-status`                                        | the boot status line; also `role="status"`                                                                                              | R5                    | a11y (BOOT-13 announcements) |
| `boot-unsupported`                                   | the POST "unsupported browser" screen                                                                                                   | R5                    | e2e (SVC-14)                 |
| `boot-panic`                                         | the kernel panic screen (names the cycle for BOOT-04)                                                                                   | R5                    | e2e, a11y                    |
| `boot-verbose-log`                                   | the verbose boot log (BOOT-05)                                                                                                          | R5                    | a11y                         |
| `recovery-console`                                   | the recovery console (SVC-06)                                                                                                           | R5                    | a11y                         |
| `login-screen`                                       | the login screen root                                                                                                                   | R3                    | e2e, a11y                    |
| `login-user-tile`                                    | a user tile (many); carries `data-user="<username>"`                                                                                    | R3                    | e2e                          |
| `login-username`                                     | the username field (other user)                                                                                                         | R3                    | e2e                          |
| `login-password`                                     | the password field                                                                                                                      | R3                    | e2e                          |
| `login-submit`                                       | the sign-in button                                                                                                                      | R3                    | e2e                          |
| `login-guest`                                        | the Guest tile                                                                                                                          | R3                    | e2e                          |
| `login-demo`                                         | the Demo tile                                                                                                                           | R3                    | e2e                          |
| `login-offline-notice`                               | the "signing in offline" notice (OFF-03 offline verifier)                                                                               | R3                    | e2e (E2)                     |
| `desktop`                                            | the desktop root, present from `desktop-interactive`                                                                                    | R3                    | every suite                  |
| `menubar`                                            | the top menu bar                                                                                                                        | R3                    | a11y                         |
| `dock`                                               | the dock / taskbar (`role="toolbar"`, label "Taskbar")                                                                                  | R3                    | a11y                         |
| `dock-item`                                          | one app button (many); carries `data-app="<app id>"`                                                                                    | R3                    | e2e, a11y                    |
| `net-status`                                         | tray connectivity text: `Online`, `Offline · n queued`, `Syncing n ops`                                                                 | R5 / R3               | e2e (OFF-01, OFF-04)         |
| `offline-ready`                                      | tray badge shown once the Service Worker is active (C11)                                                                                | R5                    | e2e, perf (warm boot)        |
| `restart-to-update`                                  | tray badge "Restart to update" (OFF-05)                                                                                                 | R5                    | e2e (E16)                    |
| `window`                                             | a window frame (many); carries `data-app` and `data-wid`                                                                                | R3                    | e2e, perf                    |
| `window-titlebar`                                    | a window's title bar (drag handle)                                                                                                      | R3                    | e2e, perf                    |
| `window-close`, `window-minimise`, `window-maximise` | title-bar buttons                                                                                                                       | R3                    | e2e                          |
| `window-resize-<h>`                                  | resize handles, `<h>` ∈ `n s e w ne nw se sw`                                                                                           | R3                    | perf (WM-03 drag script)     |
| `terminal`                                           | the Terminal's xterm host inside its window                                                                                             | R3                    | e2e                          |
| `editor`                                             | the Text Editor surface; `aria-readonly="true"` while another user holds the lock                                                       | owner of the Editor   | e2e (VFS-09)                 |
| `editor-lock-banner`                                 | "Locked by <user>" banner; carries `data-holder="<username>"` and `data-expires-at="<epoch ms>"` (the lease expiry the server reported) | owner of the Editor   | e2e (E5)                     |
| `files`                                              | the File Explorer root                                                                                                                  | owner of Files        | e2e                          |
| `task-manager`                                       | the Task Manager root                                                                                                                   | owner of Task Manager | e2e                          |
| `settings`                                           | the Settings root                                                                                                                       | owner of Settings     | e2e                          |
| `secure-prompt`                                      | the compositor-owned secure prompt (su, agent confirmation)                                                                             | R3                    | a11y (TST-14)                |
| `agent-confirm`                                      | the agent `[y/N/e]` confirmation                                                                                                        | R4 / R3               | e2e (E18)                    |
| `theme-toggle`                                       | the theme control in Settings → Appearance                                                                                              | R3                    | a11y                         |

App ids used in `data-app`: `terminal`, `files`, `editor`, `task-manager`, `settings`, `about`.

## 2. Roles and accessible names

| Selector                                                | Contract                                                                                                                                                                                              |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `getByRole('progressbar', { name: /boot/i })`           | the boot bar: `aria-valuemin="0"`, `aria-valuemax="100"`, `aria-valuenow` = round(100·P), `aria-valuetext` with the current service (BOOT-13). The value changes only on completion events (BOOT-02). |
| `role="status"` (inside `boot-status`)                  | the boot announcements: at most one per 750 ms except stage changes and failures                                                                                                                      |
| `getByRole('menu', { name: 'Plotinium Boot Manager' })` | the boot menu; its `menuitem`s' accessible names start with `Normal boot`, `Safe mode`, `Recovery`, `Verbose boot`, in that order; the focused item follows ↑/↓                                       |
| `section[role="dialog"][aria-modal="false"]`            | each window, labelled by its title (WM §3.19)                                                                                                                                                         |

## 3. Test hooks: `window.__plt`

Present only in builds made with `PLT_TEST_BUILD=1` (`__TEST_FLAGS__`, deployment-and-ci §3.4); the release job fails if a release build contains them. Tests read OS state only through these hooks, never by opening IndexedDB.

| Hook                                  | Returns                                                                     | Owner   |
| ------------------------------------- | --------------------------------------------------------------------------- | ------- |
| `bootlog()`                           | the current boot record (`bootlog --json`, boot §4.6)                       | R5      |
| `sessionId()`                         | the OS session id `session` restored (BOOT-12, WM-06)                       | R3      |
| `layout()`                            | windows bottom to top: `{ wid, app, x, y, w, h, z, state }`                 | R3      |
| `terminal.text()` / `terminal.idle()` | the focused Terminal's buffer text; true at a prompt with no foreground job | R3      |
| `oracle.snapshot(path)`               | the client oracle snapshot of a subtree (testing §3.6.5)                    | R2      |
| `perf.accumulators()` (optional)      | `performance.measure` samples per accumulator (ARC-04, WMD-20)              | R3 / R1 |

## 4. URL flags, marks and events

| Item                                                         | Contract                                                                                                                               |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `?boot=menu\|safe\|recovery\|verbose\|normal`                | boot profile for this load (boot §3.7 rule 3); boot-ui removes it with `history.replaceState`                                          |
| `?bootflags=a,b`                                             | test-build only: `hold-splash` keeps the splash on screen for the a11y scan; `inject-cycle` panics with a manifest cycle (BOOT-04, E7) |
| `performance.mark('desktop-interactive')`                    | the first input-ready frame of the desktop (boot §3.2.4); every "wait for the desktop" waits for this mark                             |
| `performance.mark('perf:script:start' \| 'perf:script:end')` | set by the perf harness itself to bound the traced drag script                                                                         |

## 5. Rules

1. Wait on OS events (the mark, a hook, a visible test id), never on a fixed sleep (testing §3.14).
2. Storage and reboot tests use a persistent context (`support/os.ts`), each in a fresh profile directory.
3. Every test title begins with its requirement ID (C18).
