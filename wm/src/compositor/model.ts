/**
 * The DOM-free window model: registry, stacking, focus and window states (window-manager.md
 * §3.3, §3.4, §3.6, §3.7, §3.8; WM-01, WM-02, WM-04; invariants I-WM1..I-WM3).
 *
 * The model decides every geometry and z value; `flush.ts` only copies the result to the DOM in
 * one requestAnimationFrame batch (R-GEO). Nothing here reads layout or touches an element.
 *
 * It also keeps the kernel's mirror right for session restore (WM-06, R-MIRROR): every window's
 * final values (rectangle, state, z, snap, restore rectangle) are reported when it opens, when
 * its z changes, and when it is minimised or restored; gestures and animated state changes
 * report at their end through the compositor.
 */
import {
  cascadeSlot,
  CASCADE_STEP,
  clampPosition,
  clampRect,
  clampSize,
  COMPACT_BELOW,
  DEFAULT_LIMITS,
  fitInside,
  magnet,
  maxRect,
  snapRectFor,
  TITLEBAR_H,
} from './geometry.ts';
import type { StackOrder, WindowTable } from './registry.ts';
import { createStackOrder, createWindowTable } from './registry.ts';
import type {
  CoarseEvent,
  CompositorToKernel,
  Limits,
  Rect,
  Snap,
  SnapZone,
  WinModel,
  WinState,
} from './types.ts';
import { DIRTY } from './types.ts';

/** Windows per desktop session (§3.3); `window.create` beyond it is refused. */
export const MAX_WINDOWS = 64;
/** The size of a new window whose app declares none. */
const DEFAULT_SIZE = { w: 720, h: 480 };

export interface CreateWindow {
  readonly wid: number;
  readonly pid: number;
  readonly app?: string;
  readonly title: string;
  readonly icon?: string;
  readonly rect?: Rect;
  /** The process received user input in the last 1,000 ms (WMD-09); default true. */
  readonly activation?: boolean;
  readonly limits?: Partial<Limits>;
  /**
   * Session restore (WM-06): the window's saved z, and whether it was saved minimised. Restored
   * windows stack in the saved order whatever order their processes start in, and never flash
   * for attention.
   */
  readonly restore?: { readonly z: number; readonly minimised?: boolean };
}

export interface ModelHooks {
  /** Coarse store events (R-STATE). */
  readonly onEvent?: (e: CoarseEvent) => void;
  /** Messages for the kernel compositor port. */
  readonly onKernel?: (m: CompositorToKernel) => void;
  /** Geometry or z changed: schedule the flush. */
  readonly onDirty?: (w: WinModel) => void;
}

export interface ModelOptions {
  /** The work area (viewport minus menu bar and dock). */
  readonly work: Rect;
  /** The whole viewport (full screen covers the dock). */
  readonly screen?: Rect;
  readonly titlebarH?: number;
  readonly now?: () => number;
  readonly hooks?: ModelHooks;
  /**
   * The size an app's new window opens at (its manifest `width` × `height`), used when the
   * kernel's `create` carries no rectangle; undefined falls back to 720 × 480.
   */
  readonly defaultSize?: (app: string) => { readonly w: number; readonly h: number } | undefined;
}

/** A window as it is saved and reported to the kernel (WM-06, window-manager.md §4.6). */
export interface PersistedWindow {
  readonly rect: Rect;
  readonly restoreRect: Rect | null;
  readonly state: WinState;
  readonly prevState: Exclude<WinState, 'minimised'>;
  readonly snap: Snap;
}

const positive = (n: number): boolean => Number.isFinite(n) && n > 0;

export class WindowModel {
  readonly registry: WindowTable<WinModel> = createWindowTable<WinModel>();
  readonly order: StackOrder = createStackOrder();
  private focusedWid: number | null = null;
  private workRect: Rect;
  private screenRect: Rect;
  private readonly titlebarH: number;
  private readonly now: () => number;
  private readonly hooks: ModelHooks;
  private readonly defaultSize: ModelOptions['defaultSize'];
  private seq = 0;
  /** The saved z of each window a session restore opened (UI-034). */
  private readonly restoreZ = new Map<number, number>();
  /** The size a normal window had before a small work area clamped it; it grows back (UI-096). */
  private readonly preferred = new Map<number, { w: number; h: number }>();
  /** Compact mode (§3.6): the work area is narrower than COMPACT_BELOW. */
  private compactMode: boolean;
  /** The windows compact mode maximised, with the snap each had (§3.6). */
  private readonly forced = new Map<number, Snap>();
  /** Windows whose final values the kernel has not been told yet (WM-06). */
  private readonly unreported = new Set<number>();
  /** While the secure prompt is open, focus never changes (§3.4 rule 9). */
  secureOpen = false;

