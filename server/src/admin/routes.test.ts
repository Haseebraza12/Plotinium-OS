import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { INO, type OpSubmit } from '@plotinium/protocol';

import { pluginApp } from '../../tests/plugin-app.ts';
import {
  ARM_TTL_MS,
  defaultCounter,
  FaultArming,
  type ArmRecord,
  type FaultEvent,
} from './faults.ts';
import type { AdminDb, Probes } from './probes.ts';
import { adminPlugin } from './routes.ts';

const OS_ALICE = '0192f2a0-0000-7000-8000-0000000000a1';
const OS_BOB = '0192f2a0-0000-7000-8000-0000000000b1';
/** alice (1001) under su to root. */
const ROOT_ALICE = { 'x-test-uid': '1001', 'x-test-principal': '0' };

class FakeAdminDb implements AdminDb {
  readonly audits: { syscall: string; detail: Readonly<Record<string, unknown>> }[] = [];
  osSessionOwner(osSessionId: string): Promise<number | null> {
    return Promise.resolve(osSessionId === OS_ALICE ? 1001 : osSessionId === OS_BOB ? 1002 : null);
  }
  probes(root: string): Promise<Probes | null> {
    if (root !== INO.ROOT) return Promise.resolve(null);
    return Promise.resolve({
      rootIno: root,
      checksum: 'c'.repeat(64),
      orphanInodes: 0,
      danglingEntries: 0,
      quotaDrift: [],
      refcountDrift: [],
      violations: [],
    });
  }
  audit(e: { syscall: string; detail: Readonly<Record<string, unknown>> }): Promise<void> {
    this.audits.push({ syscall: e.syscall, detail: e.detail });
    return Promise.resolve();
  }
}

const apps: FastifyInstance[] = [];
afterEach(async () => {
  while (apps.length > 0) await apps.pop()?.close();
});

async function make(faultInjection: boolean, t = { now: 1_000_000 }) {
  const db = new FakeAdminDb();
  const events: [FaultEvent, ArmRecord][] = [];
  const faults = new FaultArming({ now: () => t.now, audit: (e, a) => events.push([e, a]) });
  const app = await pluginApp((a) => adminPlugin(a, { faultInjection, faults, db }));
  apps.push(app);
  return { app, db, faults, events, t };
}

const submitOf = (kind: 'unlink' | 'rename' | 'chmod', osSessionId = OS_ALICE): OpSubmit =>
  ({
    opId: '0192f2a0-0000-7000-8000-000000000001',
    osSessionId,
    cseq: 1,
    lamport: 1,
    principal: 1001,
    clientTime: new Date(0).toISOString(),
    op:
      kind === 'unlink'
        ? { kind, parentIno: INO.ROOT, name: 'x', ino: INO.ROOT, recursive: true }
        : kind === 'rename'
          ? {
              kind,
              ino: INO.ROOT,
              fromParentIno: INO.ROOT,
              fromName: 'a',
              toParentIno: INO.ROOT,
              toName: 'b',
            }
          : { kind, ino: INO.ROOT, change: { absolute: 0o644 }, recursive: false },
    base: { kind: 'versions', entries: [] },
  }) satisfies OpSubmit;

