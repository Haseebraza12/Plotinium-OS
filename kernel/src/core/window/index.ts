/**
 * kernel/src/core/window: the kernel's window table, its end of the compositor port, view ports
 * and display channels, the window and notification system calls (window-manager.md; syscall-abi
 * §4.4.4). Wired by `installIo` (core/io).
 */
export { DESKTOP_TOPICS, Windows, appIdOf, cleanTitle, transferablesOf } from './service.ts';
export type { CreateRequest, CreatedWindow, WinRec, WindowHooks, WindowsDeps } from './service.ts';
export { WINDOW_SYSCALLS, registerWindowSyscalls } from './syscalls.ts';
export {
  ACTIVATION_WINDOW_MS,
  CompositorToKernelSchema,
  LayoutWindowSchema,
  MAX_WINDOWS,
  SessionLayoutSchema,
  WinStateSchema,
} from './types.ts';
export type {
  ChannelFactory,
  CompositorToKernel,
  CreatePorts,
  DeskNotification,
  DeskUser,
  KernelToCompositor,
  LayoutWindow,
  PortLike,
  Rect,
  SessionLayout,
  Snap,
  WinState,
} from './types.ts';