  constructor(opts: ModelOptions) {
    this.workRect = { ...opts.work };
    this.screenRect = { ...(opts.screen ?? opts.work) };
    this.titlebarH = opts.titlebarH ?? TITLEBAR_H;
    this.now = opts.now ?? (() => 0);
    this.hooks = opts.hooks ?? {};
    this.defaultSize = opts.defaultSize;
    this.compactMode = this.workRect.w < COMPACT_BELOW;
  }

  get focused(): number | null {
    return this.focusedWid;
  }

  get work(): Rect {
    return { ...this.workRect };
  }

  get size(): number {
    return this.registry.size;
  }

  /** Compact mode is on (§3.6): windows are shown maximised. */
  get compact(): boolean {
    return this.compactMode;
  }

  get(wid: number): WinModel | undefined {
    return this.registry.get(wid);
  }

  /** Windows bottom to top. */
  windows(): WinModel[] {
    return this.order.bottomToTop().flatMap((wid) => {
      const w = this.registry.get(wid);
      return w ? [w] : [];
    });
  }

  private emit(e: CoarseEvent): void {
    this.hooks.onEvent?.(e);
  }

  private kernel(m: CompositorToKernel): void {
    this.hooks.onKernel?.(m);
  }

  private dirty(w: WinModel, bits: number): void {
    w.dirtyBits |= bits;
    this.hooks.onDirty?.(w);
  }

  /**
   * Set a window's rectangle. The content box follows the frame unless `content` freezes it
   * (a live resize, §3.5); CONTENT is marked dirty whenever the content box changes, so a
   * gesture that ends at the size it started still refits the app once (UI-019).
   */
  private setRectOf(w: WinModel, r: Rect, content?: { cw: number; ch: number }): void {
    const cw = content?.cw ?? r.w;
    const ch = content?.ch ?? r.h;
    const bits =
      (w.x !== r.x || w.y !== r.y ? DIRTY.POS : 0) |
      (w.w !== r.w || w.h !== r.h ? DIRTY.SIZE : 0) |
      (w.cw !== cw || w.ch !== ch ? DIRTY.CONTENT : 0);
    w.x = r.x;
    w.y = r.y;
    w.w = r.w;
    w.h = r.h;
    w.cw = cw;
    w.ch = ch;
    if (bits !== 0) this.dirty(w, bits);
  }

  rectOf(w: WinModel): Rect {
    return { x: w.x, y: w.y, w: w.w, h: w.h };
  }

  /**
   * A normal window at `r`, clamped to the work area. When the clamp shrinks it, the requested
   * size is remembered so the window grows back once the work area does (UI-096).
   */
  private placeNormal(w: WinModel, r: Rect): void {
    const c = clampRect(r, w.limits, this.workRect, this.titlebarH);
    if (c.w < r.w || c.h < r.h) this.preferred.set(w.wid, { w: r.w, h: r.h });
    else this.preferred.delete(w.wid);
    this.setRectOf(w, c);
  }

  /** A normal window re-clamped to the current work area, from its remembered size if any. */
  private fitNormal(w: WinModel): Rect {
    const want = this.preferred.get(w.wid) ?? { w: w.w, h: w.h };
    const c = clampRect({ x: w.x, y: w.y, ...want }, w.limits, this.workRect, this.titlebarH);
    if (c.w < want.w || c.h < want.h) this.preferred.set(w.wid, want);
    else this.preferred.delete(w.wid);
    return c;
  }

  /** A normal window's rectangle at the size the user gave it, before any work-area clamp. */
  private wantedRect(w: WinModel): Rect {
    const want = this.preferred.get(w.wid);
    return want === undefined ? this.rectOf(w) : { x: w.x, y: w.y, w: want.w, h: want.h };
  }

