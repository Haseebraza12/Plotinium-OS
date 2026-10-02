import type { SvgIconDef, SvgNode } from './svg-tree.ts';

/**
 * The Plotinium mark, the "Bohr P" (docs/design/logo/DECISION.md): an electron shell around a
 * dense nucleus, with the one electron sitting in the shell's gap at 1:30. The shell grows a
 * stem, so the atom is also the P of Plotinium. Four filled shapes on a 24-unit grid and no
 * strokes, so no stylesheet can thin the mark into a hairline:
 *
 *   stem      a 3-unit bar, round at both ends (its top end hides under the shell)
 *   shell     a ring of outer radius 7.5 and width 3 around (12, 9), open around the electron,
 *             with round ends
 *   nucleus   a disc of radius 2.8 at the shell's centre
 *   electron  a disc of radius 2 on the shell's centre line at -45 deg, 1.25 units clear of
 *             each shell end
 *
 * The arc end points come from docs/design/logo/mark-geometry.mjs (it prints this path data).
 * Inline, the pl-logo-* classes paint the --pl-logo-* tokens (SvgIcon.module.css, boot.css),
 * so the mark follows both themes; the hex presentation attributes are the dark-theme colours
 * a standalone copy falls back to. No `style` attributes: the production CSP has no
 * 'unsafe-inline'. The smallest gap in the master mark is 1.2 units (0.8 px at 16 px) and every
 * shape is at least 3 units (2 px at 16 px) wide.
 */

interface MarkGeometry {
  readonly stem: string;
  readonly shell: string;
  /** cx, cy, r */
  readonly nucleus: readonly [number, number, number];
  readonly electron: readonly [number, number, number];
}

/** Edges on multiples of 1.5 units: whole pixels at 16, 32 and 48 px. */
const MASTER: MarkGeometry = {
  stem: 'M4.5 9V21A1.5 1.5 0 0 0 7.5 21V9A1.5 1.5 0 0 0 4.5 9Z',
  shell:
    'M19.497 9.214A7.5 7.5 0 1 1 11.786 1.503A1.5 1.5 0 0 1 11.872 4.502A4.5 4.5 0 1 0 16.498 9.128A1.5 1.5 0 0 1 19.497 9.214Z',
  nucleus: [12, 9, 2.8],
  electron: [16.243, 4.757, 2],
};

/** Hinted for 20 px (and 40, 60 ...): a 2.4-unit shell and stem, edges on multiples of 1.2. */
const HINT_20: MarkGeometry = {
  stem: 'M4.8 8.4V21.6A1.2 1.2 0 0 0 7.2 21.6V8.4A1.2 1.2 0 0 0 4.8 8.4Z',
  shell:
    'M19.193 8.087A7.2 7.2 0 1 1 12.313 1.207A1.2 1.2 0 0 1 12.209 3.605A4.8 4.8 0 1 0 16.795 8.191A1.2 1.2 0 0 1 19.193 8.087Z',
  nucleus: [12, 8.4, 2.7],
  electron: [16.243, 4.157, 1.95],
};

/** Hinted for 24 px (and 72, 120 ...): the master moved half a unit onto whole pixels. */
const HINT_24: MarkGeometry = {
  stem: 'M5 8.5V20.5A1.5 1.5 0 0 0 8 20.5V8.5A1.5 1.5 0 0 0 5 8.5Z',
  shell:
    'M19.997 8.714A7.5 7.5 0 1 1 12.286 1.003A1.5 1.5 0 0 1 12.372 4.002A4.5 4.5 0 1 0 16.998 8.628A1.5 1.5 0 0 1 19.997 8.714Z',
  nucleus: [12.5, 8.5, 2.8],
  electron: [16.743, 4.257, 2],
};

function markTree(g: MarkGeometry): readonly SvgNode[] {
  return [
    ['path', { d: g.stem, fill: '#B3B1FF', class: 'pl-logo-stem' }],
    ['path', { d: g.shell, fill: '#B3B1FF', class: 'pl-logo-shell' }],
    [
      'circle',
      {
        cx: g.nucleus[0],
        cy: g.nucleus[1],
        r: g.nucleus[2],
        fill: '#FFFFFF',
        class: 'pl-logo-core',
      },
    ],
    [
      'circle',
      {
        cx: g.electron[0],
        cy: g.electron[1],
        r: g.electron[2],
        fill: '#CFCEFF',
        class: 'pl-logo-electron',
      },
    ],
  ];
}

/** The master mark (16, 32, 48 px and any size without its own hinting). */
export const atomLogo: SvgIconDef = {
  name: 'atom',
  viewBox: '0 0 24 24',
  children: markTree(MASTER),
};

/** The mark hinted for 20 px. */
export const atomLogo20: SvgIconDef = {
  name: 'atom',
  viewBox: '0 0 24 24',
  children: markTree(HINT_20),
};

/** The mark hinted for 24 px. */
export const atomLogo24: SvgIconDef = {
  name: 'atom',
  viewBox: '0 0 24 24',
  children: markTree(HINT_24),
};

/**
 * The drawing whose edges land on whole pixels at `size` CSS px: the master at multiples of 16,
 * the 24 px hinting at other multiples of 24, the 20 px hinting at other multiples of 20, and
 * the master for every other size.
 */
export function atomLogoFor(size: number): SvgIconDef {
  if (size % 16 === 0) return atomLogo;
  if (size % 24 === 0) return atomLogo24;
  if (size % 20 === 0) return atomLogo20;
  return atomLogo;
}

/** The master shell's centre, in viewBox units: the electron orbits it on the boot splash. */
export const ATOM_SHELL_CENTRE = { x: MASTER.nucleus[0], y: MASTER.nucleus[1] } as const;
