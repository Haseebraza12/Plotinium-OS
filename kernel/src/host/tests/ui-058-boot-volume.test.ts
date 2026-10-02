/**
 * UI-058: the stage-2 boot-volume read gives the loader the real boot history (auto-safe after two
 * failed boots, BOOT-04 / boot-and-services.md §3.7 rule 2) instead of a stub, and a boot that
 * reached the login screen is not counted as failed.
 */
import { afterEach, describe, expect, it } from 'vitest';

import type { BootRecord } from '../../core/io/bootlog.ts';
import type { World } from '../../core/io/tests/world.ts';
import { bootWorld, loginWaiting } from '../../core/io/tests/world.ts';
import {
  bootFlagsOf,
  NO_VOLUME,
  outcomeOf,
  readBootVolume,
  readBootVolumeWithin,
  recentBootsOf,
} from '../boot-volume.ts';

const worlds: World[] = [];
afterEach(() => {
  for (const w of worlds.splice(0)) w.close();
});

describe('UI-058 boot history for the loader', () => {
  it('UI-058 maps stored outcomes: recovery boots, boots that reached login, stalls', () => {
    expect(outcomeOf({ outcome: 'interactive' })).toBe('interactive');
    expect(outcomeOf({ outcome: 'panic' })).toBe('panic');
    expect(outcomeOf({ outcome: 'incomplete', profile: 'recovery' })).toBe('recovery');
    expect(outcomeOf({ outcome: 'incomplete', profile: 'normal', loginAt: 1.2 })).toBe(
      'interactive',
    );
    expect(outcomeOf({ outcome: 'incomplete', profile: 'normal' })).toBe('incomplete');
    expect(outcomeOf({ outcome: 'exploded' })).toBeNull();
  });

  it('UI-058 returns the last 3 records oldest first and skips malformed rows', () => {
    const rows = [
      { seq: 4, outcome: 'incomplete', profile: 'recovery' },
      { seq: 1, outcome: 'interactive' },
      { seq: 5, outcome: 'incomplete', profile: 'recovery' },
      { seq: 2, outcome: 'interactive' },
      { seq: 'x', outcome: 'panic' },
      null,
      { seq: 3, outcome: 'panic' },
    ];
    expect(recentBootsOf(rows)).toEqual([
      { seq: 3, outcome: 'panic' },
      { seq: 4, outcome: 'recovery' },
      { seq: 5, outcome: 'recovery' },
    ]);
  });

  it('UI-058 reads a one-shot menu flag from meta.bootFlags', () => {
    expect(bootFlagsOf({ k: 'bootFlags', v: { menuNextBoot: true } })).toEqual({
      menuNextBoot: true,
    });
    expect(bootFlagsOf({ k: 'bootFlags', v: {} })).toEqual({});
    expect(bootFlagsOf(undefined)).toEqual({});
  });

  it('UI-058 without IndexedDB, or when the read is too slow, the loader decides without history', async () => {
    await expect(readBootVolume(null, 'plotinium')).resolves.toEqual(NO_VOLUME);
    let fire: (() => void) | null = null;
    const slow = readBootVolumeWithin(
      () => new Promise(() => undefined),
      300,
      (fn) => {
        fire = fn;
      },
    );
    expect(fire).not.toBeNull();
    (fire as unknown as () => void)();
    await expect(slow).resolves.toEqual(NO_VOLUME);
    const fast = await readBootVolumeWithin(
      () => Promise.resolve({ bootFlags: {}, recentBoots: [], volumeOk: true }),
      300,
      () => undefined,
    );
    expect(fast.volumeOk).toBe(true);
  });

  it('UI-058 a boot that reaches the login screen records loginAt, so it counts as healthy', async () => {
    const w = await bootWorld();
    worlds.push(w);
    await w.until(() => loginWaiting(w));
    await w.until(() => {
      let at: number | undefined;
      void w.store.scan<BootRecord>('bootlog', null, (r) => {
        at = r.loginAt;
      });
      return at !== undefined;
    });
    const rows: BootRecord[] = [];
    await w.store.scan<BootRecord>('bootlog', null, (r) => rows.push(r));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.outcome).toBe('incomplete');
    expect(recentBootsOf(rows)).toEqual([{ seq: 1, outcome: 'interactive' }]);
  });
});
