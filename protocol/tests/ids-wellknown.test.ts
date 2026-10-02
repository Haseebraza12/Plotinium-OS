import { createHash } from 'node:crypto';

import * as fc from 'fast-check';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';

import {
  bytesToUuid,
  createUuidV7Generator,
  deriveIno,
  isUuidV7,
  UUID_V7_REGEX,
  uuidToBytes,
  uuidv7,
  uuidV7Timestamp,
} from '../src/ids.ts';
import { sha256, sha256Hex, toHex } from '../src/sha256.ts';
import { Ino } from '../src/sys/common.ts';
import {
  GID_ROOT,
  INO,
  isWellKnownDir,
  isWellKnownIno,
  SEED_ID_BASE,
  seedIno,
  SYNTH_FILES,
  UID_ROOT,
  WELL_KNOWN_DIRS,
  wellKnownIno,
} from '../src/wellknown.ts';
import { codeSpans, readSpec, section, tables } from './spec-tables.ts';

const nodeSha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

describe('protocol/sha256', () => {
  it('SYN-03 sha256 matches the FIPS 180-4 test vectors', () => {
    const enc = new TextEncoder();
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
    expect(toHex(sha256(enc.encode('a'.repeat(1_000_000))))).toBe(
      'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0',
    );
  });

  it('SYN-03 sha256 equals node:crypto on random inputs of every padding length', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 0, maxLength: 300 }), (bytes) => {
        expect(toHex(sha256(bytes))).toBe(nodeSha(bytes));
      }),
      { numRuns: 1000 },
    );
    for (let n = 50; n <= 70; n++) {
      const bytes = new Uint8Array(n).fill(n);
      expect(toHex(sha256(bytes)), `length ${n}`).toBe(nodeSha(bytes));
    }
  });
});

describe('protocol/ids: UUIDv7 (C5)', () => {
  it('SYN-03 uuidv7 ids are canonical version-7 UUIDs with the current millisecond timestamp', () => {
    const before = Date.now();
    const id = uuidv7();
    const after = Date.now();
    expect(id).toMatch(UUID_V7_REGEX);
    expect(isUuidV7(id)).toBe(true);
    expect(v.safeParse(Ino, id).success).toBe(true);
    expect(uuidV7Timestamp(id)).toBeGreaterThanOrEqual(before);
    expect(uuidV7Timestamp(id)).toBeLessThanOrEqual(after + 1);
  });

  it('SYN-03 ids from one generator strictly increase within one millisecond and when the clock goes backwards', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 5 }), { minLength: 1, maxLength: 300 }),
        fc.integer({ min: 1, max: 2 ** 40 }),
        (steps, start) => {
          let clock = start;
          let i = 0;
          const gen = createUuidV7Generator({ now: () => clock });
          let prev = '';
          for (const step of steps) {
            // move the clock forwards, keep it, or move it backwards
            clock = Math.max(0, clock + (i++ % 3 === 2 ? -step : step));
            const id = gen();
            expect(id > prev, `${id} > ${prev}`).toBe(true);
            expect(isUuidV7(id)).toBe(true);
            prev = id;
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it('SYN-03 the generator advances the timestamp instead of overflowing its 12-bit counter', () => {
    const gen = createUuidV7Generator({ now: () => 1_000 });
    const ids = Array.from({ length: 10_000 }, gen);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
    expect(uuidV7Timestamp(ids[0] ?? '')).toBe(1_000);
    expect(uuidV7Timestamp(ids.at(-1) ?? '')).toBeGreaterThan(1_000);
  });

  it('SYN-03 a clock outside the 48-bit range is refused', () => {
    expect(() => createUuidV7Generator({ now: () => -1 })()).toThrow(RangeError);
    expect(() => createUuidV7Generator({ now: () => 2 ** 48 })()).toThrow(RangeError);
  });

  it('SYN-03 uuidToBytes and bytesToUuid round-trip and reject non-canonical text', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 16, maxLength: 16 }), (bytes) => {
        bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
        bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
        const id = bytesToUuid(bytes);
        expect(isUuidV7(id)).toBe(true);
        expect(uuidToBytes(id)).toEqual(bytes);
      }),
    );
    expect(() => uuidToBytes('0192F0C1-8A3B-7C4D-8E5F-0123456789AB')).toThrow(TypeError);
    expect(() => bytesToUuid(new Uint8Array(15))).toThrow(RangeError);
  });

  it('SYN-03 deriveIno follows offline-and-sync.md section 3.3.2 bit for bit', () => {
    const opId = '0192f0c1-8a3b-7c4d-8e5f-0123456789ab';
    const src = INO.HOME;
    // Independent oracle: node:crypto over the 32 bytes of the two ids, then the RFC 9562 layout.
    const digest = createHash('sha256')
      .update(Buffer.concat([uuidToBytes(opId), uuidToBytes(src)]))
      .digest();
    const first74 = BigInt(`0x${digest.subarray(0, 10).toString('hex')}`) >> 6n;
    const ts = BigInt(`0x${opId.replaceAll('-', '').slice(0, 12)}`);
    const value =
      (ts << 80n) |
      (7n << 76n) |
      ((first74 >> 62n) << 64n) |
      (2n << 62n) |
      (first74 & ((1n << 62n) - 1n));
    const hex = value.toString(16).padStart(32, '0');
    const expected = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    expect(deriveIno(opId, src)).toBe(expected);
    expect(uuidV7Timestamp(deriveIno(opId, src))).toBe(uuidV7Timestamp(opId));
  });

  it('SYN-03 derived ids are deterministic, UUIDv7-shaped and distinct per source and per op', () => {
    const gen = createUuidV7Generator();
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 5000 }), fc.integer({ min: 1, max: 5000 }), (a, b) => {
        const op = gen();
        const x = deriveIno(op, wellKnownIno(a));
        expect(deriveIno(op, wellKnownIno(a))).toBe(x);
        expect(isUuidV7(x)).toBe(true);
        if (a !== b) expect(deriveIno(op, wellKnownIno(b))).not.toBe(x);
        expect(deriveIno(gen(), wellKnownIno(a))).not.toBe(x);
      }),
      { numRuns: 300 },
    );
  });
});

