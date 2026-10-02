/**
 * VerboseLog (BOOT-05): an append-only, virtualised renderer of kernel-style boot lines,
 * `[ssss.mmm] subsystem: message`. Only the rows in view (plus overscan) exist in the DOM, so
 * a long boot record costs the same as a short one. WARN, DEGRADED, FAIL and KERNEL PANIC are
 * always written as text prefixes, so colour is never the only signal (DSN-08).
 *
 * The view sticks to the newest line until the reader scrolls up; then new lines are counted
 * on a "Jump to latest" button. Appends are batched per animation frame (never a timer).
 */
import { docOf, h, q, render, type VNode } from './dom.ts';
import type { BootLogLevel, BootLogLine, ScreenBase } from './types.ts';

const PREFIXES: readonly (readonly [string, BootLogLevel])[] = [
  ['KERNEL PANIC', 'panic'],
  ['DEGRADED', 'degraded'],
  ['WARN', 'warn'],
  ['FAIL', 'fail'],
];
const LABEL: Readonly<Record<BootLogLevel, string>> = {
  info: '',
  ok: '✓',
  warn: 'WARN',
  degraded: 'DEGRADED',
  fail: 'FAIL',
  panic: 'KERNEL PANIC',
};

/** The level of a line: its own, else the one its text prefix names. */
export function levelOf(line: BootLogLine): BootLogLevel {
  return line.level ?? PREFIXES.find(([p]) => line.msg.startsWith(p))?.[1] ?? 'info';
}

/** `[    0.087]`: seconds since t0, right-aligned in 11 columns (boot-and-services.md §3.7). */
export const formatBootTime = (t: number): string => `[${t.toFixed(3).padStart(9)}]`;

/** A line exactly as klog prints it. */
export const formatBootLine = (line: BootLogLine): string =>
  `${formatBootTime(line.t)} ${line.sub}: ${line.msg}`;

/** Parses the text form (`[    0.402] sync: WARN backend unreachable`); null if it is not one. */
export function parseBootLine(text: string): BootLogLine | null {
  const m = /^\[\s*(\d+(?:\.\d+)?)\]\s+([^\s:]+):\s?(.*)$/u.exec(text);
  return m === null ? null : { t: Number(m[1]), sub: m[2] ?? '', msg: m[3] ?? '' };
}

/**
 * Splits the text prefix from the rest of the message, keeping the original separator (so
 * `KERNEL PANIC: …` stays exact). A level given without its word gets the word added.
 */
export function splitPrefix(line: BootLogLine): readonly [prefix: string, rest: string] {
  const word = LABEL[levelOf(line)];
  if (word === '') return ['', line.msg];
  return line.msg.startsWith(word) ? [word, line.msg.slice(word.length)] : [word, ` ${line.msg}`];
}

/** One line as a static element (the panic screen's code block). */
export function lineNode(line: BootLogLine, tag = 'span'): VNode {
  const [prefix, rest] = splitPrefix(line);
  return h(
    tag,
    { class: 'plb-row', 'data-l': levelOf(line) },
    h('span', { class: 'plb-ts' }, formatBootTime(line.t)),
    ' ',
    h('span', { class: 'plb-sub' }, `${line.sub}:`),
    ' ',
    h('span', { class: 'plb-pfx', hidden: prefix === '' }, prefix),
    h('span', { class: 'plb-msg' }, rest),
  );
}

export interface VerboseLogOptions extends ScreenBase {
  /** Accessible name of the log region. */
  readonly label?: string;
  /** BOOT-05: `off` (a boot burst would flood a screen reader). The recovery output uses `polite`. */
  readonly live?: 'off' | 'polite';
  /** Row height in px; rows are fixed-height so the window is pure arithmetic. */
  readonly rowHeight?: number;
  /** Rows rendered beyond each edge of the viewport. */
  readonly overscan?: number;
  /** Text shown before the first line. */
  readonly empty?: string;
  /** Batches renders; defaults to requestAnimationFrame. null renders on every append. */
  readonly schedule?: ((fn: () => void) => void) | null;
}

export interface VerboseLog {
  readonly el: HTMLElement;
  /** Number of lines appended so far. */
  readonly length: number;
  /** Appends lines (the log never edits or removes a line). */
  append(...lines: readonly BootLogLine[]): void;
  /** Renders pending lines now. */
  flush(): void;
  /** Shows the newest line and sticks to it again. */
  scrollToEnd(): void;
  destroy(): void;
}

interface Row {
  readonly el: HTMLElement;
  readonly ts: HTMLElement;
  readonly sub: HTMLElement;
  readonly pfx: HTMLElement;
  readonly msg: HTMLElement;
}

/** Viewport rows assumed before layout exists (a detached or hidden log). */
const FALLBACK_ROWS = 40;

