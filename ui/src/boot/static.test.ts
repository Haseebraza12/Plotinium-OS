/**
 * Static checks on the boot sources, mirroring tools/check-boot-truth.ts (boot-and-services.md
 * §5.6, SVC-10) for the code that wm/boot-ui inlines from here, plus the design-system rules
 * the component tests apply to *.module.css (boot.css is plain CSS, so it is checked here).
 */
import { describe, expect, it } from 'vitest';

import tokensCss from '../tokens/tokens.css?raw';
import bootCss from './boot.css?raw';
import { h, html, render } from './dom.ts';
import { createBootMenu } from './menu.ts';
import { createPanicScreen } from './panic.ts';
import { createRecoveryConsole } from './recovery.ts';
import { createBootSplash, splashHtml } from './splash.ts';
import { createUnsupportedScreen } from './unsupported.ts';

const sources = import.meta.glob<string>(
  ['./*.ts', '!./*.test.ts', '../icons/atom-logo.ts', '../icons/svg-tree.ts'],
  {
    query: '?raw',
    import: 'default',
    eager: true,
  },
);

const stripComments = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//gu, '');
const css = stripComments(bootCss);

function declarations(property: string): string[] {
  const re = new RegExp(`(?:^|[;{\\s])${property}\\s*:\\s*([^;}]+)`, 'gu');
  return [...css.matchAll(re)].map((m) => (m[1] ?? '').trim());
}

/** The body of the first rule whose selector list contains `selector`. */
function rule(selector: string): string {
  const at = css.indexOf(`${selector} {`);
  return at < 0 ? '' : css.slice(at, css.indexOf('}', at));
}