describe('protocol/wellknown (virtual-file-system.md §3.3 and §4.7, C5)', () => {
  const vfs = readSpec('04-vfs/virtual-file-system.md');
  const expand = (cell: string): string[] =>
    codeSpans(cell).map((s) => (s.startsWith('…-') ? `00000000-0000-7000-8000-${s.slice(2)}` : s));

  it('PVFS-02 well-known inode ids are fixed forever', () => {
    expect(INO).toEqual({
      ROOT: '00000000-0000-7000-8000-000000000001',
      BIN: '00000000-0000-7000-8000-000000000002',
      SYSTEM: '00000000-0000-7000-8000-000000000003',
      SYSTEM_SERVICES: '00000000-0000-7000-8000-000000000004',
      SYSTEM_LOG: '00000000-0000-7000-8000-000000000005',
      SYSTEM_BRANDING: '00000000-0000-7000-8000-000000000006',
      ROOT_HOME: '00000000-0000-7000-8000-000000000007',
      HOME: '00000000-0000-7000-8000-000000000008',
      TMP: '00000000-0000-7000-8000-000000000009',
      MNT: '00000000-0000-7000-8000-00000000000a',
      USR: '00000000-0000-7000-8000-00000000000b',
      USR_SHARE: '00000000-0000-7000-8000-00000000000c',
      USR_SHARE_MAN: '00000000-0000-7000-8000-00000000000d',
      LOST_FOUND: '00000000-0000-7000-8000-00000000000e',
      SYSTEM_RELEASE: '00000000-0000-7000-8000-000000000100',
      LOG_BOOT: '00000000-0000-7000-8000-000000000101',
      LOG_KERNEL: '00000000-0000-7000-8000-000000000102',
      LOG_AUDIT: '00000000-0000-7000-8000-000000000103',
    });
    expect(SEED_ID_BASE).toBe(0x1000);
  });

  it('PVFS-02 the well-known directory table equals virtual-file-system.md section 3.3.1', () => {
    const rows =
      tables(section(vfs, '#### 3.3.1 The hierarchy')).find((t) => t.header[0] === 'Path')?.rows ??
      [];
    const expected: { path: string; ino: string; mode: number; level: string }[] = [];
    for (const r of rows) {
      const paths = codeSpans(r[0] ?? '');
      const inos = expand(r[6] ?? '').filter((s) => s.startsWith('00000000-'));
      if (inos.length === 0) continue; // /home/<user> and ~/lost+found are per user
      expect(inos.length, r[0]).toBe(paths.length);
      const mode = Number.parseInt(/\b([0-7]{4})\b/.exec(r[3] ?? '')?.[1] ?? 'x', 8);
      const level = (r[4] ?? '').split(/\s/)[0] ?? '';
      expect(r[2], r[0]).toBe('root:root');
      paths.forEach((path, i) => expected.push({ path, ino: inos[i] ?? '', mode, level }));
    }
    expect(
      WELL_KNOWN_DIRS.map((d) => ({ path: d.path, ino: d.ino, mode: d.mode, level: d.level })),
    ).toEqual(expected);
    for (const d of WELL_KNOWN_DIRS) {
      expect([d.uid, d.gid]).toEqual([UID_ROOT, GID_ROOT]);
      const parent = WELL_KNOWN_DIRS.find((p) => p.key === d.parent);
      if (d.parent === null) expect(d.path).toBe('/');
      else expect(d.path.slice(0, d.path.lastIndexOf('/')) || '/', d.path).toBe(parent?.path);
    }
  });

  it('PVFS-09 the synthesised files equal virtual-file-system.md section 3.3.5', () => {
    const rows =
      tables(section(vfs, '#### 3.3.5 Kernel-synthesised')).find((t) => t.header[0] === 'Path')
        ?.rows ?? [];
    expect(
      rows.map((r) => ({
        path: codeSpans(r[0] ?? '')[0],
        ino: expand(r[1] ?? '')[0],
        mode: Number.parseInt(r[2] ?? '', 8),
      })),
    ).toEqual(SYNTH_FILES.map((f) => ({ path: f.path, ino: f.ino, mode: f.mode })));
  });

  it('PVFS-02 every well-known id passes the Ino schema and sorts before every generated id', () => {
    const generated = uuidv7();
    for (const id of Object.values(INO)) {
      expect(v.safeParse(Ino, id).success, id).toBe(true);
      expect(uuidV7Timestamp(id)).toBe(0);
      expect(id < generated).toBe(true);
      expect(isWellKnownIno(id)).toBe(true);
    }
    expect(isWellKnownDir(INO.TMP)).toBe(true);
    expect(isWellKnownDir(INO.LOG_AUDIT)).toBe(false);
    expect(isWellKnownIno(generated)).toBe(false);
  });

  it('PVFS-02 seeded ids cover 0x1000 to 0xffff and nothing else', () => {
    expect(seedIno(0)).toBe('00000000-0000-7000-8000-000000001000');
    expect(seedIno(0xffff - 0x1000)).toBe('00000000-0000-7000-8000-00000000ffff');
    expect(() => seedIno(-1)).toThrow(RangeError);
    expect(() => seedIno(0xf000)).toThrow(RangeError);
    expect(() => seedIno(1.5)).toThrow(RangeError);
    expect(() => wellKnownIno(0)).toThrow(RangeError);
  });
});