  /** The rectangle a window shows in its (restored) state in the current work area. */
  private targetRect(w: WinModel): Rect {
    const state = w.state === 'minimised' ? w.prevState : w.state;
    if (state === 'maximised') return maxRect(this.workRect, w.limits);
    if (state === 'fullscreen') return maxRect(this.screenRect, w.limits);
    if (w.snap !== null) return snapRectFor(w.snap, this.workRect, w.limits);
    return this.fitNormal(w);
  }

  /** Walk bottom to top assigning z = 1..n; mark changed windows dirty (§3.4 rule 4, I-WM1). */
  private renumber(): void {
    let z = 0;
    for (const wid of this.order.bottomToTop()) {
      const w = this.registry.get(wid);
      if (!w) continue;
      z++;
      if (w.z !== z) {
        w.z = z;
        this.dirty(w, DIRTY.Z);
        this.unreported.add(wid);
      }
    }
  }

  /** Report the final values of every window that changed since the last report (WM-06). */
  private reportChanged(): void {
    if (this.unreported.size === 0) return;
    const wids = [...this.unreported];
    this.unreported.clear();
    for (const wid of wids) this.reportGeometry(wid);
  }

  private setFocused(wid: number | null): void {
    if (this.focusedWid === wid) return;
    const prev = this.focusedWid === null ? undefined : this.registry.get(this.focusedWid);
    if (prev) prev.focused = false;
    this.focusedWid = wid;
    const next = wid === null ? undefined : this.registry.get(wid);
    if (next) {
      next.focused = true;
      next.flags.attention = false;
    }
    this.emit({ type: 'focused', wid });
    this.kernel({ t: 'focused', wid, seq: ++this.seq });
  }

  /** Top-most non-minimised window, else null (the desktop has focus). */
  private nextFocus(): number | null {
    return this.order.topWhere((wid) => this.registry.get(wid)?.state !== 'minimised') ?? null;
  }

  /** The app's preferred size for a new window (UI-011). */
  private sizeFor(app: string): { w: number; h: number } {
    const s = this.defaultSize?.(app);
    return s !== undefined && positive(s.w) && positive(s.h)
      ? { w: Math.round(s.w), h: Math.round(s.h) }
      : { ...DEFAULT_SIZE };
  }

  /** The first cascade slot whose origin no open window occupies (UI-155). */
  private freeSlot(w: number, h: number): { x: number; y: number } {
    const open = this.registry.values();
    const near = CASCADE_STEP / 2;
    for (let k = 0; k < MAX_WINDOWS * 4; k++) {
      const p = cascadeSlot(k, w, h, this.workRect);
      if (!open.some((o) => Math.abs(o.x - p.x) < near && Math.abs(o.y - p.y) < near)) return p;
    }
    return cascadeSlot(open.length, w, h, this.workRect);
  }

  /** A new window without a kernel rectangle: its app's size, cascaded, inside the work area. */
  private placeNew(wid: number, app: string, limits: Limits): Rect {
    const want = this.sizeFor(app);
    const size = clampSize(want.w, want.h, limits, this.workRect);
    if (size.w < want.w || size.h < want.h) this.preferred.set(wid, want);
    const at = this.freeSlot(size.w, size.h);
    return fitInside(
      clampRect({ ...at, ...size }, limits, this.workRect, this.titlebarH),
      this.workRect,
    );
  }

  /**
   * Session restore (UI-034): a restored window goes just below every restored window with a
   * higher saved z, so the final order is the saved order whatever order they were created in.
   */
  private placeRestored(wid: number, z: number): void {
    this.order.insertTop(wid);
    for (const other of this.order.bottomToTop()) {
      const oz = this.restoreZ.get(other);
      if (other !== wid && oz !== undefined && oz > z) this.order.raise(other);
    }
  }

  /**
   * I-WM2 and WMD-09 after a restore placement: the focused window stays the top-most visible
   * one (`pending` is a window about to be minimised by its restore, so it does not count).
   */
  private keepFocusOnTop(pending: number | null): void {
    const f = this.focusedWid;
    if (f === null) return;
    const top = this.order.topWhere(
      (wid) => wid !== pending && this.registry.get(wid)?.state !== 'minimised',
    );
    if (top === undefined || top === f) return;
    this.order.raise(f);
    this.renumber();
  }

