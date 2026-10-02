import { describe, expect, it } from 'vitest';

import motionCss from './motion.css?raw';
import tokensCss from './tokens.css?raw';

const moduleCss = import.meta.glob<string>('../**/*.module.css', {
  query: '?raw',
  import: 'default',
  eager: true,
});
const allCss: readonly [string, string][] = [
  ...Object.entries(moduleCss),
  ['motion.css', motionCss],
];

const ANIMATABLE = new Set(['transform', 'opacity']);
/** Files in src/primitives allowed a live backdrop-filter (popover/menu material, sheets and dialogs). */
const BACKDROP_ALLOWED = new Set([
  '../primitives/internal/Floating.module.css',
  '../primitives/dialog/Modal.module.css',
]);

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//gu, '');
}

/** The bodies of every @keyframes rule. */
function keyframeBodies(css: string): { name: string; body: string }[] {
  const out: { name: string; body: string }[] = [];
  const text = stripComments(css);
  for (const match of text.matchAll(/@keyframes\s+([\w-]+)\s*\{/gu)) {
    let depth = 0;
    const start = (match.index ?? 0) + match[0].length - 1;
    for (let i = start; i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}' && --depth === 0) {
        out.push({ name: match[1] ?? '', body: text.slice(start + 1, i) });
        break;
      }
    }
  }
  return out;
}

function declarationsOf(css: string, property: string): string[] {
  const re = new RegExp(`(?:^|[;{\\s])${property}\\s*:\\s*([^;}]+)`, 'gu');
  return [...stripComments(css).matchAll(re)].map((m) => (m[1] ?? '').trim());
}

describe('UI-motion', () => {
  it('WM-03 every @keyframes rule animates only transform and opacity', () => {
    const offenders: string[] = [];
    for (const [file, css] of allCss) {
      for (const { name, body } of keyframeBodies(css)) {
        for (const prop of body.matchAll(/([a-z-]+)\s*:/gu)) {
          if (!ANIMATABLE.has(prop[1] ?? ''))
            offenders.push(`${file} @keyframes ${name}: ${prop[1] ?? ''}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('WM-03 every transition lists only transform or opacity', () => {
    const offenders: string[] = [];
    for (const [file, css] of allCss) {
      for (const value of declarationsOf(css, 'transition')) {
        for (const part of value.split(/,(?![^(]*\))/u)) {
          const property = part.trim().split(/\s+/u)[0] ?? '';
          if (property !== 'none' && !ANIMATABLE.has(property))
            offenders.push(`${file}: transition ${part.trim()}`);
        }
      }
      for (const value of declarationsOf(css, 'transition-property')) {
        for (const property of value.split(',').map((p) => p.trim())) {
          if (!ANIMATABLE.has(property)) offenders.push(`${file}: transition-property ${property}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('DSN-24 live backdrop-filter appears in primitives only on the popover and sheet materials', () => {
    const offenders = Object.entries(moduleCss)
      .filter(([file]) => file.startsWith('../primitives/'))
      .filter(
        ([file, css]) =>
          /(^|[^-])backdrop-filter\s*:/u.test(stripComments(css)) && !BACKDROP_ALLOWED.has(file),
      )
      .map(([file]) => file);
    expect(offenders).toEqual([]);
  });

  it('DSN-31 will-change is set only by the one-shot motion classes, never statically by components', () => {
    const offenders = Object.entries(moduleCss)
      .filter(([, css]) => /will-change\s*:/u.test(stripComments(css)))
      .map(([file]) => file);
    expect(offenders).toEqual([]);
    const perClass =
      stripComments(motionCss).match(/\.pl-anim-[\w-]+\s*\{[^}]*will-change/gu) ?? [];
    expect(perClass.length).toBeGreaterThan(10);
  });

  it('DSN-30 every animated component stylesheet has a reduced-motion path', () => {
    const offenders: string[] = [];
    for (const [file, css] of Object.entries(moduleCss)) {
      const moving = [
        ...declarationsOf(css, 'transition'),
        ...declarationsOf(css, 'animation'),
      ].filter((v) => v !== 'none');
      if (moving.length === 0) continue;
      const tokenTimed = moving.every(
        (v) => v.includes('var(--pl-motion-') || v.includes('var(--pl-k)'),
      );
      if (!tokenTimed && !css.includes('prefers-reduced-motion')) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it('DSN-30 motion.css guards every pl-anim class under reduced motion (media query and data-motion)', () => {
    expect(motionCss).toContain('@media (prefers-reduced-motion: reduce)');
    expect(motionCss).toContain(":root[data-motion='reduce'] :where([class*='pl-anim-']");
    const classes = new Set(
      [...stripComments(motionCss).matchAll(/\.(pl-anim-[\w-]+)/gu)].map((m) => m[1]),
    );
    for (const required of [
      'pl-anim-window-open',
      'pl-anim-window-close',
      'pl-anim-window-minimise',
      'pl-anim-window-maximise',
      'pl-anim-menu-in',
      'pl-anim-popover-in',
      'pl-anim-sheet-in',
      'pl-anim-notification-in',
      'pl-anim-cc-in',
      'pl-anim-search-in',
      'pl-anim-overview-in',
      'pl-anim-dock-bounce',
      'pl-anim-boot-glow',
      'pl-anim-progress-sweep',
      'pl-anim-login-unlock',
      'pl-anim-restore-shimmer',
      'pl-anim-toggle-spring',
      'pl-anim-menubar-in',
      'pl-anim-dock-in',
    ]) {
      expect(classes.has(required), required).toBe(true);
    }
  });

  it('DSN-29 every linear() spring token has a cubic-bezier fallback for browsers without linear()', () => {
    const base = stripComments(tokensCss);
    const springs = [...base.matchAll(/(--pl-ease-[\w-]+)\s*:\s*linear\(/gu)].map(
      (m) => m[1] ?? '',
    );
    expect(springs.length).toBeGreaterThanOrEqual(2);
    const start = base.indexOf('@supports not (transition-timing-function: linear(0, 1))');
    expect(start).toBeGreaterThan(0);
    const fallback = base.slice(start, base.indexOf('}', base.indexOf('}', start) + 1));
    for (const name of springs)
      expect(fallback, name).toMatch(new RegExp(`${name}\\s*:\\s*cubic-bezier\\(`, 'u'));
    expect(stripComments(motionCss)).not.toContain('linear(');
  });
});
