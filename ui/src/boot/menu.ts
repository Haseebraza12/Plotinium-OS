/**
 * BootMenu, "Plotinium Boot Manager" (BOOT-06, BOOT-13; ui-design-system.md §3.8.2). A dialog
 * holding a listbox: ↑/↓ move (wrapping), Home/End jump, 1–4 pick and boot, Enter boots, Esc
 * closes (the driver then boots Normal). Focus stays on the listbox and the selected option is
 * `aria-activedescendant`; one highlight pill slides between rows.
 *
 * The auto-boot countdown is drawn here but not timed here: wm/boot-ui/menu.ts owns the one
 * allowlisted countdown timer and calls setCountdown() on each tick. The ring shows only while
 * the menu is open and the countdown runs; the first key or pointer press stops it for good.
 */
import { docOf, h, listenKeys, nodes, q, qa, render, typing, uid, type VNode } from './dom.ts';
import { glyph, type GlyphName } from './glyphs.ts';
import { backdrop, logoSvg } from './logo.ts';
import type { BootIdentity, BootScreen, ScreenBase } from './types.ts';

export type BootMode = 'normal' | 'safe' | 'recovery' | 'verbose';

export interface BootMenuOption {
  readonly id: BootMode;
  readonly title: string;
  readonly description: string;
  readonly icon: GlyphName;
}

/** The four entries of boot-and-services.md §3.7, worded as ui-design-system.md §3.8.2. */
export const BOOT_MENU_OPTIONS: readonly BootMenuOption[] = [
  {
    id: 'normal',
    title: 'Normal boot',
    description: 'Start Plotinium and restore your session',
    icon: 'power',
  },
  {
    id: 'safe',
    title: 'Safe mode',
    description: 'No AI services · no autostart apps · default theme',
    icon: 'shield',
  },
  {
    id: 'recovery',
    title: 'Recovery',
    description: 'File-system check · clear local cache · reset session',
    icon: 'wrench',
  },
  { id: 'verbose', title: 'Verbose boot', description: 'Timestamped kernel log', icon: 'terminal' },
];

export interface BootMenuOptions extends BootIdentity, ScreenBase {
  readonly options?: readonly BootMenuOption[];
  /** Initially selected entry (Normal by default; Safe after two failed boots). */
  readonly selected?: BootMode;
  /** Consecutive failed boots; 2 or more shows the warning line and preselects Safe (SVC-07). */
  readonly failedBoots?: number;
  /** Enter, a number key or a double click: boot this mode. */
  readonly onChoose: (mode: BootMode) => void;
  /** Esc: close the menu (the driver boots Normal). */
  readonly onClose?: () => void;
  /** The first key or pointer press: the driver stops the countdown timer. */
  readonly onInteract?: () => void;
  /** Speaks through the boot status region (the countdown is announced once, not every second). */
  readonly announce?: (text: string) => void;
}

export interface BootMenu extends BootScreen {
  readonly selected: BootMode;
  select(mode: BootMode): void;
  /**
   * Shows `auto-boot in n s` and a ring of `total` segments, one dimming per elapsed second.
   * null hides it. Ignored once the user has interacted.
   */
  setCountdown(remaining: number | null, total?: number): void;
}

const RING_R = 6.5;

/** One ring segment per second, with 20° gaps. */
function ring(total: number): VNode {
  const n = Math.max(1, Math.round(total));
  const pt = (deg: number): string => {
    const a = ((deg - 90) * Math.PI) / 180;
    return `${(8 + RING_R * Math.cos(a)).toFixed(2)} ${(8 + RING_R * Math.sin(a)).toFixed(2)}`;
  };
  const span = 360 / n;
  return h(
    'svg',
    { class: 'plb-ring', width: 16, height: 16, viewBox: '0 0 16 16', 'aria-hidden': 'true' },
    h('circle', { cx: 8, cy: 8, r: RING_R }),
    Array.from({ length: n }, (_, i) => {
      const a0 = i * span + 10;
      const a1 = (i + 1) * span - 10;
      return h('path', {
        d: `M${pt(a0)}A${RING_R} ${RING_R} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${pt(a1)}`,
      });
    }),
  );
}

