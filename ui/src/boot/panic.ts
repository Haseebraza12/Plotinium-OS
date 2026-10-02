/**
 * PanicScreen (BOOT-04, BOOT-08; ui-design-system.md §3.8.4; boot-and-services.md §3.6). A
 * halted boot: the title, the reason in words and in the log (scrolled to the failing line),
 * the dependency cycle drawn as a small graph, and actions with single-key shortcuts that work
 * wherever focus is: [T] retry (a failed critical service, BOOT-08), [R] recovery console,
 * [S] safe mode, [D] diagnostics (a download). It is an alertdialog; focus starts on the first
 * action. There is no timeout.
 */
import { docOf, h, listenKeys, q, qa, render, typing, uid, type VNode } from './dom.ts';
import { glyph, type GlyphName } from './glyphs.ts';
import { lineNode } from './log.ts';
import { logoSvg } from './logo.ts';
import type { BootIdentity, BootLogLine, BootScreen, ScreenBase } from './types.ts';

export type PanicAction = 'retry' | 'recovery' | 'safe' | 'diagnostics';

export interface PanicScreenOptions extends BootIdentity, ScreenBase {
  /** The klog tail, ending with the `KERNEL PANIC:` line. */
  readonly lines: readonly BootLogLine[];
  /** The cycle as printed, closed by repeating its first member: `['auth','sync','lockd','auth']`. */
  readonly cycle?: readonly string[];
  /** Default `Kernel panic`; a failed critical service is `Plotinium could not start` (§3.6). */
  readonly title?: string;
  /** What failed, in one line under the title: `sched failed: timeout 500 ms`. */
  readonly reason?: string;
  /** Plain-language explanation under the title. */
  readonly explanation?: string;
  /** Offer [T] Retry first (a failed critical service or kernel start, BOOT-08). */
  readonly retry?: boolean;
  readonly bootId?: string;
  /** Wall-clock time and uptime for the footer, preformatted by the caller. */
  readonly time?: string;
  readonly onAction: (action: PanicAction) => void;
}

export interface PanicScreen extends BootScreen {
  /** Marks an action as running (`Rebooting into recovery…`); the others are disabled. */
  setBusy(action: PanicAction | null, label?: string): void;
}

const ALL_ACTIONS: readonly (readonly [PanicAction, string, GlyphName, string])[] = [
  ['retry', 'T', 'reset', 'Retry'],
  ['recovery', 'R', 'terminal', 'Recovery console'],
  ['safe', 'S', 'shield', 'Safe mode'],
  // boot-and-services.md §3.6 calls it [D] Diagnostics; the short label keeps four actions on
  // one row.
  ['diagnostics', 'D', 'download', 'Diagnostics'],
];

/** `T, R, S or D`. */
const keyList = (keys: readonly string[]): string =>
  keys.length < 2 ? (keys[0] ?? '') : `${keys.slice(0, -1).join(', ')} or ${keys.at(-1) ?? ''}`;

const f = (v: number): string => v.toFixed(1);

/**
 * The cycle as an SVG graph: nodes on an ellipse, one curved arrow per requires edge (u → v
 * means v requires u), the closing edge labelled. Arrowheads and the label carry the meaning
 * as well as the colour.
 */
export function cycleSvg(cycle: readonly string[], id: string): VNode | null {
  const names = cycle.length > 1 && cycle[0] === cycle.at(-1) ? cycle.slice(0, -1) : [...cycle];
  const n = names.length;
  if (n < 2) return null;
  const cx = 210;
  const cy = 84;
  const pts = names.map((name, i) => {
    const a = ((-150 + (i * 360) / n) * Math.PI) / 180;
    return {
      name,
      x: cx + 128 * Math.cos(a),
      y: cy + 52 * Math.sin(a),
      hw: name.length * 3.7 + 13,
    };
  });
  /** Moves from a node's centre towards (tx, ty) until just outside its pill. */
  const edge = (node: (typeof pts)[number], tx: number, ty: number, gap: number): string => {
    const len = Math.hypot(tx - node.x, ty - node.y) || 1;
    const ux = (tx - node.x) / len;
    const uy = (ty - node.y) / len;
    const d = Math.min(node.hw / (Math.abs(ux) || 1e-6), 12 / (Math.abs(uy) || 1e-6)) + gap;
    return `${f(node.x + ux * d)} ${f(node.y + uy * d)}`;
  };
  const edges: VNode[] = [];
  let label: VNode | null = null;
  pts.forEach((a, i) => {
    const b = pts[(i + 1) % n] ?? a;
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    const kx = mx + (mx - cx) * 0.55;
    const ky = my + (my - cy) * 0.55;
    edges.push(
      h('path', {
        '--plb-i': i,
        d: `M${edge(a, kx, ky, 3)}Q${f(kx)} ${f(ky)} ${edge(b, kx, ky, 6)}`,
        'marker-end': `url(#${id}ah)`,
      }),
    );
    if (i === n - 1) {
      const lx = kx + (kx - cx) * 0.12;
      label = h(
        'text',
        {
          class: 'plb-gl',
          x: f(lx),
          y: f(ky + (ky - cy) * 0.12 + 4),
          'text-anchor': lx < cx - 20 ? 'end' : lx > cx + 20 ? 'start' : 'middle',
        },
        'closes cycle',
      );
    }
  });
  const spoken = pts
    .map((a, i) => `${pts[(i + 1) % n]?.name ?? a.name} requires ${a.name}`)
    .join(', ');
  return h(
    'svg',
    {
      class: 'plb-graph',
      viewBox: '0 0 420 172',
      role: 'img',
      'aria-label': `Dependency cycle: ${spoken}.`,
    },
    h(
      'defs',
      null,
      h(
        'marker',
        {
          id: `${id}ah`,
          viewBox: '0 0 10 10',
          refX: 8,
          refY: 5,
          markerWidth: 7,
          markerHeight: 7,
          orient: 'auto-start-reverse',
        },
        h('path', { d: 'M0 0L10 5 0 10z' }),
      ),
    ),
    h('g', { class: 'plb-ge' }, edges),
    label,
    pts.map((p, i) =>
      h(
        'g',
        { class: 'plb-gn', '--plb-i': i, transform: `translate(${f(p.x)} ${f(p.y)})` },
        h('rect', { x: f(-p.hw), y: -12, width: f(p.hw * 2), height: 24, rx: 12 }),
        h('text', { 'text-anchor': 'middle', y: 4 }, p.name),
      ),
    ),
  );
}

