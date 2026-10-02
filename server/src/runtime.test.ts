import { execFile } from 'node:child_process';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, withPassword, type Database } from './db/client.ts';
import { defaultStatusFor, ERRNOS, isErrno } from './errno.ts';
import { createMetrics, startMetricsServer } from './obs/metrics.ts';
import { newestMigrationIn, runDbChecks } from './selftest/db-checks.ts';

const run = promisify(execFile);
const here = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

async function exitOf(
  args: string[],
  env: Record<string, string>,
): Promise<{ code: number; stderr: string }> {
  try {
    await run(process.execPath, args, {
      env: { PATH: process.env['PATH'] ?? '', ...env },
      timeout: 20_000,
    });
    return { code: 0, stderr: '' };
  } catch (e) {
    const err = e as { code?: number; stderr?: string };
    return { code: err.code ?? -1, stderr: err.stderr ?? '' };
  }
}

describe('SRV-04 the errno vocabulary (syscall-abi.md §4.3; backend-api.md §3.5)', () => {
  it('SRV-04 the server uses exactly the 25 C3 errnos of @plotinium/protocol, each with an HTTP status', () => {
    expect(ERRNOS).toHaveLength(25);
    for (const e of ERRNOS) {
      expect(isErrno(e)).toBe(true);
      expect([400, 403, 404, 409, 413, 422, 429, 500, 503, 504]).toContain(defaultStatusFor(e));
    }
    expect(isErrno('ESTALE')).toBe(false);
    expect([
      defaultStatusFor('EDQUOT'),
      defaultStatusFor('EAGAIN'),
      defaultStatusFor('ETIMEDOUT'),
    ]).toEqual([413, 429, 504]);
  });
});

describe('SRV-15 the internal metrics listener (backend-api.md §3.16)', () => {
  it('SRV-15 GET /metrics serves the Prometheus text and every other path is 404', async () => {
    const metrics = createMetrics({ defaultMetrics: false });
    metrics.authLogins.inc({ result: 'success' });
    const server = await startMetricsServer(metrics, '127.0.0.1', 0);
    const { port } = server.address() as AddressInfo;
    const get = (path: string) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        request({ host: '127.0.0.1', port, path }, (res) => {
          let body = '';
          res.on('data', (c: Buffer) => (body += c.toString()));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        })
          .on('error', reject)
          .end();
      });
    try {
      const m = await get('/metrics');
      expect(m.status).toBe(200);
      expect(m.body).toContain('plotinium_auth_logins_total{result="success"} 1');
      expect((await get('/')).status).toBe(404);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await expect(startMetricsServer(metrics, '203.0.113.1', 1)).rejects.toThrow();
  });
});

describe('SRV-02 process entry points refuse bad input with sysexits codes', () => {
  it('SRV-02 main.ts exits 78 on an invalid configuration and names the variable', async () => {
    const r = await exitOf([here('./main.ts')], {
      PLOTINIUM_ENV: 'production',
      FAULT_INJECTION: '1',
    });
    expect(r.code).toBe(78);
    expect(r.stderr).toContain('FAULT_INJECTION');
  });

  it('SRV-20 the seed CLI exits 64 without --demo and 78 without OWNER_DATABASE_URL', async () => {
    expect((await exitOf([here('./seed.ts')], {})).code).toBe(64);
    expect((await exitOf([here('./seed.ts'), '--demo', '--bench-profile', 'huge'], {})).code).toBe(
      64,
    );
    const noUrl = await exitOf([here('./seed.ts'), '--demo'], {});
    expect(noUrl.code).toBe(78);
    expect(noUrl.stderr).toContain('OWNER_DATABASE_URL');
  });

  it('SRV-02 a password file value is put into the connection URL, never logged', () => {
    expect(withPassword('postgres://plotinium_app@db:5432/plotinium', 'a/b@c')).toBe(
      'postgres://plotinium_app:a%2Fb%40c@db:5432/plotinium',
    );
    expect(withPassword('postgres://u@h/d', undefined)).toBe('postgres://u@h/d');
  });
});

const URL_ = process.env['DATABASE_URL'];

describe.runIf(URL_ !== undefined)(
  'SRV-17 database self-tests against PostgreSQL 18 (backend-api.md §3.18.2)',
  () => {
    let database: Database;
    beforeAll(() => {
      database = createDatabase({
        url: URL_ ?? '',
        password: undefined,
        poolMax: 2,
        statementTimeoutMs: 10_000,
        lockTimeoutMs: 2_000,
      });
    });
    afterAll(async () => {
      await database.close();
    });

    it('SRV-17 PostgreSQL 18, pgvector 0.8.6, the builtin locale provider and the build migration pass; a newer build fails', async () => {
      const expected = newestMigrationIn(here('../../db/migrations'));
      const r = await runDbChecks(database, expected);
      expect(Math.floor(r.serverVersionNum / 10_000)).toBe(18);
      expect(r).toMatchObject({
        vectorVersion: '0.8.6',
        localeProvider: 'b',
        appliedMigration: expected,
      });
      expect(Math.abs(r.clockSkewMs)).toBeLessThan(2_000);
      expect((await runDbChecks(database, '20200101000000')).warnings.join()).toMatch(
        /newer than this build/,
      );
      await expect(runDbChecks(database, '29990101000000')).rejects.toThrow(
        /migrations behind the build/,
      );
    });
  },
);
