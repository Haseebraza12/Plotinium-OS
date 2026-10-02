/**
 * Boot status cards the ui/ boot kit does not ship as builders yet (UIG §3.4.6 StatusCard): the
 * second-tab takeover (ARC-02), "moved to another tab", the stage-2 kernel-load failure (boot
 * §6.1), the boot-stall screen (§3.9, SVC-18) and the halted state (§3.10 step 9). Built from the
 * kit's element-tree helpers and boot.css card classes, so they share the unsupported-browser
 * card's look and the same rules: no HTML sinks, no inline style attributes, single-key
 * shortcuts that work wherever focus is.
 *
 * While a card is up, the login screen or desktop under it (#plt-desktop) is inert: it cannot
 * take focus or keys, so the card's primary action (Enter) always works (UI-031).
 */
import { backdrop, h, logoSvg, render } from '@plotinium/ui/boot';

export interface MessageAction {
  /** Single-key shortcut (letter or `Enter`), shown as a keycap. */
  readonly key: string;
  readonly label: string;
  readonly primary?: boolean;
  readonly run: () => void;
}

export interface MessageOptions {
  readonly over: string;
  readonly title: string;
  readonly body: string;
  /** `Plotinium 0.3.0 · build a1f93c2` under the title. */
  readonly meta: string;
  readonly actions: readonly MessageAction[];
  /** `alert` for failures, `status` otherwise. */
  readonly tone?: 'alert' | 'status';
  readonly testId?: string;
  /** Extra monospace detail (an error message), shown under the body. */
  readonly detail?: string;
}

export interface MessageScreen {
  readonly el: HTMLElement;
  focus(): void;
  destroy(): void;
}

let seq = 0;

const typing = (e: KeyboardEvent): boolean =>
  e.ctrlKey ||
  e.metaKey ||
  e.altKey ||
  (e.target instanceof Element &&
    e.target.closest('input, textarea, select, [contenteditable="true"]') !== null);

export function messageScreen(doc: Document, opts: MessageOptions): MessageScreen {
  const id = `plt-msg${(++seq).toString(36)}-`;
  const root = render(
    h(
      'div',
      { class: 'plb plb-unsup', 'data-testid': opts.testId },
      backdrop(),
      h(
        'main',
        { class: 'plb-card', 'aria-labelledby': `${id}t`, 'aria-describedby': `${id}d` },
        logoSvg({ size: 64, id, cls: 'plb-dim' }),
        h('p', { class: 'plb-over' }, opts.over),
        h('h1', { class: 'plb-h', id: `${id}t` }, opts.title),
        h('p', { class: 'plb-meta' }, opts.meta),
        h('p', { class: 'plb-lead', id: `${id}d` }, opts.body),
        opts.detail !== undefined && h('p', { class: 'plb-meta' }, opts.detail),
        opts.actions.length > 0 &&
          h(
            'div',
            { class: 'plb-actions' },
            opts.actions.map((a, i) =>
              h(
                'button',
                {
                  type: 'button',
                  class: a.primary === true ? 'plb-btn plb-primary' : 'plb-btn',
                  'data-i': i,
                  'aria-keyshortcuts': a.key,
                },
                h('kbd', { 'aria-hidden': 'true' }, a.key === 'Enter' ? '↵' : a.key),
                h('span', null, a.label),
              ),
            ),
          ),
        h('p', { class: 'plb-sr', role: opts.tone ?? 'status' }, `${opts.title}. ${opts.body}`),
      ),
    ),
    doc,
  );
  const buttons = [...root.querySelectorAll<HTMLButtonElement>('.plb-btn')];
  root.addEventListener('click', (e) => {
    const btn = e.target instanceof Element ? e.target.closest<HTMLElement>('.plb-btn') : null;
    const action = opts.actions[Number(btn?.dataset['i'] ?? -1)];
    action?.run();
  });
  const release = silenceDesktop(doc);
  const onKey = (e: KeyboardEvent): void => {
    if (typing(e) || e.repeat) return;
    const action = opts.actions.find((a) =>
      a.key === 'Enter' ? e.key === 'Enter' : a.key.toUpperCase() === e.key.toUpperCase(),
    );
    if (action === undefined) return;
    // Enter on a focused button is that button's own click.
    if (e.key === 'Enter' && e.target instanceof HTMLButtonElement) return;
    e.preventDefault();
    action.run();
  };
  doc.addEventListener('keydown', onKey);
  doc.body.append(root);
  return {
    el: root,
    focus: () => {
      (buttons.find((b) => b.classList.contains('plb-primary')) ?? buttons[0])?.focus();
    },
    destroy: () => {
      doc.removeEventListener('keydown', onKey);
      release();
      root.remove();
    },
  };
}

