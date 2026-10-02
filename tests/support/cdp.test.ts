import type { CDPSession } from '@playwright/test';
import { describe, expect, it } from 'vitest';

import { NETWORK, throttleCpu, throttleNetwork } from './cdp.ts';

function fakeSession(): { session: CDPSession; sent: Array<[string, unknown]> } {
  const sent: Array<[string, unknown]> = [];
  const session = {
    send: (method: string, params?: unknown) => {
      sent.push([method, params]);
      return Promise.resolve({});
    },
  } as unknown as CDPSession;
  return { session, sent };
}

describe('BOOT-02 network throttling', () => {
  it('BOOT-02 throttling disables the cache and bypasses the Service Worker before limiting the network', async () => {
    const { session, sent } = fakeSession();
    await throttleNetwork(session, NETWORK.boot02);
    expect(sent.map(([m]) => m)).toEqual([
      'Network.enable',
      'Network.setCacheDisabled',
      'Network.setBypassServiceWorker',
      'Network.emulateNetworkConditions',
    ]);
    expect(sent[1]?.[1]).toEqual({ cacheDisabled: true });
    expect(sent[2]?.[1]).toEqual({ bypass: true });
    expect(sent[3]?.[1]).toEqual({
      offline: false,
      latency: 400,
      downloadThroughput: 50_000,
      uploadThroughput: 50_000,
    });
  });

  it('TST-21 CPU throttling accepts a calibrated rate of at least 1 and rejects a speed-up', async () => {
    const { session, sent } = fakeSession();
    await throttleCpu(session, 2.5);
    expect(sent).toEqual([['Emulation.setCPUThrottlingRate', { rate: 2.5 }]]);
    await expect(throttleCpu(session, 0.5)).rejects.toThrow(RangeError);
    await expect(throttleCpu(session, Number.NaN)).rejects.toThrow(RangeError);
  });
});
