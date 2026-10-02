/**
 * Demo Day 0:08–0:18, item 7: two users contend for a lock (spec §17.1; testing §3.16.5 item 7;
 * Appendix A VFS-09; offline-and-sync; demo lease profile C6: TTL 15 s, heartbeat 5 s).
 *
 * Two Chrome profiles side by side: alice (A) and bob (B) open /home/shared/plan.md (mode 664,
 * group team) in the Editor. B is read-only with "Locked by alice"; `lsof` in B shows alice's
 * exclusive lease counting down from at most the TTL. A's renderer is then ended the way the
 * examiner does it from Chrome's Task Manager (a real renderer crash); B acquires the lock within
 * TTL + 0.5 s (`VFS-09.crash-expiry`). The drill "lease not released after the renderer kill" is
 * this same path: the lease expires by TTL, which is what VFS-09 requires.
 *
 * The Editor is opened with `edit PATH` as in tests/e2e/lock-contention.spec.ts (TODO(R3): the
 * Files app's "Open with Editor" once its selectors land).
 */
import { expect, test } from '@playwright/test';

import { budget, miss } from '../../performance/budgets.ts';
import { SHARED_PLAN } from '../../fixtures/users.ts';
import { sel, TID } from '../../support/selectors.ts';

import { demoDay, FIXME_UI, SKIP_DEMO_DAY, uiReady } from './env.ts';
import { parseLeases } from './parse.ts';
import { bootAs, crashRenderer, measure, recordRehearsal, Shell, type DemoOS } from './session.ts';

async function openShared(os: DemoOS): Promise<void> {
  const shell = await Shell.open(os.page);
  await shell.ok(`edit ${SHARED_PLAN}`);
  await expect(sel.windows(os.page, 'editor')).toHaveCount(1);
}

test.describe
  .serial('Demo Day 0:08–0:18 item 7: two users contend for /home/shared/plan.md', () => {
  test.skip(!demoDay(), SKIP_DEMO_DAY);
  test.fixme(!uiReady(), FIXME_UI);
  test.describe.configure({ timeout: 3 * 60_000 });

  let alice: DemoOS;
  let bob: DemoOS;
  let chrome: string | null = null;
  recordRehearsal('sut', '7 two users contend', () => chrome);

  test.beforeAll(async () => {
    alice = await bootAs('alice');
    bob = await bootAs('bob');
    chrome = alice.chrome;
  });

  test.afterAll(async () => {
    await alice?.close().catch(() => undefined);
    await bob?.close();
  });

  test('VFS-09 bob opens the shared file read-only and sees Locked by alice', async () => {
    await openShared(alice);
    await expect(alice.page.getByTestId(TID.editorLockBanner)).toBeHidden();
    await expect(alice.page.getByTestId(TID.editor)).not.toHaveAttribute('aria-readonly', 'true');
    await openShared(bob);
    const banner = bob.page.getByTestId(TID.editorLockBanner);
    await expect(banner).toBeVisible();
    await expect(banner).toHaveText(/Locked by alice/);
    await expect(banner).toHaveAttribute('data-holder', 'alice');
    await expect(bob.page.getByTestId(TID.editor)).toHaveAttribute('aria-readonly', 'true');
  });

  test("VFS-09 lsof in bob's Terminal shows alice's exclusive lease counting down from at most the TTL", async () => {
    // A second Terminal on top of the Editor; the Editor keeps its banner behind it.
    const shell = await Shell.open(bob.page);
    const leases = parseLeases(await shell.ok(`lsof ${SHARED_PLAN}`), SHARED_PLAN);
    const held = leases.find((l) => l.user === 'alice' && l.mode === 'X');
    expect(held, `no exclusive lease of alice in lsof:\n${JSON.stringify(leases)}`).toBeDefined();
    const ttlS = Number(budget('VFS-09.crash-expiry').params?.['ttlMs'] ?? 15_000) / 1000;
    measure('expires in s', held?.expiresInS ?? 'n/a');
    measure('fence', held?.fence ?? 'n/a');
    expect(held?.expiresInS).not.toBeNull();
    expect(held?.expiresInS ?? Infinity).toBeLessThanOrEqual(ttlS);
  });

  test("VFS-09 after alice's renderer is killed bob acquires the lock within TTL plus 0.5 s", async () => {
    const limit = budget('VFS-09.crash-expiry');
    const banner = bob.page.getByTestId(TID.editorLockBanner);
    const expiresAt = Number(await banner.getAttribute('data-expires-at'));
    const crashedAt = Date.now();
    await crashRenderer(alice.page);
    await expect(banner).toBeHidden({ timeout: limit.threshold + 5_000 });
    const acquiredAt = Date.now();
    await expect(bob.page.getByTestId(TID.editor)).not.toHaveAttribute('aria-readonly', 'true');
    measure('crash to acquire ms', acquiredAt - crashedAt);
    // Measured from the crash, which is after alice's last renewal: a lower bound of the delay.
    expect(miss(limit, acquiredAt - crashedAt)).toBeUndefined();
    if (Number.isFinite(expiresAt) && expiresAt > 0) {
      const slack = Number(limit.params?.['slackMs'] ?? 500);
      measure('after server expiry ms', acquiredAt - expiresAt);
      expect(
        acquiredAt - expiresAt,
        'acquired later than the server expiry + 0.5 s',
      ).toBeLessThanOrEqual(slack);
    }
  });
});
