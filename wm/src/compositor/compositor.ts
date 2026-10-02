/**
 * The compositor (window-manager.md §3.1–§3.8; WM-01..WM-04, WMD-01..WMD-07): the single authority
 * over window geometry, stacking and focus on the main thread. Framework-free (C11): it imports
 * no Solid; it pushes coarse events to whoever subscribes (the Solid store) and writes geometry
 * only through `Flusher`. Lifecycle commands are accepted ONLY on the kernel compositor port
 * bound once at link-up (R-PORT, WMD-02); nothing else can create, close or focus a window.
 */
import type { AnimationHooks } from './anim.ts';
import { flipFrom, genieTo, NO_ANIMATION } from './anim.ts';
import type { FrameRequest, StyleTarget } from './flush.ts';
import { Flusher } from './flush.ts';
import type { CaptureTarget, KeyboardGesture, PointerLike } from './gestures.ts';
import { Gestures } from './gestures.ts';
import { workArea } from './geometry.ts';
import { WindowModel } from './model.ts';
import type { CreateWindow } from './model.ts';
import type {
  CoarseEvent,
  CompositorToKernel,
  KernelToCompositor,
  Rect,
  ResizeEdge,
  WindowPhase,
  WinState,
} from './types.ts';

/** The window frame element as the compositor sees it. */
export interface FrameElement extends StyleTarget {
  readonly style: StyleTarget['style'] & { willChange: string };
  readonly classList: { toggle(token: string, force?: boolean): boolean };
}

export interface CompositorOptions {
  /** Viewport size, read at start and on resize only (R-READ). */
  readonly viewport: () => { w: number; h: number; dpr: number };
  /**
   * Menu bar (top) and dock (bottom) heights. A function is read again on every
   * `viewportChanged`, so the work area follows a Dock that changes size or hides (UI-040).
   */
  readonly insets?: Insets | (() => Insets);
  readonly raf: FrameRequest;
  /** Messages to the kernel compositor port (null until the kernel link is up). */
  readonly post?: (m: CompositorToKernel) => void;
  /** The router's `interactive` hint (WMD-05). */
  readonly interactive?: (active: boolean) => void;
  readonly anim?: AnimationHooks;
  /** Centre of an app's dock icon (the genie target), or null. */
  readonly dockIcon?: (app: string) => { x: number; y: number } | null;
  /**
   * The point a newly opened window of `app` grows out of (its dock icon when the Dock launched
   * it), or null for the default origin. Read once at animation start (R-READ).
   */
  readonly openOrigin?: (app: string) => { x: number; y: number } | null;
  /** The app's preferred window size (its manifest), used when `create` has no rectangle. */
  readonly defaultSize?: (app: string) => { readonly w: number; readonly h: number } | undefined;
  /** Show the snap preview rectangle while a drag is in a snap zone, or hide it with null. */
  readonly snapPreview?: (r: Rect | null) => void;
  readonly titlebarH?: number;
  readonly now?: () => number;
}

/** The space the menu bar (top) and the Dock (bottom) keep free, in CSS px. */
export interface Insets {
  readonly top?: number;
  readonly bottom?: number;
}

export interface LayoutRow {
  readonly wid: number;
  readonly app: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly z: number;
  readonly state: WinState;
}

export interface Compositor {
  readonly model: WindowModel;
  readonly flusher: Flusher;
  readonly gestures: Gestures;
  subscribe(listener: (e: CoarseEvent) => void): () => void;
  /** Bind the kernel compositor port; callable once (R-PORT). */
  bindKernelPort(port: {
    onmessage: ((ev: MessageEvent) => void) | null;
    postMessage(m: unknown): void;
  }): void;
  /** The frame and content elements of a window the shell mounted. */
  attach(wid: number, el: FrameElement, content: StyleTarget): void;
  titlePointerDown(wid: number, ev: PointerLike, target: CaptureTarget): void;
  resizeStart(wid: number, edge: ResizeEdge, ev: PointerLike, target: CaptureTarget): void;
  /** WM-04 §3.8: the title bar's `dblclick` outside its buttons. */
  titleDoubleClick(wid: number): void;
  focus(wid: number): void;
  /** A press on the bare desktop: no window keeps focus (UI-083); the stacking stays. */
  focusDesktop(): void;
  minimise(wid: number): Promise<void>;
  restore(wid: number): Promise<void>;
  toggleMaximise(wid: number): Promise<void>;
  /** Window menu → Full Screen (§3.7): the whole viewport, over the dock; again to leave. */
  toggleFullscreen(wid: number): Promise<void>;
  /** Window menu → Move / Size (§3.9 rule 4): the keyboard mode, or null when it cannot start. */
  keyboard(wid: number, mode: 'move' | 'size'): KeyboardGesture | null;
  /** The close button: the kernel decides (SIGTERM, then `close`); WMD-12. */
  requestClose(wid: number): void;
  /** First input per 100 ms per window (activation for window.focus, §3.13 rule 5). */
  input(wid: number): void;
  viewportChanged(): void;
  /** Windows bottom to top (the `window.__plt.layout()` test hook). */
  layout(): LayoutRow[];
}

