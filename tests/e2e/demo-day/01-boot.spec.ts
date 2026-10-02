/**
 * Demo Day 0:05–0:08, boot (spec §17.1; testing §3.16.4; boot-and-services §3.7, §5.8).
 *
 * 1. The first load is a real cold boot; verbose mode shows the timestamped kernel-style log
 *    (BOOT-05). The examiner holds V or uses Esc → Verbose boot; the script uses `?boot=verbose`
 *    and, separately, the boot menu by keyboard.
 * 2. Log in as `demo`; `bootlog`, then `bootlog --critical-path` (BOOT-11).
 * 3. Wait for the taskbar badge "Offline-ready" (C11: the Service Worker registers after
 *    desktop-interactive plus idle).
 * 4. Disconnect the network and `reboot`: the desktop boots offline (BOOT-09). With
 *    PLT_E2E_STACK=1 the local-stack variant also stops `app` and `web` (TST-12), because cutting
 *    the network does not stop localhost.
 * 5. Core utilities offline: `ls -la ~`, `cat`, Files, Editor, Task Manager, Settings; an edit is
 *    queued (OFF-01). Reconnect: "Online" again and the queue replays once (OFF-02, OFF-04).
 */
import { expect, test, type Page } from '@playwright/test';

import { budget } from '../../performance/budgets.ts';
import { baseUrl } from '../../support/env.ts';
import { bootRecord } from '../../support/hooks.ts';
import {
  BOOT_TIMEOUT_MS,
  bootUrl,
  launchOS,
  login,
  openApp,
  rebootFromTerminal,
  waitForDesktop,
} from '../../support/os.ts';
import { sel, TID, type AppId } from '../../support/selectors.ts';
import { assertBackendDown, stack, stackOptions } from '../../support/stack.ts';

import { composeEnv, demoUser, envRunner } from './compose.ts';
import { demoDay, FIXME_UI, SKIP_DEMO_DAY, stackControl, uiReady } from './env.ts';
import {
  criticalPathProblems,
  parseCriticalPath,
  parseVerboseLog,
  timestampsNonDecreasing,
} from './parse.ts';
import {
  assertTestHooks,
  chromeVersion,
  desktopAfterReboot,
  measure,
  recordRehearsal,
  Shell,
  type DemoOS,
} from './session.ts';

/** Subsystems whose lines BOOT-05 names: firmware (POST), loader, kernel and the service manager. */
const EARLY_SUBSYSTEMS = ['firmware', 'loader', 'kernel', 'svc'] as const;

/** `docker compose stop|up` for the local-stack offline variant, in the rehearsal's project. */
const compose = stack(
  stackOptions(process.env, {
    runner: (cmd, args, cwd) => envRunner(cmd, args, { cwd, env: composeEnv() }),
  }),
);

/** Opens an app, checks its root is shown, then closes it so the Terminal is on top again. */
async function openAndClose(page: Page, app: AppId, root: string): Promise<void> {
  const win = await openApp(page, app);
  await expect(win.getByTestId(root)).toBeVisible();
  await win.getByTestId(TID.windowClose).click();
  await expect(win).toBeHidden();
}

