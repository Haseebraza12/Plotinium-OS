/**
 * axe on every screen in both themes (testing §3.9; ui-design-system §3.11; WM-07, BOOT-13,
 * TST-14). One test per screen and theme pass, so a report names the exact screen and theme.
 * The boot screens are held with test-build flags (`PLT_TEST_BUILD=1`, SELECTORS.md).
 */
import { expect, test, type Page } from '@playwright/test';

import { seedUser } from '../fixtures/users.ts';
import { baseUrl, FIXME_UI, uiReady } from '../support/env.ts';
import { bootUrl, login, openApp, waitForDesktop, type BootProfile } from '../support/os.ts';
import { sel, TID, type AppId } from '../support/selectors.ts';

import { describeViolations, scan, THEME_PASSES } from './axe.ts';

interface Screen {
  name: string;
  /** Brings a fresh page to the screen; returns the selector to scan (whole page if undefined). */
  reach(page: Page): Promise<string | undefined>;
}

function bootScreen(
  name: string,
  opts: { boot?: BootProfile; bootFlags?: string[] },
  testId: string,
): Screen {
  return {
    name,
    reach: async (page) => {
      await page.goto(bootUrl(baseUrl(), opts));
      await expect(page.getByTestId(testId).or(sel.bootMenu(page))).toBeVisible({
        timeout: 30_000,
      });
      return undefined;
    },
  };
}

async function desktop(page: Page): Promise<void> {
  await page.goto(bootUrl(baseUrl()));
  await login(page, seedUser('demo'));
  await waitForDesktop(page);
}

function appScreen(name: string, app: AppId): Screen {
  return {
    name,
    reach: async (page) => {
      await desktop(page);
      await openApp(page, app);
      return undefined;
    },
  };
}

const BOOT_SCREENS: readonly Screen[] = [
  bootScreen('boot splash', { bootFlags: ['hold-splash'] }, TID.bootScreen),
  bootScreen('boot menu', { boot: 'menu' }, TID.bootScreen),
  bootScreen(
    'verbose boot log',
    { boot: 'verbose', bootFlags: ['hold-splash'] },
    TID.bootVerboseLog,
  ),
  bootScreen('kernel panic', { bootFlags: ['inject-cycle'] }, TID.bootPanic),
  bootScreen('recovery console', { boot: 'recovery' }, TID.recoveryConsole),
];

const DESKTOP_SCREENS: readonly Screen[] = [
  {
    name: 'login',
    reach: async (page) => {
      await page.goto(bootUrl(baseUrl()));
      await expect(page.getByTestId(TID.loginScreen)).toBeVisible({ timeout: 30_000 });
      return undefined;
    },
  },
  {
    name: 'desktop with three windows',
    reach: async (page) => {
      await desktop(page);
      for (const app of ['terminal', 'files', 'editor'] as const) await openApp(page, app);
      return undefined;
    },
  },
  appScreen('Terminal', 'terminal'),
  appScreen('File Explorer', 'files'),
  appScreen('Text Editor', 'editor'),
  appScreen('Task Manager', 'task-manager'),
  appScreen('Settings', 'settings'),
];

test.describe('axe in both themes', () => {
  test.fixme(!uiReady(), FIXME_UI);

  for (const screen of BOOT_SCREENS) {
    for (const pass of THEME_PASSES) {
      test(`BOOT-13 axe finds no serious or critical violation on the ${screen.name} (${pass.name})`, async ({
        page,
      }) => {
        const include = await screen.reach(page);
        const res = await scan(page, pass, include);
        expect(res.blocking, describeViolations(res.blocking)).toEqual([]);
      });
    }
  }

  for (const screen of DESKTOP_SCREENS) {
    for (const pass of THEME_PASSES) {
      test(`WM-07 axe reports zero serious or critical violations on ${screen.name} (${pass.name})`, async ({
        page,
      }) => {
        const include = await screen.reach(page);
        const res = await scan(page, pass, include);
        expect(res.blocking, describeViolations(res.blocking)).toEqual([]);
      });
    }
  }

  test('BOOT-13 the boot splash passes axe with reduced motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await BOOT_SCREENS[0]?.reach(page);
    const res = await scan(page, { name: 'light', colorScheme: 'light', forced: null });
    expect(res.blocking, describeViolations(res.blocking)).toEqual([]);
  });
});