const INPUT_EVERY_MS = 100;

function isKernelToCompositor(x: unknown): x is KernelToCompositor {
  if (x === null || typeof x !== 'object') return false;
  const t = (x as { t?: unknown }).t;
  const wid = (x as { wid?: unknown }).wid;
  return typeof t === 'string' && typeof wid === 'number' && Number.isInteger(wid) && wid > 0;
}

/** The part of a `create`'s saved window the compositor uses (its z and whether minimised). */
function restoreHint(x: unknown): CreateWindow['restore'] {
  if (x === null || typeof x !== 'object') return undefined;
  const z = (x as { z?: unknown }).z;
  const state = (x as { state?: unknown }).state;
  return typeof z === 'number' && Number.isFinite(z)
    ? { z, minimised: state === 'minimised' }
    : undefined;
}

export function createCompositor(opts: CompositorOptions): Compositor {
  const listeners = new Set<(e: CoarseEvent) => void>();
  const frames = new Map<number, FrameElement>();
  const lastInput = new Map<number, number>();
  const now = opts.now ?? (() => 0);
  const anim = opts.anim ?? NO_ANIMATION;
  let port: {
    onmessage: ((ev: MessageEvent) => void) | null;
    postMessage(m: unknown): void;
  } | null = null;

  const emit = (e: CoarseEvent): void => {
    for (const l of listeners) l(e);
  };
  const toKernel = (m: CompositorToKernel): void => {
    opts.post?.(m);
    port?.postMessage(m);
  };
  const insets = (): Insets =>
    typeof opts.insets === 'function' ? opts.insets() : (opts.insets ?? {});
  const vp = opts.viewport();
  const screen: Rect = { x: 0, y: 0, w: vp.w, h: vp.h };
  const flusher = new Flusher(opts.raf, () => opts.viewport().dpr, now);
  const model = new WindowModel({
    work: workArea(vp.w, vp.h, insets()),
    screen,
    ...(opts.titlebarH === undefined ? {} : { titlebarH: opts.titlebarH }),
    ...(opts.defaultSize === undefined ? {} : { defaultSize: opts.defaultSize }),
    now,
    hooks: {
      onEvent: emit,
      onKernel: toKernel,
      onDirty: (w) => {
        flusher.schedule(w);
      },
    },
  });
  const committed = (wid: number): void => {
    model.reportGeometry(wid);
  };
  const gestures = new Gestures({
    model,
    interactive: (active) => opts.interactive?.(active),
    setDragging: (wid, on) => {
      const el = frames.get(wid);
      if (el) {
        el.classList.toggle('dragging', on);
        el.style.willChange = on ? 'transform' : '';
      }
      emit({ type: 'dragging', wid, on });
    },
    preview: (r) => opts.snapPreview?.(r),
    committed,
  });

  const phase = async (
    wid: number,
    p: WindowPhase,
    detail: Parameters<AnimationHooks['play']>[2] = {},
  ): Promise<void> => {
    emit({ type: 'phase', wid, phase: p });
    try {
      await anim.play(wid, p, detail);
    } finally {
      emit({ type: 'phase', wid, phase: null });
    }
  };

  const handleKernel = (msg: KernelToCompositor): void => {
    switch (msg.t) {
      case 'create': {
        const restore = restoreHint(msg.restore);
        const w = model.create({
          wid: msg.wid,
          pid: msg.pid,
          title: msg.title,
          ...(msg.app === undefined ? {} : { app: msg.app }),
          ...(msg.icon === undefined ? {} : { icon: msg.icon }),
          ...(msg.rect === undefined ? {} : { rect: msg.rect }),
          ...(msg.activation === undefined ? {} : { activation: msg.activation }),
          ...(msg.limits === undefined ? {} : { limits: msg.limits }),
          ...(restore === undefined ? {} : { restore }),
        });
        if (!w) return;
        // A window the user opened grows out of its dock icon when the Dock launched it (UI-156).
        const origin = restore === undefined ? (opts.openOrigin?.(w.app) ?? null) : null;
        void phase(w.wid, 'opening', origin === null ? {} : { origin });
        return;
      }
      case 'close': {
        const w = model.get(msg.wid);
        if (!w) return;
        w.flags.closing = true;
        void phase(msg.wid, 'closing').then(() => {
          model.close(msg.wid);
          frames.delete(msg.wid);
          lastInput.delete(msg.wid);
          flusher.detach(msg.wid);
        });
        return;
      }
      case 'focus':
        model.focus(msg.wid);
        return;
      case 'attention':
        model.attention(msg.wid, true);
        return;
      case 'setTitle':
        model.setTitle(msg.wid, msg.title.slice(0, 256));
        return;
      case 'restoring':
        emit({
          type: 'restoring',
          wid: msg.wid,
          doneBytes: msg.doneBytes,
          totalBytes: msg.totalBytes,
        });
        return;
    }
  };

  const api: Compositor = {
    model,
    flusher,
    gestures,
    subscribe: (l) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    bindKernelPort: (p) => {
      if (port !== null) throw new Error('compositor: the kernel port is bound once');
      port = p;
      p.onmessage = (ev: MessageEvent) => {
        const data: unknown = ev.data;
        if (isKernelToCompositor(data)) handleKernel(data);
      };
    },
    attach: (wid, el, content) => {
      frames.set(wid, el);
      flusher.attach(wid, { el, content });
      const w = model.get(wid);
      if (w) flusher.schedule(w);
    },
    titlePointerDown: (wid, ev, target) => {
      gestures.beginDrag(wid, ev, target);
    },
    resizeStart: (wid, edge, ev, target) => {
      gestures.beginResize(wid, edge, ev, target);
    },
    titleDoubleClick: (wid) => {
      void api.toggleMaximise(wid);
    },
    focus: (wid) => {
      model.focus(wid);
    },
    focusDesktop: () => {
      model.unfocus();
    },
    minimise: async (wid) => {
      const w = model.get(wid);
      if (!w || w.state === 'minimised') return;
      await phase(wid, 'minimising', { ...genieDetail(w) });
      model.minimise(wid);
    },
    restore: async (wid) => {
      const w = model.get(wid);
      if (!w) return;
      const wasMinimised = w.state === 'minimised';
      const from = model.rectOf(w);
      if (!model.restore(wid)) return;
      if (wasMinimised) await phase(wid, 'restoring', genieDetail(w));
      else await phase(wid, 'unmaximising', { flip: flipFrom(from, model.rectOf(w)) });
      model.reportGeometry(wid);
    },
    toggleMaximise: async (wid) => {
      const w = model.get(wid);
      if (!w) return;
      const from = model.rectOf(w);
      const wasMax = w.state === 'maximised';
      if (!model.toggleMaximise(wid)) return;
      await phase(wid, wasMax ? 'unmaximising' : 'maximising', {
        flip: flipFrom(from, model.rectOf(w)),
      });
      model.reportGeometry(wid);
    },
    toggleFullscreen: async (wid) => {
      const w = model.get(wid);
      if (!w || w.state === 'minimised') return;
      const from = model.rectOf(w);
      const leaving = w.state === 'fullscreen';
      if (!(leaving ? model.restore(wid) : model.fullscreen(wid))) return;
      await phase(wid, leaving ? 'unmaximising' : 'maximising', {
        flip: flipFrom(from, model.rectOf(w)),
      });
      model.reportGeometry(wid);
    },
    keyboard: (wid, mode) => gestures.beginKeyboard(wid, mode),
    requestClose: (wid) => {
      if (model.get(wid)) toKernel({ t: 'closeRequested', wid, seq: Math.floor(now()) });
    },
    input: (wid) => {
      const t = now();
      const last = lastInput.get(wid);
      if (last !== undefined && t - last < INPUT_EVERY_MS) return;
      lastInput.set(wid, t);
      toKernel({ t: 'input', wid });
    },
    // The viewport or an inset (the Dock's reserve, UI-040) changed: re-lay out the work area.
    viewportChanged: () => {
      const v = opts.viewport();
      const changed = model.setWorkArea(workArea(v.w, v.h, insets()), {
        x: 0,
        y: 0,
        w: v.w,
        h: v.h,
      });
      // Compact mode entered or left: those windows changed state (§3.6, WM-06).
      for (const wid of changed) model.reportGeometry(wid);
    },
    layout: () =>
      model.windows().map((w) => ({
        wid: w.wid,
        app: w.app,
        x: w.x,
        y: w.y,
        w: w.w,
        h: w.h,
        z: w.z,
        state: w.state,
      })),
  };

  function genieDetail(w: { app: string; x: number; y: number; w: number; h: number }): {
    genie?: { x: number; y: number };
  } {
    const g = genieTo({ x: w.x, y: w.y, w: w.w, h: w.h }, opts.dockIcon?.(w.app) ?? null);
    return g === undefined ? {} : { genie: g };
  }

  return api;
}
