/**
 * E1, the spec §15.3 golden path (testing §3.8): cold boot → log in as `demo` → Terminal →
 * mkdir, echo > f, cat, cp, mv, rm, ls -la → reboot → the same OS session with windows,
 * positions, states and z-order restored (WM-06, BOOT-12). Persistent context (TST-11).
 *
 * fixme until the UI implements tests/e2e/SELECTORS.md (PLT_E2E_UI=1 on main).
 */
import { expect, test } from '@playwright/test';

import { seedUser } from '../fixtures/users.ts';
import { FIXME_UI, uiReady } from '../support/env.ts';
import { bootRecord, layout, sessionId, type WindowLayoutView } from '../support/hooks.ts';
import {
  openApp,
  persistentOS,
  rebootFromTerminal,
  runInTerminal,
  terminalText,
  waitForDesktop,
  type OsHandle,
} from '../support/os.ts';
import { sel, TID } from '../support/selectors.ts';

/** Layout without window ids, which a restore may renumber; bottom-to-top order is kept. */
function comparable(l: readonly WindowLayoutView[]): Array<Omit<WindowLayoutView, 'wid'>> {
  return l.map(({ wid: _wid, ...rest }) => rest);
}

test.describe
  .serial('E1 golden path: boot, login, Terminal, file operations, reboot, restore', () => {
  test.fixme(!uiReady(), FIXME_UI);

  let os: OsHandle;
  let before: { layout: WindowLayoutView[]; session: string } | undefined;

  test.beforeAll(async () => {
    os = await persistentOS(seedUser('demo'));
  });

  test.afterAll(async () => {
    await os?.close();
  });

  test('BOOT-01 the boot screen named Plotinium and the desktop became interactive after login', async () => {
    const rec = await bootRecord(os.page);
    expect(rec.outcome).toBe('interactive');
    expect(rec.build.version).toMatch(/^\d+\.\d+\.\d+/);
    await expect(os.page.getByTestId(TID.desktop)).toBeVisible();
    await expect(os.page).toHaveTitle(/Plotinium/);
  });

  test('SYS-02 mkdir, echo, cat, cp, mv, rm and ls -la work in the Terminal', async () => {
    const { page } = os;
    const term = await openApp(page, 'terminal');
    await term.getByTestId(TID.terminal).click();
    for (const cmd of [
      'mkdir -p ~/e2e',
      'echo plotinium-e1 > ~/e2e/f',
      'cat ~/e2e/f',
      'cp ~/e2e/f ~/e2e/g',
      'mv ~/e2e/g ~/e2e/h',
      'rm ~/e2e/f',
      'ls -la ~/e2e',
    ]) {
      await runInTerminal(page, cmd);
    }
    const text = await terminalText(page);
    expect(text).toContain('plotinium-e1');
    expect(text).toMatch(/\sh\s*$/m);
    expect(text).not.toMatch(/No such file|Permission denied/);
  });

  test('WM-06 reboot restores windows, positions, states and z-order and keeps the OS session', async () => {
    const { page } = os;
    await openApp(page, 'files');
    // Move the Files window so a restore to default positions would be caught.
    const bar = await sel
      .windows(page, 'files')
      .last()
      .getByTestId(TID.windowTitleBar)
      .boundingBox();
    if (bar === null) throw new Error('Files window has no title bar');
    await page.mouse.move(bar.x + bar.width / 2, bar.y + bar.height / 2);
    await page.mouse.down();
    await page.mouse.move(bar.x + bar.width / 2 + 120, bar.y + bar.height / 2 + 80, { steps: 8 });
    await page.mouse.up();
    before = { layout: await layout(page), session: await sessionId(page) };

    await sel.windows(page, 'terminal').last().getByTestId(TID.terminal).click();
    await rebootFromTerminal(page);
    await waitForDesktop(page);

    expect(await sessionId(page)).toBe(before.session);
    expect(comparable(await layout(page))).toEqual(comparable(before.layout));
  });

  test('BOOT-12 files written before the reboot are there after it', async () => {
    const { page } = os;
    await sel.windows(page, 'terminal').last().getByTestId(TID.terminal).click();
    await runInTerminal(page, 'cat ~/e2e/h');
    expect(await terminalText(page)).toMatch(/plotinium-e1\s*$/m);
  });
});
