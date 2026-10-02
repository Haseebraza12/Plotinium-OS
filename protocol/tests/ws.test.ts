import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as v from 'valibot';
import { describe, expect, it } from 'vitest';

import * as K from '../src/ws/constants.ts';
import { C2S_LANE, C2S_TYPES, C2SFrame, OpResult, S2C_TYPES, S2CFrame } from '../src/ws/frames.ts';
import {
  OpSubmit,
  OpSessionLayout,
  SESSION_LAYOUT_MAX_BYTES,
  VfsOp,
  WsName,
} from '../src/ws/ops.ts';
import { codeSpans, readSpec, section, tables } from './spec-tables.ts';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/ws');
const sync = readSpec('06-sync/offline-and-sync.md');
const load = (dir: string, file: string): unknown =>
  JSON.parse(readFileSync(path.join(FIXTURES, dir, file), 'utf8')) as unknown;
const schemaFor = (file: string): v.GenericSchema =>
  file.startsWith('c2s.') ? C2SFrame : S2CFrame;
const issuePath = (r: v.SafeParseResult<v.GenericSchema>): string =>
  (r.issues?.[0]?.path ?? []).map((p) => String(p.key)).join('.');

describe('protocol/ws: frames and fixtures (offline-and-sync.md §4)', () => {
  it('SYN-03 protocol fixtures: every valid frame parses and every invalid frame fails with the documented issue', () => {
    const valid = readdirSync(path.join(FIXTURES, 'valid'));
    const invalid = readdirSync(path.join(FIXTURES, 'invalid'));
    expect(valid.length).toBeGreaterThanOrEqual(C2S_TYPES.length + S2C_TYPES.length);
    for (const file of valid) {
      const r = v.safeParse(schemaFor(file), load('valid', file));
      expect(r.success, `${file}: ${issuePath(r)} ${r.issues?.[0]?.message ?? ''}`).toBe(true);
    }
    for (const file of invalid) {
      const { frame, issue } = load('invalid', file) as { frame: unknown; issue: string };
      const r = v.safeParse(schemaFor(file), frame, { abortEarly: true });
      expect(r.success, file).toBe(false);
      expect(issuePath(r), file).toBe(issue);
    }
  });

  it('SYN-03 every frame type of sections 4.3 and 4.4 has a valid fixture', () => {
    const valid = readdirSync(path.join(FIXTURES, 'valid')).map(
      (f) => load('valid', f) as { t: string },
    );
    for (const t of C2S_TYPES)
      expect(
        valid.some((f) => f.t === t && v.is(C2SFrame, f)),
        t,
      ).toBe(true);
    for (const t of S2C_TYPES)
      expect(
        valid.some((f) => f.t === t && v.is(S2CFrame, f)),
        t,
      ).toBe(true);
  });

  it('SYN-02 the frame types equal the tables of sections 4.3 and 4.4 and only op.submit and op.batch use the op lane', () => {
    const c2s =
      tables(section(sync, '### 4.3 Client')).find((t) => t.header[0] === '`t`')?.rows ?? [];
    expect(c2s.flatMap((r) => codeSpans(r[0] ?? ''))).toEqual(C2S_TYPES);
    for (const r of c2s)
      for (const t of codeSpans(r[0] ?? ''))
        expect(C2S_LANE[t as keyof typeof C2S_LANE], t).toBe(r[1]);
    const s2c =
      tables(section(sync, '### 4.4 Server')).find((t) => t.header[0] === '`t`')?.rows ?? [];
    expect(s2c.flatMap((r) => codeSpans(r[0] ?? ''))).toEqual(S2C_TYPES);
    expect(C2S_TYPES.filter((t) => C2S_LANE[t] === 'op')).toEqual(['op.submit', 'op.batch']);
  });

  it('SYN-03 every op carries opId, cseq, a Lamport counter and a base, and no hybrid logical clock', () => {
    const op = (load('valid', 'c2s.op-submit.create.json') as { body: Record<string, unknown> })
      .body;
    expect(v.is(OpSubmit, op)).toBe(true);
    for (const key of [
      'opId',
      'osSessionId',
      'cseq',
      'lamport',
      'principal',
      'clientTime',
      'op',
      'base',
    ]) {
      const { [key]: _removed, ...rest } = op;
      expect(v.is(OpSubmit, rest), key).toBe(false);
    }
    expect(v.is(OpSubmit, { ...op, hlc: '1:0' })).toBe(false);
    expect(v.is(OpSubmit, { ...op, opId: '0192f0c1-8a3b-4c4d-8e5f-0123456789ab' })).toBe(false); // v4
  });

  it('SYN-06 op.batch frames carry 1 to 32 ops', () => {
    const op = (load('valid', 'c2s.op-submit.create.json') as { body: unknown }).body;
    const batch = (n: number) => ({
      v: 1,
      t: 'op.batch',
      id: 1,
      body: { ops: Array.from({ length: n }, () => op) },
    });
    expect(v.is(C2SFrame, batch(1))).toBe(true);
    expect(v.is(C2SFrame, batch(32))).toBe(true);
    expect(v.is(C2SFrame, batch(33))).toBe(false);
  });

  it('VFS-10 an op.result conflict names the kept copy, and rejected or retry results name an errno', () => {
    const base = { opId: '0192f0c1-8a3b-7c4d-8e5f-0123456789ab', duplicate: false, lamport: 1 };
    const kept = {
      ino: '0192f0c1-8a3b-7c4d-9e5f-0123456789ac',
      parentIno: '00000000-0000-7000-8000-000000000008',
      name: 'a (conflict from bob, 2026-09-24).md',
    };
    expect(v.is(OpResult, { ...base, status: 'applied' })).toBe(true);
    expect(v.is(OpResult, { ...base, status: 'conflict', keptAs: kept })).toBe(true);
    expect(v.is(OpResult, { ...base, status: 'conflict' })).toBe(false);
    expect(v.is(OpResult, { ...base, status: 'rejected', errno: 'EACCES' })).toBe(true);
    expect(v.is(OpResult, { ...base, status: 'retry', errno: 'EAGAIN' })).toBe(false);
    expect(v.is(OpResult, { ...base, status: 'retry', errno: 'EAGAIN', retryAfterMs: 0 })).toBe(
      true,
    );
  });

  it('SYN-03 wire names must already be NFC and at most 255 bytes', () => {
    expect(v.is(WsName, 'caf\u00e9.md')).toBe(true);
    expect(v.is(WsName, 'cafe\u0301.md')).toBe(false);
    expect(v.is(WsName, '\u00e9'.repeat(127))).toBe(true);
    expect(v.is(WsName, '\u00e9'.repeat(128))).toBe(false);
    for (const bad of ['', '.', '..', 'a/b', 'a\u0000b', '\ud800'])
      expect(v.is(WsName, bad), JSON.stringify(bad)).toBe(false);
  });

  it('SYN-03 a session.layout op is at most 32 KiB serialised and chown ops name a uid or a gid', () => {
    const layout = (n: number) => ({
      kind: 'session.layout',
      rev: 1,
      layout: { blob: 'x'.repeat(n) },
    });
    expect(v.is(OpSessionLayout, layout(SESSION_LAYOUT_MAX_BYTES - 20))).toBe(true);
    expect(v.is(OpSessionLayout, layout(SESSION_LAYOUT_MAX_BYTES))).toBe(false);
    const ino = '0192f0c1-8a3b-7c4d-8e5f-0123456789ab';
    expect(v.is(VfsOp, { kind: 'chown', ino, recursive: false })).toBe(false);
    expect(v.is(VfsOp, { kind: 'chown', ino, uid: 0, recursive: false })).toBe(true);
    expect(v.is(VfsOp, { kind: 'chown', ino, gid: 100, recursive: false })).toBe(true);
  });
});

