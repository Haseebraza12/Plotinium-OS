import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const DIR = fileURLToPath(new URL('../migrations/', import.meta.url));
const files = readdirSync(DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort();

describe('DB-01 migration files (database.md §3.25)', () => {
  it('DB-01 every migration is a dbmate file named YYYYMMDDHHMMSS_snake_name.sql with an up and a down section', () => {
    expect(files.length).toBeGreaterThanOrEqual(6);
    for (const f of files) {
      expect(f).toMatch(/^\d{14}_[a-z0-9_]+\.sql$/);
      const text = readFileSync(`${DIR}${f}`, 'utf8');
      const up = text.indexOf('-- migrate:up');
      const down = text.indexOf('-- migrate:down');
      expect(up, f).toBeGreaterThanOrEqual(0);
      expect(down, f).toBeGreaterThan(up);
      expect(
        text.slice(down + '-- migrate:down'.length).trim().length,
        `${f} has an empty down section`,
      ).toBeGreaterThan(0);
    }
  });

  it('DB-01 every migration declares whether it is expand-only or a contract migration', () => {
    for (const f of files)
      expect(readFileSync(`${DIR}${f}`, 'utf8'), f).toMatch(/^-- Kind: (expand|contract)\b/m);
  });

  it('DB-01 every table a migration creates is dropped by its down section', () => {
    for (const f of files) {
      const text = readFileSync(`${DIR}${f}`, 'utf8');
      const [up = '', down = ''] = text.split('-- migrate:down');
      const created = [...up.matchAll(/CREATE TABLE (\w+)/g)].map((m) => m[1]);
      for (const t of created)
        expect(down, `${f} drops ${t}`).toMatch(new RegExp(`DROP TABLE ${t};`));
    }
  });

  it('DB-04 the schema keeps the spec constraints: types, modes, names, one writer, acyclicity and the fault hook', () => {
    const all = files.map((f) => readFileSync(`${DIR}${f}`, 'utf8')).join('\n');
    for (const needle of [
      "CHECK (type IN ('f','d','l'))",
      'CHECK (mode BETWEEN 0 AND 4095)',
      "CHECK ((type = 'l') = (symlink_target IS NOT NULL))",
      'CHECK (octet_length(name) <= 255)',
      'CHECK (name IS NFC NORMALIZED)',
      'EXCLUDE USING gist (ino WITH =, mode WITH <>)',
      "CREATE UNIQUE INDEX locks_one_writer ON locks (ino) WHERE mode = 'X'",
      'CHECK (uid = 0 OR used_bytes  <= quota_bytes)',
      "ERRCODE    = 'PTC01'",
      "current_setting('plotinium.fault_after', true)",
      'embedding     vector(384)',
      'COLLATE pg_c_utf8',
    ]) {
      expect(all, needle).toContain(needle);
    }
  });
});
