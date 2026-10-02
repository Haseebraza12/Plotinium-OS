/**
 * BOOT-10 boot timing (boot-and-services §5.7 and §7; testing §3.11.2): warm, cold and cold-first
 * boots, 20 runs each, p95 of the boot record's `bootMs`, plus the Resource Timing check that no
 * large asset starts loading before `desktop-interactive`. Lab-spec runner, Chrome stable; the
 * result files are judged by check-budgets.
 */
import { expect, test, type Page } from '@playwright/test';

import { seedUser } from '../../fixtures/users.ts';
import { baseUrl, FIXME_UI, uiReady } from '../../support/env.ts';
import { bootRecord } from '../../support/hooks.ts';
import {
  DESKTOP_INTERACTIVE,
  persistentOS,
  waitForDesktop,
  type OsHandle,
} from '../../support/os.ts';
import { TID } from '../../support/selectors.ts';
import { budget } from '../budgets.ts';
import { envelope } from '../envelope.ts';
import { writePerfResult } from '../result.ts';

import {
  bootResult,
  bootTimes,
  countResult,
  largeAssetRequests,
  type BootKind,
  type BootSample,
} from './runs.ts';

const RUNS = budget('BOOT-10.warm').samples.runs;

async function sampleBoot(page: Page): Promise<{ sample: BootSample; early: string[] }> {
  await waitForDesktop(page);
  const rec = await bootRecord(page);
  const { entries, markAt } = await page.evaluate((mark) => {
    const at = performance.getEntriesByName(mark, 'mark')[0]?.startTime ?? Number.POSITIVE_INFINITY;
    const res = performance
      .getEntriesByType('resource')
      .map((e) => ({ name: e.name, startTime: e.startTime }));
    return { entries: res, markAt: at };
  }, DESKTOP_INTERACTIVE);
  return {
    sample: { kind: rec.kind, bootMs: rec.bootMs, userWaitMs: rec.userWaitMs },
    early: largeAssetRequests(entries, markAt),
  };
}

/** Cold: empty HTTP cache and Service Worker caches, Service Worker unregistered, IndexedDB kept. */
async function makeCold(page: Page): Promise<void> {
  const session = await page.context().newCDPSession(page);
  await session.send('Network.clearBrowserCache');
  await session.detach();
  await page.evaluate(async () => {
    for (const reg of await navigator.serviceWorker.getRegistrations()) await reg.unregister();
    for (const key of await caches.keys()) await caches.delete(key);
  });
}

async function record(
  kind: BootKind,
  samples: BootSample[],
  early: string[],
  os: OsHandle,
  started: number,
): Promise<void> {
  const env = await envelope(os.page);
  const timing = { startedAt: new Date(started).toISOString(), durationMs: Date.now() - started };
  await writePerfResult(
    bootResult(budget(`BOOT-10.${kind}`), bootTimes(samples, kind), env, timing),
  );
  if (kind === 'warm') {
    await writePerfResult(
      countResult(budget('BOOT-10.no-large-assets'), early.length, samples.length, env, timing, {
        offenders: early,
      }),
    );
  }
}

test.describe('BOOT-10 boot time (lab-spec runner)', () => {
  test.fixme(!uiReady(), FIXME_UI);
  test.describe.configure({ timeout: 15 * 60_000 });

  test('BOOT-10 warm boot p95 over 20 runs is recorded and no large asset loads before desktop-interactive', async () => {
    const os = await persistentOS(seedUser('demo'), { headless: false });
    try {
      // Warm means the Service Worker is active; it registers only after interactive plus idle (C11).
      await expect(os.page.getByTestId(TID.offlineReady)).toBeVisible({ timeout: 60_000 });
      const started = Date.now();
      const samples: BootSample[] = [];
      const early: string[] = [];
      for (let i = 0; i < RUNS; i++) {
        await os.page.reload();
        const r = await sampleBoot(os.page);
        samples.push(r.sample);
        early.push(...r.early);
      }
      await record('warm', samples, early, os, started);
      expect(early, 'large assets requested before desktop-interactive').toEqual([]);
    } finally {
      await os.close();
    }
  });

  test('BOOT-10 cold boot p95 over 20 runs is recorded with caches cleared and IndexedDB kept', async () => {
    const os = await persistentOS(seedUser('demo'), { headless: false });
    try {
      const started = Date.now();
      const samples: BootSample[] = [];
      for (let i = 0; i < RUNS; i++) {
        await makeCold(os.page);
        await os.page.reload();
        samples.push((await sampleBoot(os.page)).sample);
      }
      await record('cold', samples, [], os, started);
    } finally {
      await os.close();
    }
  });

  test('BOOT-10 cold-first boot on a fresh profile is recorded for the local stack', async () => {
    const started = Date.now();
    const samples: BootSample[] = [];
    let last: OsHandle | undefined;
    for (let i = 0; i < RUNS; i++) {
      await last?.close();
      last = await persistentOS(seedUser('demo'), { headless: false, baseURL: baseUrl() });
      samples.push((await sampleBoot(last.page)).sample);
    }
    try {
      if (last !== undefined) await record('cold-first', samples, [], last, started);
    } finally {
      await last?.close();
    }
  });
});