describe('protocol/ws: constants and close codes (offline-and-sync.md §4.5 and §4.6)', () => {
  it('SYN-01 the protocol constants equal the table of offline-and-sync.md section 4.6', () => {
    const rows =
      tables(section(sync, '### 4.6 Protocol constants')).find((t) => t.header[0] === 'Constant')
        ?.rows ?? [];
    const numbers = (cell: string): number[] =>
      [...cell.matchAll(/(\d[\d,]*)\s*(KiB|MiB)?/g)].map((m) => {
        const n = Number((m[1] ?? '').replaceAll(',', ''));
        return m[2] === 'KiB' ? n * 1024 : m[2] === 'MiB' ? n * 1_048_576 : n;
      });
    const table = new Map<string, number[]>();
    for (const r of rows) {
      const names = codeSpans(r[0] ?? '');
      const values = numbers(r[1] ?? '');
      if (names.length === 1) table.set(names[0] ?? '', values);
      else names.forEach((n, i) => table.set(n, [values[i] ?? Number.NaN]));
    }
    const constants = K as unknown as Record<string, unknown>;
    for (const name of [
      'PROTO',
      'MAX_PAYLOAD',
      'OP_ENVELOPE_MAX',
      'MAX_BATCH',
      'CREDIT_WINDOW',
      'FEED_WINDOW',
      'HELLO_TIMEOUT_MS',
      'DEAD_MAN_MS',
      'SERVER_PING_MS',
      'BACKOFF_BASE_MS',
      'BACKOFF_CAP_MS',
      'PROBE_MS',
      'FEED_GAP_MS',
      'SYNC_WAIT_MS',
      'MAX_LEASES',
      'MAX_WATCHES',
      'COALESCE_AT',
      'CLOSE_AT',
      'FEED_RETENTION_DAYS',
      'PENDING_LIVE_MAX',
    ]) {
      expect(constants[name], name).toBe(table.get(name)?.[0]);
    }
    expect(table.get('LEASE_TTL_MS')).toEqual([
      K.LEASE_TTL_MS,
      K.LEASE_TTL_DEMO_MS,
      K.LEASE_TTL_MIN_MS,
      K.LEASE_TTL_MAX_MS,
    ]);
    expect(table.get('FRAME_BUCKET')).toEqual([K.FRAME_BUCKET.ratePerSecond, K.FRAME_BUCKET.burst]);
    expect(K.hbMs(K.LEASE_TTL_MS)).toBe(10_000);
    expect(K.hbMs(K.LEASE_TTL_DEMO_MS)).toBe(5_000);
  });

  it('SYN-01 the close codes equal the table of offline-and-sync.md section 4.5', () => {
    const rows =
      tables(section(sync, '### 4.5 Close codes')).find((t) => t.header[0] === 'Code')?.rows ?? [];
    expect(rows.map((r) => [Number(r[0]), r[1], (r[2] ?? '').split(' ')[0]])).toEqual(
      Object.values(K.CLOSE_CODES).map((c) => [c.code, c.name, c.sentBy]),
    );
    expect(K.closeCodeInfo(4409)?.reaction).toBe('superseded');
    expect(K.closeCodeInfo(1006)).toBeUndefined();
  });
});
