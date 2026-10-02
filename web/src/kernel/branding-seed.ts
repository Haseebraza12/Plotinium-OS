/**
 * The identity files the first-boot seed puts in /system/branding (identity-and-branding.md §3.7):
 * the ones the web build serves at /branding/ (`BRANDING_FILES`, fetched), plus the glyph-only marks
 * of docs/identity (the Bohr P without its wordmark, docs/design/logo/DECISION.md). /branding/ does
 * not serve the glyphs, so the kernel worker carries their text (under 2 KB) and seeds it directly:
 * no request, and no data: URL for the CSP to refuse.
 */
import { BRANDING_FILES, fetchSeed } from '@plotinium/kernel';
import type { SeedSource } from '@plotinium/kernel';

// docs/identity is the identity kit (static assets, not a workspace package), and the only copy of
// the glyphs: web/public/branding does not carry them (docs/design/logo/build-identity.mjs).
// eslint-disable-next-line local/no-relative-import-outside-package -- asset text, see above
import glyphMonoSvg from '../../../docs/identity/glyph-mono.svg?raw';
// eslint-disable-next-line local/no-relative-import-outside-package -- asset text, see above
import glyphSvg from '../../../docs/identity/glyph.svg?raw';

/** A seed file as `IoDeps.seed` returns it. */
export interface BrandingFile {
  readonly path: string;
  readonly bytes: Uint8Array;
}

/** The files fetched from /branding/. */
export const BRANDING_SOURCES: readonly SeedSource[] = BRANDING_FILES.map((f) => ({
  url: `/branding/${f}`,
  path: `/system/branding/${f}`,
}));

const encoder = new TextEncoder();

/** The bundled glyph marks. */
export const GLYPH_FILES: readonly BrandingFile[] = [
  { path: '/system/branding/glyph.svg', bytes: encoder.encode(glyphSvg) },
  { path: '/system/branding/glyph-mono.svg', bytes: encoder.encode(glyphMonoSvg) },
];

/** Everything to seed: the fetched files that answered, then the glyphs. */
export async function brandingSeed(
  fetchFn: (url: string) => Promise<Response>,
): Promise<BrandingFile[]> {
  const fetched = await fetchSeed(fetchFn, BRANDING_SOURCES);
  return [...fetched, ...GLYPH_FILES];
}
