import { describe, expect, it } from 'vitest';

import { CALLS } from '@plotinium/protocol';

import {
  argsDigest,
  argsSummary,
  Auditor,
  MemoryAuditSink,
  TRACE_SAMPLE_EVERY,
} from '../src/core/ipc/audit.ts';
import { Klog } from '../src/core/klog/klog.ts';
import { createPcb } from '../src/core/proc/pcb.ts';
import { isUnder, normalisePath, scopeViolation } from '../src/core/ipc/scope.ts';

const pcb = (cls: 'user' | 'agent' = 'user', uid = 1001, ruid = uid) =>
  createPcb({
    pid: 5,
    ppid: 1,
    kind: 'user',
    cls,
    name: 'x',
    cred: { uid, gid: uid, groups: [], ruid },
    now: 0,
  });

describe('audit', () => {
  it('ABI-08 audit records never contain file data, passwords or tokens', () => {
    const data = new Uint8Array(70_000).fill(7).buffer;
    const summary = argsSummary({
      path: '/home/alice/a.txt',
      data,
      secret: 'hunter2',
      token: 'plan.1.mac',
      mode: 420,
      opts: { a: 1 },
      list: [1, 2],
    });
    expect(summary).not.toContain('hunter2');
    expect(summary).not.toContain('plan.1.mac');
    expect(summary).toContain('data=<redacted>');
    expect(summary).toContain('path="/home/alice/a.txt"');
    expect(summary).toContain('opts={…}');
    expect(summary).toContain('list=[2]');
    expect(argsSummary({ buf: new Uint8Array(3) })).toBe('buf=<3 bytes>');
    expect(argsSummary(null)).toBe('null');
    expect(
      argsSummary({
        long: 'x'.repeat(900),
        more: 'y'.repeat(900),
        k: 'z'.repeat(900),
        l: 'w'.repeat(900),
        m: 'v'.repeat(900),
        n: 'u'.repeat(900),
        o: 'q'.repeat(900),
        p: 'r'.repeat(900),
      }).length,
    ).toBeLessThanOrEqual(512);
  });

  it('ABI-08 the args digest is canonical: key order does not matter and binary is hashed, not embedded', () => {
    expect(argsDigest({ a: 1, b: 'x' })).toBe(argsDigest({ b: 'x', a: 1 }));
    expect(argsDigest({ data: new Uint8Array([1, 2]).buffer })).not.toBe(
      argsDigest({ data: new Uint8Array([1, 3]).buffer }),
    );
    expect(argsDigest({ v: new Uint8Array([1, 2]) })).toMatch(/^[0-9a-f]{64}$/);
    expect(argsDigest({ n: Number.NaN, u: undefined, f: () => 1 })).toBe(
      argsDigest({ n: null, u: null, f: null }),
    );
  });

  it('ABI-08 trace records every error and 1 in 64 successful F calls; agents always get a durable record', () => {
    let t = 0;
    const klog = new Klog();
    const sink = new MemoryAuditSink();
    const a = new Auditor({
      klog,
      sink,
      now: () => t++,
      epochMs: () => 1_000,
      osSessionId: () => '0192f0c1-0000-7000-8000-000000000001',
    });
    const p = pcb();
    for (let i = 0; i < TRACE_SAMPLE_EVERY; i++)
      a.end(a.begin(p, 'getpid', CALLS.getpid, {}), null);
    expect(klog.read({ filter: (r) => r.kind === 'trace' })).toHaveLength(1);
    a.end(a.begin(p, 'sleep', CALLS.sleep, { ms: 1 }), null);
    a.end(a.begin(p, 'getpid', CALLS.getpid, {}), 'EINVAL');
    expect(klog.read({ filter: (r) => r.kind === 'trace' })).toHaveLength(3);
    expect(sink.records).toHaveLength(0);
    const su = pcb('user', 0, 1001);
    a.end(a.begin(su, 'kill', CALLS.kill, { pid: 9, sig: 'SIGKILL' }), null, true);
    expect(sink.records.at(-1)).toMatchObject({
      level: 'security',
      uid: 0,
      ruid: 1001,
      outcome: 'ok',
      actor: 'user',
    });
    a.end(a.begin(pcb('agent'), 'stat', CALLS.stat, { path: '/' }), 'ENOENT');
    expect(sink.records.at(-1)).toMatchObject({
      level: 'agent',
      actor: 'agent',
      outcome: 'error',
      errno: 'ENOENT',
      errnoCode: 2,
    });
    a.rejected(null, 'nope', undefined, {}, 'ENOSYS');
    expect(klog.read({ filter: (r) => r.kind === 'trace' }).at(-1)).toMatchObject({
      pid: 0,
      call: 'nope',
      errno: 'ENOSYS',
    });
  });
});

describe('fs.scope lexical check', () => {
  it('AGT-04 paths are normalised against the cwd and must lie under an allowed prefix', () => {
    expect(normalisePath('../b/./c', '/home/alice/x')).toBe('/home/alice/b/c');
    expect(normalisePath('/../..', '/')).toBe('/');
    expect(isUnder('/home/alice2', '/home/alice')).toBe(false);
    expect(isUnder('/anything', '/')).toBe(true);
    expect(scopeViolation({ from: 'a', to: '/tmp/b' }, '/home/alice', ['/home/alice'])).toBe(
      '/tmp/b',
    );
    expect(
      scopeViolation({ paths: ['x', '/home/alice/y'] }, '/home/alice', ['/home/alice/']),
    ).toBeNull();
    expect(scopeViolation({ paths: ['/etc'] }, '/', ['/home'])).toBe('/etc');
    expect(scopeViolation('not an object', '/', ['/home'])).toBeNull();
  });
});