export function createBootMenu(opts: BootMenuOptions): BootMenu {
  const doc = docOf(opts.doc);
  const id = uid('plb-m');
  const options = opts.options ?? BOOT_MENU_OPTIONS;
  const failed = (opts.failedBoots ?? 0) >= 2;
  const initial = opts.selected ?? (failed ? 'safe' : 'normal');

  const root = render(
    h(
      'div',
      { class: 'plb plb-menu' },
      backdrop(),
      h('div', { class: 'plb-scrim', 'aria-hidden': 'true' }),
      h(
        'div',
        { class: 'plb-panel', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': `${id}h` },
        h(
          'header',
          { class: 'plb-mh' },
          logoSvg({ size: 22, id }),
          h('h1', { id: `${id}h` }, 'Plotinium Boot Manager'),
          h('span', { class: 'plb-tag' }, `${opts.version} · ${opts.build}`),
        ),
        failed &&
          h(
            'p',
            { class: 'plb-warn', role: 'status' },
            glyph('alert', 16),
            `The last ${opts.failedBoots ?? 2} boots failed. Safe mode is selected.`,
          ),
        h(
          'div',
          {
            class: 'plb-lb',
            role: 'listbox',
            tabindex: 0,
            'aria-labelledby': `${id}h`,
            'aria-describedby': `${id}k`,
          },
          h('i', { class: 'plb-hl', 'aria-hidden': 'true' }),
          options.map((o, i) =>
            h(
              'div',
              {
                class: 'plb-opt',
                role: 'option',
                id: `${id}o${i}`,
                'aria-selected': 'false',
                'aria-labelledby': `${id}t${i}`,
                'aria-describedby': `${id}d${i}`,
                'data-i': i,
              },
              glyph(o.icon),
              h('span', { class: 'plb-ot', id: `${id}t${i}` }, o.title),
              h('span', { class: 'plb-od', id: `${id}d${i}` }, o.description),
              h('span', { class: 'plb-mk', 'aria-hidden': 'true' }, '▶'),
            ),
          ),
        ),
        h(
          'footer',
          { class: 'plb-mf' },
          h(
            'span',
            { class: 'plb-keys', 'aria-hidden': 'true' },
            h('kbd', null, '↑'),
            h('kbd', null, '↓'),
            ' select',
            h('i', null, '·'),
            h('kbd', null, 'Enter'),
            ' boot',
            h('i', null, '·'),
            h('kbd', null, 'Esc'),
            ' close',
          ),
          h(
            'span',
            { class: 'plb-sr', id: `${id}k` },
            'Use the arrow keys to choose, Enter to boot, Escape to close.',
          ),
          h('span', { class: 'plb-cd', hidden: true }, 'auto-boot in ', h('b', null, '0'), ' s'),
        ),
      ),
      h(
        'p',
        { class: 'plb-help' },
        'Hold ',
        h('kbd', null, 'Esc'),
        ' at start-up, or run ',
        h('code', null, 'reboot --menu'),
        ', to open this menu',
      ),
    ),
    doc,
  );
  const panel = q(root, '.plb-panel');
  const list = q(root, '.plb-lb');
  const opts$ = qa(list, '.plb-opt');
  const cd = q(root, '.plb-cd');
  const cdNum = q(cd, 'b');
  let index = Math.max(
    0,
    options.findIndex((o) => o.id === initial),
  );
  let chosen = false;
  let stopped = false;
  let ringTotal = 0;
  let announced = false;

  const paint = (): void => {
    list.style.setProperty('--plb-sel', String(index));
    list.setAttribute('aria-activedescendant', `${id}o${index}`);
    opts$.forEach((o, i) => o.setAttribute('aria-selected', String(i === index)));
  };

  const interact = (): void => {
    if (stopped) return;
    stopped = true;
    const running = !cd.hidden;
    cd.hidden = true;
    opts.onInteract?.();
    if (running) opts.announce?.('auto-boot stopped');
  };

  const choose = (i: number): void => {
    const option = options[i];
    if (chosen || option === undefined) return;
    chosen = true;
    index = i;
    paint();
    panel.dataset.chosen = '';
    q(root, '.plb-keys').textContent = `Starting ${option.title.toLowerCase()}…`;
    opts.onChoose(option.id);
  };

  const onKey = (e: KeyboardEvent): void => {
    interact();
    if (chosen) return;
    const n = options.length;
    const digit = Number.parseInt(e.key, 10);
    let handled = true;
    if (e.key === 'ArrowDown') index = (index + 1) % n;
    else if (e.key === 'ArrowUp') index = (index - 1 + n) % n;
    else if (e.key === 'Home') index = 0;
    else if (e.key === 'End') index = n - 1;
    else if (e.key === 'Enter' || e.key === ' ') choose(index);
    else if (e.key === 'Escape') opts.onClose?.();
    else if (digit >= 1 && digit <= n) choose(digit - 1);
    else handled = false;
    if (handled) {
      e.preventDefault();
      paint();
    }
  };
  list.addEventListener('keydown', onKey);
  // A click outside the list (the scrim, the help line) moves focus to the body; the keys keep
  // working from anywhere while the menu is open (UI-066), and focus returns to the list.
  const unlisten = listenKeys(doc, (e) => {
    const target = e.target;
    if (target instanceof Node && list.contains(target)) return;
    if (e.defaultPrevented || typing(e)) return;
    // Holding Esc to open the menu repeats the key: a repeat never closes it.
    if (e.repeat && e.key === 'Escape') return;
    onKey(e);
    if (!chosen) list.focus();
  });
  // Any press on the menu is an interaction: the auto-boot countdown stops.
  root.addEventListener('pointerdown', interact);
  list.addEventListener('click', (e) => {
    const row = e.target instanceof Element ? e.target.closest<HTMLElement>('.plb-opt') : null;
    if (row === null || chosen) return;
    index = Number(row.dataset.i);
    paint();
    list.focus();
  });
  list.addEventListener('dblclick', () => choose(index));

  paint();
  return {
    el: root,
    get selected() {
      return options[index]?.id ?? 'normal';
    },
    select(mode) {
      const i = options.findIndex((o) => o.id === mode);
      if (i >= 0 && !chosen) {
        index = i;
        paint();
      }
    },
    setCountdown(remaining, total = 5) {
      if (stopped || chosen) return;
      if (remaining === null) {
        cd.hidden = true;
        return;
      }
      if (total !== ringTotal) {
        ringTotal = total;
        cd.querySelector('svg')?.remove();
        cd.append(...nodes(ring(total), doc));
      }
      const left = Math.max(0, Math.ceil(remaining));
      cd.hidden = false;
      cdNum.textContent = String(left);
      qa<Element>(cd, 'path').forEach((p, i) => p.toggleAttribute('data-off', i < total - left));
      if (!announced) {
        announced = true;
        opts.announce?.(`auto-boot in ${Math.ceil(remaining)} seconds`);
      }
    },
    focus() {
      list.focus();
    },
    destroy() {
      unlisten();
      root.remove();
    },
  };
}