export function createVerboseLog(opts: VerboseLogOptions = {}): VerboseLog {
  const doc = docOf(opts.doc);
  const rh = opts.rowHeight ?? 20;
  const overscan = opts.overscan ?? 8;
  const raf = doc.defaultView?.requestAnimationFrame.bind(doc.defaultView);
  const schedule =
    opts.schedule === undefined
      ? raf === undefined
        ? null
        : (fn: () => void) => void raf(fn)
      : opts.schedule;

  const root = render(
    h(
      'div',
      { class: 'plb-log', '--plb-rh': `${rh}px` },
      h(
        'div',
        {
          class: 'plb-scroll',
          role: 'log',
          'aria-live': opts.live ?? 'off',
          'aria-label': opts.label ?? 'Boot log',
          tabindex: 0,
        },
        h('p', { class: 'plb-empty' }, opts.empty ?? 'waiting for firmware…'),
        h('div', { class: 'plb-sizer' }),
      ),
      h(
        'button',
        { type: 'button', class: 'plb-jump', hidden: true },
        '↓ ',
        h('span', null, '0'),
        ' new lines',
      ),
    ),
    doc,
  );
  const scroller = q(root, '.plb-scroll');
  const sizer = q(root, '.plb-sizer');
  const empty = q(root, '.plb-empty');
  const jump = q<HTMLButtonElement>(root, '.plb-jump');
  const jumpCount = q(jump, 'span');

  const lines: BootLogLine[] = [];
  const pool: Row[] = [];
  /** Lines laid out by the last paint: the scroll height the scroller really has. */
  let painted = 0;
  let stick = true;
  let unseen = 0;
  let fresh = 0;
  let pending = false;
  let alive = true;

  const makeRow = (): Row => {
    const row = render(lineNode({ t: 0, sub: '', msg: '' }, 'div'), doc);
    const [ts, , sub, , pfx, msg] = row.childNodes;
    sizer.append(row);
    return {
      el: row,
      ts: ts as HTMLElement,
      sub: sub as HTMLElement,
      pfx: pfx as HTMLElement,
      msg: msg as HTMLElement,
    };
  };

  const fill = (row: Row, i: number): void => {
    const line = lines[i];
    if (line === undefined) return;
    const [prefix, msg] = splitPrefix(line);
    row.el.hidden = false;
    row.el.style.top = `${i * rh}px`;
    row.el.dataset.l = levelOf(line);
    row.ts.textContent = formatBootTime(line.t);
    row.sub.textContent = `${line.sub}:`;
    row.pfx.textContent = prefix;
    row.pfx.hidden = prefix === '';
    row.msg.textContent = msg;
  };

  const viewport = (): number => scroller.clientHeight || rh * FALLBACK_ROWS;

  const paint = (): void => {
    if (!alive) return;
    pending = false;
    const n = lines.length;
    const vh = viewport();
    painted = n;
    sizer.style.height = `${n * rh}px`;
    empty.hidden = n > 0;
    let top = scroller.scrollTop;
    if (stick) {
      top = Math.max(0, n * rh - vh);
      scroller.scrollTop = top;
    }
    const first = Math.max(0, Math.floor(top / rh) - overscan);
    const end = Math.min(n, Math.ceil((top + vh) / rh) + overscan);
    while (pool.length < end - first) pool.push(makeRow());
    pool.forEach((row, k) => {
      if (first + k < end) fill(row, first + k);
      else row.el.hidden = true;
    });
    // Only the newest line of a small batch slides in; a burst appears at once.
    const newest = pool[n - 1 - first];
    if (stick && fresh > 0 && fresh <= 8 && newest !== undefined) {
      newest.el.setAttribute('data-new', '');
      newest.el.getBoundingClientRect();
      newest.el.removeAttribute('data-new');
    }
    fresh = 0;
    jump.hidden = stick || unseen === 0;
    jumpCount.textContent = String(unseen);
  };

  // Compared with the painted height, not lines.length: lines appended since the last paint
  // are not laid out yet, and counting them made the scroll event of our own jump to the end
  // look like the reader scrolling up, so the log stopped following (UI-062).
  const onScroll = (): void => {
    const atEnd = scroller.scrollTop + viewport() >= painted * rh - rh / 2;
    if (atEnd === stick) return;
    stick = atEnd;
    if (stick) unseen = 0;
    paint();
  };
  scroller.addEventListener('scroll', onScroll, { passive: true });
  scroller.addEventListener('keydown', (e) => {
    if (e.key === 'End') api.scrollToEnd();
  });
  jump.addEventListener('click', () => {
    api.scrollToEnd();
    scroller.focus();
  });

  const api: VerboseLog = {
    el: root,
    get length() {
      return lines.length;
    },
    append(...added) {
      if (added.length === 0) return;
      lines.push(...added);
      fresh += added.length;
      if (!stick) unseen += added.length;
      if (schedule === null) paint();
      else if (!pending) {
        pending = true;
        schedule(() => {
          if (pending) paint();
        });
      }
    },
    flush() {
      if (pending) paint();
    },
    scrollToEnd() {
      stick = true;
      unseen = 0;
      paint();
    },
    destroy() {
      alive = false;
      root.remove();
    },
  };
  return api;
}
