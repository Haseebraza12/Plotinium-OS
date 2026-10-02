/**
 * Pointer gestures (window-manager.md §3.5, WM-03, WM-04, WMD-04, WMD-05, WMD-07): drag by the
 * title bar and resize by any of the eight handles, with pointer capture. Layout is read once at
 * gesture start (R-READ); `pointermove` is O(1) arithmetic plus a flush schedule; the gesture
 * posts the interactive hint at start and end and toggles the window's `dragging` state.
 * The keyboard move and size mode (§3.9 rule 4, WCAG 2.5.7) is the same gesture driven by keys.
 */
import {
  DRAG_THRESHOLD,
  edgesOf,
  resizeRect,
  snapRectFor,
  snapZone,
  unsnapUnderPointer,
} from './geometry.ts';
import type { WindowModel } from './model.ts';
import type { Rect, ResizeEdge, SnapZone } from './types.ts';

/** A running keyboard move or size mode (window menu → Move / Size). */
export interface KeyboardGesture {
  readonly wid: number;
  readonly mode: 'move' | 'size';
  /** Move the window (or its right and bottom edges) by (dx, dy); returns the new rectangle. */
  step(dx: number, dy: number): Rect;
  /** Enter: keep the rectangle and report it. */
  commit(): void;
  /** Esc: back to the rectangle (and snap) from before the mode. */
  cancel(): void;
  readonly done: boolean;
}

/** The fields of a PointerEvent the gestures read. */
export interface PointerLike {
  readonly clientX: number;
  readonly clientY: number;
  readonly pointerId: number;
  readonly button: number;
}

/** The element that receives pointer capture (the title bar or a handle). */
export interface CaptureTarget {
  setPointerCapture(pointerId: number): void;
  addEventListener(
    type: 'pointermove' | 'pointerup' | 'pointercancel' | 'lostpointercapture',
    fn: (ev: PointerLike) => void,
    opts?: { once?: boolean },
  ): void;
  removeEventListener(
    type: 'pointermove' | 'pointerup' | 'pointercancel' | 'lostpointercapture',
    fn: (ev: PointerLike) => void,
  ): void;
}

export interface GestureDeps {
  readonly model: WindowModel;
  /** The router's `interactive` hint (WMD-05): the scheduler pauses the background band. */
  readonly interactive: (active: boolean) => void;
  /** Toggle the window's `dragging` state (class and store event). */
  readonly setDragging: (wid: number, on: boolean) => void;
  /** Show the snap preview rectangle, or hide it with null. */
  readonly preview?: (r: Rect | null) => void;
  /** Report final values (flush, geometry to the kernel, layout persist). */
  readonly committed: (wid: number) => void;
}

const END_EVENTS = ['pointerup', 'pointercancel', 'lostpointercapture'] as const;

export class Gestures {
  private readonly deps: GestureDeps;
  private active: number | null = null;

  constructor(deps: GestureDeps) {
    this.deps = deps;
  }

  /** The wid being dragged or resized, if any. */
  get current(): number | null {
    return this.active;
  }

  private bind(
    target: CaptureTarget,
    ev: PointerLike,
    move: (e: PointerLike) => void,
    end: (e: PointerLike | null) => void,
  ): void {
    target.setPointerCapture(ev.pointerId);
    let done = false;
    const finish = (e: PointerLike): void => {
      if (done) return;
      done = true;
      target.removeEventListener('pointermove', move);
      for (const type of END_EVENTS) target.removeEventListener(type, finish);
      end(e);
    };
    target.addEventListener('pointermove', move);
    for (const type of END_EVENTS) target.addEventListener(type, finish, { once: true });
  }

