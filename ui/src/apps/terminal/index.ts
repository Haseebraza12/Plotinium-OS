// Terminal chrome for apps/terminal (the line discipline is apps/terminal/tty.ts, not here).
export * from './ansi.ts';
export {
  ANSI_GREYS,
  buildTerminalTheme,
  contrastRatio,
  createTokenResolver,
  flatten,
  luminance,
  parseColour,
  TERMINAL_TOKENS,
  terminalOptions,
  toHex,
  type PlotiniumTerminalTheme,
  type Rgba,
  type Scheme,
  type TerminalOptionInputs,
  type TokenResolver,
} from './theme.ts';
export {
  chordLabel,
  isPasteKey,
  TERMINAL_KEYS,
  terminalKeyAction,
  type TerminalChord,
  type TerminalKeyAction,
} from './keys.ts';
export {
  bufferLines,
  createXterm,
  hasLayoutBox,
  TerminalHost,
  type BufferLike,
  type TerminalFactory,
  type TerminalHandle,
  type TerminalHostProps,
  type TerminalInstance,
  type TerminalLike,
  type TerminalSize,
} from './TerminalHost.tsx';
export {
  agentStatusText,
  TerminalStatusStrip,
  txnStatusText,
  type AgentStatus,
  type TerminalStatusStripProps,
  type TxnStatus,
} from './TerminalStatusStrip.tsx';
export {
  TERMINAL_TAB_LIMIT,
  TerminalApp,
  type TerminalAppProps,
  type TerminalSessionTab,
} from './TerminalApp.tsx';