/**
 * Makes #plt-desktop (the login screen or the desktop) inert while a boot screen covers it, and
 * moves focus out of it. Returns the function that restores it.
 */
export function silenceDesktop(doc: Document): () => void {
  const desktop = doc.getElementById('plt-desktop');
  if (desktop === null) return () => undefined;
  const was = desktop.hasAttribute('inert');
  desktop.setAttribute('inert', '');
  const active = doc.activeElement;
  if (active instanceof HTMLElement && desktop.contains(active)) active.blur();
  return () => {
    desktop.toggleAttribute('inert', was);
  };
}

const meta = (identity: { version: string; build: string }): string =>
  `Plotinium ${identity.version} · build ${identity.build}`;

type Identity = { readonly version: string; readonly build: string };

export function takeoverScreen(
  doc: Document,
  identity: Identity,
  useHere: () => void,
): MessageScreen {
  return messageScreen(doc, {
    over: 'One kernel per browser',
    title: 'Plotinium is running in another tab',
    body: 'Only one tab can run the kernel at a time. Use it here to move the session to this tab; the other tab stops.',
    meta: meta(identity),
    actions: [{ key: 'Enter', label: 'Use here', primary: true, run: useHere }],
  });
}

export function lostScreen(doc: Document, identity: Identity, reload: () => void): MessageScreen {
  return messageScreen(doc, {
    over: 'Session moved',
    title: 'Plotinium moved to another tab',
    body: 'This tab stopped its kernel because another tab took over. Reload to take it back.',
    meta: meta(identity),
    actions: [{ key: 'Enter', label: 'Reload', primary: true, run: reload }],
  });
}

export function kernelLoadScreen(
  doc: Document,
  identity: Identity,
  error: string,
  on: { retry: () => void; diagnostics: () => void },
): MessageScreen {
  return messageScreen(doc, {
    over: 'Bootloader',
    title: 'Could not load the kernel',
    body: 'The kernel image did not download. Check that the Plotinium server is running, then retry. After one successful visit Plotinium also starts offline.',
    detail: error,
    meta: meta(identity),
    tone: 'alert',
    actions: [
      { key: 'T', label: 'Retry', primary: true, run: on.retry },
      { key: 'D', label: 'Diagnostics', run: on.diagnostics },
    ],
  });
}

export function stallScreen(
  doc: Document,
  identity: Identity,
  lastEvent: string,
  ageS: number,
  on: { retry: () => void; safe: () => void; diagnostics: () => void },
): MessageScreen {
  return messageScreen(doc, {
    over: 'Boot watchdog',
    title: `Plotinium is not making progress: ${lastEvent} (${String(ageS)} s ago)`,
    body: 'No boot step finished for a while, so the boot stopped here instead of spinning. Reload to try again, or start in Safe mode.',
    meta: meta(identity),
    tone: 'alert',
    actions: [
      { key: 'T', label: 'Retry (reload)', primary: true, run: on.retry },
      { key: 'S', label: 'Safe mode', run: on.safe },
      { key: 'D', label: 'Diagnostics', run: on.diagnostics },
    ],
  });
}

/**
 * The halted state (§3.10 step 9). `sessionSaved` is true only when someone was signed in; a
 * shutdown from the login screen has no session to save, so the card does not claim one.
 */
export function haltedScreen(
  doc: Document,
  identity: Identity,
  start: () => void,
  sessionSaved = false,
): MessageScreen {
  return messageScreen(doc, {
    over: 'Power',
    title: 'Plotinium has shut down.',
    body: sessionSaved
      ? 'Every service stopped cleanly and your session was saved. Start again to boot.'
      : 'Every service stopped cleanly. Start again to boot.',
    meta: meta(identity),
    actions: [{ key: 'Enter', label: 'Start', primary: true, run: start }],
  });
}
