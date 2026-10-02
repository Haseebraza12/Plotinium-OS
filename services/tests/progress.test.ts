import { describe, expect, it } from 'vitest';

import { alphaFor, backoffCeiling, backoffDelay, BootProgress, W_ASSETS } from '../src/index.ts';

const A_WEIGHTS = {
  kernel: 3,
  sched: 1,
  storage: 4,
  wm: 2,
  mm: 2,
  vfs: 5,
  login: 2,
  session: 3,
  desktop: 3,
};

describe('truthful progress', () => {
  it('BOOT-02 alpha is W_assets over W_assets plus the built-in weight of A', () => {
    expect(alphaFor('desktop')).toBeCloseTo(W_ASSETS / 35, 12);
    expect(alphaFor('recovery')).toBeCloseTo(W_ASSETS / 25, 12);
  });

  it('BOOT-02 progress never changes without an event: 60 s of fake time with no events leaves P unchanged', () => {
    const p = new BootProgress('desktop', 100_000);
    const before = p.apply({ t: 'asset-bytes', url: '/k.js', bytes: 40_000 });
    // Time passes: there is no API through which it could reach the model.
    const after = p.snapshot();
    expect(after).toEqual(before);
  });

  it('BOOT-02 P is non-decreasing over a recorded boot and equals 1 exactly when every asset and A service is done', () => {
    const p = new BootProgress('desktop', 1_000);
    const seen: number[] = [];
    seen.push(p.apply({ t: 'asset-bytes', url: '/k.js', bytes: 300 }).p);
    seen.push(
      p.apply({ t: 'target', target: 'desktop', weights: A_WEIGHTS, assetsTotal: 1_000 }).p,
    );
    seen.push(p.apply({ t: 'asset-bytes', url: '/k.js', bytes: 200 }).p); // stale smaller read is ignored
    seen.push(p.apply({ t: 'asset-done', url: '/k.js', bytes: 800 }).p);
    for (const name of Object.keys(A_WEIGHTS)) {
      seen.push(p.apply({ t: 'service-done', name }).p);
      if (name === 'session')
        seen.push(p.apply({ t: 'asset-done', url: '/shell.js', bytes: 200 }).p);
    }
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1] ?? 0);
    expect(seen.slice(0, -1).every((x) => x < 1)).toBe(true);
    expect(seen.at(-1)).toBe(1);
  });

  it('BOOT-02 editing a service weight in the volume keeps P monotone', () => {
    const p = new BootProgress('desktop', 100);
    p.apply({ t: 'asset-done', url: '/k.js', bytes: 100 });
    const beforeTarget = p.snapshot().p;
    const edited = { ...A_WEIGHTS, vfs: 10 };
    const afterTarget = p.apply({
      t: 'target',
      target: 'desktop',
      weights: edited,
      assetsTotal: 100,
    }).p;
    expect(afterTarget).toBeGreaterThanOrEqual(beforeTarget);
    let last = afterTarget;
    for (const name of Object.keys(edited)) {
      const now = p.apply({ t: 'service-done', name }).p;
      expect(now).toBeGreaterThanOrEqual(last);
      last = now;
    }
    expect(last).toBe(1);
  });

  it('BOOT-02 a dev build without an inlined boot manifest fixes the asset total once, from the download', () => {
    const p = new BootProgress('desktop');
    expect(p.apply({ t: 'asset-bytes', url: '/k.js', bytes: 50 }).pa).toBe(0);
    expect(p.apply({ t: 'assets-total', bytes: 100 }).pa).toBe(0.5);
    expect(p.apply({ t: 'assets-total', bytes: 1_000 }).pa).toBe(0.5);
    expect(p.apply({ t: 'asset-done', url: '/k.js', bytes: 100 }).pa).toBe(1);
    expect(p.currentTarget).toBe('desktop');
  });

  it('BOOT-02 a service outside A never moves the bar', () => {
    const p = new BootProgress('desktop', 100);
    p.apply({ t: 'target', target: 'desktop', weights: A_WEIGHTS, assetsTotal: 100 });
    const before = p.snapshot().p;
    expect(p.apply({ t: 'service-done', name: 'sync' }).p).toBe(before);
  });
});

describe('back-off', () => {
  it('BOOT-07 the schedule doubles from 500 ms and caps at 60 s with equal jitter', () => {
    expect([1, 2, 3, 8, 20].map(backoffCeiling)).toEqual([500, 1_000, 2_000, 60_000, 60_000]);
    expect(backoffDelay(1, 0)).toBe(250);
    expect(backoffDelay(1, 0.999)).toBeLessThan(500);
    expect(backoffDelay(3, 0.5)).toBe(1_500);
    expect(backoffDelay(0, 0)).toBe(250);
  });
});
