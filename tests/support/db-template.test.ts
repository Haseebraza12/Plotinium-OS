import { describe, expect, it } from 'vitest';

import { fingerprint, readMigrations, testDatabaseName, upSection } from './db-template.ts';
import { ident, isPgError, loadPg, withDatabase } from './sql.ts';

describe('TST-23 integration databases from the Compose db service', () => {
  it('TST-23 the up section of a dbmate migration stops at the down marker', () => {
    const sql =
      '-- header\n-- migrate:up\nCREATE TABLE a (x int);\n\n-- migrate:down\nDROP TABLE a;\n';
    expect(upSection(sql)).toBe('CREATE TABLE a (x int);');
    expect(upSection('-- migrate:up transaction:false\nSELECT 1;')).toBe('SELECT 1;');
    expect(() => upSection('SELECT 1;', 'x.sql')).toThrow(/x\.sql has no -- migrate:up/);
  });

  it('TST-23 every committed migration has an up section and they apply in version order', async () => {
    const ms = await readMigrations();
    expect(ms.length).toBeGreaterThan(0);
    expect(ms.map((m) => m.version)).toEqual([...ms.map((m) => m.version)].sort());
    for (const m of ms) expect(m.up.length, m.file).toBeGreaterThan(0);
  });

  it('TST-23 the template fingerprint changes with any migration text', () => {
    const a = [{ version: '20260924100000', file: 'a.sql', up: 'SELECT 1;' }];
    expect(fingerprint(a)).toBe(fingerprint([...a]));
    expect(fingerprint(a)).not.toBe(
      fingerprint([{ ...a[0], up: 'SELECT 2;' } as (typeof a)[number]]),
    );
  });

  it('TST-23 each test file gets its own database name and only safe identifiers are quoted', () => {
    const a = testDatabaseName(new URL('../fault-injection/server.test.ts', import.meta.url).href);
    const b = testDatabaseName(new URL('../integration/probes.test.ts', import.meta.url).href);
    expect(a).toMatch(/^t_[0-9a-f]{12}$/);
    expect(a).not.toBe(b);
    expect(ident(a)).toBe(`"${a}"`);
    expect(() => ident('x"; DROP DATABASE plotinium; --')).toThrow(RangeError);
    expect(withDatabase('postgres://u:p@127.0.0.1:55432/plotinium?sslmode=disable', a)).toBe(
      `postgres://u:p@127.0.0.1:55432/${a}?sslmode=disable`,
    );
  });

  it('TST-23 pg is loaded from the server package and errors are recognised by SQLSTATE', () => {
    expect(typeof loadPg().Pool).toBe('function');
    const err = Object.assign(new Error('injected fault at node op 500 on inodes'), {
      code: 'P0001',
    });
    expect(isPgError(err)).toBe(true);
    expect(isPgError(new Error('plain'))).toBe(false);
  });
});
