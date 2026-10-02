import { describe, expect, it } from 'vitest';

import { bootUrl, chromeArgs, launchOptions } from './os.ts';

describe('TST-13 persistent OS launch options', () => {
  it('TST-13 every launch uses Google Chrome stable, never the bundled Chromium', () => {
    expect(launchOptions()?.channel).toBe('chrome');
    expect(launchOptions({ baseURL: 'http://localhost:4718' })?.baseURL).toBe(
      'http://localhost:4718',
    );
  });

  it('TST-11 the SQLite IndexedDB backend is forced only when asked for', () => {
    expect(chromeArgs()).toEqual([]);
    expect(chromeArgs('sqlite')).toEqual([
      '--enable-features=IdbSqliteBackingStore,IdbSqliteOnDiskRollout',
    ]);
    expect(launchOptions({ idbBackend: 'sqlite' })?.args).toEqual(chromeArgs('sqlite'));
  });

  it('BOOT-06 boot URLs carry the profile and the test-build flags', () => {
    expect(bootUrl('http://localhost:4717')).toBe('http://localhost:4717/');
    expect(bootUrl('http://localhost:4717/', { boot: 'menu' })).toBe(
      'http://localhost:4717/?boot=menu',
    );
    expect(
      bootUrl('http://localhost:4717', {
        boot: 'safe',
        bootFlags: ['inject-cycle', 'hold-splash'],
      }),
    ).toBe('http://localhost:4717/?boot=safe&bootflags=inject-cycle%2Chold-splash');
    expect(bootUrl('http://localhost:4717', { bootFlags: [] })).toBe('http://localhost:4717/');
  });

  it('WM-07 themes and reduced motion default to light and no preference', () => {
    const o = launchOptions({ colorScheme: 'dark', reducedMotion: 'reduce' });
    expect(o?.colorScheme).toBe('dark');
    expect(o?.reducedMotion).toBe('reduce');
    expect(launchOptions()?.colorScheme).toBe('light');
  });
});
