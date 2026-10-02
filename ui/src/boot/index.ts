/**
 * @plotinium/ui/boot: the framework-free boot screens (DSN-14, C11). Plain TypeScript and one
 * stylesheet (boot.css, inlined into index.html next to tokens.css); no Solid, lucide, xterm
 * or CodeMirror, because these screens run before any framework loads and must work when the
 * shell chunk is the thing that failed.
 *
 * Every screen is a tiny render function returning `{ el, …setters, focus, destroy }`. The
 * screens hold no boot logic and no timers: wm/boot-ui drives them from real boot events and
 * receives the user's intents through callbacks (SYS-01).
 */
export { ANNOUNCE_INTERVAL_MS, createAnnouncer, Say } from './announcer.ts';
export type { Announcer, AnnouncerOptions } from './announcer.ts';
export {
  createVerboseLog,
  formatBootLine,
  formatBootTime,
  levelOf,
  lineNode,
  parseBootLine,
  splitPrefix,
} from './log.ts';
export type { VerboseLog, VerboseLogOptions } from './log.ts';
export { BOOT_MENU_OPTIONS, createBootMenu } from './menu.ts';
export type { BootMenu, BootMenuOption, BootMenuOptions, BootMode } from './menu.ts';
export { createPanicScreen, cycleSvg } from './panic.ts';
export type { PanicAction, PanicScreen, PanicScreenOptions } from './panic.ts';
export { createRecoveryConsole, RECOVERY_ACTIONS } from './recovery.ts';
export type {
  CheckItem,
  CheckState,
  RecoveryAction,
  RecoveryActionId,
  RecoveryConsole,
  RecoveryConsoleOptions,
} from './recovery.ts';
export { createBootSplash, splashHtml, splashTree } from './splash.ts';
export type { BootSplash, BootSplashOptions, SplashMarkupOptions } from './splash.ts';
export type { BootIdentity, BootLogLevel, BootLogLine, BootScreen, ScreenBase } from './types.ts';
export {
  createUnsupportedScreen,
  DEGRADED_TITLE,
  localAddress,
  UNSUPPORTED_TITLE,
} from './unsupported.ts';
export type {
  CapabilityRow,
  CapabilityStatus,
  PageLocation,
  UnsupportedScreen,
  UnsupportedScreenOptions,
} from './unsupported.ts';
export { backdrop, logoSvg } from './logo.ts';
export { h, html, render } from './dom.ts';
export type { Attrs, Kid, VNode } from './dom.ts';
