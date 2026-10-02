/**
 * The boot menu from the keyboard alone (BOOT-13, BOOT-06; boot-and-services §3.7; testing §3.9).
 * No mouse event is used in this file: every step is a key press, as a keyboard-only user would.
 */
import { expect, test, type Page } from '@playwright/test';

import { seedUser } from '../fixtures/users.ts';
import { baseUrl, FIXME_UI, uiReady } from '../support/env.ts';
import { bootRecord } from '../support/hooks.ts';
import { bootUrl, launchOS, waitForDesktop, type OsHandle } from '../support/os.ts';
import { BOOT_MENU_ENTRIES, sel, TID } from '../support/selectors.ts';

/** Keyboard-only login: Tab to the user tile, Enter, type the password, Enter. */
async function keyboardLogin(page: Page, username: 'demo'): Promise<void> {
  const user = seedUser(username);
  await expect(page.getByTestId(TID.loginScreen)).toBeVisible({ timeout: 30_000 });
  const tile = sel.userTile(page, username);
  for (let i = 0; i < 20 && !(await tile.evaluate((el) => el === document.activeElement)); i++)
    await page.keyboard.press('Tab');
  await expect(tile).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId(TID.loginPassword)).toBeFocused();
  await page.keyboard.type(user.password ?? '');
  await page.keyboard.press('Enter');
}

test.describe('boot menu', () => {
  test.fixme(!uiReady(), FIXME_UI);

  let os: OsHandle;
  test.beforeEach(async () => {
    os = await launchOS();
  });
  test.afterEach(async () => {
    await os?.close();
  });

  test('BOOT-06 holding Esc from navigation opens the boot menu with Normal, Safe, Recovery and Verbose', async () => {
    const { page } = os;
    await page.goto(bootUrl(baseUrl()), { waitUntil: 'commit' });
    const menu = sel.bootMenu(page);
    // Held Esc produces repeats; each press is buffered by the inlined boot-ui from its first line.
    for (let i = 0; i < 200 && !(await menu.isVisible()); i++) await page.keyboard.press('Escape');
    await expect(menu).toBeVisible();
    const items = menu.getByRole('menuitem');
    await expect(items).toHaveCount(BOOT_MENU_ENTRIES.length);
    for (const [i, entry] of BOOT_MENU_ENTRIES.entries())
      await expect(items.nth(i)).toHaveAccessibleName(new RegExp(`^${entry}`));
  });

  test('BOOT-13 the boot menu is operable with the keyboard alone and Safe mode boots with no AI services', async () => {
    const { page } = os;
    await page.goto(bootUrl(baseUrl(), { boot: 'menu' }));
    const menu = sel.bootMenu(page);
    await expect(menu).toBeVisible();
    await expect(sel.bootMenuItem(page, 'Normal boot')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(sel.bootMenuItem(page, 'Safe mode')).toBeFocused();
    await page.keyboard.press('Enter');
    await keyboardLogin(page, 'demo');
    await waitForDesktop(page);
    const rec = await bootRecord(page);
    expect(rec.profile).toBe('safe');
  });

  test('BOOT-13 Escape closes the boot menu and boots normally', async () => {
    const { page } = os;
    await page.goto(bootUrl(baseUrl(), { boot: 'menu' }));
    await expect(sel.bootMenu(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(sel.bootMenu(page)).toBeHidden();
    await keyboardLogin(page, 'demo');
    await waitForDesktop(page);
    expect((await bootRecord(page)).profile).toBe('normal');
  });
});
