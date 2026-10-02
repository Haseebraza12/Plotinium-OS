/**
 * The selector contract of tests/e2e/SELECTORS.md §1 for the parts the shell composes from
 * @plotinium/ui components (which carry no test ids themselves). The shell tags the rendered
 * DOM by role and ARIA structure, never by CSS class, and re-tags when a subtree re-renders.
 * Framework-free.
 */

function tag(el: Element | null | undefined, id: string, attrs: Record<string, string> = {}): void {
  if (el === null || el === undefined) return;
  if (el.getAttribute('data-testid') !== id) el.setAttribute('data-testid', id);
  for (const [k, v] of Object.entries(attrs)) if (el.getAttribute(k) !== v) el.setAttribute(k, v);
}

/**
 * App ids as the selector contract names them (tests/e2e/SELECTORS.md: `terminal`, `files`,
 * `editor`, `task-manager`, `settings`, `about`). Only the test attribute changes; the app id
 * itself stays `taskmgr` everywhere else (UI-092).
 */
const CONTRACT_APP_ID: Readonly<Record<string, string>> = { taskmgr: 'task-manager' };

/** The `data-app` value for an app id. */
export function contractAppId(app: string): string {
  return CONTRACT_APP_ID[app] ?? app;
}

/** A window section: `window`, its title bar, the three lights and the eight handles. */
export function tagWindow(section: HTMLElement, app: string, wid: number): void {
  tag(section, 'window', { 'data-app': contractAppId(app), 'data-wid': String(wid) });
  const lights = section.querySelector('[role="group"][aria-label="Window controls"]');
  tag(lights?.parentElement, 'window-titlebar');
  const [close, minimise, zoom] = Array.from(lights?.querySelectorAll('button') ?? []);
  tag(close, 'window-close');
  tag(minimise, 'window-minimise');
  tag(zoom, 'window-maximise');
  tagHandles(section);
}

/** The resize handles are re-created when a window leaves the maximised state. */
export function tagHandles(section: HTMLElement): void {
  for (const h of Array.from(section.querySelectorAll(':scope > [data-edge]'))) {
    const edge = h.getAttribute('data-edge');
    if (edge !== null) tag(h, `window-resize-${edge}`);
  }
}

/** Dock buttons carry `data-dock-id`; the contract wants `dock-item` plus `data-app`. */
export function tagDock(root: HTMLElement): void {
  for (const b of Array.from(root.querySelectorAll('[data-dock-id]'))) {
    const id = b.getAttribute('data-dock-id') ?? '';
    if (id !== 'trash') tag(b, 'dock-item', { 'data-app': contractAppId(id) });
  }
}

export interface LoginTagUser {
  readonly name: string;
  readonly kind?: 'user' | 'guest' | 'demo';
}

/** Login tiles in order (`data-user-index`), the password field, submit and offline notice. */
export function tagLogin(
  root: HTMLElement,
  users: readonly LoginTagUser[],
  offline: boolean,
): void {
  for (const tile of Array.from(root.querySelectorAll('[data-user-index]'))) {
    const i = Number(tile.getAttribute('data-user-index'));
    const u = users[i];
    if (u === undefined) continue;
    const id =
      u.kind === 'guest' ? 'login-guest' : u.kind === 'demo' ? 'login-demo' : 'login-user-tile';
    tag(tile, id, { 'data-user': u.name });
  }
  tag(
    root.querySelector('input[type="password"], input[autocomplete="current-password"]'),
    'login-password',
  );
  tag(root.querySelector('button[aria-label="Sign in"]'), 'login-submit');
  if (offline) {
    const notice = Array.from(root.querySelectorAll('[role="status"]')).find((p) =>
      /offline/iu.test(p.textContent),
    );
    tag(notice, 'login-offline-notice');
  }
}

/** Re-run `fn` whenever `root`'s subtree changes (small subtrees only: login, dock). */
export function retag(root: HTMLElement, fn: () => void, subtree = true): () => void {
  fn();
  const Observer = root.ownerDocument.defaultView?.MutationObserver;
  if (Observer === undefined) return () => undefined;
  const mo = new Observer(() => fn());
  mo.observe(root, { childList: true, subtree });
  return () => mo.disconnect();
}