  /** Title-bar pointerdown (outside its buttons). */
  beginDrag(wid: number, ev: PointerLike, target: CaptureTarget): void {
    const { model } = this.deps;
    const w = model.get(wid);
    if (!w || ev.button !== 0 || model.secureOpen || this.active !== null) return;
    model.focus(wid);
    const work = model.work; // the one layout-dependent read, at gesture start
    let originX = w.x;
    let originY = w.y;
    const frac = w.w > 0 ? (ev.clientX - w.x) / w.w : 0.5;
    const grabDy = ev.clientY - w.y;
    // What a snap at the end of this drag restores to: the rectangle before the drag, or the one
    // a snapped or maximised window already remembers (UI-095), never the release point.
    const restoreFrom: Rect | undefined =
      w.state === 'normal' && w.snap === null
        ? { x: w.x, y: w.y, w: w.w, h: w.h }
        : (w.restoreRect ?? undefined);
    let dragging = false;
    let zone: SnapZone = null;
    this.active = wid;

    const move = (e: PointerLike): void => {
      const dx = e.clientX - ev.clientX;
      const dy = e.clientY - ev.clientY;
      if (!dragging) {
        if (dx * dx + dy * dy < DRAG_THRESHOLD * DRAG_THRESHOLD) return;
        dragging = true;
        this.deps.setDragging(wid, true);
        this.deps.interactive(true);
        if (w.state === 'maximised' || w.snap !== null) {
          const restore = w.restoreRect ?? {
            x: w.x,
            y: w.y,
            w: Math.min(720, work.w),
            h: Math.min(480, work.h),
          };
          model.unsnapTo(
            wid,
            unsnapUnderPointer(restore, frac, e.clientX, e.clientY, Math.min(grabDy, 20)),
          );
          originX = w.x - dx;
          originY = w.y - dy;
        }
      }
      model.moveTo(wid, originX + dx, originY + dy);
      const z = snapZone(e.clientX, e.clientY, work);
      if (z !== zone) {
        zone = z;
        // The preview shows exactly where the window will land (min size included, UI-096).
        this.deps.preview?.(z === null ? null : snapRectFor(z, work, w.limits));
      }
    };

    this.bind(target, ev, move, () => {
      this.active = null;
      if (!dragging) return;
      this.deps.preview?.(null);
      if (zone !== null) model.snap(wid, zone, restoreFrom);
      else model.settle(wid);
      this.deps.setDragging(wid, false);
      this.deps.interactive(false);
      this.deps.committed(wid);
    });
  }

  /** Pointerdown on one of the eight handles. */
  beginResize(wid: number, edge: ResizeEdge, ev: PointerLike, target: CaptureTarget): void {
    const { model } = this.deps;
    const w = model.get(wid);
    if (!w || ev.button !== 0 || model.secureOpen || w.state !== 'normal' || this.active !== null)
      return;
    model.focus(wid);
    const work = model.work;
    const start: Rect = { x: w.x, y: w.y, w: w.w, h: w.h };
    const edges = edgesOf(edge);
    let resized = false;
    this.active = wid;
    this.deps.setDragging(wid, true);
    this.deps.interactive(true);

    const move = (e: PointerLike): void => {
      const r = resizeRect(
        start,
        e.clientX - ev.clientX,
        e.clientY - ev.clientY,
        edges,
        w.limits,
        work,
      );
      resized = true;
      model.setRect(wid, r, { cw: Math.max(start.w, r.w), ch: Math.max(start.h, r.h) });
    };

    this.bind(target, ev, move, () => {
      this.active = null;
      // The content box catches up with the frame: one resize for the app (§3.5, UI-019).
      if (resized) model.setRect(wid, { x: w.x, y: w.y, w: w.w, h: w.h }, { cw: w.w, ch: w.h });
      this.deps.setDragging(wid, false);
      this.deps.interactive(false);
      this.deps.committed(wid);
    });
  }

  /**
   * Keyboard move or size mode (window-manager.md §3.9 rule 4; WCAG 2.5.7): each step moves the
   * window, or its right and bottom edges, under the same clamp and limits as a pointer gesture.
   * A snapped window leaves its snap where it is; maximised, full-screen and minimised windows
   * have no mode. Returns null when the mode cannot start.
   */
  beginKeyboard(wid: number, mode: 'move' | 'size'): KeyboardGesture | null {
    const { model } = this.deps;
    const w = model.get(wid);
    if (!w || model.secureOpen || this.active !== null || w.state !== 'normal') return null;
    const start: Rect = { x: w.x, y: w.y, w: w.w, h: w.h };
    const startSnap = w.snap;
    const startRestore = w.restoreRect;
    if (startSnap !== null) model.unsnapTo(wid, start);
    model.focus(wid);
    this.active = wid;
    let done = false;
    const rect = (): Rect => ({ x: w.x, y: w.y, w: w.w, h: w.h });
    const finish = (revert: boolean): void => {
      if (done) return;
      done = true;
      if (this.active === wid) this.active = null;
      if (revert) {
        model.setRect(wid, start);
        if (startSnap !== null) model.snap(wid, startSnap, startRestore ?? undefined);
      }
      this.deps.committed(wid);
    };
    return {
      wid,
      mode,
      step: (dx, dy) => {
        if (done || model.get(wid) === undefined) return rect();
        if (mode === 'move') model.moveTo(wid, w.x + dx, w.y + dy);
        else
          model.setRect(
            wid,
            resizeRect(
              rect(),
              dx,
              dy,
              { l: false, t: false, r: true, b: true },
              w.limits,
              model.work,
            ),
          );
        return rect();
      },
      commit: () => finish(false),
      cancel: () => finish(true),
      get done() {
        return done;
      },
    };
  }
}