describe('UI-boot static', () => {
  it('UI-boot the stylesheets load as ?raw text (css.include in ui/vitest.config.ts), so no check passes vacuously', () => {
    expect(bootCss.length).toBeGreaterThan(10_000);
    expect(tokensCss.length).toBeGreaterThan(10_000);
  });

  it('BOOT-02 the boot screens contain no timer, keyframes or CSS animation (SVC-10 static check)', () => {
    expect(Object.keys(sources).length).toBeGreaterThanOrEqual(10);
    const banned = /\b(setTimeout|setInterval)\b|@keyframes|(^|[\s;{])animation(-[a-z-]+)?\s*:/mu;
    const offenders = [...Object.entries(sources), ['boot.css', bootCss] as const]
      .filter(([, text]) => banned.test(text))
      .map(([file]) => file);
    expect(offenders).toEqual([]);
  });

  it('DSN-07 every boot progressbar is determinate and there is no spinner or looping state', () => {
    expect(bootCss).not.toMatch(/indeterminate|spinner|infinite/iu);
    const id = { version: '0.3.0', build: 'a1f93c2' };
    const screens = [
      createBootSplash(id).el,
      createRecoveryConsole({ ...id, onAction: () => undefined }).el,
    ];
    const bars = screens.flatMap((el) => [...el.querySelectorAll('[role="progressbar"]')]);
    expect(bars).toHaveLength(2);
    for (const bar of bars) {
      expect(bar.getAttribute('aria-valuenow')).toBe('0');
      expect(bar.getAttribute('aria-valuemax')).toBe('100');
    }
  });

  it('UI-boot writes no inline style attribute (CSP has no unsafe-inline); custom properties go through the CSSOM', () => {
    const id = { version: '0.3.0', build: 'a1f93c2' };
    expect(splashHtml(id)).not.toMatch(/\sstyle=/u);
    // The builder never writes `style` (or on* handlers); `--*` keys become CSSOM writes.
    const probe = h('div', { style: 'color: red', onclick: 'x()', '--plb-i': 3 }, 'text');
    const built = render(probe, document);
    expect(built.getAttribute('onclick')).toBeNull();
    expect(built.style.getPropertyValue('color')).toBe('');
    expect(built.style.getPropertyValue('--plb-i')).toBe('3');
    expect(html(probe)).toBe('<div>text</div>');
    // The shared icon definitions (../icons) do use `style`; logo.ts strips it from the boot copy.
    for (const [file, text] of Object.entries(sources).filter(([f]) => f.startsWith('./'))) {
      expect(text, file).not.toMatch(/setAttribute\(\s*'style'|\bstyle:\s*['`]/u);
    }
    const splash = createBootSplash(id);
    splash.setProgress(0.5);
    expect(splash.el.style.getPropertyValue('--plb-p')).toBe('0.5');
    // One tickable group: the electron and its shell (the stem and the nucleus stay put).
    const orbit = splash.el.querySelectorAll('.plb-orbit[data-o]');
    expect(orbit).toHaveLength(1);
    expect(orbit[0]?.querySelector('.pl-logo-electron')).not.toBeNull();
    expect(orbit[0]?.querySelector('.pl-logo-shell')).not.toBeNull();
    expect(orbit[0]?.querySelector('.pl-logo-stem')).toBeNull();
    const screens = [
      createBootMenu({ ...id, onChoose: () => undefined }).el,
      createPanicScreen({ ...id, lines: [], cycle: ['a', 'b', 'a'], onAction: () => undefined }).el,
      createRecoveryConsole({ ...id, onAction: () => undefined }).el,
      createUnsupportedScreen({ ...id, capabilities: [{ name: 'IndexedDB', status: 'pass' }] }).el,
    ];
    expect(screens.every((el) => el.querySelector('[onclick], [srcdoc]') === null)).toBe(true);
  });

  it('DSN-14 the boot screens import no Solid, lucide, xterm or CodeMirror, directly or through their imports', () => {
    const imports = Object.entries(sources).flatMap(([file, text]) =>
      [...text.matchAll(/^\s*(?:import|export)\b[^'"]*?from\s+'([^']+)'/gmu)].map(
        (m) => [file, m[1] ?? ''] as const,
      ),
    );
    expect(imports.length).toBeGreaterThan(10);
    const external = imports.filter(([, spec]) => !spec.startsWith('.'));
    expect(external).toEqual(external.filter(([, spec]) => spec === '@plotinium/protocol'));
    const local = imports.filter(([, spec]) => spec.startsWith('../'));
    expect(local.map(([, spec]) => spec).sort()).toEqual([
      '../icons/atom-logo.ts',
      '../icons/svg-tree.ts',
    ]);
    // Protocol is imported for types only, so it adds no runtime code to the inlined script.
    for (const [file, text] of Object.entries(sources)) {
      if (text.includes("'@plotinium/protocol'"))
        expect(text, file).toMatch(/import type \{[^}]+\} from '@plotinium\/protocol'/u);
    }
  });

  it('WM-03 boot.css moves only transform and opacity', () => {
    const offenders: string[] = [];
    for (const value of declarations('transition')) {
      for (const part of value.split(/,(?![^(]*\))/u)) {
        const property = part.trim().split(/\s+/u)[0] ?? '';
        if (property !== 'none' && property !== 'transform' && property !== 'opacity')
          offenders.push(part.trim());
      }
    }
    expect(declarations('transition').length).toBeGreaterThan(20);
    expect(offenders).toEqual([]);
  });

  it('DSN-30 every boot transition is timed by a motion token or scales with --pl-k (reduced motion stops it)', () => {
    const offenders = declarations('transition')
      .flatMap((v) => v.split(/,(?![^(]*\))/u))
      .map((p) => p.trim())
      .filter((p) => p !== 'none')
      .filter((p) => !p.includes('var(--pl-motion-') && !p.includes('var(--pl-k)'));
    expect(offenders).toEqual([]);
    for (const delay of declarations('transition-delay')) expect(delay).toContain('var(--pl-k)');
  });

  it('BOOT-13 with reduced motion the bar has a 0 s transition and the orbits stand still', () => {
    expect(rule('.plb-fill')).toContain('transition:\n      transform var(--pl-motion-fast)');
    const reduced = tokensCss.slice(tokensCss.indexOf(":root[data-motion='reduce'] {"));
    expect(reduced).toMatch(/--pl-motion-fast:\s*0ms/u);
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{\s*\.plb-orbit \{\s*transform: none;/u,
    );
    expect(css).toContain(":root[data-motion='reduce'] .plb-orbit {\n    transform: none;");
  });

  it('DSN-02 boot.css uses only defined tokens and no raw hex colours', () => {
    const defined = new Set([...tokensCss.matchAll(/(--pl-[\w-]+)\s*:/gu)].map((m) => m[1]));
    const missing = [...css.matchAll(/var\((--pl-[\w-]+)/gu)]
      .map((m) => m[1] ?? '')
      .filter((name) => !defined.has(name));
    expect(missing).toEqual([]);
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/iu);
    expect(css).not.toMatch(/\brgba?\(/u);
  });

  it('DSN-24 the only live backdrop-filter on the boot path is the recovery console menu bar', () => {
    const uses = [...css.matchAll(/([^{}]+)\{[^}]*(?:^|[\s;])backdrop-filter\s*:/gmu)].map((m) =>
      (m[1] ?? '').trim(),
    );
    expect(uses).toEqual(['.plb-top']);
  });

  it('DSN-31 boot.css never sets will-change statically', () => {
    expect(css).not.toMatch(/will-change\s*:/u);
  });
});
