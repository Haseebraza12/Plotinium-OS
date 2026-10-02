/**
 * Unique storage names per test file (spec §3.2.1, TST-11).
 *
 * Every browser test file opens IndexedDB and OPFS under names derived from its own path, so two
 * files never share state even if file parallelism is switched on by mistake. Production names
 * (`plotinium`, `plotinium-swap`, C4) are reserved for the e2e suite.
 *
 * Works in Node and in Chrome: it hashes with WebCrypto, and derives the repository-relative path
 * from this module's own URL, which shares the scheme and root with the caller's URL in both
 * environments (file: under Node, http://localhost:<port>/ under the Vitest browser server).
 */
export interface StorageNames {
  idb: string;
  swap: string;
  opfsDir: string;
}

export const PRODUCTION_NAMES = ['plotinium', 'plotinium-swap'] as const;

const SELF = 'tests/support/storage-names.ts';

/** Path of `fileUrl` relative to the repository root, `/`-separated, no leading slash. */
export function repoRelative(fileUrl: string, selfUrl: string = import.meta.url): string {
  const self = new URL(selfUrl);
  const target = new URL(fileUrl);
  const rootPath = decodeURIComponent(self.pathname).slice(0, -SELF.length);
  let path = decodeURIComponent(target.pathname);
  // Vite serves files outside its root under /@fs/<absolute path>.
  const fs = path.indexOf('/@fs/');
  if (fs >= 0) path = path.slice(fs + '/@fs'.length);
  if (path.startsWith(rootPath)) path = path.slice(rootPath.length);
  return path.replace(/^\/+/, '');
}

async function sha1Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-1', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** `{ idb: 'plotinium-test-<h>', swap: 'plotinium-swap-test-<h>', opfsDir: 'test-<h>' }`, h = sha1[0..8]. */
export async function testStorageNames(fileUrl: string, selfUrl?: string): Promise<StorageNames> {
  const h = (await sha1Hex(repoRelative(fileUrl, selfUrl))).slice(0, 8);
  return { idb: `plotinium-test-${h}`, swap: `plotinium-swap-test-${h}`, opfsDir: `test-${h}` };
}
