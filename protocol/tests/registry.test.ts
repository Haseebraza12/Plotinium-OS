import * as v from 'valibot';
import { describe, expect, it } from 'vitest';

import { CAP_NAMES } from '../src/caps.ts';
import type { Cap } from '../src/caps.ts';
import { ERRNO_NAMES } from '../src/errno.ts';
import type { Errno } from '../src/errno.ts';
import { CALL_NAMES, isAiCall } from '../src/sys/names.ts';
import { CALLS, callTable, lookupCall, requiredCaps } from '../src/sys/registry.ts';
import type { CallAudit, CallClass, CallSpec } from '../src/sys/registry.ts';
import { codeSpans, readSpec, section, tables } from './spec-tables.ts';

interface CatalogueRow {
  readonly name: string;
  readonly may: boolean;
  readonly cls: string;
  readonly org: string;
  readonly caps: string;
  readonly errnos: string;
  readonly audit: string;
}

const catalogueText = section(
  readSpec('01-architecture/syscall-abi.md'),
  '### 4.4 System-call catalogue',
);
const ROWS: CatalogueRow[] = tables(catalogueText)
  .filter((t) => t.header[0] === 'Call' && t.header[2] === 'Cls')
  .flatMap((t) =>
    t.rows.map((r) => ({
      name: codeSpans(r[0] ?? '')[0] ?? '',
      may: /\(may\b/.test(r[0] ?? ''),
      cls: r[2] ?? '',
      org: r[3] ?? '',
      caps: r[4] ?? '',
      errnos: r[6] ?? '',
      audit: r[7] ?? '',
    })),
  );
const byName = new Map(ROWS.map((row) => [row.name, row]));

function asTarget(cell: string): string | undefined {
  return /^as `([^`]+)`/.exec(cell.trim())?.[1];
}

function specClasses(row: CatalogueRow): CallClass[] {
  const target = asTarget(row.cls);
  if (target !== undefined) return specClasses(byName.get(target) as CatalogueRow);
  return row.cls
    .replace(/\([^)]*\)/g, '')
    .split(';')
    .map((part) => part.trim()[0] ?? '')
    .filter((c): c is CallClass => 'FTBXR'.includes(c) && c !== '');
}

function specErrnos(row: CatalogueRow): Set<string> {
  const target = asTarget(row.errnos);
  if (target !== undefined) return specErrnos(byName.get(target) as CatalogueRow);
  return new Set(
    [...row.errnos.matchAll(/\bE[A-Z]+\b/g)]
      .map((m) => m[0])
      .filter((e) => ERRNO_NAMES.includes(e as Errno)),
  );
}

function specCaps(cell: string): { base: Set<string>; conditional: Set<string> } {
  const base = new Set<string>();
  const conditional = new Set<string>();
  for (const segment of cell.split(/;|, \*\*or\*\*|, plus| \(/)) {
    const caps = codeSpans(segment).filter((c) => (CAP_NAMES as readonly string[]).includes(c));
    const qualified = /\bfor\b|\bneeds\b|\bplus\b/.test(segment);
    for (const cap of caps) (qualified ? conditional : base).add(cap);
  }
  return { base, conditional };
}

function specAudit(cell: string): CallAudit {
  const c = cell.trim();
  if (c === 'T') return 'trace';
  if (c === '**S**') return 'security';
  if (c === 'agent') return 'agent';
  if (c.startsWith('none')) return 'none';
  if (/^S (if|for)\b/.test(c)) return 'conditional';
  throw new Error(`unknown audit cell: ${cell}`);
}

const spec = (name: string): CallSpec => CALLS[name as keyof typeof CALLS];

describe('protocol/registry: conformance with syscall-abi.md §4.4', () => {
  it('ABI-11 the catalogue tables were found and list 120 calls', () => {
    expect(ROWS.length).toBe(120);
    expect(new Set(ROWS.map((r) => r.name)).size).toBe(ROWS.length);
  });

  it('ABI-11 every call listed in syscall-abi.md section 4.4 exists in CALLS with the same class, origin and caps', () => {
    for (const row of ROWS) {
      const s = lookupCall(row.name);
      expect(s, row.name).toBeDefined();
      if (s === undefined) continue;
      const [cls, alt] = specClasses(row);
      expect(s.cls, `${row.name} class`).toBe(cls);
      expect(s.clsAlt, `${row.name} second class`).toBe(alt);
      expect(s.origin, `${row.name} origin`).toBe(/^(EV|E|V)\b/.exec(row.org.trim())?.[1]);
      const { base, conditional } = specCaps(row.caps);
      expect(new Set(s.caps), `${row.name} caps`).toEqual(base);
      const declared = new Set<string>([
        ...(s.capsDynamic ?? []),
        ...(s.capsAgent ?? []),
        ...(s.capsCrossUid ?? []),
      ]);
      expect(declared, `${row.name} conditional caps`).toEqual(conditional);
      expect(s.may === true, `${row.name} may`).toBe(row.may);
    }
  });

  it('ABI-11 CALLS has no call that the catalogue does not list, in catalogue order', () => {
    expect([...CALL_NAMES]).toEqual(ROWS.map((r) => r.name));
    expect(Object.keys(CALLS).sort()).toEqual([...CALL_NAMES].sort());
  });

  it("ABI-11 every call's errno list and audit level match syscall-abi.md section 4.4", () => {
    for (const row of ROWS) {
      const s = spec(row.name);
      expect(new Set(s.errnos), `${row.name} errnos`).toEqual(specErrnos(row));
      expect(s.audit, `${row.name} audit`).toBe(specAudit(row.audit));
    }
  });

  it('ABI-11 every CallName has args and return schemas, a class, an origin, caps, an audit level, an errno list and a man 2 page', () => {
    for (const name of CALL_NAMES) {
      const s = spec(name);
      expect(s.args.kind, name).toBe('schema');
      expect(s.ret.kind, name).toBe('schema');
      expect(['F', 'T', 'B', 'X', 'R']).toContain(s.cls);
      expect(['E', 'V', 'EV']).toContain(s.origin);
      expect(s.caps.every((c) => (CAP_NAMES as readonly string[]).includes(c))).toBe(true);
      expect(['none', 'trace', 'security', 'conditional', 'agent']).toContain(s.audit);
      expect(s.errnos.every((e) => ERRNO_NAMES.includes(e))).toBe(true);
      expect(new Set(s.errnos).size, `${name} duplicate errno`).toBe(s.errnos.length);
      expect(s.man.length, name).toBeGreaterThan(8);
      expect(s.man.length, name).toBeLessThanOrEqual(80);
      expect(s.group === 'ai', name).toBe(isAiCall(name));
    }
  });

  it('ABI-11 exactly the batch, ai.agent.plan, ai.agent.submit and ai.index.put calls are large', () => {
    const large = CALL_NAMES.filter((n) => spec(n).large === true);
    expect(large.sort()).toEqual(['ai.agent.plan', 'ai.agent.submit', 'ai.index.put', 'batch']);
  });

  it('ABI-11 lookupCall returns undefined for unknown names and inherited object keys', () => {
    expect(lookupCall('stat')).toBe(CALLS.stat);
    for (const name of ['nope', 'toString', '__proto__', 'constructor', 'hasOwnProperty', '']) {
      expect(lookupCall(name), name).toBeUndefined();
    }
  });
});

describe('protocol/registry: dispatch tables', () => {
  it('ABI-15 the view table holds only V and EV calls and never write, unlink or spawn', () => {
    const view = callTable('V', { ai: true });
    for (const [name, s] of view) expect(['V', 'EV'], name).toContain(s.origin);
    for (const name of ['write', 'unlink', 'spawn', 'batch', 'writeFile', 'kill'])
      expect(view.has(name as never), name).toBe(false);
    expect(view.has('tty.input')).toBe(true);
    expect(view.has('auth.login')).toBe(true);
  });

  it('ABI-15 the executor table holds only E and EV calls and never view-only calls', () => {
    const exec = callTable('E', { ai: true });
    for (const [name, s] of exec) expect(['E', 'EV'], name).toContain(s.origin);
    for (const name of ['tty.input', 'tty.resize', 'auth.login', 'ai.search.focus'])
      expect(exec.has(name as never), name).toBe(false);
    expect(exec.size + callTable('V', { ai: true }).size).toBe(
      CALL_NAMES.length + CALL_NAMES.filter((n) => spec(n).origin === 'EV').length,
    );
  });

  it('ARC-06 the AI-off tables answer ENOSYS for every ai call because none is present', () => {
    for (const origin of ['E', 'V'] as const) {
      const table = callTable(origin, { ai: false });
      expect([...table.keys()].some((n) => n.startsWith('ai.'))).toBe(false);
      expect(table.size).toBe(
        [...callTable(origin, { ai: true }).keys()].filter((n) => !n.startsWith('ai.')).length,
      );
    }
  });
});

describe('protocol/registry: stage 4 capabilities', () => {
  const caps = (name: string, args: unknown, cls: 'user' | 'agent' | 'system' = 'user'): Cap[] =>
    [...requiredCaps(spec(name), args, cls)].sort();

  it('ABI-06 open needs fs.read for r, fs.write for w, a, create and trunc, and both for rw', () => {
    expect(caps('open', { path: '/a', flags: 'r' })).toEqual(['fs.read']);
    expect(caps('open', { path: '/a', flags: 'w' })).toEqual(['fs.write']);
    expect(caps('open', { path: '/a', flags: 'a' })).toEqual(['fs.write']);
    expect(caps('open', { path: '/a', flags: 'rw' })).toEqual(['fs.read', 'fs.write']);
    expect(caps('open', { path: '/a', flags: 'r', create: true })).toEqual(['fs.read', 'fs.write']);
    expect(caps('open', { path: '/a', flags: 'r', trunc: true })).toEqual(['fs.read', 'fs.write']);
  });

  it('ABI-06 fsck repair, sysctl.set of a global key, ai.index.status files and mmap rw add their capability', () => {
    expect(caps('fsck', {})).toEqual(['fs.read']);
    expect(caps('fsck', { repair: true })).toEqual(['fs.read', 'sys.admin']);
    expect(caps('sysctl.set', { key: 'ui.theme', value: 'dark' })).toEqual([]);
    expect(caps('sysctl.set', { key: 'mm.budgetMB', value: 256 })).toEqual([]);
    expect(caps('sysctl.set', { key: 'sched.tAge', value: 100 })).toEqual([]);
    expect(caps('sysctl.set', { key: 'boot.showMenuNextBoot', value: true })).toEqual([]);
    expect(caps('sysctl.set', { key: 'net.leaseTtlMs', value: 15_000 })).toEqual(['sys.admin']);
    expect(caps('ai.index.status', {})).toEqual([]);
    expect(caps('ai.index.status', { files: true })).toEqual(['ai.index']);
    expect(caps('mmap', { path: '/a', flags: 'r' })).toEqual(['fs.read']);
    expect(caps('mmap', { path: '/a', flags: 'rw' })).toEqual(['fs.read', 'fs.write']);
  });

  it('ABI-06 an agent-class caller needs batch.grant instead of fs.write for batch', () => {
    const args = {
      txnId: '0192f0c1-8a3b-7c4d-8e5f-0123456789ab',
      ops: [{ op: 'unlink', path: '/a' }],
      expectedVersions: [],
    };
    expect(caps('batch', args, 'user')).toEqual(['fs.write']);
    expect(caps('batch', args, 'agent')).toEqual(['batch.grant']);
    expect(caps('unlink', { path: '/a' }, 'agent')).toEqual(['fs.write']);
  });

  it('ABI-06 capsFor only names capabilities declared in capsDynamic', () => {
    for (const name of CALL_NAMES) {
      const s = spec(name);
      expect(s.capsFor === undefined, name).toBe(s.capsDynamic === undefined);
    }
  });
});

describe('protocol/registry: window geometry is never a system call', () => {
  it('WM-01 the call registry contains no call that sets window geometry or z-order', () => {
    const geometry = /(move|resize|geometry|bounds|zorder|z-order|raise|lower|maximi|minimi|snap)/i;
    for (const name of CALL_NAMES) {
      if (name === 'tty.resize') continue; // terminal cols and rows, not window geometry
      expect(geometry.test(name), name).toBe(false);
    }
    for (const name of CALL_NAMES.filter((n) => n.startsWith('window.') && n !== 'window.create')) {
      const entries = (spec(name).args as unknown as { entries: Record<string, unknown> }).entries;
      for (const key of ['x', 'y', 'w', 'h', 'rect', 'z', 'zIndex'])
        expect(key in entries, `${name}.${key}`).toBe(false);
    }
  });
});

describe('protocol/registry: Valibot conventions (§3.11)', () => {
  type Node = Record<string, unknown>;
  const children = (n: Node): unknown[] => [
    ...Object.values((n['entries'] as Node | undefined) ?? {}),
    ...((n['options'] as unknown[] | undefined) ?? []).filter(
      (o) => typeof o === 'object' && o !== null,
    ),
    ...((n['items'] as unknown[] | undefined) ?? []),
    ...['item', 'wrapped', 'key', 'value']
      .map((k) => n[k])
      .filter((c) => typeof c === 'object' && c !== null),
    ...((n['pipe'] as unknown[] | undefined) ?? []).slice(1),
  ];
  function walk(root: unknown, visit: (node: Node, parent: Node | undefined) => void): void {
    const stack: [unknown, Node | undefined][] = [[root, undefined]];
    while (stack.length > 0) {
      const [node, parent] = stack.pop() as [unknown, Node | undefined];
      if (node === null || typeof node !== 'object') continue;
      visit(node as Node, parent);
      for (const child of children(node as Node)) stack.push([child, node as Node]);
    }
  }
  const pipeTypes = (n: Node): string[] =>
    ((n['pipe'] as Node[] | undefined) ?? []).map((a) => String(a['type']));
  const unboundedRegex = (n: Node): boolean =>
    ((n['pipe'] as Node[] | undefined) ?? []).some((a) => {
      if (a['type'] !== 'regex') return false;
      const src = (a['requirement'] as RegExp).source.replace(/\\./g, '');
      return /[*+]|\{\d+,\}/.test(src);
    });

  it('ABI-04 every object schema in every args and return schema is strict', () => {
    for (const name of CALL_NAMES) {
      for (const schema of [spec(name).args, spec(name).ret]) {
        walk(schema, (node) => {
          expect(
            ['object', 'loose_object', 'object_with_rest'],
            `${name}: ${String(node['type'])}`,
          ).not.toContain(node['type']);
        });
      }
    }
  });

  it('ABI-04 the only schema message used anywhere is the errno tag ENAMETOOLONG', () => {
    for (const name of CALL_NAMES) {
      for (const schema of [spec(name).args, spec(name).ret]) {
        walk(schema, (node) => {
          for (const action of [node, ...((node['pipe'] as Node[] | undefined) ?? [])]) {
            const message = action['message'];
            expect(
              message === undefined || message === 'ENAMETOOLONG',
              `${name}: ${String(message)}`,
            ).toBe(true);
          }
        });
      }
    }
  });

  it('ABI-13 every string, array and record in call arguments has a limit, and only large calls take unknown values', () => {
    for (const name of CALL_NAMES) {
      const s = spec(name);
      walk(s.args, (node, parent) => {
        const type = node['type'];
        const where = `${name}: ${String(type)}`;
        if (type === 'string') {
          const host = node['pipe'] !== undefined ? node : parent;
          const actions = host === undefined ? [] : pipeTypes(host);
          const bounded =
            ['max_length', 'max_bytes', 'length'].some((t) => actions.includes(t)) ||
            (actions.includes('regex') && host !== undefined && !unboundedRegex(host));
          expect(bounded, where).toBe(true);
        }
        if (type === 'array')
          expect(
            pipeTypes(node).some((t) => t === 'max_length' || t === 'length'),
            where,
          ).toBe(true);
        if (type === 'record') expect(pipeTypes(node).includes('max_entries'), where).toBe(true);
        if (type === 'unknown' || type === 'any') expect(s.large, where).toBe(true);
      });
    }
  });

  it('ABI-13 binary fields are ArrayBuffer or typed-array instances, never strings', () => {
    for (const name of ['write', 'writeFile'] as const) {
      const data = (
        spec(name).args as unknown as { entries: { data: { type: string; class: unknown } } }
      ).entries.data;
      expect(data.type).toBe('instance');
      expect(data.class).toBe(ArrayBuffer);
    }
    expect(v.safeParse(CALLS.read.ret, new ArrayBuffer(1)).success).toBe(true);
    expect(v.safeParse(CALLS.read.ret, 'bytes').success).toBe(false);
  });
});
