import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { argon2Available } from '../gateway/argon2.ts';
import { newestMigrationIn } from './db-checks.ts';
import { argon2KnownAnswer, SelfTestError, sha256KnownAnswer } from './kat.ts';

describe('SRV-17 startup self-tests (backend-api.md §3.18.2)', () => {
  it.runIf(argon2Available())(
    'SRV-17 the RFC 9106 Argon2id known answer passes on this Node build',
    async () => {
      await expect(argon2KnownAnswer()).resolves.toBeUndefined();
    },
  );

  it.runIf(argon2Available())(
    'SRV-17 the Argon2id known-answer test fails startup when the tag differs',
    async () => {
      await expect(argon2KnownAnswer('00'.repeat(32))).rejects.toBeInstanceOf(SelfTestError);
    },
  );

  it('SRV-17 the SHA-256 known answer passes and a wrong vector fails', () => {
    expect(() => sha256KnownAnswer()).not.toThrow();
    expect(() => sha256KnownAnswer('00')).toThrow(SelfTestError);
  });

  it('SRV-17 the build newest migration is read from the dbmate file names', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'plt-mig-'));
    try {
      await writeFile(join(dir, '20261019090000_a.sql'), '');
      await writeFile(join(dir, '20261109090000_b.sql'), '');
      await writeFile(join(dir, 'README.md'), '');
      expect(newestMigrationIn(dir)).toBe('20261109090000');
      expect(newestMigrationIn(join(dir, 'missing'))).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('SRV-17 the repository migrations directory has a newest version', () => {
    const newest = newestMigrationIn(
      fileURLToPath(new URL('../../../db/migrations', import.meta.url)),
    );
    expect(newest).toMatch(/^\d{14}$/);
  });
});
