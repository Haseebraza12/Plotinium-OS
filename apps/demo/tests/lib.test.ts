/// <reference types="vite/client" />
import { describe, expect, it } from 'vitest';

import { AppManifestSchema, CAP_NAMES } from '@plotinium/protocol';
import type { ProgramContext } from '@plotinium/kernel/sys';

import { DEMO_ARGSPEC, DEMO_MANIFESTS, DEMO_PROGRAMS, demoProgram } from '../index.ts';
import type { DemoName } from '../lib/cli.ts';
import {
  basename,
  binSize,
  clockMs,
  dirname,
  helpText,
  homeOf,
  parseSize,
  thousands,
  usageText,
} from '../lib/cli.ts';
import { backendFor, ctxMemOf } from '../lib/pages.ts';
import type { PageKey } from '../lib/pattern.ts';
import {
  checksum,
  compressibleLine,
  fillPage,
  mulberry32,
  mulberryStep,
  pageBytes,
  pageSeed,
} from '../lib/pattern.ts';
import { FakeKernel } from './fakesys.ts';

const PAGES = import.meta.glob<string>('../man/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
});

interface Front {
  name: string;
  section: number;
  summary: string;
  synopsis: string;
  owner: string;
  requirements: string[];
  flags: { short: string | null; long: string | null; arg: string | null; desc: string }[];
  seeAlso: string[];
}

function front(text: string): Front {
  const m = /^---json\n([\s\S]*?)\n---\n/.exec(text);
  if (m === null) throw new Error('no front matter');
  return JSON.parse(m[1] ?? '') as Front;
}

const NAMES = Object.keys(DEMO_PROGRAMS) as DemoName[];

