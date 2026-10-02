/**
 * E5, two users contend for one file (VFS-09; testing §3.6.7, §3.8; offline-and-sync).
 *
 * alice and bob, each in their own persistent Chrome profile, open /home/shared/plan.md in the
 * Editor. alice holds the X lease; bob's Editor is read-only with "Locked by alice". alice's
 * renderer is then killed without a clean release (offline first, so no FIN reaches the server);
 * bob must acquire within TTL + 0.5 s (demo lease profile: TTL 15 s).
 *
 * The elapsed time is measured from the crash, which is after alice's last renewal, so this is a
 * lower bound of the true expiry delay; the banner's data-expires-at (SELECTORS.md) gives the
 * server's own expiry, which is asserted too.
 */
import { expect, test } from '@playwright/test';

import { SHARED_PLAN, seedUser } from '../fixtures/users.ts';
import { budget, miss } from '../performance/budgets.ts';
import { FIXME_UI, uiReady } from '../support/env.ts';
import { openApp, persistentOS, runInTerminal, type OsHandle } from '../support/os.ts';
import { sel, TID } from '../support/selectors.ts';

async function openShared(os: OsHandle): Promise<void> {
  const term = await openApp(os.page, 'terminal');
  await term.getByTestId(TID.terminal).click();
  // TODO(R3): switch to the Files app's "Open with Editor" once its selectors land.
  await runInTerminal(os.page, `edit ${SHARED_PLAN}`);
  await expect(sel.windows(os.page, 'editor')).toHaveCount(1);
}

test.describe.serial('E5 two users contend for /home/shared/plan.md', () => {
  test.fixme(!uiReady(), FIXME_UI);
  test.describe.configure({ timeout: 3 * 60_000 });

  let alice: OsHandle;
  let bob: OsHandle;

  test.beforeAll(async () => {
    alice = await persistentOS(seedUser('alice'));
    bob = await persistentOS(seedUser('bob'));
  });

  test.afterAll(async () => {
    await alice?.close().catch(() => undefined);
    await bob?.close();
  });

  test('VFS-09 the second user opens the file read-only and sees who holds the lock', async () => {
    await openShared(alice);
    await expect(alice.page.getByTestId(TID.editorLockBanner)).toBeHidden();
    await openShared(bob);
    const banner = bob.page.getByTestId(TID.editorLockBanner);
    await expect(banner).toBeVisible();
    await expect(banner).toHaveText(/Locked by alice/);
    await expect(bob.page.getByTestId(TID.editor)).toHaveAttribute('aria-readonly', 'true');
  });

  test("VFS-09 a crashed holder's lease expires within TTL plus 0.5 s and the other user acquires it", async () => {
    const limit = budget('VFS-09.crash-expiry');
    const banner = bob.page.getByTestId(TID.editorLockBanner);
    const expiresAt = Number(await banner.getAttribute('data-expires-at'));
    await alice.context.setOffline(true);
    const crashedAt = Date.now();
    await alice.page.close({ runBeforeUnload: false });
    await expect(banner).toBeHidden({ timeout: limit.threshold + 5_000 });
    const acquiredAt = Date.now();
    await expect(bob.page.getByTestId(TID.editor)).not.toHaveAttribute('aria-readonly', 'true');
    expect(miss(limit, acquiredAt - crashedAt)).toBeUndefined();
    if (Number.isFinite(expiresAt) && expiresAt > 0) {
      const slack = Number(limit.params?.['slackMs'] ?? 500);
      expect(acquiredAt - expiresAt, 'acquired later than expiry + 0.5 s').toBeLessThanOrEqual(
        slack,
      );
    }
  });
});
