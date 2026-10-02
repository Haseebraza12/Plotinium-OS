import { describe, expect, it } from 'vitest';

import type { LoaderView, UrlBoot } from '../src/boot/flags.ts';
import { decideProfile, failedStreak, readUrlBoot, verboseFromKeys } from '../src/boot/flags.ts';
import { NEXT_BOOT_KEY, readNextBoot, writeNextBoot } from '../src/boot/next-boot.ts';

function fakeHistory(): {
  history: Pick<History, 'replaceState' | 'state'>;
  replaced: string[];
} {
  const replaced: string[] = [];
  return {
    replaced,
    history: {
      state: null,
      replaceState: (_s: unknown, _t: string, url?: string | URL | null) => {
        replaced.push(String(url));
      },
    },
  };
}

const NO_URL: UrlBoot = { menu: false, profile: null, verbose: false, flags: [], testFlags: [] };
const CLEAN: LoaderView = { bootFlags: {}, recentBoots: [] };

describe('boot URL flags (boot §3.7 rule 3)', () => {
  it('SVC-07 ?boot=menu requests the menu and is removed from the address bar', () => {
    const { history, replaced } = fakeHistory();
    const u = readUrlBoot({ href: 'http://localhost:4717/?boot=menu&x=1#h' }, history);
    expect(u.menu).toBe(true);
    expect(u.profile).toBeNull();
    expect(u.flags).toEqual(['url:menu']);
    expect(replaced).toEqual(['/?x=1#h']);
  });

  it('BOOT-06 ?boot=safe and ?boot=recovery pick the profile; unknown values are ignored but removed', () => {
    expect(readUrlBoot({ href: 'http://h/?boot=safe' }, fakeHistory().history).profile).toBe(
      'safe',
    );
    expect(readUrlBoot({ href: 'http://h/?boot=recovery' }, fakeHistory().history).profile).toBe(
      'recovery',
    );
    const { history, replaced } = fakeHistory();
    const u = readUrlBoot({ href: 'http://h/?boot=turbo' }, history);
    expect(u).toMatchObject({ menu: false, profile: null, verbose: false, flags: [] });
    expect(replaced).toEqual(['/']);
  });

  it('BOOT-05 ?boot=verbose turns the verbose log on without changing the profile', () => {
    const u = readUrlBoot({ href: 'http://h/?boot=verbose' }, fakeHistory().history);
    expect(u.verbose).toBe(true);
    expect(u.profile).toBeNull();
  });

  it('OPS-19 ?bootflags= is honoured only in test builds and keeps only well-formed names', () => {
    const release = readUrlBoot({ href: 'http://h/?bootflags=hold-splash' }, fakeHistory().history);
    expect(release.testFlags).toEqual([]);
    const { history, replaced } = fakeHistory();
    const test = readUrlBoot(
      { href: 'http://h/?bootflags=hold-splash,inject-cycle,BAD!,x' },
      history,
      true,
    );
    expect(test.testFlags).toEqual(['hold-splash', 'inject-cycle', 'x']);
    expect(test.flags).toEqual(['test:hold-splash', 'test:inject-cycle', 'test:x']);
    expect(replaced).toEqual(['/']);
  });

  it('SVC-07 a URL without boot parameters is left untouched', () => {
    const { history, replaced } = fakeHistory();
    expect(readUrlBoot({ href: 'http://h/?q=1' }, history)).toEqual(NO_URL);
    expect(replaced).toEqual([]);
  });
});

