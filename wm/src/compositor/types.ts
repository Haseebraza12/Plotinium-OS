/**
 * Compositor types (window-manager.md §4.1, §4.3; architecture.md §4.3). Framework-free.
 *
 * `WindowPhase` and `ResizeEdge` are the same unions as ui/ `WindowFrame` props, so the chrome and
 * the compositor agree structurally without either importing the other.
 */

export type WinState = 'normal' | 'minimised' | 'maximised' | 'fullscreen';
export type Snap = 'left' | 'right' | null;
export type SnapZone = 'left' | 'right' | 'max' | null;
export type ResizeEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
export type WindowPhase =
  'opening' | 'closing' | 'minimising' | 'restoring' | 'maximising' | 'unmaximising';

/** CSS px, work-area origin. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Limits {
  minW: number;
  minH: number;
  maxW: number;
  maxH: number;
}

export interface Edges {
  readonly l: boolean;
  readonly t: boolean;
  readonly r: boolean;
  readonly b: boolean;
}

export interface WinFlags {
  restoring: boolean;
  suspended: boolean;
  crashed: boolean;
  notResponding: boolean;
  attention: boolean;
  closeGuard: string | null;
  secureStrip: boolean;
  closing: boolean;
}

/**
 * The registry record (§4.1) without its DOM references: every geometry decision is made on this
 * model, so it is unit-tested without a DOM (WM-01, WM-02, WM-04).
 */
export interface WinModel {
  readonly wid: number;
  readonly pid: number;
  readonly app: string;
  title: string;
  icon: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Content box (frozen during a live resize, §3.5). */
  cw: number;
  ch: number;
  /** 1..n after every operation (I-WM1). */
  z: number;
  state: WinState;
  prevState: Exclude<WinState, 'minimised'>;
  snap: Snap;
  restoreRect: Rect | null;
  focused: boolean;
  limits: Limits;
  flags: WinFlags;
  dirtyBits: number;
  readonly createdAt: number;
}

/** Dirty bits for the single rAF flush (§3.5). */
export const DIRTY = Object.freeze({ POS: 1, SIZE: 2, Z: 4, CONTENT: 8 } as const);

/** Coarse events the compositor pushes into the Solid store (never per pointermove, R-STATE). */
export type CoarseEvent =
  | {
      readonly type: 'opened';
      readonly wid: number;
      readonly app: string;
      readonly title: string;
      readonly focused: boolean;
    }
  | { readonly type: 'closed'; readonly wid: number }
  | { readonly type: 'focused'; readonly wid: number | null }
  | { readonly type: 'state'; readonly wid: number; readonly state: WinState; readonly rect: Rect }
  | { readonly type: 'snap'; readonly wid: number; readonly snap: Snap }
  | { readonly type: 'title'; readonly wid: number; readonly title: string }
  | { readonly type: 'attention'; readonly wid: number; readonly on: boolean }
  | { readonly type: 'dragging'; readonly wid: number; readonly on: boolean }
  | {
      readonly type: 'restoring';
      readonly wid: number;
      readonly doneBytes: number;
      readonly totalBytes: number;
    }
  | { readonly type: 'phase'; readonly wid: number; readonly phase: WindowPhase | null }
  | { readonly type: 'geometry'; readonly wid: number; readonly rect: Rect };

/**
 * Compositor port messages (architecture.md §4.3, extended by window-manager.md §4.3).
 * TODO(protocol): protocol/src/host/compositor.ts with Valibot schemas; declared here until then.
 */
export type KernelToCompositor =
  | {
      readonly t: 'create';
      readonly wid: number;
      readonly pid: number;
      readonly app?: string;
      readonly title: string;
      readonly icon?: string;
      readonly rect?: Rect;
      readonly seq: number;
      readonly activation?: boolean;
      readonly limits?: Partial<Limits>;
      /**
       * Session restore (WM-06): the saved window. The compositor reads only its saved `z` and
       * `state`, so restored windows stack in the saved order whatever order their processes
       * start in.
       */
      readonly restore?: { readonly z?: unknown; readonly state?: unknown };
    }
  | { readonly t: 'close'; readonly wid: number; readonly seq: number }
  | { readonly t: 'focus'; readonly wid: number; readonly seq: number }
  | { readonly t: 'attention'; readonly wid: number; readonly level: 'info' | 'urgent' }
  | { readonly t: 'setTitle'; readonly wid: number; readonly title: string }
  | {
      readonly t: 'restoring';
      readonly wid: number;
      readonly doneBytes: number;
      readonly totalBytes: number;
    };

export type CompositorToKernel =
  | { readonly t: 'focused'; readonly wid: number | null; readonly seq: number }
  | {
      readonly t: 'minimised' | 'restored' | 'closeRequested';
      readonly wid: number;
      readonly seq: number;
    }
  | {
      readonly t: 'geometry';
      readonly wid: number;
      readonly rect: Rect;
      readonly state: WinState;
      readonly z: number;
      /**
       * Additions for session restore (WM-06, UI-034): the snap flag and the rectangle a restore
       * returns to. The kernel's Valibot schema is a plain `object`, so a kernel that does not
       * read them yet drops them.
       */
      readonly snap: Snap;
      readonly restoreRect: Rect | null;
    }
  | { readonly t: 'input'; readonly wid: number };
