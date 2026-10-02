/**
 * E9, truthful boot progress (BOOT-02; boot-and-services §5.5, §8.3; testing §3.8).
 *
 * A warm boot is cache-bound, so both runs disable the HTTP cache and bypass the Service Worker
 * over CDP; one run is unthrottled and one runs at 400 kbps. The progressbar's aria-valuenow is
 * sampled on every mutation by an init script, from the first byte of the page.
 */
import { expect, test } from '@playwright/test';

import { seedUser } from '../fixtures/users.ts';
import { budget, miss } from '../performance/budgets.ts';
import { baseUrl, FIXME_UI, uiReady } from '../support/env.ts';
import { NETWORK, throttleNetwork, type NetworkConditions } from '../support/cdp.ts';
import { bootUrl, launchOS, login, waitForDesktop, DESKTOP_INTERACTIVE } from '../support/os.ts';
import {
  distinctValues,
  installProgressRecorder,
  isNonDecreasing,
  progressSamples,
  valueAt,
  type ProgressSample,
} from '../support/progress.ts';

/** The asset share α of Normal and Safe boots: W_assets / (W_assets + Σw) = 10 / 35 (§5.5). */
const ASSET_SHARE = 10 / 35;

interface BootRun {
  samples: ProgressSample[];
  interactiveAt: number;
}

async function recordedBoot(conditions: NetworkConditions): Promise<BootRun> {
  const os = await launchOS();
  try {
    await installProgressRecorder(os.context);
    const session = await os.context.newCDPSession(os.page);
    await throttleNetwork(session, conditions);
    await os.page.goto(bootUrl(baseUrl()));
    await login(os.page, seedUser('demo'));
    await waitForDesktop(os.page, 120_000);
    const interactiveAt = await os.page.evaluate(
      (mark) => performance.getEntriesByName(mark, 'mark')[0]?.startTime ?? Number.NaN,
      DESKTOP_INTERACTIVE,
    );
    return { samples: await progressSamples(os.page), interactiveAt };
  } finally {
    await os.close();
  }
}

test.describe.serial('E9 truthful boot progress', () => {
  test.fixme(!uiReady(), FIXME_UI);
  test.describe.configure({ timeout: 5 * 60_000 });

  let fast: BootRun;
  let slow: BootRun;

  test.beforeAll(async () => {
    fast = await recordedBoot(NETWORK.none);
    slow = await recordedBoot(NETWORK.boot02);
  });

  test('BOOT-02 P is non-decreasing over a recorded boot and equals 1 exactly at desktop-interactive', () => {
    for (const run of [fast, slow]) {
      expect(isNonDecreasing(run.samples)).toBe(true);
      const last = run.samples[run.samples.length - 1];
      expect(last?.v).toBe(100);
      // Reaching 100 before the mark would be progress that ran ahead of the real work.
      expect(valueAt(run.samples, run.interactiveAt - 1)).toBeLessThan(100);
    }
  });

  test('BOOT-02 with cache disabled and SW bypassed at 400 kbps, P at 500 ms is lower than on the unthrottled run and the kernel download produces at least 5 distinct P values', () => {
    const at = Number(budget('BOOT-02.throttled').params?.['atMs'] ?? 500);
    const fastAt = valueAt(fast.samples, at);
    const slowAt = valueAt(slow.samples, at);
    expect(fastAt, 'the unthrottled boot must have progressed by 500 ms').toBeGreaterThan(0);
    expect(miss(budget('BOOT-02.throttled'), slowAt / fastAt)).toBeUndefined();
    const assetPhase = slow.samples.filter((s) => s.v < 100 * ASSET_SHARE);
    expect(miss(budget('BOOT-02.kernel-steps'), distinctValues(assetPhase))).toBeUndefined();
  });
});
