import * as fc from 'fast-check';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';

import {
  ABI_VERSION,
  abiDescriptor,
  abiDigest,
  canonicalJson,
  describeSchema,
} from '../src/abi.ts';
import { AuditRecord } from '../src/audit.ts';
import { applyModeChange, parseMode } from '../src/sys/mode.ts';
import { codeSpans, readSpec, section, tables } from './spec-tables.ts';
import { AUDIT } from './samples.ts';

describe('protocol/abi (syscall-abi.md §3.10)', () => {
  it('ABI-10 ABI_VERSION is 1 and the digest is a stable SHA-256 of the registry', () => {
    expect(ABI_VERSION).toBe(1);
    expect(abiDigest()).toMatch(/^[0-9a-f]{64}$/);
    expect(abiDigest()).toBe(abiDigest());
    expect(canonicalJson(abiDescriptor())).toBe(canonicalJson(abiDescriptor()));
  });

  it('ABI-10 the descriptor covers every call and changes when a schema limit changes', () => {
    const d = abiDescriptor() as { calls: { name: string }[] };
    expect(d.calls).toHaveLength(120);
    const a = canonicalJson(describeSchema(v.pipe(v.string(), v.maxLength(5))));
    const b = canonicalJson(describeSchema(v.pipe(v.string(), v.maxLength(6))));
    expect(a).not.toBe(b);
    const c = canonicalJson(describeSchema(v.strictObject({ x: v.optional(v.number(), 1) })));
    const e = canonicalJson(describeSchema(v.strictObject({ x: v.optional(v.number(), 2) })));
    expect(c).not.toBe(e);
    expect(canonicalJson(describeSchema(v.pipe(v.string(), v.regex(/^a+$/))))).toContain(
      '"regex":"^a+$"',
    );
  });

  it('ABI-10 describeSchema ignores function source and canonical JSON ignores key order', () => {
    const x = describeSchema(
      v.pipe(
        v.string(),
        v.check((s) => s.length > 1),
      ),
    );
    const y = describeSchema(
      v.pipe(
        v.string(),
        v.check((s) => s.length > 99),
      ),
    );
    expect(canonicalJson(x)).toBe(canonicalJson(y));
    expect(canonicalJson({ b: 1, a: [2, { d: null, c: 'x' }] })).toBe(
      '{"a":[2,{"c":"x","d":null}],"b":1}',
    );
  });
});