describe('man pages and flags', () => {
  it('SYS-02 every demo program has a man page and every man page has a program', () => {
    const pages = Object.keys(PAGES)
      .map((p) => p.replace(/^.*\/(.*)\.md$/, '$1'))
      .sort();
    expect(pages).toEqual([...NAMES].sort());
    expect(NAMES.sort()).toEqual(['burn', 'idx50k', 'lockdemo', 'memhog', 'mktree']);
  });

  it("SYS-02 each program's option parser accepts exactly the flags of its man front matter (argspec.gen.ts is current)", () => {
    for (const [path, text] of Object.entries(PAGES)) {
      const fm = front(text);
      expect(path).toContain(`/${fm.name}.md`);
      const gen = DEMO_ARGSPEC[fm.name as DemoName];
      expect(gen.synopsis).toBe(fm.synopsis);
      expect(gen.summary).toBe(fm.summary);
      expect(gen.flags.map((f) => [f.short, f.long, f.arg, f.desc])).toEqual(
        fm.flags.map((f) => [f.short, f.long, f.arg, f.desc]),
      );
    }
  });

  it('SYS-02 every page has the coreutils sections, a requirement list and its flags under OPTIONS', () => {
    for (const text of Object.values(PAGES)) {
      const fm = front(text);
      expect(fm.section).toBe(1);
      expect(['R1', 'R2', 'R3', 'R4', 'R5']).toContain(fm.owner);
      expect(fm.requirements.length).toBeGreaterThan(0);
      const body = text.slice(text.indexOf('\n---\n') + 5);
      const sections = [...body.matchAll(/^# (.+)$/gm)].map((m) => m[1]);
      expect(sections).toEqual([
        'NAME',
        'SYNOPSIS',
        'DESCRIPTION',
        'OPTIONS',
        'EXIT STATUS',
        'ERRORS',
        'EXAMPLES',
        'SEE ALSO',
      ]);
      expect(body).toContain(`${fm.name} — ${fm.summary}`);
      expect(body).toContain(`\`${fm.synopsis}\``);
      const options = body.slice(body.indexOf('# OPTIONS'), body.indexOf('# EXIT STATUS'));
      for (const f of fm.flags) {
        const label = [f.short, f.long].filter((x) => x !== null).join(', ');
        expect(options).toContain(`\`${label}${f.arg === null ? '' : ` ${f.arg}`}\` — ${f.desc}`);
        expect(f.desc.length).toBeLessThanOrEqual(80);
        if (f.short !== null) expect(f.short).toMatch(/^-[A-Za-z0-9]$/);
        if (f.long !== null) expect(f.long).toMatch(/^--[a-z][a-z0-9-]*$/);
      }
      const seeAlso = body.slice(body.indexOf('# SEE ALSO'));
      for (const name of fm.seeAlso) expect(seeAlso).toContain(`${name}(1)`);
    }
  });

  it('SYS-02 --help prints the synopsis and every flag from the man page and exits 0', () => {
    const k = new FakeKernel();
    for (const name of NAMES) {
      const r = k.run(DEMO_PROGRAMS[name], [name, '--help']);
      expect(r.status).toBe(0);
      expect(r.err).toBe('');
      expect(r.out).toBe(helpText(name));
      expect(r.out.split('\n')[0]).toBe(`Usage: ${DEMO_ARGSPEC[name].synopsis}`);
      for (const f of DEMO_ARGSPEC[name].flags) expect(r.out).toContain(String(f.long));
    }
    expect(usageText('burn', 'burn: bad')).toBe(
      `burn: bad\nUsage: ${DEMO_ARGSPEC.burn.synopsis}\nTry 'man burn'.\n`,
    );
  });

  it('SYS-02 the /bin manifests are valid, one per program, with capabilities from the registry', () => {
    expect(DEMO_MANIFESTS.map((m) => m.name).sort()).toEqual([...NAMES].sort());
    for (const m of DEMO_MANIFESTS) {
      // Standard Schema validation of the protocol schema (apps do not depend on valibot).
      const result = AppManifestSchema['~standard'].validate(m);
      if (result instanceof Promise || result.issues !== undefined)
        throw new Error(`invalid manifest ${m.name}`);
      const parsed = result.value;
      expect(parsed.kind).toBe('command');
      for (const cap of parsed.caps) expect(CAP_NAMES).toContain(cap);
      expect(demoProgram(m.name)).toBe(DEMO_PROGRAMS[m.name as DemoName]);
      expect(Boolean(parsed.checkpointable)).toBe(
        Boolean(DEMO_PROGRAMS[m.name as DemoName].checkpointable),
      );
    }
    expect(demoProgram('ls')).toBeUndefined();
    expect(demoProgram('constructor')).toBeUndefined();
  });
});

describe('option values and formatting', () => {
  it('KMM-14 sizes take binary K, M and G suffixes', () => {
    expect(parseSize('512M')).toBe(536_870_912);
    expect(parseSize('50K')).toBe(51_200);
    expect(parseSize('1.5G')).toBe(1_610_612_736);
    expect(parseSize('4096')).toBe(4096);
    expect(parseSize('64MiB')).toBe(67_108_864);
    expect(parseSize('2mb')).toBe(2_097_152);
    for (const bad of ['', 'M', '-1M', '1T', '1.2.3K', 'abc']) expect(parseSize(bad)).toBeNull();
    expect(binSize(0)).toBe('0B');
    expect(binSize(84_172)).toBe('82.2K');
    expect(binSize(536_870_912)).toBe('512.0M');
    expect(binSize(2 * 1_073_741_824)).toBe('2.0G');
    expect(thousands(1_609_683)).toBe('1,609,683');
  });

  it('SYS-02 path and clock helpers', () => {
    expect(dirname('/home/alice/fixtures/tree1000')).toBe('/home/alice/fixtures');
    expect(dirname('/tree')).toBe('/');
    expect(dirname('tree')).toBe('.');
    expect(dirname('/a/b/')).toBe('/a');
    expect(basename('/home/alice/fixtures/tree1000/')).toBe('tree1000');
    expect(basename('x')).toBe('x');
    expect(clockMs(Date.UTC(2026, 8, 25, 9, 3, 12, 418), 300)).toBe('14:03:12.418');
    const k = new FakeKernel();
    const p = k.start(DEMO_PROGRAMS.burn, ['burn'], { env: { HOME: '' } });
    expect(homeOf(p.ctx)).toBe('/home/alice');
  });
});

describe('page pattern and checksum (MEM-03)', () => {
  const key = (over: Partial<PageKey> = {}): PageKey => ({
    seed: 42,
    child: 3,
    page: 17,
    gen: 2,
    compressible: false,
    ...over,
  });

  it('MEM-03 fillPage returns the checksum of exactly the bytes it wrote, aligned or not, for any length', () => {
    for (const len of [262_144, 1000, 4097, 3, 1]) {
      const aligned = new Uint8Array(len);
      const sum = fillPage(aligned, key());
      expect(checksum(aligned)).toBe(sum);
      const backing = new Uint8Array(len + 1);
      const unaligned = backing.subarray(1);
      expect(fillPage(unaligned, key())).toBe(sum);
      expect(unaligned).toEqual(aligned);
      expect(pageBytes(len, key())).toEqual(aligned);
    }
  });

  it('MEM-03 any single changed bit, a missing byte or an extra byte changes the checksum', () => {
    const body = pageBytes(4096, key());
    const sum = checksum(body);
    const rng = mulberry32(7);
    for (let i = 0; i < 200; i++) {
      const copy = body.slice();
      const at = Math.floor(rng() * copy.length);
      copy[at] = (copy[at] ?? 0) ^ (1 << Math.floor(rng() * 8));
      expect(checksum(copy)).not.toBe(sum);
    }
    expect(checksum(body.subarray(0, 4095))).not.toBe(sum);
    const longer = new Uint8Array(4097);
    longer.set(body);
    expect(checksum(longer)).not.toBe(sum);
    expect(checksum(new Uint8Array(8))).not.toBe(checksum(new Uint8Array(12)));
  });

  it('MEM-03 the pattern differs by seed, child, page and generation, and looks like noise', () => {
    const sums = new Set(
      [key(), key({ seed: 43 }), key({ child: 4 }), key({ page: 18 }), key({ gen: 3 })].map((k) =>
        checksum(pageBytes(8192, k)),
      ),
    );
    expect(sums.size).toBe(5);
    const noise = pageBytes(65_536, key());
    const counts = new Array<number>(256).fill(0);
    for (const b of noise) counts[b] = (counts[b] ?? 0) + 1;
    expect(Math.min(...counts)).toBeGreaterThan(150);
    expect(new Set([0, 1, 2, 3].map((g) => pageSeed(42, 0, 0, g))).size).toBe(4);
  });

  it('KMM-14 --compressible pages repeat one text line', () => {
    const k = key({ compressible: true });
    const body = pageBytes(1000, k);
    const line = compressibleLine(k);
    expect(line).toBe('memhog seed 42 child 3 page 17 gen 2\n');
    expect(new TextDecoder().decode(body)).toBe(
      line.repeat(Math.ceil(1000 / line.length)).slice(0, 1000),
    );
    expect(fillPage(new Uint8Array(1000), k)).toBe(checksum(body));
  });

  it('MEM-03 mulberryStep gives the sequence of mulberry32 from state kept in st', () => {
    const rng = mulberry32(42);
    let state = 42;
    for (let i = 0; i < 100; i++) {
      const r = mulberryStep(state);
      expect(r.value).toBe(rng());
      state = r.state;
    }
  });

  it('MEM-06 ctx.mem is used when the executor provides it, else the mem.alloc fallback', () => {
    const k = new FakeKernel();
    const withMem = k.start(DEMO_PROGRAMS.burn, ['burn'], { ctxMem: true });
    const without = k.start(DEMO_PROGRAMS.burn, ['burn']);
    expect(ctxMemOf(withMem.ctx)).not.toBeNull();
    expect(backendFor(withMem.ctx).name).toBe('ctx.mem');
    expect(ctxMemOf(without.ctx)).toBeNull();
    expect(backendFor(without.ctx).name).toBe('mem.alloc');
    const odd = { ...without.ctx, mem: { alloc: 1 } } as unknown as ProgramContext;
    expect(ctxMemOf(odd)).toBeNull();
  });
});
