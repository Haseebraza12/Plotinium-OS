import { describe, expect, it } from 'vitest';

import { ABI_VERSION, abiDigest } from '@plotinium/protocol';

import type { KlogProc } from '../src/core/klog/records.ts';
import { createLoopback } from '../src/host/loopback.ts';
import { counter, crasher, oneCall, probe, rogue } from './fixtures/programs.ts';
import type { ProbeState } from './fixtures/programs.ts';

describe('loopback kernel', () => {
  it('SYS-01 a program reaches getpid, uname, time.now, proc.list and dmesg only through the dispatcher', async () => {
    const lb = createLoopback();
    const out: ProbeState = { results: {}, errors: {} };
    const pcb = lb.spawn(probe(out), { name: 'probe' });
    const r = await lb.run(pcb.pid);
    expect(r.code).toBe(0);
    expect(out.results['getpid']).toEqual({ pid: pcb.pid, ppid: 1, pgid: 1, sid: 1 });
    expect(out.results['uname']).toMatchObject({
      sysname: 'Plotinium',
      uid: 1001,
      user: 'alice',
      cores: 8,
    });
    expect(out.results['time.now']).toMatchObject({ tz: 'Asia/Karachi', tzOffsetMin: 300 });
    const list = out.results['proc.list'] as { procs: { pid: number }[] };
    expect(list.procs.map((p) => p.pid)).toEqual([1, pcb.pid]);
    // `stat` is registered by the VFS; until it lands the kernel answers ENOSYS at stage 2.
    expect(out.errors['stat']).toBe('ENOSYS');
  });

  it('PROC-03 an F call answered while nothing else waits resumes the same slice without a new dispatch', async () => {
    const lb = createLoopback();
    const pcb = lb.spawn(probe({ results: {}, errors: {} }), { name: 'probe' });
    const r = await lb.run(pcb.pid);
    const dispatches = lb.kernel.klog.read({
      filter: (rec) => rec.kind === 'proc' && rec.pid === pcb.pid && rec.reason === 'dispatch',
    });
    expect(dispatches).toHaveLength(1);
    expect(r.reports.filter((x) => x.t === 'syscall')).toHaveLength(6);
  });

  it('PROC-06 every transition of a scripted workload appears in the klog trace with from, to and reason', async () => {
    const lb = createLoopback({ quantumMs: 0 });
    const pcb = lb.spawn(counter, { name: 'count', argv: ['count', '3'] });
    await lb.run(pcb.pid);
    const trace = lb.kernel.klog
      .read({ filter: (rec) => rec.kind === 'proc' && rec.pid === pcb.pid })
      .map((rec) => {
        const p = rec as KlogProc;
        return `${p.from ?? '-'}>${p.to ?? '-'}:${p.reason}`;
      });
    expect(trace[0]).toBe('->NEW:spawn');
    expect(trace[1]).toBe('NEW>READY:admit');
    expect(trace).toContain('RUNNING>READY:quantum');
    expect(trace.at(-2)).toBe('RUNNING>TERMINATED:exit');
    expect(trace.at(-1)).toBe('TERMINATED>-:reaped');
  });

  it('PROC-06 a crash exits 1 with reason crash and logs the message', async () => {
    const lb = createLoopback();
    const pcb = lb.spawn(crasher, { name: 'crash' });
    const r = await lb.run(pcb.pid);
    expect(r).toMatchObject({ code: 1, reason: 'crash' });
    const lines = lb.kernel.klog.read({ level: 'fail' });
    expect(lines.some((l) => l.kind === 'line' && l.msg.includes('boom'))).toBe(true);
  });

  it('KPS-03 a program that yields something other than ctx.tick or a syscall crashes', async () => {
    const lb = createLoopback();
    const pcb = lb.spawn(rogue, { name: 'rogue' });
    expect((await lb.run(pcb.pid)).reason).toBe('crash');
  });

  it('ABI-04 an args object with an unknown key uid is rejected with EINVAL', async () => {
    const lb = createLoopback();
    const out = { err: null as string | null, value: undefined as unknown };
    const pcb = lb.spawn(oneCall('getpid', { uid: 0 }, out), { name: 'forge' });
    await lb.run(pcb.pid);
    expect(out.err).toBe('EINVAL');
    const last = lb.kernel.klog.read({ filter: (r) => r.kind === 'trace' }).at(-1);
    expect(last).toMatchObject({ kind: 'trace', call: 'getpid', errno: 'EINVAL', pid: pcb.pid });
  });

  it('ABI-15 a view opened on a window answers view-origin calls with the owning process credentials', async () => {
    const lb = createLoopback();
    const pcb = lb.spawn(counter, { name: 'files', argv: ['files', '1'] });
    const view = lb.openView(pcb.pid, 4);
    view.send({ t: 'hello', abi: ABI_VERSION, digest: abiDigest() });
    view.send({ t: 'req', req: { id: 1, call: 'uname', args: {} } });
    view.send({ t: 'req', req: { id: 2, call: 'getpid', args: {} } });
    expect(view.replies[0]).toMatchObject({ id: 1, ok: true, value: { uid: 1001 } });
    expect(view.replies[1]).toMatchObject({ id: 2, ok: true, value: { pid: pcb.pid } });
    view.send({ t: 'hello', abi: 0, digest: 'x' });
    expect(view.closedWith).toBe('abi-mismatch');
    await lb.run(pcb.pid);
    expect(lb.kernel.handlers.has('uname')).toBe(true);
    expect(lb.kernel.handlers.names()).toEqual(
      expect.arrayContaining(['getpid', 'uname', 'dmesg', 'proc.list', 'time.now']),
    );
  });

  it('PROC-06 a program whose init throws fails to spawn: NEW → TERMINATED with exit 126', async () => {
    const lb = createLoopback();
    const bad = {
      init: () => {
        throw new Error('bad argv');
      },
      *run() {
        yield* [];
        return 0;
      },
    };
    const pcb = lb.spawn(bad, { name: 'bad', uid: 1002, cls: 'user', fsScope: ['/home/bob'] });
    expect(pcb).toMatchObject({ state: 'TERMINATED', exitCode: 126, exitReason: 'spawn-failed' });
    await expect(lb.run(pcb.pid)).rejects.toThrow(/no pid/);
  });

  it('PROC-03 run stops after maxSlices and a long job keeps yielding on quantum', async () => {
    const lb = createLoopback({ quantumMs: 0 });
    const pcb = lb.spawn(counter, { name: 'count', argv: ['count', '1000'] });
    const r = await lb.run(pcb.pid, { maxSlices: 3, advanceMsPerSlice: 2 });
    expect(r.code).toBeNull();
    expect(r.reports.map((x) => x.t)).toEqual(['yield', 'yield', 'yield']);
    expect(lb.clock.now()).toBe(6);
  });
});
