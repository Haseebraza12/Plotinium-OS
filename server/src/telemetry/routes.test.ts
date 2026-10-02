import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { TelemetryEvent } from '@plotinium/protocol';

import { pluginApp } from '../../tests/plugin-app.ts';
import { telemetryPlugin } from './routes.ts';
import { eventId, type Consent, type StoredEvents, type TelemetryStore } from './store.ts';

const ALICE = { 'x-test-uid': '1001' };
const BOB = { 'x-test-uid': '1002' };
const OS = '0192f2a0-0000-7000-8000-0000000000a1';

/** The TelemetryStore contract in memory: opt-in gates every read and write, opt-out deletes. */
class MemoryTelemetryStore implements TelemetryStore {
  readonly optIn = new Map<number, string>();
  readonly events = new Map<number, Map<string, TelemetryEvent>>();

  consent(uid: number): Promise<Consent | null> {
    const since = this.optIn.get(uid);
    return Promise.resolve(since === undefined ? { optIn: false } : { optIn: true, since });
  }
  setConsent(uid: number, optIn: boolean): Promise<Consent> {
    if (optIn) this.optIn.set(uid, this.optIn.get(uid) ?? new Date(0).toISOString());
    else {
      this.optIn.delete(uid);
      this.events.delete(uid);
    }
    return this.consent(uid) as Promise<Consent>;
  }
  insert(uid: number, events: readonly TelemetryEvent[]) {
    if (!this.optIn.has(uid)) return Promise.resolve(null);
    const mine = this.events.get(uid) ?? new Map<string, TelemetryEvent>();
    this.events.set(uid, mine);
    let accepted = 0;
    for (const e of events) {
      const id = eventId(uid, e);
      if (mine.has(id)) continue;
      mine.set(id, e);
      accepted++;
    }
    return Promise.resolve({ accepted, duplicates: events.length - accepted });
  }
  list(uid: number, _after: string | null, limit: number): Promise<StoredEvents | null> {
    if (!this.optIn.has(uid)) return Promise.resolve(null);
    return Promise.resolve({ events: [...(this.events.get(uid)?.values() ?? [])].slice(0, limit) });
  }
  deleteAll(uid: number): Promise<number> {
    const n = this.events.get(uid)?.size ?? 0;
    this.events.delete(uid);
    return Promise.resolve(n);
  }
  sweepRetention(): Promise<number> {
    return Promise.resolve(0);
  }
}

const event = (seq: number): TelemetryEvent => ({
  v: 1,
  seq,
  ts: 1_790_000_000_000 + seq,
  tzOffsetMin: 300,
  kind: 'launch',
  app: 'terminal',
  prev: null,
  hourBucket: 2,
  dow: 3,
  weekend: false,
  sessionPos: seq,
  origin: 'user',
  osSessionId: OS,
});

let app: FastifyInstance;
let store: MemoryTelemetryStore;

beforeEach(async () => {
  store = new MemoryTelemetryStore();
  app = await pluginApp((a) => telemetryPlugin(a, { store }));
});
afterEach(async () => {
  await app.close();
});

describe('PRE-05 /api/telemetry is opt-in and keyed by the login uid (backend-api.md §3.14)', () => {
  it('PRE-05 uploads are refused with 403 EPERM opt-in until consent, then deduplicated, listed and deleted', async () => {
    const upload = (headers = ALICE, events = [event(1), event(2)]) =>
      app.inject({ method: 'POST', url: '/api/telemetry', headers, payload: { events } });
    const refused = await upload();
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ errno: 'EPERM', reason: 'opt-in' });
    expect(
      (await app.inject({ method: 'GET', url: '/api/telemetry', headers: ALICE })).statusCode,
    ).toBe(403);

    const consent = await app.inject({
      method: 'PUT',
      url: '/api/telemetry/consent',
      headers: ALICE,
      payload: { optIn: true },
    });
    expect(consent.json()).toMatchObject({ optIn: true });
    expect(
      (await app.inject({ method: 'GET', url: '/api/telemetry/consent', headers: ALICE })).json(),
    ).toMatchObject({
      optIn: true,
    });

    const first = await upload();
    expect(first.statusCode).toBe(202);
    expect(first.json()).toEqual({ accepted: 2, duplicates: 0 });
    expect((await upload()).json()).toEqual({ accepted: 0, duplicates: 2 });
    const list = await app.inject({ method: 'GET', url: '/api/telemetry?limit=1', headers: ALICE });
    expect(list.json<{ events: unknown[] }>().events).toHaveLength(1);
    // bob never sees alice's events and is not opted in himself
    expect(
      (await app.inject({ method: 'GET', url: '/api/telemetry', headers: BOB })).statusCode,
    ).toBe(403);

    expect(
      (await app.inject({ method: 'DELETE', url: '/api/telemetry', headers: ALICE })).statusCode,
    ).toBe(204);
    expect(store.events.get(1001)).toBeUndefined();
    const out = await app.inject({
      method: 'PUT',
      url: '/api/telemetry/consent',
      headers: ALICE,
      payload: { optIn: false },
    });
    expect(out.json()).toEqual({ optIn: false });
  });

  it('SRV-05 an event that fails the protocol schema, an empty batch and an unknown key are 400 EINVAL', async () => {
    await store.setConsent(1001, true);
    for (const payload of [
      { events: [] },
      { events: [{ ...event(1), app: 'Not An App' }] },
      { events: [event(1)], extra: true },
    ]) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/telemetry',
        headers: ALICE,
        payload,
      });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(res.json()).toMatchObject({ errno: 'EINVAL' });
    }
    expect((await app.inject({ method: 'GET', url: '/api/telemetry/consent' })).statusCode).toBe(
      401,
    );
  });

  it('SRV-04 without a database every telemetry route answers 503 EIO server', async () => {
    const none = await pluginApp((a) => telemetryPlugin(a, { store: null }));
    const res = await none.inject({ method: 'GET', url: '/api/telemetry/consent', headers: ALICE });
    expect(res.statusCode).toBe(503);
    await none.close();
  });
});
