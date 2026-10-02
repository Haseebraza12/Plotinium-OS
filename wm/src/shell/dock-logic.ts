/**
 * Dock content and click semantics (window-manager.md §3.10, WMD-10, moved from the taskbar to
 * the dock by ui-implementation-guide.md D-02). Pure: the shell feeds the registry and the
 * coarse window list, and acts on the returned decision.
 */
import type { WinState } from '../compositor/index.ts';
import type { AppEntry } from './env.ts';
import type { DockItem } from './ui.ts';

/** What the dock needs to know about one window. */
export interface DockWindow {
  readonly wid: number;
  readonly app: string;
  readonly state: WinState;
  readonly focused: boolean;
  readonly attention: boolean;
  /** Stacking position, higher is nearer the top. */
  readonly z: number;
}

/**
 * A system panel: an app kept out of the Dock (`pinned: false`) that opens one fixed-size window,
 * like About Plotinium. It gets no Dock tile even while open (as macOS gives "About This Mac"
 * none, UI-153); ordinary unpinned apps still appear while they run.
 */
export function isSystemPanel(app: AppEntry): boolean {
  return (
    app.pinned === false &&
    app.singleton === true &&
    app.window?.resizable === false &&
    app.window.maximizable === false
  );
}

/**
 * Pinned apps in registry order, then running apps that are not pinned in first-launch order
 * (stable, so icons never jump), except system panels. A group exists while at least one of its
 * windows exists. Each item counts its windows and how many of them are minimised (UI-093).
 */
export function dockItems(
  apps: readonly AppEntry[],
  windows: readonly DockWindow[],
  launching: ReadonlySet<string>,
  firstLaunch: readonly string[] = [],
): DockItem[] {
  const count = new Map<string, number>();
  const minimised = new Map<string, number>();
  const attention = new Set<string>();
  for (const w of windows) {
    count.set(w.app, (count.get(w.app) ?? 0) + 1);
    if (w.state === 'minimised') minimised.set(w.app, (minimised.get(w.app) ?? 0) + 1);
    if (w.attention && !w.focused) attention.add(w.app);
  }
  const item = (app: AppEntry): DockItem => {
    const n = count.get(app.id) ?? 0;
    return {
      id: app.id,
      label: app.title,
      icon: app.icon,
      running: n > 0,
      windows: n,
      minimised: minimised.get(app.id) ?? 0,
      attention: attention.has(app.id),
      launching: launching.has(app.id),
    };
  };
  const pinned = apps.filter((a) => a.pinned !== false);
  const extra = apps
    .filter((a) => a.pinned === false && !isSystemPanel(a) && (count.get(a.id) ?? 0) > 0)
    .sort((a, b) => rank(firstLaunch, a.id) - rank(firstLaunch, b.id));
  return [...pinned, ...extra].map(item);
}

function rank(order: readonly string[], id: string): number {
  const i = order.indexOf(id);
  return i < 0 ? Number.MAX_SAFE_INTEGER : i;
}

export type DockDecision =
  | { readonly kind: 'launch' }
  | { readonly kind: 'focus'; readonly wid: number }
  | { readonly kind: 'minimise'; readonly wid: number }
  | { readonly kind: 'restore'; readonly wid: number }
  | { readonly kind: 'choose'; readonly wids: readonly number[] };

/**
 * WMD-10 click semantics. No window: launch. One window: focused → minimise; minimised →
 * restore and focus; otherwise focus. Several windows: focus the top-most one unless it already
 * has focus, in which case the group menu lists every window to choose from.
 */
export function dockDecision(app: string, windows: readonly DockWindow[]): DockDecision {
  const own = windows.filter((w) => w.app === app).sort((a, b) => b.z - a.z);
  const [top] = own;
  if (top === undefined) return { kind: 'launch' };
  if (own.length === 1) {
    if (top.state === 'minimised') return { kind: 'restore', wid: top.wid };
    if (top.focused) return { kind: 'minimise', wid: top.wid };
    return { kind: 'focus', wid: top.wid };
  }
  const visible = own.find((w) => w.state !== 'minimised');
  if (visible === undefined) return { kind: 'restore', wid: top.wid };
  if (visible.focused) return { kind: 'choose', wids: own.map((w) => w.wid) };
  return { kind: 'focus', wid: visible.wid };
}
