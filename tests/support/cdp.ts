/**
 * Chrome DevTools Protocol helpers: network throttling for BOOT-02 and CPU throttling for hosted
 * perf smoke runs (TST-21).
 *
 * A warm boot is cache-bound, so throttling alone changes nothing; BOOT-02 therefore disables the
 * HTTP cache and bypasses the Service Worker as well (boot-and-services §5.5, critic fix).
 */
import type { CDPSession, Page } from '@playwright/test';

export interface NetworkConditions {
  /** Added round-trip latency, ms. */
  latency: number;
  /** Bytes per second. */
  downloadThroughput: number;
  uploadThroughput: number;
}

const kbps = (n: number): number => (n * 1000) / 8;

/** Named profiles. `boot02` is the 400 kbps profile of the boot spec's BOOT-02 test title. */
export const NETWORK: Readonly<Record<'boot02' | 'slow4g' | 'none', NetworkConditions>> = {
  boot02: { latency: 400, downloadThroughput: kbps(400), uploadThroughput: kbps(400) },
  // DevTools "Slow 4G" preset (testing spec E9 names it).
  slow4g: { latency: 562.5, downloadThroughput: kbps(1440), uploadThroughput: kbps(675) },
  none: { latency: 0, downloadThroughput: -1, uploadThroughput: -1 },
};

export async function cdp(page: Page): Promise<CDPSession> {
  return page.context().newCDPSession(page);
}

/** Cache off, Service Worker bypassed, network throttled; call before navigating. */
export async function throttleNetwork(
  session: CDPSession,
  conditions: NetworkConditions,
): Promise<void> {
  await session.send('Network.enable');
  await session.send('Network.setCacheDisabled', { cacheDisabled: true });
  await session.send('Network.setBypassServiceWorker', { bypass: true });
  await session.send('Network.emulateNetworkConditions', { offline: false, ...conditions });
}

/** CPU slowdown factor; 1 means no throttle. The lab runner never throttles (WM §8.2 step 1). */
export async function throttleCpu(session: CDPSession, rate: number): Promise<void> {
  if (!(rate >= 1)) throw new RangeError(`CPU throttling rate must be at least 1, got ${rate}`);
  await session.send('Emulation.setCPUThrottlingRate', { rate });
}
