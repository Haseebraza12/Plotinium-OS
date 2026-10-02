/**
 * Test-only bridge for the `@plotinium/ui` package root. ui-implementation-guide.md §3.3 says the
 * root (`ui/src/index.ts`) re-exports every Solid area, and wm/src/shell/ui.ts imports the shell,
 * overlay and login components from there. Until ui/src/index.ts adds those three re-exports,
 * the shell's render tests merge the areas into the mocked root here; once the root exports
 * them, `withUiAreas` returns the real root unchanged and this file can be deleted.
 *
 * Use it from a test file as:
 *   vi.mock('@plotinium/ui', async (importOriginal) => {
 *     const { withUiAreas } = await import('./ui-areas.ts');
 *     return withUiAreas(await importOriginal());
 *   });
 */
const AREAS = ['shell', 'overlays', 'login'] as const;

export async function withUiAreas(root: Record<string, unknown>): Promise<Record<string, unknown>> {
  if ('MenuBar' in root && 'SearchPalette' in root && 'LoginScreen' in root) return root;
  const merged: Record<string, unknown> = { ...root };
  for (const area of AREAS) {
    // A computed path (not an import specifier): decode it, since the repository path has a space.
    const file = decodeURIComponent(
      new URL(`../../../ui/src/${area}/index.ts`, import.meta.url).pathname,
    );
    const mod = (await import(/* @vite-ignore */ file)) as Record<string, unknown>;
    Object.assign(merged, mod);
  }
  return merged;
}
