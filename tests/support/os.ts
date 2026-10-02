/**
 * Driving a whole Plotinium OS from Playwright (spec §3.3 shared fixtures, owner R5).
 *
 * `persistentOS()` launches Google Chrome with a disk-backed persistent profile in a fresh temp
 * directory (TST-11: IndexedDB, OPFS and the Service Worker survive a reboot of the page), boots,
 * logs in as a seeded user and waits for the `desktop-interactive` mark. Every wait is on an OS
 * event (the mark, a test hook), never on a fixed sleep (spec §3.14 "fixes, not retries").
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chromium, expect, type BrowserContext, type Page } from '@playwright/test';

import type { SeedUser } from '../fixtures/users.ts';

import { baseUrl } from './env.ts';
import { sel, TID } from './selectors.ts';

export type BootProfile = 'normal' | 'safe' | 'recovery' | 'verbose' | 'menu';
export type IdbBackend = 'default' | 'sqlite';

export interface OsOptions {
  baseURL?: string;
  /** `?boot=<profile>` (boot §3.7 rule 3); omitted for a normal boot. */
  boot?: BootProfile;
  /** Test-build flags (`?bootflags=a,b`), honoured only by `PLT_TEST_BUILD=1` builds. */
  bootFlags?: readonly string[];
  colorScheme?: 'light' | 'dark';
  reducedMotion?: 'reduce' | 'no-preference';
  /** Force Chrome's SQLite IndexedDB backend (spec §3.2.1, storage budgets run on both). */
  idbBackend?: IdbBackend;
  headless?: boolean;
  /** Reuse a profile directory, for example to reopen after a crash (E12). */
  userDataDir?: string;
}

export interface OsHandle {
  context: BrowserContext;
  page: Page;
  userDataDir: string;
  /** Closes Chrome and deletes the profile unless it was supplied by the caller. */
  close(): Promise<void>;
}

export const DESKTOP_INTERACTIVE = 'desktop-interactive';

/** Default wait for a boot on the lab-spec machine: 3 s cold budget plus login and headroom. */
export const BOOT_TIMEOUT_MS = 30_000;

export function bootUrl(base: string, opts: Pick<OsOptions, 'boot' | 'bootFlags'> = {}): string {
  const url = new URL('/', base);
  if (opts.boot !== undefined) url.searchParams.set('boot', opts.boot);
  if (opts.bootFlags !== undefined && opts.bootFlags.length > 0)
    url.searchParams.set('bootflags', opts.bootFlags.join(','));
  return url.href;
}

export function chromeArgs(idbBackend: IdbBackend = 'default'): string[] {
  return idbBackend === 'sqlite'
    ? ['--enable-features=IdbSqliteBackingStore,IdbSqliteOnDiskRollout']
    : [];
}

export function launchOptions(
  opts: OsOptions = {},
): Parameters<typeof chromium.launchPersistentContext>[1] {
  return {
    channel: 'chrome',
    baseURL: opts.baseURL ?? baseUrl(),
    headless: opts.headless ?? true,
    colorScheme: opts.colorScheme ?? 'light',
    reducedMotion: opts.reducedMotion ?? 'no-preference',
    viewport: { width: 1440, height: 900 },
    args: chromeArgs(opts.idbBackend),
  };
}

export async function launchOS(opts: OsOptions = {}): Promise<OsHandle> {
  const owned = opts.userDataDir === undefined;
  const userDataDir = opts.userDataDir ?? (await mkdtemp(join(tmpdir(), 'plt-e2e-')));
  const context = await chromium.launchPersistentContext(userDataDir, launchOptions(opts));
  const page = context.pages()[0] ?? (await context.newPage());
  return {
    context,
    page,
    userDataDir,
    close: async () => {
      await context.close();
      if (owned) await rm(userDataDir, { recursive: true, force: true });
    },
  };
}

export async function waitForDesktop(page: Page, timeout = BOOT_TIMEOUT_MS): Promise<void> {
  await page.waitForFunction(
    (mark) => performance.getEntriesByName(mark, 'mark').length > 0,
    DESKTOP_INTERACTIVE,
    { timeout },
  );
  await expect(page.getByTestId(TID.desktop)).toBeVisible();
}

export async function login(page: Page, user: SeedUser): Promise<void> {
  await expect(page.getByTestId(TID.loginScreen)).toBeVisible({ timeout: BOOT_TIMEOUT_MS });
  if (user.kind === 'guest') {
    await page.getByTestId(TID.loginGuest).click();
    return;
  }
  await sel.userTile(page, user.username).click();
  if (user.password === undefined) throw new Error(`seed user ${user.username} has no password`);
  await page.getByTestId(TID.loginPassword).fill(user.password);
  await page.getByTestId(TID.loginSubmit).click();
}

/** Boot, log in and wait for `desktop-interactive`. */
export async function persistentOS(user: SeedUser, opts: OsOptions = {}): Promise<OsHandle> {
  const os = await launchOS(opts);
  try {
    await os.page.goto(bootUrl(opts.baseURL ?? baseUrl(), opts));
    await login(os.page, user);
    await waitForDesktop(os.page);
    return os;
  } catch (err) {
    await os.close();
    throw err;
  }
}

/** Opens an app from the dock and returns its newest window. */
export async function openApp(
  page: Page,
  app: Parameters<typeof sel.dockItem>[1],
): Promise<ReturnType<typeof sel.windows>> {
  const before = await sel.windows(page, app).count();
  await sel.dockItem(page, app).click();
  await expect(sel.windows(page, app)).toHaveCount(before + 1);
  return sel.windows(page, app).last();
}

/** Types a command into the focused Terminal and waits until it is idle again. */
export async function runInTerminal(page: Page, command: string, timeout = 15_000): Promise<void> {
  await page.keyboard.type(command);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__plt?.terminal.idle() === true, undefined, { timeout });
}

export async function terminalText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const h = window.__plt;
    if (h === undefined) throw new Error('window.__plt is missing: not a PLT_TEST_BUILD=1 build');
    return h.terminal.text();
  });
}

/** `reboot` from the Terminal, then wait for the next boot's `desktop-interactive` mark. */
export async function rebootFromTerminal(page: Page, args = ''): Promise<void> {
  const navigated = page.waitForEvent('framenavigated', { timeout: BOOT_TIMEOUT_MS });
  await page.keyboard.type(`reboot${args === '' ? '' : ` ${args}`}`);
  await page.keyboard.press('Enter');
  await navigated;
}
