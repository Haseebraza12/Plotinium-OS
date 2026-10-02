import { describe, expect, it } from 'vitest';

import { SuGrants, type SuEndReason } from './su-grants.ts';

/** Manual timers: `fire()` runs every timer due at the current time. */
function harness() {
  const t = { now: 1_000 };
  const timers: { at: number; fn: () => void; cleared: boolean; unref: () => undefined }[] = [];
  const ended: [string, number, SuEndReason][] = [];
  const grants = new SuGrants({
    now: () => t.now,
    onEnded: (s, uid, reason) => ended.push([s, uid, reason]),
    setTimer: (fn, ms) => {
      const timer = { at: t.now + ms, fn, cleared: false, unref: () => undefined };
      timers.push(timer);
      return timer;
    },
    clearTimer: (h) => {
      (h as { cleared: boolean }).cleared = true;
    },
  });
  const fire = () => {
    for (const timer of [...timers])
      if (!timer.cleared && timer.at <= t.now) {
        timer.cleared = true;
        timer.fn();
      }
  };
  return { t, grants, ended, fire };
}

const grant = (uid: number, expiresAt: number, gids: number[] = [uid]) => ({
  uid,
  expiresAt: new Date(expiresAt),
  gids,
});

describe('SRV-19 the live su grants the sockets see (backend-api.md §3.8.6, §3.17)', () => {
  it('SRV-19 a grant is visible until it expires, then SIGHUP su-expired fires once', () => {
    const { t, grants, ended, fire } = harness();
    grants.set('s1', grant(0, 61_000, [0, 10]));
    expect(grants.grantsOf('s1')).toEqual([{ uid: 0, expiresAt: new Date(61_000) }]);
    expect(grants.gidsOf('s1', 0)).toEqual([0, 10]);
    expect(grants.gidsOf('s1', 1002)).toBeUndefined();
    expect(grants.size).toBe(1);
    t.now = 61_000;
    fire();
    expect(ended).toEqual([['s1', 0, 'su-expired']]);
    expect(grants.grantsOf('s1')).toEqual([]);
    fire();
    expect(ended).toHaveLength(1);
  });

  it('SRV-19 revoking signals su-revoked; replacing a grant ends the previous uid; forgetting is silent', () => {
    const { grants, ended } = harness();
    grants.set('s1', grant(0, 100_000));
    grants.set('s1', grant(1002, 100_000));
    expect(ended).toEqual([['s1', 0, 'su-revoked']]);
    grants.revoke('s1', 1002);
    expect(ended).toEqual([
      ['s1', 0, 'su-revoked'],
      ['s1', 1002, 'su-revoked'],
    ]);
    // A revoke for a grant the process never saw still reaches the sockets.
    grants.revoke('s2', 0);
    expect(ended.at(-1)).toEqual(['s2', 0, 'su-revoked']);
    grants.set('s3', grant(0, 100_000));
    grants.forget(['s3', 'unknown']);
    expect(grants.grantsOf('s3')).toEqual([]);
    expect(ended).toHaveLength(3);
  });

  it('SRV-19 seeding from the cookie session never overrides a newer in-process grant, and an expired grant is ignored', () => {
    const { grants } = harness();
    grants.seed('s1', grant(0, 50_000));
    grants.seed('s1', grant(1002, 90_000));
    expect(grants.grantsOf('s1')[0]?.uid).toBe(0);
    grants.seed('s2', null);
    grants.set('s3', grant(0, 500)); // already expired at now = 1000
    expect(grants.grantsOf('s3')).toEqual([]);
    grants.stop();
    expect(grants.size).toBe(0);
  });
});