describe('protocol/mode (virtual-file-system.md §5.4)', () => {
  it('VFS-04 chmod parses octal and symbolic modes as in the table of 5.4', () => {
    const rows =
      tables(section(readSpec('04-vfs/virtual-file-system.md'), '### 5.4')).find(
        (t) => t.header[0] === 'Spec',
      )?.rows ?? [];
    expect(rows.length).toBeGreaterThanOrEqual(10);
    for (const r of rows) {
      const spec = codeSpans(r[0] ?? '')[0] ?? '';
      const umask = Number.parseInt(/umask (\d+)/.exec(r[0] ?? '')?.[1] ?? '022', 8);
      const change = parseMode(spec, umask);
      const expected = r[3] ?? '';
      if (/EINVAL/.test(expected) || spec.includes('X')) {
        // X depends on each inode's old mode, so the ABI's single delta cannot express it (see mode.ts).
        expect(change, spec).toBeUndefined();
        continue;
      }
      const oldMode = r[1] === 'any' ? 0o640 : Number.parseInt(codeSpans(r[1] ?? '')[0] ?? '', 8);
      const newMode = Number.parseInt(codeSpans(expected)[0] ?? '', 8);
      expect(change, spec).toBeDefined();
      if (change !== undefined)
        expect(applyModeChange(oldMode, change).toString(8), spec).toBe(newMode.toString(8));
    }
  });

  it('VFS-04 chmod rejects setuid and setgid bits, octal values above 1777 and unsupported symbols', () => {
    for (const spec of [
      '4755',
      '2755',
      '7777',
      '17777',
      '8',
      '',
      'u+s',
      'g+S',
      'o+T',
      'g=u',
      ',',
      'u',
      'z+r',
      'a+X',
    ]) {
      expect(parseMode(spec, 0o022), spec).toBeUndefined();
    }
    expect(parseMode('0', 0o022)).toEqual({ op: 'set', bits: 0 });
    expect(parseMode('1777', 0o022)).toEqual({ op: 'set', bits: 0o1777 });
  });

  it('VFS-04 a symbolic delta equals the clause-by-clause evaluation of 5.4', () => {
    // Reference: the evaluate() pseudo code of virtual-file-system.md §5.4, without X.
    const WHO: Record<string, number> = { u: 0o700, g: 0o070, o: 0o007, a: 0o777 };
    const PERM: Record<string, number> = { r: 0o444, w: 0o222, x: 0o111 };
    const evaluate = (
      clauses: [string, [string, string][]][],
      old: number,
      umask: number,
    ): number => {
      let mode = old;
      for (const [who, actions] of clauses) {
        const implicit = who === '';
        const whoMask = implicit ? 0o777 : [...who].reduce((m, c) => m | (WHO[c] ?? 0), 0);
        for (const [op, perms] of actions) {
          let rwx = [...perms].reduce((m, c) => m | (PERM[c] ?? 0), 0) & whoMask;
          if (implicit && (op === '+' || op === '=')) rwx &= ~umask;
          const sticky = perms.includes('t') && (implicit || /[oa]/.test(who)) ? 0o1000 : 0;
          if (op === '+') mode |= rwx | sticky;
          else if (op === '-') mode &= ~(rwx | sticky);
          else mode = (mode & ~whoMask) | rwx | sticky;
        }
      }
      return mode;
    };
    const who = fc.stringMatching(/^[ugoa]{0,3}$/);
    const action = fc.tuple(fc.constantFrom('+', '-', '='), fc.stringMatching(/^[rwxt]{0,3}$/));
    const clause = fc.tuple(who, fc.array(action, { minLength: 1, maxLength: 3 }));
    fc.assert(
      fc.property(
        fc.array(clause, { minLength: 1, maxLength: 4 }),
        fc.integer({ min: 0, max: 0o1777 }),
        fc.integer({ min: 0, max: 0o777 }),
        (clauses, old, umask) => {
          const spec = clauses
            .map(([w, acts]) => w + acts.map(([op, p]) => op + p).join(''))
            .join(',');
          const change = parseMode(spec, umask);
          expect(change, spec).toBeDefined();
          if (change !== undefined)
            expect(applyModeChange(old, change), spec).toBe(evaluate(clauses, old, umask));
        },
      ),
      { numRuns: 2000 },
    );
  });
});

describe('protocol/audit (syscall-abi.md §4.7)', () => {
  it('ABI-08 an agent audit record validates and fields for file data, passwords or tokens do not exist', () => {
    expect(v.safeParse(AuditRecord, AUDIT).success).toBe(true);
    for (const field of ['password', 'secret', 'token', 'data', 'args', 'content']) {
      expect(v.safeParse(AuditRecord, { ...AUDIT, [field]: 'x' }).success, field).toBe(false);
    }
  });

  it('ABI-08 audit records bound the argument summary to 512 characters and the request to 2000', () => {
    expect(v.safeParse(AuditRecord, { ...AUDIT, argsSummary: 'x'.repeat(512) }).success).toBe(true);
    expect(v.safeParse(AuditRecord, { ...AUDIT, argsSummary: 'x'.repeat(513) }).success).toBe(
      false,
    );
    expect(v.safeParse(AuditRecord, { ...AUDIT, request: 'x'.repeat(2001) }).success).toBe(false);
    expect(v.safeParse(AuditRecord, { ...AUDIT, argsDigest: 'not-a-digest' }).success).toBe(false);
    expect(v.safeParse(AuditRecord, { ...AUDIT, call: 'rm' }).success).toBe(false);
    expect(
      v.safeParse(AuditRecord, {
        ...AUDIT,
        outcome: 'killed_rolled_back',
        errno: 'ECANCELED',
        errnoCode: 125,
      }).success,
    ).toBe(true);
  });
});
