import { describe, expect, it } from 'vitest';

import { buildOf, chromeChannel, chromeVersionFromProduct } from './envelope.ts';

describe('TST-13 result envelope', () => {
  it('TST-13 the Chrome version is read from the CDP product string, headed or headless', () => {
    expect(chromeVersionFromProduct('Chrome/153.0.7310.12')).toBe('153.0.7310.12');
    expect(chromeVersionFromProduct('HeadlessChrome/154.0.7400.3')).toBe('154.0.7400.3');
    expect(() => chromeVersionFromProduct('Firefox/140.0')).toThrow(/not a Chrome product/);
  });

  it('TST-13 the channel is stable unless the nightly beta probe says otherwise', () => {
    expect(chromeChannel({})).toBe('stable');
    expect(chromeChannel({ PLT_CHROME_CHANNEL: 'beta' })).toBe('beta');
  });

  it('TST-06 the build identity comes from version.json and is unknown otherwise', () => {
    expect(buildOf({ version: '0.3.0', build: 'a1f93c2' })).toBe('0.3.0+a1f93c2');
    expect(buildOf({ version: '0.3.0' })).toBe('unknown');
    expect(buildOf(null)).toBe('unknown');
  });
});
