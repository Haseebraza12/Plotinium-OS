import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  fittedHeight,
  galleryPages,
  galleryUrlFor,
  MAX_HEIGHT,
  MIN_HEIGHT,
  pageIdOf,
  snapshotName,
} from './gallery.ts';

describe('PLT-ID-06 gallery visual regression helper', () => {
  it('PLT-ID-06 a page id is read from the module meta export', () => {
    expect(
      pageIdOf(
        `export const meta: GalleryPageMeta = {\n  id: 'dock',\n  title: 'Dock',\n  group: 'Shell',\n};`,
      ),
    ).toBe('dock');
    expect(pageIdOf(`export const meta = { title: "x", id: "window-chrome" };`)).toBe(
      'window-chrome',
    );
    expect(pageIdOf('export default function Kit() {}')).toBeUndefined();
  });

  it('PLT-ID-06 every committed gallery page is discovered in file order and can be narrowed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'plt-gallery-'));
    try {
      await writeFile(
        join(dir, 'b.tsx'),
        `export const meta = { id: 'beta', title: 'B', group: 'x' };`,
      );
      await writeFile(
        join(dir, 'a.tsx'),
        `export const meta = { id: 'alpha', title: 'A', group: 'x' };`,
      );
      await writeFile(join(dir, 'kit.tsx'), `export const x = 1;`);
      await writeFile(join(dir, 'notes.md'), `id: 'nope'`);
      expect(galleryPages(dir, {})).toEqual(['alpha', 'beta']);
      expect(galleryPages(dir, { PLOTINIUM_GALLERY_PAGES: 'beta, gamma' })).toEqual(['beta']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    expect(galleryPages(join(dir, 'missing'), {})).toEqual([]);
    const real = galleryPages(undefined, {});
    expect(real.length).toBeGreaterThan(0);
    for (const id of real) expect(id).toMatch(/^[a-z0-9-]+$/);
  });

  it('PLT-ID-06 each page is opened per theme through the gallery hash with motion off', () => {
    expect(galleryUrlFor('http://localhost:4718/', 'dock', 'dark')).toBe(
      'http://localhost:4718/#/dock?theme=dark&motion=reduce',
    );
    expect(galleryUrlFor('http://localhost:4718/gallery/', 'tokens', 'light')).toBe(
      'http://localhost:4718/gallery/#/tokens?theme=light&motion=reduce',
    );
    expect(snapshotName('dock', 'light')).toBe('dock-light.png');
  });

  it('PLT-ID-06 the viewport grows to show the whole page body within the screenshot limits', () => {
    expect(fittedHeight(400)).toBe(MIN_HEIGHT);
    expect(fittedHeight(2400.2)).toBe(2401);
    expect(fittedHeight(50_000)).toBe(MAX_HEIGHT);
  });
});
