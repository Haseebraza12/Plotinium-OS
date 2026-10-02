/**
 * UnsupportedScreen (boot-and-services.md §3.2.1, SVC-14; ui-design-system.md §3.8.1). The POST
 * capability checklist. If a required capability is missing the boot stops here: the title is
 * the identity string `Plotinium cannot start in this browser` and there is no Continue button.
 * If only degradable capabilities are missing, the card offers Continue. Every status is a word
 * as well as a colour and a glyph.
 */
import { docOf, h, listenKeys, q, qa, render, swapBox, swapText, typing, uid } from './dom.ts';
import { glyph, type GlyphName } from './glyphs.ts';
import { backdrop, logoSvg } from './logo.ts';
import type { BootIdentity, BootScreen, ScreenBase } from './types.ts';

export type CapabilityStatus = 'pass' | 'missing' | 'degraded' | 'checking' | 'unknown';

export interface CapabilityRow {
  readonly name: string;
  /** Probe detail in monospace, e.g. `localhost:4717` or `crypto.subtle`. */
  readonly probe?: string;
  readonly status: CapabilityStatus;
  /** One-line consequence or fix, e.g. `Open http://localhost:4717, not a LAN IP`. */
  readonly fix?: string;
  /** Required capabilities stop the boot when missing (§3.2.1). */
  readonly required?: boolean;
}

export interface UnsupportedScreenOptions extends BootIdentity, ScreenBase {
  readonly capabilities: readonly CapabilityRow[];
  /**
   * Where to open Plotinium instead (`http://localhost:4718`). Default: from the page's own
   * location (localAddress), never a fixed port (UI-069).
   */
  readonly address?: string;
  /** Browser and platform, e.g. `Chrome 128 on Linux`. */
  readonly platform?: string;
  readonly explanation?: string;
  /** Link to the requirements page (opens in a new tab). */
  readonly requirementsHref?: string;
  /** Continue in degraded mode; never offered when a required capability is missing. */
  readonly onContinue?: () => void;
  readonly onCopyDiagnostics?: () => void;
}

export interface UnsupportedScreen extends BootScreen {
  /** True when a required capability is missing: the boot cannot continue. */
  readonly fatal: boolean;
  /** Result of Copy diagnostics, shown on the button. */
  setCopyState(state: 'idle' | 'copied' | 'failed'): void;
}

/** The parts of `Location` that localAddress reads. */
export interface PageLocation {
  readonly protocol: string;
  readonly hostname: string;
  readonly port: string;
  readonly origin: string;
}

/**
 * The address that gives this page a secure context (UI-069): its own origin when it is already
 * https or on this machine, otherwise the same port on localhost, because a LAN IP over plain
 * http is not a secure context. Built from the page's location, so every port is right.
 */
export function localAddress(loc: PageLocation): string {
  const host = loc.hostname.toLowerCase();
  const onThisMachine =
    host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '[::1]';
  if (loc.protocol === 'https:' || onThisMachine) return loc.origin;
  return `http://localhost${loc.port === '' ? '' : `:${loc.port}`}`;
}

export const UNSUPPORTED_TITLE = 'Plotinium cannot start in this browser';
export const DEGRADED_TITLE = 'Plotinium will run with reduced features';

const TAG: Readonly<Record<CapabilityStatus, string>> = {
  pass: 'Pass',
  missing: 'Missing',
  degraded: 'Degraded',
  checking: 'Checking…',
  unknown: 'Unknown',
};
const ICON: Readonly<Record<CapabilityStatus, GlyphName>> = {
  pass: 'check',
  missing: 'x',
  degraded: 'alert',
  checking: 'circle',
  unknown: 'circle',
};

