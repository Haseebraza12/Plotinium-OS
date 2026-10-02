import '@xterm/xterm/css/xterm.css';

import { FitAddon } from '@xterm/addon-fit';
import { Terminal, type ITerminalOptions, type ITheme } from '@xterm/xterm';
import { createEffect, on, onCleanup, onMount, splitProps, type JSX } from 'solid-js';

import { mirrorBlockedStyles, withInertStyles } from '../../primitives/internal/csp-styles.ts';
import { cx } from '../../primitives/internal/cx.ts';
import { cspSafeRowStyles } from './csp-rows.ts';
import { prefersReducedMotion } from '../../primitives/internal/motion.ts';
import styles from './Terminal.module.css';
import {
  buildTerminalTheme,
  createTokenResolver,
  monoFontFamily,
  terminalOptions,
  whenFontLoaded,
  type Scheme,
  type TokenResolver,
} from './theme.ts';

export interface TerminalSize {
  cols: number;
  rows: number;
}

/** The part of xterm's Terminal the host uses; tests inject a fake with the same shape. */
export interface TerminalLike {
  readonly cols: number;
  readonly rows: number;
  options: ITerminalOptions;
  open(parent: HTMLElement): void;
  write(data: string | Uint8Array, callback?: () => void): void;
  onData(listener: (data: string) => void): { dispose(): void };
  onResize(listener: (size: TerminalSize) => void): { dispose(): void };
  onTitleChange(listener: (title: string) => void): { dispose(): void };
  focus(): void;
  clear(): void;
  reset(): void;
  getSelection(): string;
  hasSelection(): boolean;
  selectAll(): void;
  /** Sends text as a paste: bracketed when the program asked for it, line ends as CR. */
  paste(text: string): void;
  scrollToBottom(): void;
  dispose(): void;
  /**
   * The main screen's lines as plain text (the alternate screen of `top` or the pager is left
   * out), oldest first, without the blank rows below the last written one, at most `maxLines`.
   * Optional so test doubles may leave it out.
   */
  lines?(maxLines: number): string[];
}

/** One buffer line as xterm's `IBufferLine.translateToString(true)` gives it. */
export interface BufferLike {
  readonly length: number;
  getLine(y: number): { translateToString(trimRight?: boolean): string } | undefined;
}

/**
 * The last `maxLines` lines of `buffer` up to its last non-blank one (shell-and-terminal.md §3.3
 * snapshot, UI-127).
 */
export function bufferLines(buffer: BufferLike, maxLines: number): string[] {
  const text = (y: number): string => buffer.getLine(y)?.translateToString(true) ?? '';
  let end = buffer.length;
  while (end > 0 && text(end - 1).trim() === '') end -= 1;
  const out: string[] = [];
  for (let y = Math.max(0, end - Math.max(0, maxLines)); y < end; y++) out.push(text(y));
  return out;
}

export interface TerminalInstance {
  terminal: TerminalLike;
  /** Resizes the grid to the container; returns the new size, if it could be measured. */
  fit: () => TerminalSize | undefined;
}

export type TerminalFactory = (options: ITerminalOptions) => TerminalInstance;

/**
 * Whether `el` has a layout box to measure. A terminal in a hidden tab panel (`display: none`)
 * has none: its computed width and height are the specified `100%`, which the fit addon would
 * read as 100 px, shrinking the grid to about 10 × 4 cells and sending the shell a SIGWINCH for
 * that size (UI-020).
 */
export function hasLayoutBox(el: HTMLElement): boolean {
  return el.isConnected && el.clientWidth > 0 && el.clientHeight > 0;
}

/** The real factory: xterm.js 6 (DOM renderer) with the fit addon. */
export const createXterm: TerminalFactory = (options) => {
  const terminal = new Terminal(options);
  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  return {
    terminal: {
      get cols() {
        return terminal.cols;
      },
      get rows() {
        return terminal.rows;
      },
      get options() {
        return terminal.options;
      },
      set options(value: ITerminalOptions) {
        terminal.options = value;
      },
      open: (parent) => {
        terminal.open(parent);
        // Selected and true-colour cells get their colours through the CSSOM, not a refused
        // `style` attribute (csp-rows.ts, UI-050).
        cspSafeRowStyles(terminal);
      },
      write: (data, callback) => terminal.write(data, callback),
      onData: (listener) => terminal.onData(listener),
      onResize: (listener) => terminal.onResize(listener),
      onTitleChange: (listener) => terminal.onTitleChange(listener),
      focus: () => terminal.focus(),
      clear: () => terminal.clear(),
      reset: () => terminal.reset(),
      getSelection: () => terminal.getSelection(),
      hasSelection: () => terminal.hasSelection(),
      selectAll: () => terminal.selectAll(),
      paste: (text) => terminal.paste(text),
      scrollToBottom: () => terminal.scrollToBottom(),
      dispose: () => terminal.dispose(),
      lines: (maxLines) => bufferLines(terminal.buffer.normal, maxLines),
    },
    fit: () => {
      // The fit addon measures the element xterm was opened in.
      const parent = terminal.element?.parentElement;
      if (parent === null || parent === undefined || !hasLayoutBox(parent)) return undefined;
      const size = fitAddon.proposeDimensions();
      if (size === undefined || !Number.isFinite(size.cols) || !Number.isFinite(size.rows)) {
        return undefined;
      }
      fitAddon.fit();
      return { cols: terminal.cols, rows: terminal.rows };
    },
  };
};