  /** Kernel `create` (§3.3). Returns null when the session already has MAX_WINDOWS windows. */
  create(c: CreateWindow): WinModel | null {
    if (this.registry.size >= MAX_WINDOWS || this.registry.has(c.wid)) return null;
    const limits: Limits = { ...DEFAULT_LIMITS, ...c.limits };
    const app = c.app ?? 'app';
    const r =
      c.rect === undefined
        ? this.placeNew(c.wid, app, limits)
        : clampRect(c.rect, limits, this.workRect, this.titlebarH);
    const w: WinModel = {
      wid: c.wid,
      pid: c.pid,
      app,
      title: c.title,
      icon: c.icon ?? c.app ?? 'app',
      ...r,
      cw: r.w,
      ch: r.h,
      z: 0,
      state: 'normal',
      prevState: 'normal',
      snap: null,
      restoreRect: null,
      focused: false,
      limits,
      flags: {
        restoring: false,
        suspended: false,
        crashed: false,
        notResponding: false,
        attention: false,
        closeGuard: null,
        secureStrip: false,
        closing: false,
      },
      dirtyBits: DIRTY.POS | DIRTY.SIZE | DIRTY.CONTENT,
      createdAt: this.now(),
    };
    this.registry.set(c.wid, w);
    const activation = c.activation ?? true;
    const restored = c.restore !== undefined && Number.isFinite(c.restore.z);
    if (restored && c.restore !== undefined) {
      this.restoreZ.set(c.wid, c.restore.z);
      this.placeRestored(c.wid, c.restore.z);
    } else if (activation || this.focusedWid === null) this.order.insertTop(c.wid);
    else this.order.insertBelowTop(c.wid);
    this.renumber();
    this.dirty(w, DIRTY.POS | DIRTY.SIZE | DIRTY.CONTENT | DIRTY.Z);
    this.emit({ type: 'opened', wid: c.wid, app: w.app, title: w.title, focused: activation });
    if (activation) {
      if (!this.secureOpen) this.setFocused(c.wid);
    } else if (!restored) {
      w.flags.attention = true;
      this.emit({ type: 'attention', wid: c.wid, on: true });
    }
    if (restored) this.keepFocusOnTop(c.restore?.minimised === true ? c.wid : null);
    else this.compactFit(c.wid);
    this.unreported.add(c.wid);
    this.reportChanged();
    return w;
  }

  /** Click, keyboard switch or activated kernel focus: raise, renumber, focus (§3.4 rule 3). */
  focus(wid: number): boolean {
    const w = this.registry.get(wid);
    if (!w || this.secureOpen || w.flags.closing) return false;
    if (w.state === 'minimised') return this.restore(wid);
    if (this.focusedWid === wid && this.order.top() === wid) return true;
    this.order.raise(wid);
    this.renumber();
    this.setFocused(wid);
    this.reportChanged();
    return true;
  }

  /**
   * A press on the bare desktop (UI-083): no window has focus, as on macOS; the stacking stays.
   * The next click, launch or switch focuses a window again. Refused while the secure prompt is
   * open (§3.4 rule 9). Returns whether focus changed.
   */
  unfocus(): boolean {
    if (this.secureOpen || this.focusedWid === null) return false;
    this.setFocused(null);
    return true;
  }

  /** Remove a window after the kernel's `close` (animation done); focus moves on (§3.4 rule 6). */
  close(wid: number): boolean {
    const w = this.registry.get(wid);
    if (!w) return false;
    this.order.remove(wid);
    this.registry.delete(wid);
    this.restoreZ.delete(wid);
    this.preferred.delete(wid);
    this.forced.delete(wid);
    this.unreported.delete(wid);
    this.renumber();
    this.emit({ type: 'closed', wid });
    if (this.focusedWid === wid) {
      this.focusedWid = null;
      const next = this.nextFocus();
      if (next !== null && !this.secureOpen) this.focus(next);
      else this.setFocused(null);
    }
    this.reportChanged();
    return true;
  }