export function createUnsupportedScreen(opts: UnsupportedScreenOptions): UnsupportedScreen {
  const doc = docOf(opts.doc);
  const id = uid('plb-u');
  const caps = opts.capabilities;
  const fatal =
    opts.onContinue === undefined ||
    caps.some((c) => c.required === true && c.status === 'missing');
  const failing = caps.filter((c) => c.status === 'missing' || c.status === 'degraded');
  const title = fatal ? UNSUPPORTED_TITLE : DEGRADED_TITLE;
  const location = doc.defaultView?.location;
  const address =
    opts.address ?? (location === undefined ? 'http://localhost' : localAddress(location));
  const explanation =
    opts.explanation ??
    (fatal
      ? `Plotinium runs its kernel and apps in browser workers and keeps your files in local storage. This browser lacks a feature Plotinium cannot start without. Open Plotinium in the latest Chrome at ${address}, not a LAN IP.`
      : 'Plotinium runs its kernel and apps in browser workers and keeps your files in local storage. Some features it relies on are unavailable here. You can continue: everything works, but paging and scheduling will be slower.');
  const summary = `${title}. ${failing.length} ${failing.length === 1 ? 'feature' : 'features'} unavailable${failing.length === 0 ? '' : `: ${failing.map((c) => c.name).join(', ')}`}.`;
  const identity = `Plotinium ${opts.version} · build ${opts.build}`;
  const root = render(
    h(
      'div',
      { class: 'plb plb-unsup' },
      backdrop(),
      h(
        'main',
        { class: 'plb-card', 'aria-labelledby': `${id}t` },
        logoSvg({ size: 64, id, cls: 'plb-dim' }),
        h('p', { class: 'plb-over' }, 'Power-on self test'),
        h('h1', { class: 'plb-h', id: `${id}t` }, title),
        h(
          'p',
          { class: 'plb-meta' },
          opts.platform === undefined ? identity : `${identity} · ${opts.platform}`,
        ),
        h(
          'ul',
          { class: 'plb-caps', 'aria-label': 'Browser capabilities' },
          caps.map((c, i) =>
            h(
              'li',
              { 'data-s': c.status, '--plb-i': i },
              glyph(ICON[c.status], 14, 'plb-ci'),
              h(
                'span',
                { class: 'plb-cn' },
                c.name,
                c.probe !== undefined && [' ', h('code', null, c.probe)],
              ),
              h('span', { class: 'plb-tagx' }, TAG[c.status]),
              c.fix !== undefined && h('span', { class: 'plb-fix' }, c.fix),
            ),
          ),
        ),
        h('p', { class: 'plb-lead' }, explanation),
        h(
          'div',
          { class: 'plb-actions' },
          !fatal &&
            h(
              'button',
              {
                type: 'button',
                class: 'plb-btn plb-primary',
                'data-a': 'continue',
                'aria-keyshortcuts': 'Enter',
              },
              h('span', null, 'Continue in degraded mode'),
              glyph('arrow', 16),
            ),
          h(
            'button',
            { type: 'button', class: 'plb-btn', 'data-a': 'copy', 'aria-keyshortcuts': 'D' },
            glyph('clipboard', 16),
            swapBox('plb-cp', 'Copy diagnostics'),
          ),
        ),
        h(
          'footer',
          { class: 'plb-uf' },
          opts.requirementsHref === undefined
            ? h('span')
            : h(
                'a',
                { href: opts.requirementsHref, target: '_blank', rel: 'noopener' },
                'Requirements',
                glyph('external', 13),
                h('span', { class: 'plb-sr' }, ' (opens in a new tab)'),
              ),
          h(
            'span',
            { class: 'plb-keys', 'aria-hidden': 'true' },
            !fatal && [h('kbd', null, 'Enter'), ' continue · '],
            h('kbd', null, 'D'),
            ' copy diagnostics',
          ),
        ),
        h('p', { class: 'plb-sr', role: fatal ? 'alert' : 'status' }, summary),
      ),
      h('p', { class: 'plb-ufoot' }, identity),
    ),
    doc,
  );
  const [first] = qa<HTMLButtonElement>(root, '.plb-btn');
  const copyBtn = q<HTMLButtonElement>(root, '[data-a="copy"]');

  root.addEventListener('click', (e) => {
    const a =
      e.target instanceof Element
        ? e.target.closest<HTMLElement>('[data-a]')?.dataset.a
        : undefined;
    if (a === 'continue') opts.onContinue?.();
    else if (a === 'copy') opts.onCopyDiagnostics?.();
  });
  const unlisten = listenKeys(doc, (e) => {
    if (typing(e) || e.repeat) return;
    if (e.key.toUpperCase() === 'D') {
      e.preventDefault();
      opts.onCopyDiagnostics?.();
    } else if (
      e.key === 'Enter' &&
      !fatal &&
      !(e.target instanceof HTMLButtonElement || e.target instanceof HTMLAnchorElement)
    ) {
      e.preventDefault();
      opts.onContinue?.();
    }
  });

  return {
    el: root,
    fatal,
    setCopyState(state) {
      copyBtn.dataset.state = state;
      swapText(
        q(copyBtn, '.plb-cp'),
        state === 'copied' ? 'Copied' : state === 'failed' ? "Couldn't copy" : 'Copy diagnostics',
      );
    },
    focus() {
      first?.focus();
    },
    destroy() {
      unlisten();
      root.remove();
    },
  };
}