describe('DB-02 SRV-14 the fault-injection harness (backend-api.md §3.15)', () => {
  it('DB-02 an arm is one-shot, scoped to its OS session and op kind, and becomes the vfsTxn fault', async () => {
    const { app, faults, events } = await make(true);
    const arm = await app.inject({
      method: 'POST',
      url: '/api/debug/fault',
      headers: { ...ROOT_ALICE, 'x-plotinium-os-session': OS_ALICE },
      payload: { op: 'unlink', target: 'server', failAtNode: 500 },
    });
    expect(arm.statusCode, arm.body).toBe(200);
    expect(arm.json()).toMatchObject({ armed: true, osSessionId: OS_ALICE });

    expect(faults.take(submitOf('unlink', OS_BOB))).toBeUndefined(); // another OS session
    expect(faults.take(submitOf('chmod'))).toBeUndefined(); // another op kind
    expect(faults.take(submitOf('unlink'))).toEqual({ after: 499, on: 'inodes' });
    expect(faults.take(submitOf('unlink'))).toBeUndefined(); // consumed
    expect(events.map(([e]) => e)).toEqual(['arm', 'fire']);
  });

  it('DB-02 list and disarm are per OS session; a foreign OS session is 403 and the header is required', async () => {
    const { app } = await make(true);
    const headers = { ...ROOT_ALICE, 'x-plotinium-os-session': OS_ALICE };
    await app.inject({
      method: 'POST',
      url: '/api/debug/fault',
      headers,
      payload: { op: 'batch', target: 'both', delayMs: 100 },
    });
    const listed = await app.inject({ method: 'GET', url: '/api/debug/fault', headers });
    expect(listed.json<{ armed: ArmRecord[] }>().armed).toMatchObject([
      { op: 'batch', delayMs: 100 },
    ]);
    const all = await app.inject({ method: 'GET', url: '/api/debug/fault', headers: ROOT_ALICE });
    expect(all.json<{ armed: unknown[] }>().armed).toHaveLength(1);
    expect(
      (await app.inject({ method: 'DELETE', url: '/api/debug/fault', headers })).statusCode,
    ).toBe(204);
    expect(
      (await app.inject({ method: 'GET', url: '/api/debug/fault', headers })).json<{
        armed: unknown[];
      }>().armed,
    ).toEqual([]);

    const foreign = await app.inject({
      method: 'POST',
      url: '/api/debug/fault',
      headers: { ...ROOT_ALICE, 'x-plotinium-os-session': OS_BOB },
      payload: { op: 'unlink', target: 'server', failAtNode: 1 },
    });
    expect(foreign.statusCode).toBe(403);
    expect(foreign.json()).toMatchObject({ errno: 'EACCES', reason: 'principal' });
    const missing = await app.inject({
      method: 'POST',
      url: '/api/debug/fault',
      headers: ROOT_ALICE,
      payload: { op: 'unlink', target: 'server', failAtNode: 1 },
    });
    expect(missing.statusCode).toBe(400);
    const noNode = await app.inject({
      method: 'POST',
      url: '/api/debug/fault',
      headers,
      payload: { op: 'unlink', target: 'server' },
    });
    expect(noNode.statusCode).toBe(400);
  });

  it('SRV-14 the harness is root only, and absent (404) without FAULT_INJECTION', async () => {
    const on = await make(true);
    const user = await on.app.inject({
      method: 'GET',
      url: '/api/debug/fault',
      headers: { 'x-test-uid': '1001' },
    });
    expect(user.statusCode).toBe(403);
    const off = await make(false);
    expect(
      (await off.app.inject({ method: 'GET', url: '/api/debug/fault', headers: ROOT_ALICE }))
        .statusCode,
    ).toBe(404);
  });

  it('DB-02 arms expire after 5 minutes and every arm, replacement and expiry is audited', () => {
    const t = { now: 0 };
    const events: FaultEvent[] = [];
    const f = new FaultArming({ now: () => t.now, audit: (e) => events.push(e) });
    f.arm(OS_ALICE, 1001, { op: 'rename', target: 'server', failAtNode: 3 });
    f.arm(OS_ALICE, 1001, { op: 'rename', target: 'client', failAtNode: 3 });
    expect(f.take(submitOf('rename'))).toBeUndefined(); // a client arm is consumed, nothing more
    f.arm(OS_ALICE, 1001, { op: 'chmod', target: 'server', failAtNode: 2, on: 'dentries' });
    t.now = ARM_TTL_MS + 1;
    expect(f.list(undefined)).toEqual([]);
    expect(f.disarm(OS_ALICE)).toBe(false);
    expect(events).toEqual(['arm', 'disarm', 'arm', 'fire', 'arm', 'expire']);
    expect(defaultCounter('rename')).toBe('dentries');
    expect(defaultCounter('unlink')).toBe('inodes');
  });

  it('DB-02 /api/admin/probes runs the integrity probes as root and audits the run', async () => {
    const { app, db } = await make(false);
    const res = await app.inject({ method: 'GET', url: '/api/admin/probes', headers: ROOT_ALICE });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ rootIno: INO.ROOT, violations: [] });
    expect(db.audits).toMatchObject([{ syscall: 'admin.probe', detail: { violations: 0 } }]);
    const missing = await app.inject({
      method: 'GET',
      url: '/api/admin/probes?root=0192f2a0-0000-7000-8000-00000000dead',
      headers: ROOT_ALICE,
    });
    expect(missing.statusCode).toBe(404);
  });
});
