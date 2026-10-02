/**
 * Keyboard-only flows and live-region behaviour (testing §3.9; WM-07, BOOT-13, TST-14).
 */
import { expect, test } from '@playwright/test';

import { seedUser } from '../fixtures/users.ts';
import { baseUrl, FIXME_UI, uiReady } from '../support/env.ts';
import { bootUrl, launchOS, login, openApp, waitForDesktop, type OsHandle } from '../support/os.ts';
import { sel } from '../support/selectors.ts';

import { announcements, installAnnouncementRecorder, tooFrequent } from './announce.ts';

test.describe('keyboard and live regions', () => {
  test.fixme(!uiReady(), FIXME_UI);

  let os: OsHandle;
  test.beforeEach(async () => {
    os = await launchOS();
  });
  test.afterEach(async () => {
    await os?.close();
  });

  test('BOOT-13 the boot status region announces ordinary progress at most once per 750 ms', async () => {
    await installAnnouncementRecorder(os.context);
    await os.page.goto(bootUrl(baseUrl()));
    await login(os.page, seedUser('demo'));
    await waitForDesktop(os.page);
    const list = await announcements(os.page);
    expect(list.length, 'the boot screen must announce its stages').toBeGreaterThan(0);
    expect(tooFrequent(list)).toEqual([]);
  });

  test('WM-07 Alt+` switches to the next window with the keyboard alone', async () => {
    const { page } = os;
    await page.goto(bootUrl(baseUrl()));
    await login(page, seedUser('demo'));
    await waitForDesktop(page);
    await openApp(page, 'terminal');
    await openApp(page, 'files');
    const focusedApp = (): Promise<string | null> =>
      page.evaluate(
        () =>
          document.activeElement?.closest('[data-testid="window"]')?.getAttribute('data-app') ??
          null,
      );
    const first = await focusedApp();
    await page.keyboard.down('Alt');
    await page.keyboard.press('Backquote');
    await page.keyboard.up('Alt');
    await expect.poll(focusedApp).not.toBe(first);
    await page.keyboard.press('Alt+J');
    await expect.poll(focusedApp).toBe(first);
  });

  test('WM-07 Alt+M minimises and the taskbar restores the window by keyboard', async () => {
    const { page } = os;
    await page.goto(bootUrl(baseUrl()));
    await login(page, seedUser('demo'));
    await waitForDesktop(page);
    const win = await openApp(page, 'terminal');
    await page.keyboard.press('Alt+M');
    await expect(win).toBeHidden();
    await page.keyboard.press('Alt+N');
    const item = sel.dockItem(page, 'terminal');
    // The taskbar is a roving-tabindex toolbar: arrow keys move between its buttons.
    for (let i = 0; i < 12 && !(await item.evaluate((el) => el === document.activeElement)); i++)
      await page.keyboard.press('ArrowRight');
    await expect(item).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(win).toBeVisible();
  });
});
