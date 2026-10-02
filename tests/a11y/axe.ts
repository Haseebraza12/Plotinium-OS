/**
 * axe scans in both themes (testing §3.9, TST-14; ui-design-system §3.11, DSN-20; WM-07, BOOT-13).
 *
 * Every screen is scanned with `emulateMedia({ colorScheme })` for light and dark (the "Follow
 * system" path) and again with `data-theme` forced to the opposite of the emulated scheme, to
 * catch token values that resolve correctly only one way. The gate is zero `serious` or
 * `critical` violations; `moderate` and `minor` are reported.
 */
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';

export const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] as const;
export const BLOCKING_IMPACTS: ReadonlySet<string> = new Set(['serious', 'critical']);

export type Theme = 'light' | 'dark';

export interface ThemePass {
  name: string;
  colorScheme: Theme;
  /** `data-theme` forced on <html>, or null to follow the emulated system scheme. */
  forced: Theme | null;
}

export const THEME_PASSES: readonly ThemePass[] = [
  { name: 'light', colorScheme: 'light', forced: null },
  { name: 'dark', colorScheme: 'dark', forced: null },
  { name: 'light system, dark forced', colorScheme: 'light', forced: 'dark' },
  { name: 'dark system, light forced', colorScheme: 'dark', forced: 'light' },
];

export type AxeResults = Awaited<ReturnType<AxeBuilder['analyze']>>;
export type AxeViolation = AxeResults['violations'][number];

/** The violations that fail the gate. */
export function blocking(violations: readonly Pick<AxeViolation, 'impact'>[]): number[] {
  return violations.flatMap((v, i) =>
    v.impact !== undefined && v.impact !== null && BLOCKING_IMPACTS.has(v.impact) ? [i] : [],
  );
}

/** One line per violation with its impact, rule, help text and first offending targets. */
export function describeViolations(violations: readonly AxeViolation[], max = 3): string {
  return violations
    .map((v) => {
      const targets = v.nodes
        .slice(0, max)
        .map((n) => n.target.join(' '))
        .join(', ');
      return `[${v.impact ?? 'unknown'}] ${v.id}: ${v.help} (${v.nodes.length} node(s): ${targets})`;
    })
    .join('\n');
}

export async function applyTheme(page: Page, pass: ThemePass): Promise<void> {
  await page.emulateMedia({ colorScheme: pass.colorScheme });
  await page.evaluate((forced) => {
    const root = document.documentElement;
    if (forced === null) root.removeAttribute('data-theme');
    else root.dataset.theme = forced;
  }, pass.forced);
}

export interface ScanResult {
  pass: ThemePass;
  blocking: AxeViolation[];
  reported: AxeViolation[];
}

/** Scans the page (or `include`, a CSS selector) in one theme pass. */
export async function scan(page: Page, pass: ThemePass, include?: string): Promise<ScanResult> {
  await applyTheme(page, pass);
  let builder = new AxeBuilder({ page }).withTags([...AXE_TAGS]);
  if (include !== undefined) builder = builder.include(include);
  const res = await builder.analyze();
  const idx = new Set(blocking(res.violations));
  return {
    pass,
    blocking: res.violations.filter((_, i) => idx.has(i)),
    reported: res.violations.filter((_, i) => !idx.has(i)),
  };
}