/** What the Terminal app gets once xterm is mounted. */
export interface TerminalHandle {
  /** Writes TTY output. The callback fires after xterm parsed it (the SHL-03 batch ack). */
  write(data: string | Uint8Array, callback?: () => void): void;
  /** Writes a line and CRLF. */
  writeln(line: string): void;
  clear(): void;
  reset(): void;
  focus(): void;
  fit(): TerminalSize | undefined;
  size(): TerminalSize;
  selection(): string;
  hasSelection(): boolean;
  selectAll(): void;
  /** Sends text to the TTY as a paste (bracketed when the program enabled it). */
  paste(text: string): void;
  scrollToBottom(): void;
  /** The main screen's text, at most `maxLines` lines (see `TerminalLike.lines`; UI-127). */
  lines(maxLines: number): string[];
  /** The scheme of the current theme (it follows the page and any [data-theme] ancestor). */
  scheme(): Scheme;
}

export interface TerminalHostProps {
  /** Accessible name of the terminal region, e.g. "Terminal, student@plotinium: ~". */
  label: string;
  /** Keystrokes and pastes as bytes for the TTY (xterm turns keys into bytes; SHL-01). */
  onData?: (data: string) => void;
  /** The grid changed size (for SIGWINCH). */
  onResize?: (size: TerminalSize) => void;
  /** An OSC title sequence arrived. */
  onTitleChange?: (title: string) => void;
  onReady?: (handle: TerminalHandle) => void;
  /** Text written once after mount, e.g. a restored snapshot (shell-and-terminal.md §3.3). */
  initialText?: string;
  /** Default 14 (ui-design-system.md §3.8.10). */
  fontSize?: number;
  /** From Settings → Accessibility. */
  screenReaderMode?: boolean;
  scrollback?: number;
  /** Focus the terminal on mount. */
  autofocus?: boolean;
  /** Replaces xterm, for tests. */
  createTerminal?: TerminalFactory;
  /** Replaces the token probe, for tests. */
  resolveToken?: TokenResolver;
  class?: string;
}

function themesEqual(a: ITheme | undefined, b: ITheme): boolean {
  if (a === undefined) return false;
  const keys = Object.keys(b) as (keyof ITheme)[];
  return keys.every((key) => a[key] === b[key]);
}

/**
 * Hosts one xterm.js terminal: Plotinium light and dark themes built from tokens, the
 * `--pl-font-mono` face (re-measured once the web font has loaded), fit-to-container on resize
 * (one fit per animation frame, never while hidden), the cursor blink off under reduced motion,
 * and theme changes followed live. It renders bytes; the line discipline is the kernel TTY's
 * (apps/terminal/tty.ts).
 *
 * xterm is opened in an unpadded element inside the padded region, because the fit addon sizes
 * the grid from its parent's computed width and height, which include padding under
 * `box-sizing: border-box` (the grid was one padding wider than the viewport, UI-128). Its
 * run-time `<style>` elements are created as inert stand-ins and applied through adopted sheets,
 * so the strict CSP neither blocks them nor reports a violation (csp-styles.ts, UI-050).
 */