  minimise(wid: number): boolean {
    const w = this.registry.get(wid);
    if (!w || w.state === 'minimised') return false;
    w.prevState = w.state;
    w.state = 'minimised';
    this.emit({ type: 'state', wid, state: w.state, rect: this.rectOf(w) });
    this.kernel({ t: 'minimised', wid, seq: ++this.seq });
    this.unreported.add(wid);
    if (this.focusedWid === wid) {
      const next = this.nextFocus();
      if (next !== null) this.focus(next);
      else this.setFocused(null);
    }
    this.reportChanged();
    return true;
  }

  /**
   * Restore: from minimised back to the previous state (and focus); from maximised, full screen
   * or a snap back to the saved normal rectangle.
   */
  restore(wid: number): boolean {
    const w = this.registry.get(wid);
    if (!w) return false;
    if (w.state === 'minimised') {
      w.state = w.prevState;
      // The work area may have changed while it was minimised.
      this.setRectOf(w, this.targetRect(w));
      this.dirty(w, DIRTY.POS | DIRTY.SIZE);
      this.emit({ type: 'state', wid, state: w.state, rect: this.rectOf(w) });
      this.kernel({ t: 'restored', wid, seq: ++this.seq });
      this.order.raise(wid);
      this.renumber();
      if (!this.secureOpen) this.setFocused(wid);
      this.unreported.add(wid);
      this.reportChanged();
      return true;
    }
    if (w.state === 'normal' && w.snap === null) return false;
    const back = w.restoreRect ?? this.rectOf(w);
    w.state = 'normal';
    w.prevState = 'normal';
    const hadSnap = w.snap !== null;
    w.snap = null;
    w.restoreRect = null;
    this.forced.delete(wid);
    this.placeNormal(w, back);
    if (hadSnap) this.emit({ type: 'snap', wid, snap: null });
    this.emit({ type: 'state', wid, state: 'normal', rect: this.rectOf(w) });
    return true;
  }

  /**
   * Remember the rectangle a restore returns to: `from` when the caller knows it (the rectangle
   * before a drag that ends in a snap zone, UI-095), else the current one if it is normal and
   * unsnapped (a snapped window keeps the one from before its snap). The current one is taken at
   * the size the user gave it, not the size a small work area clamped it to, so a maximise, snap
   * or full-screen round trip does not make that clamp permanent (UI-096).
   */
  private saveRestoreRect(w: WinModel, from?: Rect): void {
    if (from !== undefined) w.restoreRect = { ...from };
    else if (w.state === 'normal' && w.snap === null) w.restoreRect = this.wantedRect(w);
  }

  maximise(wid: number, from?: Rect): boolean {
    const w = this.registry.get(wid);
    if (!w || w.state === 'maximised' || w.state === 'minimised') return false;
    this.saveRestoreRect(w, from);
    w.state = 'maximised';
    w.prevState = 'maximised';
    const hadSnap = w.snap !== null;
    w.snap = null;
    this.setRectOf(w, maxRect(this.workRect, w.limits));
    if (hadSnap) this.emit({ type: 'snap', wid, snap: null });
    this.emit({ type: 'state', wid, state: 'maximised', rect: this.rectOf(w) });
    return true;
  }

  /** Title-bar double-click (WM-04, §3.8): normal (snapped or not) ↔ maximised. */
  toggleMaximise(wid: number): boolean {
    const w = this.registry.get(wid);
    if (!w) return false;
    if (w.state === 'maximised') return this.restore(wid);
    if (w.state === 'normal') return this.maximise(wid);
    return false;
  }

  fullscreen(wid: number): boolean {
    const w = this.registry.get(wid);
    if (!w || w.state === 'minimised' || w.state === 'fullscreen') return false;
    this.saveRestoreRect(w);
    w.state = 'fullscreen';
    w.prevState = 'fullscreen';
    const hadSnap = w.snap !== null;
    w.snap = null;
    this.forced.delete(wid);
    this.setRectOf(w, maxRect(this.screenRect, w.limits));
    if (hadSnap) this.emit({ type: 'snap', wid, snap: null });
    this.emit({ type: 'state', wid, state: 'fullscreen', rect: this.rectOf(w) });
    return true;
  }

