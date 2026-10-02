/**
 * E2 and E3 (testing §3.8; TST-12): the offline boot path.
 *
 * E2, the gate variant: boot online, wait for "Offline-ready", stop the `app` and `web`
 * containers (setOffline leaves WebSockets open, §6.3), reload from the Service Worker, log in
 * with the offline verifier, use the core utilities, queue an edit, then start the stack and see
 * the queue replay once (OFF-01, OFF-02). E3: the same with `context.setOffline(true)` (BOOT-09,
 * OFF-04), plus cross-origin isolation after an offline reboot (MEM-01, ARC-03).
 */
import { expect, test } from '@playwright/test';

import { seedUser } from '../fixtures/users.ts';
import { budget } from '../performance/budgets.ts';
import { baseUrl, FIXME_STACK, FIXME_UI, stackControl, uiReady } from '../support/env.ts';
import {
  login,
  openApp,
  persistentOS,
  runInTerminal,
  terminalText,
  waitForDesktop,
  type OsHandle,
} from '../support/os.ts';
import { TID } from '../support/selectors.ts';
import { assertBackendDown, stack } from '../support/stack.ts';

const DEMO = seedUser('demo');

async function reloadOffline(os: OsHandle): Promise<void> {
  await os.page.reload();
  // A cached session boots straight to the desktop; otherwise the login uses the offline verifier.
  const loginScreen = os.page.getByTestId(TID.loginScreen);
  const desktop = os.page.getByTestId(TID.desktop);
  await expect(loginScreen.or(desktop)).toBeVisible({ timeout: 30_000 });
  if (await loginScreen.isVisible()) {
    await expect(os.page.getByTestId(TID.loginOfflineNotice)).toBeVisible();
    await login(os.page, DEMO);
  }
  await waitForDesktop(os.page);
}

test.describe.serial('E2 offline boot with the server stopped (gate variant)', () => {
  test.fixme(!uiReady(), FIXME_UI);
  test.fixme(!stackControl(), FIXME_STACK);

  let os: OsHandle;
  const compose = stack();

  test.beforeAll(async () => {
    os = await persistentOS(DEMO);
    await expect(os.page.getByTestId(TID.offlineReady)).toBeVisible({ timeout: 60_000 });
    await compose.stop(['app', 'web']);
    await assertBackendDown(baseUrl(), (url, init) => fetch(url, init));
  });

  test.afterAll(async () => {
    await compose.start(['app', 'web']);
    await os?.close();
  });

  test('OFF-01 with the app and web containers stopped the desktop boots from the Service Worker and the core utilities work', async () => {
    await reloadOffline(os);
    await expect(os.page.getByTestId(TID.netStatus)).toHaveText(/Offline/);
    const term = await openApp(os.page, 'terminal');
    await term.getByTestId(TID.terminal).click();
    await runInTerminal(os.page, 'ls -la ~');
    await runInTerminal(os.page, 'echo offline-edit > ~/offline.txt');
    await runInTerminal(os.page, 'cat ~/offline.txt');
    expect(await terminalText(os.page)).toContain('offline-edit');
    for (const app of ['files', 'editor', 'task-manager', 'settings'] as const)
      await openApp(os.page, app);
    await expect(os.page.getByTestId(TID.netStatus)).toHaveText(/1 queued/);
  });

  test('OFF-02 when the server returns the queued edit replays exactly once', async () => {
    await compose.start(['app', 'web']);
    await expect(os.page.getByTestId(TID.netStatus)).toHaveText(/Online/, {
      timeout: budget('OFF-04.offline-indicator-silent').threshold,
    });
    await expect(os.page.getByTestId(TID.netStatus)).not.toHaveText(/queued/);
    const res = await os.page.request.get('/api/readyz');
    expect(res.ok()).toBe(true);
  });
});

test.describe.serial('E3 offline boot with the browser offline (setOffline variant)', () => {
  test.fixme(!uiReady(), FIXME_UI);

  let os: OsHandle;

  test.beforeAll(async () => {
    os = await persistentOS(DEMO);
    await expect(os.page.getByTestId(TID.offlineReady)).toBeVisible({ timeout: 60_000 });
  });

  test.afterAll(async () => {
    await os?.context.setOffline(false);
    await os?.close();
  });

  test('OFF-04 the taskbar shows Offline within its budget after the offline event', async () => {
    const started = Date.now();
    await os.context.setOffline(true);
    await expect(os.page.getByTestId(TID.netStatus)).toHaveText(/Offline/, {
      timeout: budget('OFF-04.offline-indicator').threshold,
    });
    expect(Date.now() - started).toBeLessThanOrEqual(budget('OFF-04.offline-indicator').threshold);
  });

  test('BOOT-09 with the browser offline, reload reaches a usable desktop', async () => {
    await reloadOffline(os);
    const term = await openApp(os.page, 'terminal');
    await term.getByTestId(TID.terminal).click();
    await runInTerminal(os.page, 'uname -a');
    expect(await terminalText(os.page)).toContain('Plotinium');
  });

  test('MEM-01 crossOriginIsolated is true in the window and in a worker after an offline reboot', async () => {
    expect(await os.page.evaluate(() => crossOriginIsolated)).toBe(true);
    const inWorker = await os.page.evaluate(
      () =>
        new Promise<boolean>((resolve) => {
          const src = URL.createObjectURL(
            new Blob(['postMessage(self.crossOriginIsolated)'], { type: 'text/javascript' }),
          );
          const w = new Worker(src);
          w.onmessage = (e: MessageEvent<boolean>) => {
            resolve(e.data);
            w.terminate();
          };
        }),
    );
    expect(inWorker).toBe(true);
  });
});