export function TerminalHost(props: TerminalHostProps): JSX.Element {
  const [local] = splitProps(props, [
    'label',
    'onData',
    'onResize',
    'onTitleChange',
    'onReady',
    'initialText',
    'fontSize',
    'screenReaderMode',
    'scrollback',
    'autofocus',
    'createTerminal',
    'resolveToken',
    'class',
  ]);
  let container: HTMLDivElement | undefined;
  /** The unpadded element xterm is opened in (its size is the region's content box). */
  let mount: HTMLDivElement | undefined;
  let instance: TerminalInstance | undefined;
  let scheme: Scheme = 'dark';
  let frame = 0;

  const resolver = (): TokenResolver | undefined =>
    local.resolveToken ?? (container === undefined ? undefined : createTokenResolver(container));

  const currentTheme = (): ITheme | undefined => {
    const resolve = resolver();
    if (resolve === undefined) return undefined;
    const built = buildTerminalTheme(resolve);
    scheme = built.scheme;
    return built.theme;
  };

  const reducedMotion = (): boolean =>
    typeof document !== 'undefined' && prefersReducedMotion(document);

  const refreshAppearance = (): void => {
    const terminal = instance?.terminal;
    if (terminal === undefined) return;
    const theme = currentTheme();
    if (theme !== undefined && !themesEqual(terminal.options.theme, theme)) {
      terminal.options = { theme };
    }
    const blink = !reducedMotion();
    if (terminal.options.cursorBlink !== blink) terminal.options = { cursorBlink: blink };
  };

  // A hidden tab keeps its grid: fitting it would shrink the TTY to a few cells (UI-020). The
  // ResizeObserver fits it again when its panel is shown.
  const fitNow = (): TerminalSize | undefined =>
    mount === undefined || !hasLayoutBox(mount) ? undefined : instance?.fit();

  const scheduleFit = (): void => {
    if (frame !== 0) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      fitNow();
    });
  };

  onMount(() => {
    const host = container;
    const parent = mount;
    if (host === undefined || parent === undefined) return;
    const theme = currentTheme() ?? {};
    const factory = local.createTerminal ?? createXterm;
    instance = factory(
      terminalOptions({
        theme,
        fontFamily: monoFontFamily(host, local.resolveToken),
        fontSize: local.fontSize,
        reducedMotion: reducedMotion(),
        screenReaderMode: local.screenReaderMode,
        scrollback: local.scrollback,
      }),
    );
    const terminal = instance.terminal;
    // xterm creates its <style> elements (mono font, cell size, ANSI colours, scrollbar) inside
    // `open`; they are made as inert stand-ins, so the CSP never refuses or reports them, and
    // their CSS applies through adopted stylesheets (csp-styles.ts).
    withInertStyles(host.ownerDocument, () => terminal.open(parent));
    const unmirrorStyles = mirrorBlockedStyles(parent);
    // Handlers read the latest props when an event fires (they are not tracked scopes).
    const handlers = {
      onData: (data: string): void => local.onData?.(data),
      onResize: (size: TerminalSize): void => local.onResize?.(size),
      onTitleChange: (title: string): void => local.onTitleChange?.(title),
    };
    const subscriptions = [
      terminal.onData(handlers.onData),
      terminal.onResize(handlers.onResize),
      terminal.onTitleChange(handlers.onTitleChange),
    ];
    fitNow();
    if (local.initialText !== undefined && local.initialText !== '') {
      terminal.write(local.initialText);
    }

    // xterm measures its cell once, at open. If the mono web font was still loading, that measure
    // used the fallback face (rows about 10% short); measure again once the face has arrived.
    // xterm re-measures only when fontFamily changes value, hence the two writes.
    let mounted = true;
    const family = terminal.options.fontFamily;
    if (family !== undefined && family !== '') {
      whenFontLoaded(host.ownerDocument, `${terminal.options.fontSize ?? 14}px ${family}`, () => {
        if (!mounted) return;
        terminal.options = { fontFamily: '' };
        terminal.options = { fontFamily: family };
        scheduleFit();
      });
    }

    const resizeObserver =
      typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(scheduleFit);
    resizeObserver?.observe(parent);

    // Follow theme, motion and transparency switches on the page or on any themed ancestor.
    const mutationObserver = new MutationObserver(refreshAppearance);
    mutationObserver.observe(host.ownerDocument.documentElement, {
      attributes: true,
      subtree: true,
      attributeFilter: ['data-theme', 'data-motion'],
    });
    const media = ['(prefers-color-scheme: dark)', '(prefers-reduced-motion: reduce)']
      .map((query) => (typeof matchMedia === 'undefined' ? undefined : matchMedia(query)))
      .filter((m): m is MediaQueryList => m !== undefined);
    for (const m of media) m.addEventListener('change', refreshAppearance);

    local.onReady?.({
      write: (data, callback) => terminal.write(data, callback),
      writeln: (line) => terminal.write(`${line}\r\n`),
      clear: () => terminal.clear(),
      reset: () => terminal.reset(),
      focus: () => terminal.focus(),
      fit: fitNow,
      size: () => ({ cols: terminal.cols, rows: terminal.rows }),
      selection: () => terminal.getSelection(),
      hasSelection: () => terminal.hasSelection(),
      selectAll: () => terminal.selectAll(),
      paste: (text) => terminal.paste(text),
      scrollToBottom: () => terminal.scrollToBottom(),
      lines: (maxLines) => terminal.lines?.(maxLines) ?? [],
      scheme: () => scheme,
    });
    if (local.autofocus === true) terminal.focus();

    onCleanup(() => {
      mounted = false;
      cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      mutationObserver.disconnect();
      for (const m of media) m.removeEventListener('change', refreshAppearance);
      for (const s of subscriptions) s.dispose();
      terminal.dispose();
      unmirrorStyles();
      instance = undefined;
    });
  });

  createEffect(
    on(
      () => [local.fontSize, local.screenReaderMode] as const,
      ([fontSize, screenReaderMode]) => {
        const terminal = instance?.terminal;
        if (terminal === undefined) return;
        terminal.options = {
          fontSize: fontSize ?? 14,
          screenReaderMode: screenReaderMode === true,
        };
        scheduleFit();
      },
      { defer: true },
    ),
  );

  return (
    <div
      ref={(el) => (container = el)}
      role="region"
      aria-label={local.label}
      data-testid="terminal"
      class={cx(styles.host, local.class)}
      onPointerDown={() => instance?.terminal.focus()}
    >
      <div ref={(el) => (mount = el)} class={styles.mount} />
    </div>
  );
}
