/**
 * The Terminal app's public surface, in the same place as the other apps (apps/<app>/index.ts).
 * The descriptor itself lives in ./manifest.ts; this module stays equally light.
 */
export {
  descriptor,
  TERMINAL_MENU,
  TERMINAL_RELAY_CALLS,
  TERMINAL_WINDOW,
  type TerminalMenuItem,
} from './manifest.ts';
