import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { BRANDING_FILES } from '@plotinium/kernel';

import { brandingSeed, BRANDING_SOURCES, GLYPH_FILES } from '../src/kernel/branding-seed.ts';

const identity = (name: string): string =>
  readFileSync(new URL(`../../docs/identity/${name}`, import.meta.url), 'utf8');

describe('PLT-ID-12 the first-boot seed carries every identity file into /system/branding', () => {
  it('PLT-ID-12 fetches each BRANDING_FILES entry from /branding/', () => {
    expect(BRANDING_SOURCES.map((s) => s.url)).toEqual(BRANDING_FILES.map((f) => `/branding/${f}`));
    for (const s of BRANDING_SOURCES) expect(s.path).toBe(`/system/branding/${s.url.slice(10)}`);
  });

  it('PLT-ID-12 seeds the glyph marks from the bundle, byte for byte as in docs/identity', () => {
    const dec = new TextDecoder();
    expect(GLYPH_FILES.map((f) => f.path)).toEqual([
      '/system/branding/glyph.svg',
      '/system/branding/glyph-mono.svg',
    ]);
    expect(dec.decode(GLYPH_FILES[0]?.bytes)).toBe(identity('glyph.svg'));
    expect(dec.decode(GLYPH_FILES[1]?.bytes)).toBe(identity('glyph-mono.svg'));
  });

  it('PLT-ID-12 a failed or missing fetch still seeds the rest and the glyphs', async () => {
    const files = await brandingSeed((url) =>
      url.endsWith('logo.svg')
        ? Promise.resolve(new Response('<svg/>', { status: 200 }))
        : url.endsWith('usage.md')
          ? Promise.reject(new TypeError('offline'))
          : Promise.resolve(new Response('missing', { status: 404 })),
    );
    expect(files.map((f) => f.path)).toEqual([
      '/system/branding/logo.svg',
      '/system/branding/glyph.svg',
      '/system/branding/glyph-mono.svg',
    ]);
  });
});
