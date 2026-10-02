/**
 * wm/src/compositor: the framework-free window compositor (window-manager.md; WM-01..WM-04).
 * The sole writer of window geometry and z-index; no Solid imports (C11, ESLint-enforced).
 */
export { flipFrom, genieTo, NO_ANIMATION } from './anim.ts';
export type { AnimationDetail, AnimationHooks } from './anim.ts';
export { createCompositor } from './compositor.ts';
export type {
  Compositor,
  CompositorOptions,
  FrameElement,
  Insets,
  LayoutRow,
} from './compositor.ts';
export { Flusher } from './flush.ts';
export type { FlushStats, FrameRequest, StyleTarget, Surfaces } from './flush.ts';
export * from './geometry.ts';
export { Gestures } from './gestures.ts';
export type { CaptureTarget, GestureDeps, KeyboardGesture, PointerLike } from './gestures.ts';
export { MAX_WINDOWS, WindowModel } from './model.ts';
export type { CreateWindow, ModelHooks, ModelOptions, PersistedWindow } from './model.ts';
export {
  ArrayStackOrder,
  createStackOrder,
  createWindowTable,
  HashWindowTable,
  MapWindowTable,
  ZOrderStack,
} from './registry.ts';
export type { StackOrder, WindowTable } from './registry.ts';
export { DIRTY } from './types.ts';
export type {
  CoarseEvent,
  CompositorToKernel,
  Edges,
  KernelToCompositor,
  Limits,
  Rect,
  ResizeEdge,
  Snap,
  SnapZone,
  WindowPhase,
  WinFlags,
  WinModel,
  WinState,
} from './types.ts';
