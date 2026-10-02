// @plotinium/ui desktop shell: wallpaper, menu bar, dock, window chrome, Control Centre and
// notifications (specs/05-wm/window-manager.md, visual-language-macos.md). Presentational only:
// the compositor and the shell store feed props and act on the callbacks (SYS-01).
export { Wallpaper, type WallpaperProps } from './wallpaper/Wallpaper.tsx';
export {
  appMenuItems,
  MenuBar,
  systemMenuItems,
  type MenuBarApi,
  type MenuBarMenu,
  type MenuBarProps,
} from './menubar/MenuBar.tsx';
export { StatusItems, type StatusItemsProps } from './menubar/StatusItems.tsx';
export { ControlCentreGlyph } from './menubar/glyphs.tsx';
export { Dock, TRASH_ID, type DockApi, type DockProps } from './dock/Dock.tsx';
export { DockIcon, dockItemLabel, type DockIconProps } from './dock/DockIcon.tsx';
export {
  DOCK_MAX_SCALE,
  DOCK_RANGE,
  falloff,
  magnify,
  restingMagnification,
  type DockSlot,
  type Magnification,
} from './dock/magnify.ts';
export { RESIZE_EDGES, WindowFrame, type WindowFrameProps } from './window/WindowFrame.tsx';
export {
  ControlCentre,
  type ControlCentreCloseReason,
  type ControlCentreProps,
  type MemoryBudgetView,
} from './control-centre/ControlCentre.tsx';
export { NotificationCard, type NotificationCardProps } from './notifications/NotificationCard.tsx';
export {
  groupNotifications,
  NotificationCenter,
  type NotificationCenterProps,
} from './notifications/NotificationCenter.tsx';
export {
  DEFAULT_TOAST_TIMERS,
  NotificationToasts,
  type NotificationToastsProps,
  type ToastDismissReason,
  type ToastTimers,
} from './notifications/NotificationToasts.tsx';
export * from './format.ts';
export type * from './types.ts';
