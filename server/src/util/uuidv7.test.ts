import { describe, expect, it } from 'vitest';

import { UUIDV7_RE, uuidv7 } from './uuidv7.ts';

describe('SRV-15 request ids are UUIDv7 (C5, RFC 9562)', () => {
  it('SRV-15 uuidv7 has version 7, variant 10 and the millisecond timestamp in its first 48 bits', () => {
    const t = Date.UTC(2026, 8, 24, 12, 0, 0);
    const id = uuidv7(t);
    expect(id).toMatch(UUIDV7_RE);
    expect(parseInt(id.replaceAll('-', '').slice(0, 12), 16)).toBe(t);
    expect(uuidv7(0, new Uint8Array(10))).toBe('00000000-0000-7000-8000-000000000000');
  });

  it('SRV-15 ids minted later sort after earlier ones', () => {
    const a = uuidv7(1_000);
    const b = uuidv7(1_001);
    expect(a < b).toBe(true);
    expect(() => uuidv7(-1)).toThrow(RangeError);
  });
});
