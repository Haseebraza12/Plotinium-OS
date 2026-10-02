/**
 * UI-006: ops of an OS session that ran OFFLINE (it never sent a `hello`, so the server never
 * registered it) are replayed under their own `osSessionId` (offline-and-sync.md §3.8.1). Step 1
 * of the op pipeline lets the uid's device claim such an unknown session instead of closing the
 * socket with 1008 for ever; an id of another uid or another device is still refused.
 */
import { describe, expect, it } from 'vitest';

import type { OsSessionStore } from './feed-reader.ts';
import { ownsOrClaims } from './feed-reader.ts';

function store(withClaim = true): OsSessionStore & {
  readonly rows: Map<string, { ownerUid: number; deviceId: string | null }>;
} {
  const rows = new Map<string, { ownerUid: number; deviceId: string | null }>();
  return {
    rows,
    register: (r) => {
      const e = rows.get(r.osSessionId);
      if (e !== undefined && e.ownerUid !== r.ownerUid) return Promise.resolve(false);
      rows.set(r.osSessionId, { ownerUid: r.ownerUid, deviceId: r.deviceId });
      return Promise.resolve(true);
    },
    owns: (id, uid, dev) => {
      const s = rows.get(id);
      return Promise.resolve(
        s !== undefined &&
          s.ownerUid === uid &&
          (dev === null || s.deviceId === null || s.deviceId === dev),
      );
    },
    ...(withClaim
      ? {
          claim: (r: { osSessionId: string; ownerUid: number; deviceId: string }) => {
            if (rows.has(r.osSessionId)) return Promise.resolve(false);
            rows.set(r.osSessionId, { ownerUid: r.ownerUid, deviceId: r.deviceId });
            return Promise.resolve(true);
          },
        }
      : {}),
  };
}

describe('UI-006 an offline OS session is claimed by its device on reconnect', () => {
  it('UI-006 an unknown session id is registered to the uid and device and accepted', async () => {
    const s = store();
    expect(await ownsOrClaims(s, 'os-offline', 1000, 'dev-a')).toBe(true);
    expect(s.rows.get('os-offline')).toEqual({ ownerUid: 1000, deviceId: 'dev-a' });
    // From then on it is simply owned.
    expect(await ownsOrClaims(s, 'os-offline', 1000, 'dev-a')).toBe(true);
  });

  it('UI-006 another uid’s session, another device’s session, or HTTP without a device: refused', async () => {
    const s = store();
    await s.register({
      osSessionId: 'os-bob',
      ownerUid: 1101,
      authSessionId: null,
      deviceId: 'dev-b',
      kernelEpoch: 1,
    });
    expect(await ownsOrClaims(s, 'os-bob', 1000, 'dev-a')).toBe(false);
    expect(await ownsOrClaims(s, 'os-bob', 1101, 'dev-a')).toBe(false);
    expect(await ownsOrClaims(s, 'os-new', 1000, null)).toBe(false);
    expect(s.rows.has('os-new')).toBe(false);
  });

  it('UI-006 a store without claim keeps the strict rule', async () => {
    expect(await ownsOrClaims(store(false), 'os-offline', 1000, 'dev-a')).toBe(false);
  });
});
