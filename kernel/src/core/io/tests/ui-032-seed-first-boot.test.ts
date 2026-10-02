/**
 * UI-032: on a slow network the first boot's mkfs does not wait for the host's seed files (the
 * branding) beyond SEED_FETCH_FIRST_MS, so the critical `vfs` start never times out on them.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { SEED_FETCH_FIRST_MS } from '../vfs.ts';
import type { World } from './world.ts';
import { bootWorld } from './world.ts';

const worlds: World[] = [];
afterEach(() => {
  for (const w of worlds.splice(0)) w.close();
});

describe('UI-032 first-boot seed fetch is bounded', () => {
  it('UI-032 a seed fetch that never answers: vfs mounts after the cap and logs why', async () => {
    const w = await bootWorld({ io: { seed: () => new Promise(() => undefined) } });
    worlds.push(w);
    await w.until(() => w.stateOf('vfs') === 'running', SEED_FETCH_FIRST_MS + 2_000);
    expect(w.clock.now()).toBeGreaterThanOrEqual(SEED_FETCH_FIRST_MS);
    const lines = w.lb.kernel.klog.read().map((r) => JSON.stringify(r));
    expect(lines.some((l) => l.includes('formatting without them'))).toBe(true);
    expect(w.panics).toEqual([]);
  });
});