  /**
   * Apply a snap zone at drag end or from the keyboard (§3.6). `from` is the rectangle a later
   * restore returns to (the drag's starting rectangle), else the current normal one.
   */
  snap(wid: number, zone: Exclude<SnapZone, null>, from?: Rect): boolean {
    const w = this.registry.get(wid);
    if (!w || w.state === 'minimised') return false;
    if (zone === 'max') return this.maximise(wid, from);
    if (w.state !== 'normal') this.restore(wid);
    this.saveRestoreRect(w, from);
    this.forced.delete(wid);
    w.snap = zone;
    this.setRectOf(w, snapRectFor(zone, this.workRect, w.limits));
    this.emit({ type: 'snap', wid, snap: zone });
    return true;
  }

  /** Drag: move a normal window, clamped so the title bar stays reachable (WMD-06). */
  moveTo(wid: number, x: number, y: number): void {
    const w = this.registry.get(wid);
    if (w?.state !== 'normal') return;
    const p = clampPosition(x, y, w.w, this.workRect, this.titlebarH);
    this.setRectOf(w, { x: p.x, y: p.y, w: w.w, h: w.h });
  }

  /**
   * Resize result (already within limits and the work area, see geometry.resizeRect). During a
   * live resize `content` freezes the content box at max(start, current) so the app re-lays out
   * once at the end, not every frame (§3.5); without it the content box follows the frame.
   */
  setRect(wid: number, r: Rect, content?: { cw: number; ch: number }): void {
    const w = this.registry.get(wid);
    if (w?.state !== 'normal') return;
    if (r.w !== w.w || r.h !== w.h) this.preferred.delete(wid);
    this.setRectOf(w, r, content);
  }

  /**
   * Leave a snapped or maximised state because a drag started (unsnap under the pointer): the
   * window becomes normal at `r` without emitting a restore of the old rectangle.
   */
  unsnapTo(wid: number, r: Rect): void {
    const w = this.registry.get(wid);
    if (!w || (w.state !== 'maximised' && w.snap === null)) return;
    const hadSnap = w.snap !== null;
    w.state = 'normal';
    w.prevState = 'normal';
    w.snap = null;
    w.restoreRect = null;
    this.forced.delete(wid);
    this.placeNormal(w, r);
    if (hadSnap) this.emit({ type: 'snap', wid, snap: null });
    this.emit({ type: 'state', wid, state: 'normal', rect: this.rectOf(w) });
  }

  /** Drag end without a snap zone: the edge magnet (§3.6). */
  settle(wid: number): void {
    const w = this.registry.get(wid);
    if (w?.state !== 'normal' || w.snap !== null) return;
    this.setRectOf(w, magnet(this.rectOf(w), this.workRect));
  }

  /**
   * A window as it is saved and reported (WM-06): as the user left it. A window that compact
   * mode maximised is saved normal (or snapped) at the rectangle it gets back once the work area
   * grows (§3.6), so a narrow session does not come back as a desktop of maximised windows.
   */
  persisted(w: WinModel): PersistedWindow {
    const snap = this.forced.get(w.wid);
    if (snap === undefined) {
      return {
        rect: this.rectOf(w),
        restoreRect: w.restoreRect === null ? null : { ...w.restoreRect },
        state: w.state,
        prevState: w.prevState,
        snap: w.snap,
      };
    }
    const normal = w.restoreRect ?? this.rectOf(w);
    return {
      rect: snap === null ? { ...normal } : snapRectFor(snap, this.workRect, w.limits),
      restoreRect: snap === null ? null : { ...normal },
      state: w.state === 'minimised' ? 'minimised' : 'normal',
      prevState: 'normal',
      snap,
    };
  }

  /** Final values for the kernel (WM-06 session restore) and the store. */
  reportGeometry(wid: number): void {
    const w = this.registry.get(wid);
    if (!w) return;
    this.unreported.delete(wid);
    const p = this.persisted(w);
    this.kernel({
      t: 'geometry',
      wid,
      rect: p.rect,
      state: p.state,
      z: w.z,
      snap: p.snap,
      restoreRect: p.restoreRect,
    });
    this.emit({ type: 'geometry', wid, rect: this.rectOf(w) });
  }

