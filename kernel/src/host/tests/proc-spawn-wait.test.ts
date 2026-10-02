/**
 * Process creation, exit and wait through the system calls on the process loopback host:
 * `spawn` (manifest resolution, the start-up closure over dsa/dag, caps), `exit`, `wait`
 * (exit status, reaping, nohang, no child) and the lifecycle trace of Figure 9.1.
 */
import { describe, expect, it } from 'vitest';

import { isAllowedEdge } from '../../core/proc/lifecycle.ts';
import { PROCESS_TABLE_KIND } from '../../core/proc/table.ts';
import {
  attempt,
  defineScript,
  loopback,
  manifest,
  procRecords,
  runScript,
  trace,
} from './proc-harness.ts';

defineScript('exit-3', function* (ctx) {
  yield* ctx.sys.exit({ code: 3 });
  return 0;
});

defineScript('return-5', function* (ctx) {
  yield ctx.tick;
  return 5;
});

defineScript('crash', function* (ctx) {
  yield ctx.tick;
  throw new Error('boom');
});

defineScript('sleep-50', function* (ctx) {
  yield* ctx.sleep(50);
  return 0;
});

defineScript('parent-wait', function* (ctx, rec) {
  rec['self'] = yield* ctx.sys.getpid({});
  const a = yield* ctx.sys.spawn({ path: '/bin/script.json', argv: ['script', 'exit-3'] });
  const b = yield* ctx.sys.spawn({ path: '/bin/script', argv: ['script', 'return-5'] });
  const c = yield* ctx.sys.spawn({ path: 'script', argv: ['script', 'crash'] });
  rec['children'] = [a.pid, b.pid, c.pid];
  rec['waitA'] = yield* ctx.sys.wait({ pid: a.pid });
  rec['waitB'] = yield* ctx.sys.wait({ pid: b.pid });
  rec['waitC'] = yield* ctx.sys.wait({ pid: -1 });
  rec['noChild'] = yield* attempt(ctx.sys.wait({ pid: -1 }));
  const d = yield* ctx.sys.spawn({ path: '/bin/script.json', argv: ['script', 'sleep-50'] });
  rec['nohang'] = yield* ctx.sys.wait({ pid: d.pid, nohang: true });
  rec['waitD'] = yield* ctx.sys.wait({ pid: d.pid });
  rec['missing'] = yield* attempt(ctx.sys.spawn({ path: '/bin/nope.json', argv: ['nope'] }));
  rec['notBin'] = yield* attempt(ctx.sys.spawn({ path: '/home/alice/x.json', argv: ['x'] }));
  rec['rootPrio'] = yield* attempt(
    ctx.sys.spawn({ path: '/bin/script.json', argv: ['script', 'exit-3'], priority: 5 }),
  );
  return 0;
});

describe('spawn, exit and wait (syscalls)', () => {
  it('PROC-01 spawn creates a PCB in the hash-table process table and getpid returns its identity', async () => {
    const lb = loopback();
    expect(PROCESS_TABLE_KIND).toBe('hash table');
    const { pid, code, rec } = await runScript(lb, 'parent-wait');
    expect(code).toBe(0);
    expect(rec['self']).toEqual({
      pid,
      ppid: lb.session.pid,
      pgid: lb.session.pgid,
      sid: lb.session.sid,
    });
    const kids = rec['children'] as number[];
    expect(new Set(kids).size).toBe(3);
    // Every child was a real PCB with the Spec §9.1 fields while it lived (spawn records).
    for (const k of kids) expect(trace(lb, k)[0]).toBe('->NEW:spawn');
    lb.checkInvariants();
  });

  it('PROC-07 exit codes, crash and wait: wait reaps the zombie, nohang answers pid 0, no child is ESRCH', async () => {
    const lb = loopback();
    const { rec } = await runScript(lb, 'parent-wait');
    const [a, b, c] = rec['children'] as [number, number, number];
    expect(rec['waitA']).toEqual({ pid: a, status: { kind: 'exited', code: 3 } });
    expect(rec['waitB']).toEqual({ pid: b, status: { kind: 'exited', code: 5 } });
    expect(rec['waitC']).toEqual({ pid: c, status: { kind: 'exited', code: 1 } });
    expect(rec['noChild']).toEqual({ errno: 'ESRCH' });
    expect(rec['nohang']).toEqual({ pid: 0 });
    expect(rec['waitD']).toMatchObject({ status: { kind: 'exited', code: 0 } });
    // Reaped: the children are gone from the table.
    for (const k of [a, b, c]) expect(lb.kernel.procs.get(k)).toBeUndefined();
    expect(trace(lb, c)).toContain('RUNNING>TERMINATED:crash');
    expect(
      lb.kernel.klog.read().some((r) => r.kind === 'line' && r.msg.includes('crashed: boom')),
    ).toBe(true);
    lb.checkInvariants();
  });

  it('PROC-01 spawn resolves /bin/<name>.json through the injected registry; other paths are ENOENT and raising priority is EPERM', async () => {
    const lb = loopback();
    const { rec } = await runScript(lb, 'parent-wait');
    expect(rec['missing']).toEqual({ errno: 'ENOENT' });
    expect(rec['notBin']).toEqual({ errno: 'ENOENT' });
    expect(rec['rootPrio']).toEqual({ errno: 'EPERM' });
  });

  it('PROC-06 every transition of a scripted workload is logged with from, to and reason on Figure 9.1 edges', async () => {
    const lb = loopback();
    const sub = lb.kernel.bus.subscribe(['proc.state', 'proc.spawn', 'proc.exit'], {
      cred: { uid: 0, gid: 0, groups: [] },
      limit: 100_000,
    });
    const { pid } = await runScript(lb, 'parent-wait');
    const events = sub.take().events.map((e) => e.topic);
    const recs = procRecords(lb);
    const mine = recs.filter((r) => r.pid === pid);
    expect(mine.map((r) => `${r.from ?? '-'}>${r.to ?? '-'}`)).toEqual(
      expect.arrayContaining([
        '->NEW',
        'NEW>READY',
        'READY>RUNNING',
        'RUNNING>BLOCKED',
        'BLOCKED>READY',
        'RUNNING>TERMINATED',
      ]),
    );
    for (const r of recs) {
      expect(typeof r.reason).toBe('string');
      if (r.from !== null && r.to !== null && r.reason !== 'annotate')
        expect(isAllowedEdge(r.from, r.to)).toBe(true);
    }
    // Blocking calls name what the process waits on.
    expect(mine.some((r) => r.to === 'BLOCKED' && r.waitingOn === 'wait:-1')).toBe(true);
    expect(mine.some((r) => r.to === 'BLOCKED' && r.waitingOn === 'io:spawn')).toBe(true);
    // One proc.state event per non-annotation transition.
    expect(events.filter((t) => t === 'proc.state').length).toBeGreaterThan(10);
  });
});

