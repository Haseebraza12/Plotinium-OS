/**
 * The boot mark, built from the same element tree as the Solid AtomLogo
 * (ui/src/icons/atom-logo.ts), so the two cannot drift apart. The boot copy adds what the
 * splash needs: the shell and its electron in one group (the electron takes one step round the
 * nucleus per real boot event, carrying the shell's gap with it), a nucleus group that can
 * flash, and a static bloom glow behind the nucleus. The stem stays still.
 *
 * The steps swing to and fro inside a safe arc (UI-003). The shell's gap spans 283°–347° round
 * the shell centre (screen angles: 0° right, 90° down) and the stem joins the ring at 127°–194°,
 * so a turn of the shell stays clear of the stem for any angle in [-88°, +139°]. A full turn
 * would carry the gap and the electron onto the stem (a normal boot reaches 17 steps, 204°) and
 * break the P apart; the ±60° swing keeps the mark whole at every step, with 28° to spare.
 */
import { ATOM_SHELL_CENTRE, atomLogo } from '../icons/atom-logo.ts';
import { resolveAttrs, type SvgNode } from '../icons/svg-tree.ts';
import { h, type VNode } from './dom.ts';

/**
 * The shared mark carries hex presentation attributes plus pl-logo-* class hooks and no `style`
 * attributes (the CSP has no 'unsafe-inline'). boot.css paints the same --pl-logo-* tokens
 * through those classes; any `style` is still dropped defensively.
 */
function fromDef(node: SvgNode, prefix: string): VNode {
  const { style: _style, ...attrs } = resolveAttrs(node[1], prefix);
  return h(
    node[0],
    attrs,
    (node[2] ?? []).map((kid) => fromDef(kid, prefix)),
  );
}

/** Degrees the shell and electron turn per real boot event. */
export const ORBIT_STEP_DEG = 12;
/** The swing either side of the mark's own position (a multiple of the step). */
export const ORBIT_SWING_DEG = 60;

/**
 * The shell's turn after `tick` boot events: 0, 12 … 60, 48 … -60, -48 … 0 and round again (a
 * triangle wave), so every step is one step from the last and the mark never meets its stem.
 */
export function orbitAngle(tick: number): number {
  const n = ORBIT_SWING_DEG / ORBIT_STEP_DEG;
  const period = 4 * n;
  const t = Number.isFinite(tick) ? Math.trunc(tick) : 0;
  const p = ((t % period) + period) % period;
  const k = p <= n ? p : p <= 3 * n ? 2 * n - p : p - period;
  return k * ORBIT_STEP_DEG;
}

/** The part of the mark with the given pl-logo-* class. */
function part(name: 'stem' | 'shell' | 'core' | 'electron'): SvgNode | undefined {
  return atomLogo.children.find((n) => n[1]['class'] === `pl-logo-${name}`);
}

/**
 * The boot backdrop: base field, three soft light blobs (they step once per boot stage) and a
 * faint generative wallpaper of partial orbit arcs (ui-design-system.md §3.2). Decorative only.
 */
export const backdrop = (): VNode =>
  h(
    'div',
    { class: 'plb-bg', 'aria-hidden': 'true' },
    h('i'),
    h('i'),
    h('i'),
    h(
      'svg',
      { class: 'plb-arcs', viewBox: '0 0 1440 900', preserveAspectRatio: 'xMidYMid slice' },
      [
        'M-120 760A900 360-12 0 1 1100 120',
        'M260 980A820 300 18 0 1 1560 520',
        'M1500 90A700 260-28 0 0 520-60',
        'M-80 300A640 220 8 0 0 700 960',
      ].map((d) => h('path', { d })),
      h('circle', { cx: 1100, cy: 120, r: 2 }),
    ),
  );

export interface LogoOptions {
  /** Pixel size (the splash uses --pl-boot-logo, 96 px). */
  readonly size: number;
  /** Unique id prefix for the gradients. */
  readonly id: string;
  /** Accessible name; omit for a decorative copy (aria-hidden). */
  readonly label?: string;
  readonly cls?: string;
}

/** The mark with a tickable shell and electron, a nucleus group and a bloom. */
export function logoSvg(opts: LogoOptions): VNode {
  const prefix = `${opts.id}lg-`;
  const [stem, shell, core, electron] = (['stem', 'shell', 'core', 'electron'] as const).map(
    (name) => part(name),
  );
  const copy = (node: SvgNode | undefined): VNode | false =>
    node !== undefined && fromDef(node, prefix);

  return h(
    'svg',
    {
      class: `plb-logo ${opts.cls ?? ''}`.trim(),
      width: opts.size,
      height: opts.size,
      viewBox: atomLogo.viewBox,
      ...(opts.label === undefined
        ? { 'aria-hidden': 'true' }
        : { role: 'img', 'aria-label': opts.label }),
    },
    h(
      'defs',
      null,
      h(
        'radialGradient',
        { id: `${prefix}bloom` },
        h('stop', { offset: 0, class: 'plb-glow' }),
        h('stop', { offset: 1, class: 'plb-glow', 'stop-opacity': 0 }),
      ),
    ),
    h('circle', {
      class: 'plb-bloom',
      cx: ATOM_SHELL_CENTRE.x,
      cy: ATOM_SHELL_CENTRE.y,
      r: 9,
      fill: `url(#${prefix}bloom)`,
    }),
    copy(stem),
    h('g', { class: 'plb-orbit', 'data-o': 0 }, copy(shell), copy(electron)),
    h('g', { class: 'plb-nuc' }, copy(core)),
  );
}
