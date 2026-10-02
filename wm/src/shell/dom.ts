/**
 * Small DOM adapters between the Solid chrome and the framework-free compositor. Framework-free.
 */
import type { CaptureTarget, PointerLike, StyleTarget } from '../compositor/index.ts';

type EndType = 'pointermove' | 'pointerup' | 'pointercancel' | 'lostpointercapture';

/**
 * The element that receives pointer capture for a drag or resize, typed for the compositor's
 * gestures. Listener identity is kept so `removeEventListener` removes what was added.
 */
export function captureTarget(el: HTMLElement): CaptureTarget {
  const wrapped = new Map<(ev: PointerLike) => void, (ev: Event) => void>();
  const wrap = (fn: (ev: PointerLike) => void): ((ev: Event) => void) => {
    let w = wrapped.get(fn);
    if (w === undefined) {
      w = (ev: Event) => {
        if ('clientX' in ev && 'pointerId' in ev) fn(ev as PointerEvent);
      };
      wrapped.set(fn, w);
    }
    return w;
  };
  return {
    setPointerCapture: (id: number) => {
      try {
        el.setPointerCapture(id);
      } catch {
        // a synthetic or already released pointer: the gesture still ends on pointerup
      }
    },
    addEventListener: (type: EndType, fn: (ev: PointerLike) => void, opts?: { once?: boolean }) => {
      el.addEventListener(type, wrap(fn), opts);
    },
    removeEventListener: (type: EndType, fn: (ev: PointerLike) => void) => {
      el.removeEventListener(type, wrap(fn));
    },
  };
}

/**
 * The window's content box as the compositor's flush sees it (window-manager.md §3.5): width and
 * height of the whole frame, frozen at max(start, current) during a live resize. The app view's
 * container sits under the title bar, so its height is the frame height minus the title bar
 * (`titlebarPx`; 0 for unified chrome, whose floating lights sit over the content).
 */
export function contentBox(view: HTMLElement, titlebarPx: number): StyleTarget {
  const style = {
    get transform(): string {
      return '';
    },
    set transform(_v: string) {
      // the content box is never moved on its own
    },
    get width(): string {
      return view.style.width;
    },
    set width(v: string) {
      view.style.width = v;
    },
    get height(): string {
      return view.style.height;
    },
    set height(v: string) {
      view.style.height =
        v === '' ? '' : titlebarPx > 0 ? `calc(${v} - ${String(titlebarPx)}px)` : v;
    },
    get zIndex(): string {
      return '';
    },
    set zIndex(_v: string) {
      // stacking belongs to the frame
    },
  };
  return { style };
}

