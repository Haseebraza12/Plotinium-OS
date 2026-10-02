import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { PROBES_PATH, probeStatement } from '../fault-injection/server.ts';

describe('TST-09 server probes', () => {
  it('TST-09 the psql probe script becomes one plain statement with the root bound', () => {
    const sql = probeStatement(
      readFileSync(PROBES_PATH, 'utf8'),
      '00000000-0000-7000-8000-000000000001',
    );
    expect(sql).not.toMatch(/^\\/m);
    expect(sql).not.toMatch(/^\s*(BEGIN|COMMIT)\b/im);
    expect(sql).not.toContain(":'root'");
    expect(sql).toContain("'00000000-0000-7000-8000-000000000001'");
    for (const p of [
      'P1_orphan',
      'P2_parentless',
      'P3_unreachable',
      'P4_nlink',
      'P5_quota',
      'P6_refcount',
    ]) {
      expect(sql).toContain(p);
    }
    expect(sql.endsWith(';')).toBe(false);
  });

  it('TST-09 a root that is not a uuid is refused', () => {
    expect(() => probeStatement("SELECT :'root'", "x'; DROP TABLE inodes; --")).toThrow(RangeError);
    expect(
      probeStatement(
        "\\if :{?root}\n\\else\n  \\set root 'x'\n\\endif\nBEGIN;\nSELECT :'root';\nCOMMIT;",
      ),
    ).toBe("SELECT '00000000-0000-7000-8000-000000000001'");
  });
});
