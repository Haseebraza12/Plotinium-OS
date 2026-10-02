import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { perPeriod, take, type Bucket } from './bucket.ts';
import { LOCAL_GUEST_PER_HOUR, RATE_CLASSES, rateOverridesFor } from './classes.ts';
import { RateLimiter } from './limiter.ts';
import { InsertionOrderKeyStore } from './store.ts';

describe('SRV-09 token bucket (backend-api.md §3.9, §5.2)', () => {
  it('SRV-09 the token bucket never allows more than capacity plus rate times T calls in any window of length T', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 20 }),
        fc.integer({ min: 1, max: 50 }),
        fc.array(fc.integer({ min: 0, max: 200 }), { minLength: 1, maxLength: 200 }),
        (capacity, perSecond, gaps) => {
          const spec = perPeriod(perSecond, 1000, capacity);
          const store = new InsertionOrderKeyStore<Bucket>(10);
          let now = 0;
          const allowed: number[] = [];
          for (const gap of gaps) {
            now += gap;
            if (take(store, 'k', spec, 1, now).ok) allowed.push(now);
          }
          // every window [t0, t1] admits at most capacity + rate * (t1 - t0) calls
          for (let i = 0; i < allowed.length; i++) {
            for (let j = i; j < allowed.length; j++) {
              const window = (allowed[j] ?? 0) - (allowed[i] ?? 0);
              expect(j - i + 1).toBeLessThanOrEqual(capacity + spec.ratePerMs * window + 1e-9);
            }
          }
        },
      ),
      { numRuns: 100, seed: 42 },
    );
  });

  it('SRV-09 a denied call reports how long until enough tokens exist, and a key that waits capacity / rate is full again', () => {
    const spec = perPeriod(1, 1000, 3);
    const store = new InsertionOrderKeyStore<Bucket>(10);
    for (let i = 0; i < 3; i++) expect(take(store, 'ip', spec, 1, 0).ok).toBe(true);
    const denied = take(store, 'ip', spec, 1, 0);
    expect(denied).toEqual({ ok: false, retryAfterMs: 1000 });
    for (let i = 0; i < 3; i++) expect(take(store, 'ip', spec, 1, 3000).ok).toBe(true);
    expect(take(store, 'ip', spec, 1, 3000).ok).toBe(false);
  });

  it('SRV-09 a clock that goes backwards never mints tokens', () => {
    const spec = perPeriod(1, 1000, 1);
    const store = new InsertionOrderKeyStore<Bucket>(10);
    expect(take(store, 'k', spec, 1, 10_000).ok).toBe(true);
    expect(take(store, 'k', spec, 1, 0).ok).toBe(false);
  });

  it('SRV-09 the rate-limit key store stays at its capacity under a flood of distinct keys', () => {
    const store = new InsertionOrderKeyStore<number>(3);
    expect(store.put('a', 1)).toBeUndefined();
    store.put('b', 2);
    store.put('c', 3);
    expect(store.put('a', 10)).toBeUndefined(); // an update never evicts
    expect(store.put('d', 4)).toEqual(['a', 10]); // the oldest-inserted key goes first
    expect([store.get('a'), store.get('b'), store.get('d')]).toEqual([undefined, 2, 4]);
    for (let i = 0; i < 10_000; i++) store.put(`ip-${i}`, i);
    expect(store.size).toBe(3);
    expect(store.capacity).toBe(3);
    expect(store.evictions).toBeGreaterThanOrEqual(10_000);
    expect(store.delete('ip-9999')).toBe(true);
    expect(store.delete('ip-9999')).toBe(false);
    expect(() => new InsertionOrderKeyStore(0)).toThrow(RangeError);
  });

  it('SRV-09 the global login bucket still holds when a flood of distinct IPs evicts keyed buckets', () => {
    const now = 0;
    const limiter = new RateLimiter({ now: () => now, keysPerClass: 50 });
    let allowed = 0;
    for (let i = 0; i < 1000; i++)
      if (limiter.take('login-ip', `10.0.${i >> 8}.${i & 255}`).ok) allowed++;
    expect(allowed).toBe(RATE_CLASSES['login-ip'].global.capacity);
    expect(limiter.keysIn('login-ip')).toBeLessThanOrEqual(50);
  });

  it('SRV-09 denials are counted per class', () => {
    const denied: string[] = [];
    const limiter = new RateLimiter({ now: () => 0, onDenied: (c) => denied.push(c) });
    const cap = RATE_CLASSES.health.spec.capacity;
    for (let i = 0; i < cap + 2; i++) limiter.take('health', '203.0.113.9');
    expect(denied).toEqual(['health', 'health']);
  });
});

describe('UI-005 profile-aware guest limit (backend-api.md §3.9, BOOT-14)', () => {
  const HOUR = 3_600_000;
  const guests = (limiter: RateLimiter, n: number): boolean[] =>
    Array.from({ length: n }, () => limiter.take('guest-ip', '172.30.47.1').ok);

  it('UI-005 production keeps guest-ip at 3 per hour per IP and asks for a 20-minute wait', () => {
    expect(rateOverridesFor('production')).toEqual({});
    const limiter = new RateLimiter({ now: () => 0, overrides: rateOverridesFor('production') });
    expect(guests(limiter, 3)).toEqual([true, true, true]);
    expect(limiter.take('guest-ip', '172.30.47.1')).toEqual({ ok: false, retryAfterMs: HOUR / 3 });
    // Another IP has its own bucket.
    expect(limiter.take('guest-ip', '203.0.113.7').ok).toBe(true);
    expect(limiter.classOf('guest-ip').spec).toEqual(RATE_CLASSES['guest-ip'].spec);
  });

  it('UI-005 local and ci allow 60 guest sign-ins per hour per IP; every other class is unchanged', () => {
    expect(LOCAL_GUEST_PER_HOUR).toBe(60);
    for (const env of ['local', 'ci'] as const) {
      const overrides = rateOverridesFor(env);
      expect(Object.keys(overrides)).toEqual(['guest-ip']);
      const limiter = new RateLimiter({ now: () => 0, overrides });
      expect(guests(limiter, 60).every(Boolean)).toBe(true);
      expect(limiter.take('guest-ip', '172.30.47.1')).toEqual({
        ok: false,
        retryAfterMs: HOUR / 60,
      });
      expect(limiter.classOf('guest-ip').key).toBe('ip');
      expect(limiter.classOf('login-user')).toEqual(RATE_CLASSES['login-user']);
      expect(limiter.classOf('login-ip')).toEqual(RATE_CLASSES['login-ip']);
    }
  });
});
