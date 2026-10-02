/**
 * Stable selectors the e2e, a11y, perf and fault suites rely on. The contract is documented in
 * tests/e2e/SELECTORS.md; boot-ui, wm/shell and the apps MUST render these attributes. Tests never
 * select by CSS class, text of a translated string, or DOM position.
 */
import type { Locator, Page } from '@playwright/test';

/** `data-testid` values (Playwright's default test id attribute). */
export const TID = {
  bootScreen: 'boot-screen',
  bootStatus: 'boot-status',
  bootUnsupported: 'boot-unsupported',
  bootPanic: 'boot-panic',
  bootVerboseLog: 'boot-verbose-log',
  recoveryConsole: 'recovery-console',
  loginScreen: 'login-screen',
  loginUserTile: 'login-user-tile',
  loginUsername: 'login-username',
  loginPassword: 'login-password',
  loginSubmit: 'login-submit',
  loginGuest: 'login-guest',
  loginDemo: 'login-demo',
  loginOfflineNotice: 'login-offline-notice',
  desktop: 'desktop',
  menuBar: 'menubar',
  dock: 'dock',
  dockItem: 'dock-item',
  netStatus: 'net-status',
  offlineReady: 'offline-ready',
  restartToUpdate: 'restart-to-update',
  window: 'window',
  windowTitleBar: 'window-titlebar',
  windowClose: 'window-close',
  windowMinimise: 'window-minimise',
  windowMaximise: 'window-maximise',
  terminal: 'terminal',
  editor: 'editor',
  editorLockBanner: 'editor-lock-banner',
  files: 'files',
  taskManager: 'task-manager',
  settings: 'settings',
  securePrompt: 'secure-prompt',
  agentConfirm: 'agent-confirm',
  themeToggle: 'theme-toggle',
} as const;

export type ResizeHandle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

/** Built-in app ids, as used in `data-app` on windows and dock items. */
export type AppId = 'terminal' | 'files' | 'editor' | 'task-manager' | 'settings' | 'about';

/** Names of the boot-menu entries (accessible name starts with this text, spec boot §3.7). */
export const BOOT_MENU_ENTRIES = ['Normal boot', 'Safe mode', 'Recovery', 'Verbose boot'] as const;
export type BootMenuEntry = (typeof BOOT_MENU_ENTRIES)[number];

export const sel = {
  bootProgress: (page: Page): Locator => page.getByRole('progressbar', { name: /boot/i }),
  bootMenu: (page: Page): Locator => page.getByRole('menu', { name: 'Plotinium Boot Manager' }),
  bootMenuItem: (page: Page, entry: BootMenuEntry): Locator =>
    page.getByRole('menuitem', { name: new RegExp(`^${entry}`) }),
  userTile: (page: Page, username: string): Locator =>
    page.locator(`[data-testid="${TID.loginUserTile}"][data-user="${username}"]`),
  windows: (page: Page, app?: AppId): Locator =>
    page.locator(
      app === undefined
        ? `[data-testid="${TID.window}"]`
        : `[data-testid="${TID.window}"][data-app="${app}"]`,
    ),
  dockItem: (page: Page, app: AppId): Locator =>
    page.locator(`[data-testid="${TID.dockItem}"][data-app="${app}"]`),
  resizeHandle: (win: Locator, handle: ResizeHandle): Locator =>
    win.getByTestId(`window-resize-${handle}`),
} as const;
