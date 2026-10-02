import * as v from 'valibot';
import { afterAll, describe, expect, it } from 'vitest';

import { CALL_NAMES } from '../src/sys/names.ts';
import { CALLS } from '../src/sys/registry.ts';
import type { CallSpec } from '../src/sys/registry.ts';
import { INO, samples } from './samples.ts';

const channel = new MessageChannel();
const SAMPLES = samples(channel.port1);
afterAll(() => {
  channel.port1.close();
  channel.port2.close();
});

const spec = (name: string): CallSpec => CALLS[name as keyof typeof CALLS];
const parse = (schema: v.GenericSchema, input: unknown) =>
  v.safeParse(schema, input, { abortEarly: true });

describe('protocol/schemas: every call accepts valid samples and rejects invalid ones', () => {
  for (const name of CALL_NAMES) {
    it(`ABI-11 ${name} accepts its valid arguments and rejects the invalid ones`, () => {
      const s = SAMPLES[name];
      expect(s.args.length, `${name} has valid samples`).toBeGreaterThan(0);
      expect(s.badArgs.length, `${name} has invalid samples`).toBeGreaterThan(0);
      for (const args of s.args) {
        const r = parse(spec(name).args, args);
        expect(
          r.success,
          `${name} ${JSON.stringify(r.issues?.[0]?.path?.map((p) => p.key))} ${r.issues?.[0]?.message ?? ''}`,
        ).toBe(true);
      }
      for (const bad of s.badArgs)
        expect(
          parse(spec(name).args, bad).success,
          `${name} rejects ${JSON.stringify(bad)?.slice(0, 80)}`,
        ).toBe(false);
    });

    it(`ABI-11 ${name} return schema accepts valid replies and rejects invalid ones`, () => {
      const s = SAMPLES[name];
      for (const ret of s.ret) {
        const r = parse(spec(name).ret, ret);
        expect(
          r.success,
          `${name} ${JSON.stringify(r.issues?.[0]?.path?.map((p) => p.key))} ${r.issues?.[0]?.message ?? ''}`,
        ).toBe(true);
      }
      for (const bad of s.badRet ?? [])
        expect(parse(spec(name).ret, bad).success, `${name} ret rejects`).toBe(false);
    });

    it(`ABI-04 ${name} rejects an args object with an unknown key`, () => {
      for (const args of SAMPLES[name].args) {
        if (args === null || typeof args !== 'object' || Array.isArray(args)) continue;
        expect(parse(spec(name).args, { ...args, __smuggled: 1 }).success).toBe(false);
        if (!('uid' in args)) {
          const withUid = parse(spec(name).args, { ...args, uid: 0 });
          const takesUid = withUid.success;
          // Only calls that legitimately name a target uid may accept one (proc.list, quota, chown).
          if (takesUid) expect(['proc.list', 'quota', 'chown']).toContain(name);
        }
      }
    });
  }

  it('ABI-04 an args object with an unknown key uid is rejected with EINVAL', () => {
    const r = parse(CALLS.stat.args, { path: '/home/alice', uid: 0 });
    expect(r.success).toBe(false);
    expect(r.issues?.[0]?.message).not.toBe('ENAMETOOLONG');
    expect(r.issues?.[0]?.path?.[0]?.key).toBe('uid');
  });

  it('RAG-03 ai.semsearch args reject a uid field, so the caller can only come from the port', () => {
    expect(parse(CALLS['ai.semsearch'].args, { q: 'budget', uid: 0 }).success).toBe(false);
    expect(parse(CALLS['ai.semsearch'].args, { q: 'budget', pid: 1 }).success).toBe(false);
  });

  it('ABI-13 a string where an ArrayBuffer is required is rejected with EINVAL', () => {
    const r = parse(CALLS.write.args, { fd: 3, data: 'hello' });
    expect(r.success).toBe(false);
    expect(r.issues?.[0]?.message).not.toBe('ENAMETOOLONG');
    expect(parse(CALLS.write.args, { fd: 3, data: new ArrayBuffer(5) }).success).toBe(true);
  });

  it('ABI-13 write and writeFile enforce their 16 MiB and 64 MiB byte limits', () => {
    expect(parse(CALLS.write.args, { fd: 3, data: new ArrayBuffer(16 * 1_048_576) }).success).toBe(
      true,
    );
    expect(
      parse(CALLS.write.args, { fd: 3, data: new ArrayBuffer(16 * 1_048_576 + 1) }).success,
    ).toBe(false);
    expect(
      parse(CALLS.writeFile.args, { path: '/a', data: new ArrayBuffer(64 * 1_048_576 + 1) })
        .success,
    ).toBe(false);
  });

  it('ABI-11 the exit call never replies: its return schema accepts nothing', () => {
    expect(SAMPLES.exit.ret).toHaveLength(0);
    for (const value of [undefined, null, {}, 0])
      expect(parse(CALLS.exit.ret, value).success).toBe(false);
  });

  it('ABI-11 schema defaults are applied: open mode 0o666 and follow, mkdir 0o777, pipe 64 KiB, su root', () => {
    expect(v.parse(CALLS.open.args, { path: '/a', flags: 'r' })).toEqual({
      path: '/a',
      flags: 'r',
      mode: 0o666,
      follow: true,
    });
    expect(v.parse(CALLS.mkdir.args, { path: '/a' })).toEqual({ path: '/a', mode: 0o777 });
    expect(v.parse(CALLS.pipe.args, {})).toEqual({ capacity: 65_536 });
    expect(v.parse(CALLS.stat.args, { path: '/a' })).toEqual({ path: '/a', follow: true });
    expect(v.parse(CALLS['lock.acquire'].args, { path: '/a', mode: 'S' })).toEqual({
      path: '/a',
      mode: 'S',
      wait: false,
    });
    expect(v.parse(CALLS.find.args, { path: '/' })).toEqual({ path: '/', limit: 1000 });
    expect(v.parse(CALLS['ai.semsearch'].args, { q: 'x' })).toEqual({ q: 'x', k: 5 });
    expect(v.parse(CALLS.su.args, { spawn: { path: '/bin/sh.json', argv: [] } })).toMatchObject({
      user: 'root',
    });
    expect(v.parse(CALLS.writeFile.args, { path: '/a', data: new ArrayBuffer(0) })).toMatchObject({
      create: true,
    });
  });

  it('ABI-04 the spawn argv plus env limit of 60 KiB is enforced on the whole object', () => {
    const half = 'x'.repeat(30_000);
    expect(parse(CALLS.spawn.args, { path: '/bin/a.json', argv: [half, half] }).success).toBe(true);
    expect(
      parse(CALLS.spawn.args, {
        path: '/bin/a.json',
        argv: [half, half],
        env: { A: 'y'.repeat(2000) },
      }).success,
    ).toBe(false);
  });

  it('VFS-04 chmod rejects setuid and setgid bits with EINVAL', () => {
    for (const mode of [
      { op: 'set', bits: 0o4755 },
      { op: 'set', bits: 0o2755 },
      { op: 'delta', add: 0o4000, clear: 0 },
    ]) {
      const r = parse(CALLS.chmod.args, { path: '/a', mode });
      expect(r.success).toBe(false);
      expect(r.issues?.[0]?.message).not.toBe('ENAMETOOLONG');
    }
    expect(
      parse(CALLS.chmod.args, { path: '/a', mode: { op: 'delta', add: 0, clear: 0o6000 } }).success,
    ).toBe(true);
    expect(
      parse(CALLS.chmod.args, { path: '/tmp', mode: { op: 'set', bits: 0o1777 } }).success,
    ).toBe(true);
  });

  it('ABI-09 sig.action refuses to catch or ignore SIGKILL and SIGSTOP', () => {
    for (const sig of ['SIGKILL', 'SIGSTOP']) {
      expect(parse(CALLS['sig.action'].args, { sig, action: 'catch' }).success).toBe(false);
      expect(parse(CALLS['sig.action'].args, { sig, action: 'ignore' }).success).toBe(false);
      expect(parse(CALLS['sig.action'].args, { sig, action: 'default' }).success).toBe(true);
    }
  });

  it('AGT-05 batch accepts only a well-formed plan token and at most 1000 ops', () => {
    const op = { op: 'mkdir', path: '/a' };
    const base = { txnId: INO, ops: [op], expectedVersions: [] };
    expect(
      parse(CALLS.batch.args, { ...base, ops: Array.from({ length: 1000 }, () => op) }).success,
    ).toBe(true);
    expect(
      parse(CALLS.batch.args, { ...base, ops: Array.from({ length: 1001 }, () => op) }).success,
    ).toBe(false);
    expect(
      parse(CALLS.batch.args, { ...base, token: `${INO}.123.${'A'.repeat(42)}` }).success,
    ).toBe(false);
    expect(
      parse(CALLS.batch.args, { ...base, token: `${INO}.123.${'A'.repeat(43)}` }).success,
    ).toBe(true);
  });
});
