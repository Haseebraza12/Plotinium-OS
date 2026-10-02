/**
 * The compactor for the CSS that the build inlines into index.html (tokens.css + ui boot.css;
 * web/vite.config.ts). It removes comments and whitespace only where CSS never needs it, so the
 * compacted sheet means exactly what the source means (UI-013).
 *
 * Whitespace goes around `{ } ; , >` and after `:`. It stays before `:`, because there it can be
 * a descendant combinator: `.plb :where(h1)` (any h1 inside .plb) is not `.plb:where(h1)` (a
 * .plb that is itself an h1). The earlier compactor stripped both sides of `:` and broke six boot
 * selectors (the splash hand-over, verbose mode, log colours, the unsupported card's margins).
 * Build-time only: nothing on the boot path imports this module.
 */
export function compactCss(css: string): string {
  return css
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/\s+/gu, ' ')
    .replace(/\s*([{};,>])\s*/gu, '$1')
    .replace(/:\s+/gu, ':')
    .trim();
}