  /**
   * Compact mode (§3.6): while the work area is narrower than COMPACT_BELOW, a normal window is
   * shown maximised; its snap and normal rectangle are kept and come back when the work area
   * grows. Returns whether the window changed.
   */
  compactFit(wid: number): boolean {
    const w = this.registry.get(wid);
    if (!this.compactMode || !w || this.forced.has(wid)) return false;
    if (w.state === 'normal') {
      const snap = w.snap;
      // The normal rectangle to come back to keeps the size a narrower work area clamped.
      if (!this.maximise(wid, snap === null ? this.wantedRect(w) : undefined)) return false;
      this.forced.set(wid, snap);
      return true;
    }
    if (w.state === 'minimised' && w.prevState === 'normal') {
      this.forced.set(wid, w.snap);
      if (w.snap === null) w.restoreRect = this.wantedRect(w);
      const hadSnap = w.snap !== null;
      w.snap = null;
      w.prevState = 'maximised';
      this.setRectOf(w, maxRect(this.workRect, w.limits));
      if (hadSnap) this.emit({ type: 'snap', wid, snap: null });
      return true;
    }
    return false;
  }

  /** Leave compact mode: every window it maximised gets its normal rectangle and snap back. */
  private leaveCompact(): number[] {
    const changed: number[] = [];
    const list = [...this.forced];
    this.forced.clear();
    for (const [wid, snap] of list) {
      const w = this.registry.get(wid);
      if (!w) continue;
      if (w.state === 'maximised') {
        this.restore(wid);
        if (snap !== null) this.snap(wid, snap);
        changed.push(wid);
      } else if (w.state === 'minimised' && w.prevState === 'maximised') {
        const back = w.restoreRect ?? this.rectOf(w);
        w.restoreRect = null;
        w.prevState = 'normal';
        this.placeNormal(w, back);
        if (snap !== null) {
          w.restoreRect = this.rectOf(w);
          w.snap = snap;
          this.setRectOf(w, snapRectFor(snap, this.workRect, w.limits));
          this.emit({ type: 'snap', wid, snap });
        }
        changed.push(wid);
      }
    }
    return changed;
  }

  /**
   * Viewport resize (§3.6): recompute maximised, full-screen and snapped rects (never below a
   * window's minimum size), re-clamp the rest (a window a smaller viewport clamped grows back),
   * and enter or leave compact mode. Returns the windows whose state changed.
   */
  setWorkArea(work: Rect, screen: Rect = work): number[] {
    this.workRect = { ...work };
    this.screenRect = { ...screen };
    for (const w of this.windows()) this.setRectOf(w, this.targetRect(w));
    const compact = work.w < COMPACT_BELOW;
    if (compact === this.compactMode) return [];
    this.compactMode = compact;
    if (!compact) return this.leaveCompact();
    return this.windows().flatMap((w) => (this.compactFit(w.wid) ? [w.wid] : []));
  }

  setTitle(wid: number, title: string): void {
    const w = this.registry.get(wid);
    if (!w) return;
    w.title = title;
    this.emit({ type: 'title', wid, title });
  }

  attention(wid: number, on: boolean): void {
    const w = this.registry.get(wid);
    if (!w || w.focused) return;
    w.flags.attention = on;
    this.emit({ type: 'attention', wid, on });
  }

  /** I-WM1..I-WM3; throws on a violation (tests and debug builds). */
  check(): void {
    const ws = this.windows();
    const zs = ws.map((w) => w.z).sort((a, b) => a - b);
    zs.forEach((z, i) => {
      if (z !== i + 1)
        throw new Error(`I-WM1: z values ${zs.join(',')} are not 1..${String(ws.length)}`);
    });
    const focused = ws.filter((w) => w.focused);
    if (focused.length > 1) throw new Error('I-WM2: more than one focused window');
    if (this.focusedWid !== null && !this.secureOpen && this.focusedWid !== this.nextFocus()) {
      throw new Error('I-WM2: the focused window is not the top-most non-minimised one');
    }
    for (const w of ws) {
      if (w.state !== 'normal') continue;
      const p = clampPosition(w.x, w.y, w.w, this.workRect, this.titlebarH);
      if (p.x !== w.x || p.y !== w.y)
        throw new Error(`I-WM3: window ${String(w.wid)} is outside the clamp rule`);
    }
  }

  stateOf(wid: number): WinState | undefined {
    return this.registry.get(wid)?.state;
  }
}