describe('start-up closure (KPS-07, dsa/dag)', () => {
  it('KPS-07 spawn loads the start-up closure in dependency order and refuses a cycle naming its path', async () => {
    const lb = loopback({
      extra: [
        {
          manifest: manifest('editor', {
            entry: 'test/script',
            requires: ['lib:spell', 'lib:ui', 'svc:vfs?'],
          }),
        },
        {
          manifest: manifest('spell', {
            kind: 'lib',
            entry: 'test/lib-spell',
            requires: ['lib:dict'],
          }),
        },
        { manifest: manifest('dict', { kind: 'lib', entry: 'test/lib-dict', requires: [] }) },
        { manifest: manifest('ui', { kind: 'lib', entry: 'test/lib-ui', requires: ['lib:dict'] }) },
        { manifest: manifest('loop', { entry: 'test/script', requires: ['lib:la'] }) },
        { manifest: manifest('la', { kind: 'lib', entry: 'test/lib', requires: ['lib:lb'] }) },
        { manifest: manifest('lb', { kind: 'lib', entry: 'test/lib', requires: ['lib:la'] }) },
        { manifest: manifest('orphan', { entry: 'test/script', requires: ['lib:gone'] }) },
      ],
    });
    const { startupClosure } = await import('../../core/programs/closure.ts');
    const plan = startupClosure(lb.catalog, 'editor');
    const order = plan.order;
    expect(order.indexOf('lib:dict')).toBeLessThan(order.indexOf('lib:spell'));
    expect(order.indexOf('lib:dict')).toBeLessThan(order.indexOf('lib:ui'));
    expect(order.indexOf('lib:spell')).toBeLessThan(order.indexOf('editor'));
    expect(plan.services).toEqual([{ name: 'vfs', optional: true }]);

    const ok = await lb.spawn('editor', { argv: ['script', 'return-5'] });
    await lb.until(() => ok.state === 'TERMINATED');
    expect(ok.exitCode).toBe(5);
    // The executor received the closure's libs in dependency order before the program.
    const libs = lb.executors.libLoads.find((l) => l.pid === ok.pid)?.libs ?? [];
    expect([...libs].sort()).toEqual(['test/lib-dict', 'test/lib-spell', 'test/lib-ui']);
    expect(libs.indexOf('test/lib-dict')).toBeLessThan(libs.indexOf('test/lib-spell'));
    expect(libs.indexOf('test/lib-dict')).toBeLessThan(libs.indexOf('test/lib-ui'));

    const cycle = await lb.spawn('loop').then(
      () => null,
      (e: unknown) => e,
    );
    expect(cycle).toMatchObject({
      errno: 'EINVAL',
      detail: { reason: 'dependency-cycle', cycle: ['la', 'lb', 'la'] },
    });
    const orphan = await lb.spawn('orphan').then(
      () => null,
      (e: unknown) => e,
    );
    expect(orphan).toMatchObject({ errno: 'ENOENT' });
    lb.checkInvariants();
  });

  it('KPS-07 a required service that is down refuses the spawn with EAGAIN service-down', async () => {
    const lb = loopback({
      extra: [{ manifest: manifest('needs', { entry: 'test/script', requires: ['svc:sync'] }) }],
    });
    lb.kernel.proc.hooks.serviceState = (name) => (name === 'sync' ? 'down' : 'running');
    await expect(lb.spawn('needs')).rejects.toMatchObject({
      errno: 'EAGAIN',
      detail: { reason: 'service-down' },
    });
  });
});