export function createPanicScreen(opts: PanicScreenOptions): PanicScreen {
  const doc = docOf(opts.doc);
  const id = uid('plb-p');
  const ACTIONS = ALL_ACTIONS.filter(([action]) => action !== 'retry' || opts.retry === true);
  const title = opts.title ?? 'Kernel panic';
  const explanation =
    opts.explanation ??
    (opts.cycle === undefined
      ? 'Plotinium stopped during boot because the kernel could not continue. Your files are safe.'
      : 'Plotinium stopped during boot because the service graph contains a cycle. Your files are safe; nothing was written.');
  const root = render(
    h(
      'div',
      { class: 'plb plb-panic' },
      h('div', { class: 'plb-vignette', 'aria-hidden': 'true' }),
      h(
        'section',
        {
          class: 'plb-card',
          role: 'alertdialog',
          'aria-modal': 'true',
          'aria-labelledby': `${id}t`,
          'aria-describedby': `${opts.reason === undefined ? '' : `${id}w `}${id}d ${id}r`,
        },
        h('span', { class: 'plb-medal', 'aria-hidden': 'true' }, glyph('alert', 26)),
        h(
          'h1',
          { class: 'plb-h', id: `${id}t` },
          title.startsWith('Plotinium') ? null : h('span', { class: 'plb-sr' }, 'Plotinium '),
          title,
        ),
        opts.reason !== undefined && h('p', { class: 'plb-why', id: `${id}w` }, opts.reason),
        h('p', { class: 'plb-lead', id: `${id}d` }, explanation),
        h(
          'pre',
          { class: 'plb-code', id: `${id}r`, tabindex: 0, 'aria-label': 'Panic log' },
          opts.lines.map((line, i) => [i > 0 && '\n', lineNode(line)]),
        ),
        opts.cycle !== undefined && cycleSvg(opts.cycle, id),
        h(
          'div',
          { class: 'plb-actions' },
          ACTIONS.map(([action, key, icon, label], i) =>
            h(
              'button',
              {
                type: 'button',
                class: i === 0 ? 'plb-btn plb-primary' : 'plb-btn',
                'data-a': action,
                'aria-keyshortcuts': key,
              },
              h('kbd', { 'aria-hidden': 'true' }, key),
              glyph(icon, 18),
              h('span', null, label),
            ),
          ),
        ),
        h(
          'p',
          { class: 'plb-hint' },
          `Use ${keyList(ACTIONS.map(([, key]) => key))}, or Tab to move between options.${opts.retry === true ? ' Retry starts the system again.' : ''} Safe mode starts from the built-in manifests, without AI services.`,
        ),
        h('p', { class: 'plb-sr', role: 'status' }),
      ),
      h(
        'footer',
        { class: 'plb-foot' },
        h('span', null, opts.bootId === undefined ? '' : `boot id ${opts.bootId}`),
        h('span', null, opts.time ?? ''),
        h('span', null, logoSvg({ size: 14, id }), `Plotinium ${opts.version} · ${opts.build}`),
      ),
    ),
    doc,
  );
  const btns = qa<HTMLButtonElement>(root, '.plb-btn');
  const status = q(root, '[role="status"]');
  const code = q(root, '.plb-code');

  const act = (action: PanicAction): void => {
    const btn = btns.find((b) => b.dataset.a === action);
    if (btn !== undefined && btn.getAttribute('aria-disabled') !== 'true') opts.onAction(action);
  };
  root.addEventListener('click', (e) => {
    const btn = e.target instanceof Element ? e.target.closest<HTMLElement>('.plb-btn') : null;
    const action = ACTIONS.find(([a]) => a === btn?.dataset.a)?.[0];
    if (action !== undefined) act(action);
  });
  const unlisten = listenKeys(doc, (e) => {
    if (typing(e) || e.repeat) return;
    const action = ACTIONS.find(([, key]) => key === e.key.toUpperCase())?.[0];
    if (action === undefined) return;
    e.preventDefault();
    act(action);
  });

  return {
    el: root,
    setBusy(action, label) {
      for (const b of btns) {
        const mine = b.dataset.a === action;
        if (action === null || mine) b.removeAttribute('aria-disabled');
        else b.setAttribute('aria-disabled', 'true');
        const text = q(b, 'span');
        text.textContent =
          mine && label !== undefined
            ? label
            : (ACTIONS.find(([a]) => a === b.dataset.a)?.[3] ?? '');
      }
      status.textContent = label ?? '';
    },
    focus() {
      // Mounted by now: show the end of the log, where the failing line is.
      code.scrollTop = code.scrollHeight;
      btns[0]?.focus();
    },
    destroy() {
      unlisten();
      root.remove();
    },
  };
}
