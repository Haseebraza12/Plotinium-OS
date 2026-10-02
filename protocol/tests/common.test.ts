import * as fc from 'fast-check';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';

import { ChmodMode, Ino, Mode, Name, Path, SymlinkTarget, WaitStatus } from '../src/sys/common.ts';
import { INO } from '../src/wellknown.ts';

const first = (schema: v.GenericSchema, input: unknown) =>
  v.safeParse(schema, input, { abortEarly: true });
const errnoOf = (schema: v.GenericSchema, input: unknown): 'ok' | 'ENAMETOOLONG' | 'EINVAL' => {
  const r = first(schema, input);
  if (r.success) return 'ok';
  return r.issues[0].message === 'ENAMETOOLONG' ? 'ENAMETOOLONG' : 'EINVAL';
};

describe('protocol/common: names, paths and limits', () => {
  it('VFS-08 a 256-byte name and a 4097-byte path both return ENAMETOOLONG', () => {
    expect(errnoOf(Name, 'a'.repeat(255))).toBe('ok');
    expect(errnoOf(Name, 'a'.repeat(256))).toBe('ENAMETOOLONG');
    expect(errnoOf(Path, `/${'a'.repeat(4095)}`)).toBe('ok');
    expect(errnoOf(Path, `/${'a'.repeat(4096)}`)).toBe('ENAMETOOLONG');
  });

  it('VFS-08 byte limits count UTF-8 bytes, not characters', () => {
    expect(errnoOf(Name, '\u00e9'.repeat(127))).toBe('ok'); // 254 bytes
    expect(errnoOf(Name, '\u00e9'.repeat(128))).toBe('ENAMETOOLONG'); // 256 bytes
    expect(errnoOf(Name, '\u{1f600}'.repeat(63))).toBe('ok'); // 252 bytes
    expect(errnoOf(Name, '\u{1f600}'.repeat(64))).toBe('ENAMETOOLONG'); // 256 bytes
  });

  it('VFS-08 a 32-level path of short names is accepted', () => {
    expect(errnoOf(Path, `/${Array.from({ length: 32 }, (_, i) => `d${i}`).join('/')}`)).toBe('ok');
  });

  it('PVFS-12 NFD input is normalised to NFC before the byte limit', () => {
    const nfd = 'e\u0301';
    const name = nfd.repeat(127); // 381 bytes as NFD, 254 as NFC
    const r = v.safeParse(Name, name);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.output).toBe('\u00e9'.repeat(127));
      expect(r.output.normalize('NFC')).toBe(r.output);
    }
    const p = v.safeParse(Path, `/home/${nfd}`);
    expect(p.success && p.output).toBe('/home/\u00e9');
  });

  it('PVFS-12 a path or name with a lone surrogate is rejected with EINVAL', () => {
    expect(errnoOf(Path, '/a\ud800b')).toBe('EINVAL');
    expect(errnoOf(Name, '\udc00')).toBe('EINVAL');
    expect(errnoOf(Path, `/${'a'.repeat(5000)}\ud800`)).toBe('EINVAL');
  });

  it('ABI-04 empty paths, NUL bytes and slash, dot and dot-dot names are rejected with EINVAL', () => {
    expect(errnoOf(Path, '')).toBe('EINVAL');
    expect(errnoOf(Path, '/a\u0000b')).toBe('EINVAL');
    for (const name of ['', '.', '..', 'a/b', 'a\u0000'])
      expect(errnoOf(Name, name), JSON.stringify(name)).toBe('EINVAL');
    for (const name of ['...', '.hidden', 'a b', '\ufb01le', '\u202Eevil', 'CON'])
      expect(errnoOf(Name, name), name).toBe('ok');
  });

  it('VFS-05 a symlink target may be empty (ENOENT at the VFS) or dangle, and is limited to 4096 bytes', () => {
    expect(errnoOf(SymlinkTarget, '')).toBe('ok');
    expect(errnoOf(SymlinkTarget, '../does/not/exist')).toBe('ok');
    expect(errnoOf(SymlinkTarget, 'x'.repeat(4096))).toBe('ok');
    expect(errnoOf(SymlinkTarget, 'x'.repeat(4097))).toBe('ENAMETOOLONG');
    expect(errnoOf(SymlinkTarget, 'a\u0000')).toBe('EINVAL');
  });

  it('ABI-04 any string of at most 255 bytes with no slash, NUL, lone surrogate or dot name is a valid name', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'grapheme', maxLength: 60 }), (s) => {
        const ok = first(Name, s).success;
        const nfc = s.normalize('NFC');
        const expected =
          nfc.length > 0 &&
          new TextEncoder().encode(nfc).length <= 255 &&
          !nfc.includes('/') &&
          !nfc.includes('\u0000') &&
          nfc !== '.' &&
          nfc !== '..';
        expect(ok).toBe(expected);
      }),
      { numRuns: 1000 },
    );
  });

  it('PVFS-02 Ino accepts generated and well-known UUIDv7 and rejects other shapes', () => {
    expect(first(Ino, INO.ROOT).success).toBe(true);
    expect(first(Ino, '0192f0c1-8a3b-7c4d-8e5f-0123456789ab').success).toBe(true);
    for (const bad of [
      '0192F0C1-8A3B-7C4D-8E5F-0123456789AB', // upper case
      '0192f0c1-8a3b-4c4d-8e5f-0123456789ab', // version 4
      '0192f0c1-8a3b-7c4d-ce5f-0123456789ab', // variant 110
      '0192f0c18a3b7c4d8e5f0123456789ab', // no dashes
      '',
    ]) {
      expect(first(Ino, bad).success, bad).toBe(false);
    }
  });

  it('VFS-04 modes are 0..0o7777 and chmod changes carry no setuid or setgid bit', () => {
    expect(first(Mode, 0o7777).success).toBe(true);
    expect(first(Mode, 0o10000).success).toBe(false);
    expect(first(Mode, -1).success).toBe(false);
    expect(first(ChmodMode, { op: 'set', bits: 0o1777 }).success).toBe(true);
    expect(first(ChmodMode, { op: 'set', bits: 0o6755 }).success).toBe(false);
    expect(first(ChmodMode, { op: 'delta', add: 0o044, clear: 0o6022 }).success).toBe(true);
  });

  it('ABI-09 a signalled wait status carries 128 + n', () => {
    expect(first(WaitStatus, { kind: 'signaled', signal: 'SIGKILL', code: 137 }).success).toBe(
      true,
    );
    expect(first(WaitStatus, { kind: 'signaled', signal: 'SIGKILL', code: 9 }).success).toBe(false);
  });
});