describe('the stage-2 profile decision (boot §3.7)', () => {
  it('SVC-07 an Esc buffered before the loader decision opens the menu with Normal preselected', () => {
    const d = decideProfile(['Escape'], NO_URL, CLEAN);
    expect(d).toMatchObject({ menu: true, preselect: 'normal', profile: 'normal' });
    expect(d.flags).toContain('esc');
  });

  it('SVC-07 the kernel boot flag and the local next-boot flag both open the menu', () => {
    const meta = decideProfile([], NO_URL, { bootFlags: { menuNextBoot: true }, recentBoots: [] });
    expect(meta.menu).toBe(true);
    expect(meta.flags).toContain('meta:menuNextBoot');
    const local = decideProfile([], NO_URL, CLEAN, { menuNextBoot: true });
    expect(local.menu).toBe(true);
    expect(local.flags).toContain('local:menuNextBoot');
    expect(local.flags).not.toContain('meta:menuNextBoot');
  });

  it('BOOT-06 two failed boots in a row open the menu with Safe preselected', () => {
    const d = decideProfile([], NO_URL, {
      bootFlags: {},
      recentBoots: [{ outcome: 'interactive' }, { outcome: 'panic' }, { outcome: 'incomplete' }],
    });
    expect(d).toMatchObject({ menu: true, preselect: 'safe', failedBoots: 2 });
    expect(d.flags).toContain('auto-safe');
  });

  it('BOOT-06 one failed boot after a good one does not force the menu', () => {
    const d = decideProfile([], NO_URL, {
      bootFlags: {},
      recentBoots: [{ outcome: 'panic' }, { outcome: 'interactive' }, { outcome: 'recovery' }],
    });
    expect(d.menu).toBe(false);
    expect(d.failedBoots).toBe(1);
  });

  it('BOOT-06 the URL profile applies when no menu is requested', () => {
    const d = decideProfile([], { ...NO_URL, profile: 'safe', flags: ['url:safe'] }, CLEAN);
    expect(d).toMatchObject({ menu: false, profile: 'safe', flags: ['url:safe'] });
  });

  it('BOOT-05 an odd number of buffered V presses turns the verbose log on', () => {
    expect(verboseFromKeys(['v'])).toBe(true);
    expect(verboseFromKeys(['v', 'Escape', 'v'])).toBe(false);
    expect(decideProfile(['v'], NO_URL, CLEAN).verbose).toBe(true);
    expect(decideProfile([], { ...NO_URL, verbose: true }, CLEAN).verbose).toBe(true);
  });

  it('BOOT-06 the failed streak counts back from the newest record only', () => {
    expect(failedStreak([])).toBe(0);
    expect(
      failedStreak([{ outcome: 'panic' }, { outcome: 'panic' }, { outcome: 'recovery' }]),
    ).toBe(3);
    expect(failedStreak([{ outcome: 'panic' }, { outcome: 'interactive' }])).toBe(0);
  });
});

describe('the one-shot next-boot flag (Settings, reboot --menu)', () => {
  function memoryStore(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> & {
    data: Map<string, string>;
  } {
    const data = new Map<string, string>();
    return {
      data,
      getItem: (k) => data.get(k) ?? null,
      setItem: (k, v) => {
        data.set(k, v);
      },
      removeItem: (k) => {
        data.delete(k);
      },
    };
  }

  it('SVC-07 the flag round-trips and clearing it removes the key', () => {
    const store = memoryStore();
    expect(readNextBoot(store)).toEqual({});
    writeNextBoot(store, { menuNextBoot: true });
    expect(readNextBoot(store)).toEqual({ menuNextBoot: true });
    writeNextBoot(store, {});
    expect(store.data.has(NEXT_BOOT_KEY)).toBe(false);
  });

  it('SVC-07 unreadable, corrupt or blocked storage reads as no flag and never throws', () => {
    const store = memoryStore();
    store.data.set(NEXT_BOOT_KEY, '{not json');
    expect(readNextBoot(store)).toEqual({});
    store.data.set(NEXT_BOOT_KEY, '{"menuNextBoot":"yes"}');
    expect(readNextBoot(store)).toEqual({});
    expect(readNextBoot(null)).toEqual({});
    const throwing = {
      getItem: (): string | null => {
        throw new Error('SecurityError');
      },
      setItem: (): void => {
        throw new Error('QuotaExceededError');
      },
      removeItem: (): void => {
        throw new Error('SecurityError');
      },
    };
    expect(readNextBoot(throwing)).toEqual({});
    expect(() => {
      writeNextBoot(throwing, { menuNextBoot: true });
    }).not.toThrow();
  });
});
