import { describe, expect, it } from 'vitest';

import {
  blockingGate,
  checkQuarantine,
  loadQuarantine,
  type QuarantineEntry,
} from './quarantine.ts';

const NOW = Date.parse('2026-10-20T12:00:00Z');
const entry = (patch: Partial<QuarantineEntry> = {}): QuarantineEntry => ({
  title: 'VFS-09 a lease held by a tab hidden for 6 minutes is still held',
  file: 'tests/e2e/lock-contention.spec.ts',
  project: 'e2e',
  issue: 41,
  owner: 'R2',
  since: '2026-10-18',
  expires: '2026-10-25',
  ...patch,
});

describe('TST-16 flaky-test quarantine', () => {
  it('TST-16 the committed quarantine file is valid', () => {
    expect(checkQuarantine(loadQuarantine(), NOW)).toEqual([]);
  });

  it('TST-16 an expired quarantine entry fails lint and a third entry is rejected', () => {
    expect(
      checkQuarantine({ entries: [entry({ since: '2026-10-10', expires: '2026-10-17' })] }, NOW),
    ).toEqual([
      'entries[0] (VFS-09 a lease held by a tab hidden for 6 minutes is still held): expired on 2026-10-17',
    ]);
    expect(checkQuarantine({ entries: [entry(), entry(), entry()] }, NOW)).toContain(
      '3 tests in quarantine; at most 2 are allowed',
    );
  });

  it('TST-16 an entry needs an ID-first title, an issue, an owner and at most 7 days', () => {
    const errors = checkQuarantine(
      {
        entries: [
          {
            ...entry({ title: 'flaky thing', owner: 'R9' as 'R1', expires: '2026-11-30' }),
            issue: 'x',
          },
        ],
      },
      NOW,
    );
    expect(errors.join('\n')).toMatch(/requirement ID/);
    expect(errors.join('\n')).toMatch(/issue number/);
    expect(errors.join('\n')).toMatch(/owner must be/);
    expect(errors.join('\n')).toMatch(/more than 7 days/);
    expect(checkQuarantine({ entries: [{ ...entry(), since: 'soon' }] }, NOW)).toEqual([
      'entries[0] (VFS-09 a lease held by a tab hidden for 6 minutes is still held): since and expires must be ISO dates',
    ]);
    expect(checkQuarantine({ entries: [{ ...entry(), file: 3 }] }, NOW).join('')).toMatch(
      /file and project/,
    );
    expect(checkQuarantine([], NOW)).toEqual(['quarantine.json must be { "entries": [...] }']);
  });

  it('TST-16 the release job refuses to tag while a gate-relevant test is quarantined', () => {
    expect(blockingGate([entry()], new Set(['VFS-09', 'OFF-01']))).toEqual([entry().title]);
    expect(blockingGate([entry()], new Set(['OFF-01']))).toEqual([]);
  });
});
