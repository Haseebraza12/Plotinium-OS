import { describe, expect, it } from 'vitest';

import { ABI_VERSION, CALL_NAMES } from '@plotinium/protocol';

import {
  createSys,
  createViewSys,
  errnoOf,
  SysError,
  TICK,
  transferList,
} from '../src/runtime/sys.ts';

describe('sys client', () => {
  it('SYS-01 ctx.sys has one generator stub per registry call that yields the request without an id', () => {
    const sys = createSys();
    expect(Object.isFrozen(sys)).toBe(true);
    for (const name of CALL_NAMES) expect(typeof sys[name]).toBe('function');
    const gen = sys.stat({ path: '/' });
    expect(gen.next().value).toEqual({ call: 'stat', args: { path: '/' } });
    expect(gen.next({ ino: 'x' })).toEqual({ done: true, value: { ino: 'x' } });
    expect(sys.call('getpid', {}).next().value).toEqual({ call: 'getpid', args: {} });
    expect(typeof TICK).toBe('symbol');
  });

  it('ABI-05 SysError carries a master-table errno and errnoOf reads it from any thrown value', () => {
    const e = new SysError('ENOENT', undefined, { path: '/x' });
    expect(e.message).toBe('No such file or directory');
    expect(errnoOf(e)).toBe('ENOENT');
    expect(errnoOf({ errno: 'EBOGUS' })).toBeUndefined();
    expect(errnoOf('ENOENT')).toBeUndefined();
    expect(errnoOf(null)).toBeUndefined();
  });

  it('ABI-13 ArrayBuffers of 64 KiB or more are transferred, smaller ones copied', () => {
    const big = new ArrayBuffer(65_536);
    const small = new ArrayBuffer(10);
    expect(transferList({ data: big, other: small, s: 'x' })).toEqual([big]);
    expect(transferList(null)).toEqual([]);
  });

  it('ABI-10 a view client sends hello once, correlates replies by id and rejects errors as SysError', async () => {
    const ch = new MessageChannel();
    const seen: unknown[] = [];
    const events: unknown[] = [];
    let closedWith = '';
    const kernelSide = ch.port2;
    kernelSide.onmessage = (ev: MessageEvent) => {
      const msg = ev.data as { t: string; req?: { id: number; call: string } };
      seen.push(msg.t);
      if (msg.t !== 'req' || !msg.req) return;
      if (msg.req.call === 'getpid')
        kernelSide.postMessage({
          t: 'res',
          res: { id: msg.req.id, ok: true, value: { pid: 7, ppid: 1, pgid: 7, sid: 7 } },
        });
      else
        kernelSide.postMessage({
          t: 'res',
          res: { id: msg.req.id, ok: false, errno: 'ENOSYS', msg: 'nope' },
        });
    };
    const sys = createViewSys(ch.port1, {
      onEvents: (b) => events.push(...b),
      onTtyOut: (d) => events.push(d.byteLength),
      onClose: (r) => (closedWith = r),
    });
    await expect(sys.call('getpid', {})).resolves.toEqual({ pid: 7, ppid: 1, pgid: 7, sid: 7 });
    await expect(sys.call('uname', {})).rejects.toMatchObject({ errno: 'ENOSYS', message: 'nope' });
    expect(seen).toEqual(['hello', 'req', 'req']);
    kernelSide.postMessage({ t: 'events', batch: [{ topic: 'proc.spawn' }] });
    kernelSide.postMessage({ t: 'tty.out', data: new ArrayBuffer(3) });
    kernelSide.postMessage('noise');
    kernelSide.postMessage({ t: 'close', reason: 'window-closed' });
    await new Promise((r) => setTimeout(r, 10));
    expect(events).toEqual([{ topic: 'proc.spawn' }, 3]);
    expect(closedWith).toBe('window-closed');
    expect(sys.closed).toBe(true);
    await expect(sys.call('getpid', {})).rejects.toMatchObject({ errno: 'ESRCH' });
    ch.port1.close();
    ch.port2.close();
    expect(ABI_VERSION).toBeGreaterThanOrEqual(1);
  });

  it('SYS-01 pending view calls are rejected when the port closes', async () => {
    const ch = new MessageChannel();
    const sys = createViewSys(ch.port1);
    const pending = sys.call('getpid', {});
    ch.port2.postMessage({ t: 'close' });
    await expect(pending).rejects.toMatchObject({ errno: 'ESRCH' });
    ch.port1.close();
    ch.port2.close();
  });
});
