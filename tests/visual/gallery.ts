/**
 * Visual regression of the @plotinium/ui gallery (ui/gallery): every page, screenshotted in the
 * light and the dark theme, compared with committed reference images (Playwright
 * `toHaveScreenshot`). Pages are discovered from ui/gallery/pages/*.tsx (each exports
 * `meta = { id, … }`), so a new gallery page is covered without editing this harness.
 *
 * The gallery keeps its state in the URL hash (`#/<page>?theme=dark&motion=reduce`); the harness
 * sets the theme there and also emulates the matching colour scheme, turns motion off and waits
 * for fonts, so screenshots are deterministic.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Page } from '@playwright/test';

import type { Env } from '../support/env.ts';

export type GalleryTheme = 'light' | 'dark';
export const GALLERY_THEMES: readonly GalleryTheme[] = ['light', 'dark'];
export const GALLERY_PAGES_DIR = fileURLToPath(new URL('../../ui/gallery/pages/', import.meta.url));

/** The `id` of a gallery page module's `export const meta = { id: '…' }`, or undefined. */
export function pageIdOf(source: string): string | undefined {
  const meta = /export\s+const\s+meta\b[^=]*=\s*\{([\s\S]*?)\}/.exec(source);
  const id = meta?.[1] !== undefined ? /\bid:\s*['"]([a-z0-9-]+)['"]/.exec(meta[1]) : null;
  return id?.[1];
}

/** Page ids in file-name order; `PLOTINIUM_GALLERY_PAGES=a,b` narrows the set. */
export function galleryPages(dir: string = GALLERY_PAGES_DIR, env: Env = process.env): string[] {
  let files: string[];
  try {
    files = readdirSync(dir)
      .filter((f) => f.endsWith('.tsx'))
      .sort();
  } catch {
    return [];
  }
  const ids = files
    .map((f) => pageIdOf(readFileSync(join(dir, f), 'utf8')))
    .filter((id): id is string => id !== undefined);
  const only = env['PLOTINIUM_GALLERY_PAGES'];
  if (only === undefined || only === '') return ids;
  const wanted = new Set(only.split(',').map((s) => s.trim()));
  return ids.filter((id) => wanted.has(id));
}

export function galleryUrlFor(base: string, id: string, theme: GalleryTheme): string {
  const u = new URL(base);
  u.hash = `#/${id}?theme=${theme}&motion=reduce`;
  return u.href;
}

export const VIEWPORT_WIDTH = 1280;
export const MIN_HEIGHT = 900;
/** Chrome refuses screenshots taller than about 16k px; long pages are cut here. */
export const MAX_HEIGHT = 8000;

/** Viewport height that shows `contentBottom` px of content, within [MIN_HEIGHT, MAX_HEIGHT]. */
export function fittedHeight(contentBottom: number): number {
  return Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.ceil(contentBottom)));
}

export function snapshotName(id: string, theme: GalleryTheme): string {
  return `${id}-${theme}.png`;
}

/** Opens one page in one theme and waits until it is stable enough to screenshot. */
export async function openGalleryPage(
  page: Page,
  base: string,
  id: string,
  theme: GalleryTheme,
): Promise<void> {
  await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
  await page.goto(galleryUrlFor(base, id, theme));
  await page.waitForFunction(
    (t) => document.documentElement.dataset['theme'] === t && document.fonts.status === 'loaded',
    theme,
  );
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  // The gallery scrolls inside #gallery-content, so a full-page screenshot would stop at the
  // viewport: grow the viewport until the whole page body is visible.
  const bottom = await page.evaluate(() => {
    const c = document.getElementById('gallery-content');
    if (c === null) return document.documentElement.scrollHeight;
    return (
      c.getBoundingClientRect().top +
      c.scrollHeight +
      (window.innerHeight - c.getBoundingClientRect().bottom)
    );
  });
  await page.setViewportSize({ width: VIEWPORT_WIDTH, height: fittedHeight(bottom) });
}