test.describe
  .serial('Demo Day 0:05–0:08 boot: verbose cold boot, critical path, offline reboot', () => {
  test.skip(!demoDay(), SKIP_DEMO_DAY);
  test.fixme(!uiReady(), FIXME_UI);
  test.describe.configure({ timeout: 4 * 60_000 });

  let os: DemoOS;
  let shell: Shell;
  let chrome: string | null = null;
  let composeStopped = false;
  recordRehearsal('boot', 'boot', () => chrome);

  test.beforeAll(async () => {
    const user = await demoUser('demo');
    const handle = await launchOS();
    os = { ...handle, user, chrome: null };
  });

  test.afterAll(async () => {
    await os?.context.setOffline(false).catch(() => undefined);
    if (composeStopped) await compose.start(['app', 'web']);
    await os?.close();
  });

  test('BOOT-05 a cold boot in verbose mode shows the timestamped kernel-style log from firmware to the services', async () => {
    const { page } = os;
    await page.goto(bootUrl(baseUrl(), { boot: 'verbose' }));
    const log = page.getByTestId(TID.bootVerboseLog);
    await expect(log).toBeVisible({ timeout: BOOT_TIMEOUT_MS });
    let text = '';
    await expect
      .poll(
        async () => {
          text = (await log.textContent()) ?? text;
          const seen = new Set(parseVerboseLog(text).map((l) => l.subsystem));
          return EARLY_SUBSYSTEMS.every((s) => seen.has(s));
        },
        {
          timeout: BOOT_TIMEOUT_MS,
          message: 'the verbose log never showed firmware, loader, kernel and svc lines',
        },
      )
      .toBe(true);
    const lines = parseVerboseLog(text);
    measure('verbose lines', lines.length);
    expect(timestampsNonDecreasing(lines), 'verbose timestamps go backwards').toBe(true);
    // Boot §3.7 rule 3: the URL flag is consumed, so a manual reload does not repeat it.
    expect(new URL(page.url()).searchParams.has('boot')).toBe(false);

    await login(page, os.user);
    await waitForDesktop(page);
    await assertTestHooks(page);
    chrome = await chromeVersion(page);
    const rec = await bootRecord(page);
    measure('boot kind', rec.kind);
    measure('boot ms', rec.bootMs ?? 'null');
    measure('user wait ms', rec.userWaitMs);
    expect(rec.outcome).toBe('interactive');
    expect(rec.kind).toBe('cold-first');
  });

  test('BOOT-11 bootlog prints per-stage and per-service timings for the current boot', async () => {
    shell = await Shell.open(os.page);
    const stages = await shell.ok('bootlog');
    expect(stages).toMatch(/^boot #\d+ · /m);
    for (const stage of ['POST', 'kernel init', 'service start'])
      expect(stages, `bootlog has no "${stage}" stage`).toContain(stage);
    const services = await shell.ok('bootlog --services');
    for (const svc of ['kernel', 'storage', 'vfs', 'login', 'session', 'desktop'])
      expect(services, `bootlog --services has no ${svc} row`).toMatch(
        new RegExp(`^\\s*${svc}\\b`, 'm'),
      );
  });

  test('BOOT-11 bootlog --critical-path shows the chain from kernel to desktop that determined the boot time', async () => {
    const out = await shell.ok('bootlog --critical-path');
    const cp = parseCriticalPath(out);
    expect(cp, `no critical path in:\n${out}`).toBeDefined();
    if (cp === undefined) return;
    measure(
      'critical path',
      cp.rows
        .filter((r) => r.kind === 'svc')
        .map((r) => r.name)
        .join(' → '),
    );
    measure('boot s', cp.totalS);
    expect(criticalPathProblems(cp)).toEqual([]);
    const rec = await bootRecord(os.page);
    if (rec.bootMs !== null) expect(Math.abs(cp.totalS * 1000 - rec.bootMs)).toBeLessThanOrEqual(5);
  });

  test('BOOT-09 with the network disconnected, reboot boots a usable desktop from the Service Worker', async () => {
    const { page } = os;
    // C11: registration waits for desktop-interactive plus idle; cutting the network before the
    // badge is the first drill of testing §3.16.4.
    await expect(page.getByTestId(TID.offlineReady)).toBeVisible({ timeout: 60_000 });
    await os.context.setOffline(true);
    if (stackControl()) {
      await compose.stop(['app', 'web']);
      composeStopped = true;
      await assertBackendDown(baseUrl(), (url, init) => fetch(url, init));
    }
    measure('variant', stackControl() ? 'setOffline + app and web stopped' : 'setOffline');
    await shell.focus();
    await rebootFromTerminal(page);
    await desktopAfterReboot(page, os.user, true);
    await expect(page.getByTestId(TID.netStatus)).toHaveText(/Offline/, {
      timeout: budget('OFF-04.offline-indicator').threshold,
    });
    const rec = await bootRecord(page);
    measure('offline boot kind', rec.kind);
    measure('offline boot ms', rec.bootMs ?? 'null');
    expect(rec.outcome).toBe('interactive');
    expect(rec.env.swActive).toBe(true);
  });

  test('OFF-01 offline, the core utilities work and an edit is queued: ls, cat, Files, Editor, Task Manager, Settings', async () => {
    const { page } = os;
    await openAndClose(page, 'files', TID.files);
    await openAndClose(page, 'editor', TID.editor);
    await openAndClose(page, 'task-manager', TID.taskManager);
    await openAndClose(page, 'settings', TID.settings);
    shell = await Shell.open(page);
    await shell.ok('ls -la ~');
    await shell.ok('echo demo-day-offline > ~/demo-offline.txt');
    expect(await shell.ok('cat ~/demo-offline.txt')).toMatch(/^demo-day-offline$/m);
    await expect(page.getByTestId(TID.netStatus)).toHaveText(/Offline · 1 queued/);
  });

  test('OFF-02 on reconnect the taskbar returns to Online and the queued edit replays exactly once', async () => {
    const { page } = os;
    const net = page.getByTestId(TID.netStatus);
    if (composeStopped) {
      await compose.start(['app', 'web']);
      composeStopped = false;
    }
    await os.context.setOffline(false);
    const started = Date.now();
    await expect(net).toHaveText(/Online/, {
      timeout: budget('OFF-04.offline-indicator-silent').threshold,
    });
    measure('reconnect to Online ms', Date.now() - started);
    await expect(net).not.toHaveText(/queued/);
    expect(await shell.ok('cat ~/demo-offline.txt')).toMatch(/^demo-day-offline$/m);
    const res = await page.request.get('/api/readyz');
    expect(res.ok()).toBe(true);
  });
});

// The path the examiner can always use when the V key was missed (testing §3.16.4 drill).
test.describe('Demo Day 0:05–0:08 boot: verbose boot from the boot menu by keyboard', () => {
  test.skip(!demoDay(), SKIP_DEMO_DAY);
  test.fixme(!uiReady(), FIXME_UI);
  let chrome: string | null = null;
  recordRehearsal('boot', 'boot menu', () => chrome);

  test('BOOT-06 the Plotinium Boot Manager reaches Verbose boot with the arrow keys and Enter', async () => {
    const handle = await launchOS();
    try {
      const { page } = handle;
      await page.goto(bootUrl(baseUrl(), { boot: 'menu' }));
      await expect(sel.bootMenu(page)).toBeVisible({ timeout: BOOT_TIMEOUT_MS });
      for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowDown');
      await expect(sel.bootMenuItem(page, 'Verbose boot')).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(page.getByTestId(TID.bootVerboseLog)).toBeVisible({ timeout: BOOT_TIMEOUT_MS });
      chrome = await chromeVersion(page);
      await expect(page.getByTestId(TID.loginScreen)).toBeVisible({ timeout: BOOT_TIMEOUT_MS });
    } finally {
      await handle.close();
    }
  });
});