/** A length token in px from computed style, or the fallback. */
export function tokenPx(root: Element, name: string, fallback: number): number {
  const v =
    root.ownerDocument.defaultView?.getComputedStyle(root).getPropertyValue(name).trim() ?? '';
  const n = Number.parseFloat(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** A matchMedia query as a subscribable boolean. */
export function watchMedia(
  view: Window,
  query: string,
  fn: (matches: boolean) => void,
): { matches: boolean; stop: () => void } {
  if (typeof view.matchMedia !== 'function') return { matches: false, stop: () => undefined };
  const mq = view.matchMedia(query);
  const on = (e: MediaQueryListEvent): void => fn(e.matches);
  mq.addEventListener('change', on);
  return { matches: mq.matches, stop: () => mq.removeEventListener('change', on) };
}

const FOCUSABLE =
  'input, textarea, select, button, a[href], [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

/** Focus `el` and report whether it took focus (disabled, hidden or inert elements do not). */
function takeFocus(el: HTMLElement): boolean {
  el.focus({ preventScroll: true });
  return el.ownerDocument.activeElement === el;
}

/** The app view of a window section (`[data-wm-view]`), or null. */
export function viewOf(section: HTMLElement): HTMLElement | null {
  return section.querySelector<HTMLElement>('[data-wm-view]');
}

/**
 * Move DOM focus into a window (window-manager.md §3.4 rule 3): its last focused content element,
 * else the view's `[data-autofocus]` element or first control that takes focus, else the window
 * itself (`tabindex="-1"`). The chrome (traffic lights, title bar) never receives it, so a restore
 * never lands on the Minimise light (UI-017). Returns the element that has focus.
 */
export function focusInto(section: HTMLElement, last: Element | null): HTMLElement {
  const view = viewOf(section);
  if (
    last instanceof HTMLElement &&
    last.isConnected &&
    view !== null &&
    view.contains(last) &&
    takeFocus(last)
  )
    return last;
  if (view !== null) {
    const auto = view.querySelector<HTMLElement>('[data-autofocus]');
    if (auto !== null && takeFocus(auto)) return auto;
    for (const el of Array.from(view.querySelectorAll<HTMLElement>(FOCUSABLE))) {
      if (el.closest('[hidden], [inert], [aria-hidden="true"]') !== null) continue;
      if (takeFocus(el)) return el;
    }
  }
  if (!section.hasAttribute('tabindex')) section.setAttribute('tabindex', '-1');
  section.focus({ preventScroll: true });
  return section;
}

/**
 * `focusInto`, and while the view is still rendering (its chunk loading, or its main surface such
 * as CodeMirror mounting after the toolbar), keep improving on that: from the window itself to the
 * first control, and from a fallback control to the view's `[data-autofocus]` element once it
 * appears. This runs for up to `timeoutMs` and stops as soon as focus is somewhere this function
 * did not put it (the user moved it), or on the restored last element or `[data-autofocus]`
 * (UI-018). Returns a stop function.
 */
export function focusIntoWhenReady(
  section: HTMLElement,
  last: Element | null,
  timeoutMs = 3_000,
): () => void {
  let placed = focusInto(section, last);
  const view = viewOf(section);
  const win = section.ownerDocument.defaultView;
  const settled = (el: HTMLElement): boolean =>
    el === last || (el !== section && el.hasAttribute('data-autofocus'));
  if (settled(placed) || view === null || win === null || win.MutationObserver === undefined)
    return () => undefined;
  let stopped = false;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    mo.disconnect();
    win.clearTimeout(timer);
    section.removeEventListener('pointerdown', stop, true);
    section.removeEventListener('keydown', stop, true);
  };
  // Any input in the window is the user's choice of focus: stop improving on it.
  section.addEventListener('pointerdown', stop, true);
  section.addEventListener('keydown', stop, true);
  const mo = new win.MutationObserver(() => {
    if (section.ownerDocument.activeElement !== placed) {
      stop();
      return;
    }
    const auto = view.querySelector<HTMLElement>('[data-autofocus]');
    if (placed === section || (auto !== null && auto !== placed)) placed = focusInto(section, null);
    if (settled(placed)) stop();
  });
  mo.observe(view, { childList: true, subtree: true, attributes: true });
  const timer = win.setTimeout(stop, timeoutMs);
  return stop;
}

/** Controls inside a window's chrome or an app's drag region (they keep their own focus). */
const CONTROL =
  'button, input, select, textarea, a[href], [role="button"], [role="tab"], [role="radio"], [role="switch"], [role="menuitem"], [role="combobox"], [contenteditable="true"], [tabindex]:not([tabindex="-1"]), [data-no-drag]';

/**
 * Whether a pointer press at `target` hit the window's chrome rather than a control or app
 * content: the title bar, the frame edge, a resize handle, or an empty spot of an app's
 * `[data-pl-drag-region]`. Such a press focuses the window without taking DOM focus itself.
 */
export function isChromeTarget(target: EventTarget | null, section: HTMLElement): boolean {
  if (!(target instanceof Element) || !section.contains(target)) return false;
  if (target.closest(CONTROL) !== null) return false;
  const view = viewOf(section);
  if (view === null || !view.contains(target)) return true;
  return target.closest('[data-pl-drag-region]') !== null;
}

/** The title-bar double-click action the user chose (contract C3 of BUGS.md, UI-041). */
export type TitleDoubleClickAction = 'zoom' | 'minimise' | 'none';

/** `<html data-title-dblclick>`: `zoom` (default), `minimise` or `none`. */
export function titleDoubleClickAction(root: HTMLElement): TitleDoubleClickAction {
  const v = root.dataset['titleDblclick'];
  return v === 'minimise' || v === 'none' ? v : 'zoom';
}

/** `<html data-minimise-effect>`: `genie` (default) or `scale` (UI-041). */
export function minimiseEffect(root: HTMLElement): 'genie' | 'scale' {
  return root.dataset['minimiseEffect'] === 'scale' ? 'scale' : 'genie';
}

/**
 * The snap preview writer (window-manager.md §3.6; ui-implementation-guide.md §3.5.6): one element
 * that shows a zone's target rectangle. Its rectangle is written only when the zone changes
 * (never per pointermove); it fades with opacity through `data-visible`.
 */
export function snapPreviewWriter(
  el: () => HTMLElement | undefined,
): (r: { x: number; y: number; w: number; h: number } | null) => void {
  return (r) => {
    const target = el();
    if (target === undefined) return;
    if (r === null) {
      target.dataset['visible'] = 'false';
      return;
    }
    target.style.transform = `translate3d(${String(r.x)}px, ${String(r.y)}px, 0)`;
    target.style.width = `${String(r.w)}px`;
    target.style.height = `${String(r.h)}px`;
    target.dataset['visible'] = 'true';
  };
}
