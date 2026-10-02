import { fireEvent, render, screen } from '@solidjs/testing-library';
import type { ITerminalOptions } from '@xterm/xterm';
import { createSignal } from 'solid-js';
import { describe, expect, it, vi } from 'vitest';

import { INERT_STYLE_TAG, mirrorBlockedStyles } from '../../primitives/internal/csp-styles.ts';
import terminalCss from './Terminal.module.css?raw';
import { TERMINAL_TAB_LIMIT, TerminalApp, type TerminalSessionTab } from './TerminalApp.tsx';
import {
  TerminalHost,
  type TerminalFactory,
  type TerminalHandle,
  type TerminalLike,
  type TerminalSize,
} from './TerminalHost.tsx';
import { agentStatusText, TerminalStatusStrip, txnStatusText } from './TerminalStatusStrip.tsx';
import type { TokenResolver } from './theme.ts';

interface FakeTerminal extends TerminalLike {
  written: string[];
  /** Every options write after construction, in order. */
  optionWrites: ITerminalOptions[];
  opened: HTMLElement | undefined;
  disposed: boolean;
  /** Text `getSelection` returns ('' = nothing selected). */
  selected: string;
  pasted: string[];
  focused: number;
  fits: number;
  emitData(data: string): void;
  emitResize(size: TerminalSize): void;
}

function fakeFactory(onOpen?: (parent: HTMLElement) => void): {
  factory: TerminalFactory;
  created: FakeTerminal[];
} {
  const created: FakeTerminal[] = [];
  const factory: TerminalFactory = (initial) => {
    let options: ITerminalOptions = { ...initial };
    const dataListeners: ((d: string) => void)[] = [];
    const resizeListeners: ((s: TerminalSize) => void)[] = [];
    const size = { cols: 120, rows: 36 };
    const terminal: FakeTerminal = {
      written: [],
      optionWrites: [],
      opened: undefined,
      disposed: false,
      selected: '',
      pasted: [],
      focused: 0,
      fits: 0,
      get cols() {
        return size.cols;
      },
      get rows() {
        return size.rows;
      },
      get options() {
        return options;
      },
      set options(next: ITerminalOptions) {
        terminal.optionWrites.push(next);
        options = { ...options, ...next };
      },
      open(parent) {
        terminal.opened = parent;
        onOpen?.(parent);
      },
      write(data, callback) {
        terminal.written.push(typeof data === 'string' ? data : new TextDecoder().decode(data));
        callback?.();
      },
      onData(listener) {
        dataListeners.push(listener);
        return { dispose: () => undefined };
      },
      onResize(listener) {
        resizeListeners.push(listener);
        return { dispose: () => undefined };
      },
      onTitleChange: () => ({ dispose: () => undefined }),
      focus: () => {
        terminal.focused += 1;
      },
      clear: () => undefined,
      reset: () => undefined,
      getSelection: () => terminal.selected,
      hasSelection: () => terminal.selected !== '',
      selectAll: () => undefined,
      paste: (text) => {
        terminal.pasted.push(text);
      },
      scrollToBottom: () => undefined,
      dispose() {
        terminal.disposed = true;
      },
      emitData: (data) => dataListeners.forEach((l) => l(data)),
      emitResize: (next) => {
        size.cols = next.cols;
        size.rows = next.rows;
        resizeListeners.forEach((l) => l(next));
      },
    };
    created.push(terminal);
    return {
      terminal,
      fit: () => {
        terminal.fits += 1;
        return { cols: size.cols, rows: size.rows };
      },
    };
  };
  return { factory, created };
}

/** happy-dom lays nothing out: give every element a box while `run` runs. */
function withLayout<T>(run: () => T): T {
  const proto = HTMLElement.prototype;
  const width = Object.getOwnPropertyDescriptor(proto, 'clientWidth');
  const height = Object.getOwnPropertyDescriptor(proto, 'clientHeight');
  Object.defineProperty(proto, 'clientWidth', { configurable: true, get: () => 688 });
  Object.defineProperty(proto, 'clientHeight', { configurable: true, get: () => 420 });
  try {
    return run();
  } finally {
    if (width === undefined) Reflect.deleteProperty(proto, 'clientWidth');
    else Object.defineProperty(proto, 'clientWidth', width);
    if (height === undefined) Reflect.deleteProperty(proto, 'clientHeight');
    else Object.defineProperty(proto, 'clientHeight', height);
  }
}

const DARK_TOKENS: TokenResolver = (token) =>
  (
    ({
      '--pl-surface': 'rgb(30, 30, 38)',
      '--pl-text': 'rgba(255, 255, 255, 0.92)',
      '--pl-font-mono': "'Geist Mono Variable', monospace",
    }) as Record<string, string>
  )[token] ?? '';

describe('UI-TerminalHost', () => {
  it('UI-TerminalHost mounts xterm with the Plotinium theme, font and the §3.8.10 options', () => {
    const { factory, created } = fakeFactory();
    let handle: TerminalHandle | undefined;
    render(() => (
      <TerminalHost
        label="Terminal, student@plotinium: ~"
        createTerminal={factory}
        resolveToken={DARK_TOKENS}
        initialText="restored text"
        onReady={(h) => (handle = h)}
      />
    ));
    const region = screen.getByRole('region', { name: 'Terminal, student@plotinium: ~' });
    const terminal = created[0];
    // xterm lives in the region's unpadded inner element (UI-128).
    expect(terminal?.opened?.parentElement).toBe(region);
    expect(terminal?.options.fontFamily).toBe("'Geist Mono Variable', monospace");
    expect(terminal?.options.minimumContrastRatio).toBe(4.5);
    expect(terminal?.options.theme?.background).toBe('#1e1e26');
    expect(terminal?.written).toEqual(['restored text']);
    expect(handle?.scheme()).toBe('dark');
    expect(handle?.size()).toEqual({ cols: 120, rows: 36 });
  });

  it('UI-TerminalHost measures the cell again once the mono web font has loaded', async () => {
    let resolveLoad: (faces: FontFace[]) => void = () => undefined;
    const fonts = {
      check: vi.fn(() => false),
      load: vi.fn(
        () =>
          new Promise<FontFace[]>((resolve) => {
            resolveLoad = resolve;
          }),
      ),
    };
    const original = Object.getOwnPropertyDescriptor(document, 'fonts');
    Object.defineProperty(document, 'fonts', { configurable: true, value: fonts });
    try {
      const { factory, created } = fakeFactory();
      render(() => (
        <TerminalHost
          label="Terminal"
          createTerminal={factory}
          resolveToken={DARK_TOKENS}
          fontSize={13}
        />
      ));
      const terminal = created[0];
      expect(fonts.load).toHaveBeenCalledWith("13px 'Geist Mono Variable', monospace");
      expect(terminal?.optionWrites.some((w) => 'fontFamily' in w)).toBe(false);
      resolveLoad([{} as FontFace]);
      await Promise.resolve();
      await Promise.resolve();
      // xterm re-measures only on a changed value: an empty family, then the real one.
      const writes = terminal?.optionWrites.filter((w) => 'fontFamily' in w);
      expect(writes).toEqual([
        { fontFamily: '' },
        { fontFamily: "'Geist Mono Variable', monospace" },
      ]);
      expect(terminal?.options.fontFamily).toBe("'Geist Mono Variable', monospace");
    } finally {
      if (original === undefined) Reflect.deleteProperty(document, 'fonts');
      else Object.defineProperty(document, 'fonts', original);
    }
  });

  it('SHL-03 writes reach xterm and the parse callback acknowledges the batch', () => {
    const { factory, created } = fakeFactory();
    let handle: TerminalHandle | undefined;
    render(() => (
      <TerminalHost
        label="Terminal"
        createTerminal={factory}
        resolveToken={DARK_TOKENS}
        onReady={(h) => (handle = h)}
      />
    ));
    const ack = vi.fn();
    handle?.write('batch-1', ack);
    handle?.writeln('line');
    expect(created[0]?.written).toEqual(['batch-1', 'line\r\n']);
    expect(ack).toHaveBeenCalledOnce();
  });

  it('SHL-01 keystrokes and resizes are forwarded as intents; unmount disposes xterm', () => {
    const { factory, created } = fakeFactory();
    const onData = vi.fn();
    const onResize = vi.fn();
    const { unmount } = render(() => (
      <TerminalHost
        label="Terminal"
        createTerminal={factory}
        resolveToken={DARK_TOKENS}
        onData={onData}
        onResize={onResize}
      />
    ));
    created[0]?.emitData('ls\r');
    created[0]?.emitResize({ cols: 100, rows: 30 });
    expect(onData).toHaveBeenCalledWith('ls\r');
    expect(onResize).toHaveBeenCalledWith({ cols: 100, rows: 30 });
    unmount();
    expect(created[0]?.disposed).toBe(true);
  });

  it('DSN-05 the cursor does not blink under reduced motion', () => {
    document.documentElement.setAttribute('data-motion', 'reduce');
    const { factory, created } = fakeFactory();
    render(() => (
      <TerminalHost label="Terminal" createTerminal={factory} resolveToken={DARK_TOKENS} />
    ));
    expect(created[0]?.options.cursorBlink).toBe(false);
  });

  it('UI-020 a terminal without a layout box (a hidden tab) is never fitted, so its TTY keeps its size', () => {
    const { factory, created } = fakeFactory();
    let handle: TerminalHandle | undefined;
    render(() => (
      <TerminalHost
        label="Terminal"
        createTerminal={factory}
        resolveToken={DARK_TOKENS}
        onReady={(h) => (handle = h)}
      />
    ));
    // happy-dom has no layout, like a `display: none` panel: no fit at mount or on request.
    expect(created[0]?.fits).toBe(0);
    expect(handle?.fit()).toBeUndefined();
    expect(created[0]?.fits).toBe(0);
    // Shown again (it has a box): the fit runs.
    expect(withLayout(() => handle?.fit())).toEqual({ cols: 120, rows: 36 });
    expect(created[0]?.fits).toBe(1);
  });

  it('UI-128 xterm is opened in an unpadded element, so the fit measures the content box', () => {
    const { factory, created } = fakeFactory();
    withLayout(() =>
      render(() => (
        <TerminalHost label="Terminal" createTerminal={factory} resolveToken={DARK_TOKENS} />
      )),
    );
    const region = screen.getByRole('region', { name: 'Terminal' });
    const inner = created[0]?.opened;
    expect(inner?.parentElement).toBe(region);
    expect(created[0]?.fits).toBe(1);
    // The region carries the padding; the element xterm measures has none.
    const mountRule = /\.mount\s*\{([^}]*)\}/u.exec(terminalCss)?.[1] ?? '';
    expect(mountRule).toMatch(/width: 100%;/u);
    expect(mountRule).toMatch(/height: 100%;/u);
    expect(mountRule).not.toMatch(/padding/u);
    expect(region.firstElementChild).toBe(inner);
  });

  it('UI-050 xterm creates its styles as inert stand-ins: no <style> reaches the page, the CSS still applies', () => {
    const { factory } = fakeFactory((parent) => {
      // What xterm 6 does inside `open`: document.createElement('style') for the viewport,
      // the renderer's dimensions and its theme, appended to .xterm-screen and filled later.
      const screenEl = parent.ownerDocument.createElement('div');
      screenEl.className = 'xterm-screen';
      const theme = parent.ownerDocument.createElement('style');
      theme.textContent = '.xterm-dom-renderer-owner-3 .xterm-rows { color: rgb(1, 2, 3); }';
      screenEl.append(theme);
      parent.append(screenEl);
    });
    const before = document.adoptedStyleSheets.length;
    const { unmount } = render(() => (
      <TerminalHost label="Terminal" createTerminal={factory} resolveToken={DARK_TOKENS} />
    ));
    const region = screen.getByRole('region', { name: 'Terminal' });
    expect(region.querySelectorAll('style')).toHaveLength(0);
    const standIn = region.querySelector(INERT_STYLE_TAG);
    expect(standIn).not.toBeNull();
    expect((standIn as HTMLElement | null)?.hidden).toBe(true);
    expect(document.adoptedStyleSheets).toHaveLength(before + 1);
    expect(document.adoptedStyleSheets.at(-1)?.cssRules[0]?.cssText).toContain('rgb(1, 2, 3)');
    // Outside `open`, createElement is the document's own again.
    expect(document.createElement('style')).toBeInstanceOf(HTMLStyleElement);
    unmount();
    expect(document.adoptedStyleSheets).toHaveLength(before);
  });
});

function AppHarness(props: {
  factory: TerminalFactory;
  initial?: number;
  onData?: (id: string, d: string) => void;
}) {
  const make = (n: number): TerminalSessionTab => ({ id: `t${n}`, label: `zsh-like shell — ${n}` });
  const [sessions, setSessions] = createSignal<TerminalSessionTab[]>(
    Array.from({ length: props.initial ?? 1 }, (_, i) => make(i + 1)),
  );
  const [selected, setSelected] = createSignal('t1');
  return (
    <TerminalApp
      title="student@plotinium: ~"
      sessions={sessions()}
      selected={selected()}
      onSelect={setSelected}
      onNew={() => {
        const next = make(sessions().length + 1);
        setSessions([...sessions(), next]);
        setSelected(next.id);
      }}
      onClose={(id) => {
        // As apps/terminal's controller does: the neighbour takes the closed tab's place.
        const list = sessions();
        const i = list.findIndex((s) => s.id === id);
        const rest = list.filter((s) => s.id !== id);
        setSessions(rest);
        if (selected() === id) setSelected(rest[Math.min(i, rest.length - 1)]?.id ?? '');
      }}
      cwd="/home/student"
      agent={{ state: 'running', pid: 212, route: 'Claude via gateway' }}
      txn={{ id: '8f2c', state: 'committed' }}
      createTerminal={props.factory}
      resolveToken={DARK_TOKENS}
      onData={props.onData}
    />
  );
}

describe('UI-TerminalApp', () => {
  it('UI-TerminalApp renders tabs, a tabpanel per window and the status strip', () => {
    const { factory } = fakeFactory();
    render(() => <AppHarness factory={factory} initial={2} />);
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.getAttribute('aria-label'))).toEqual([
      'zsh-like shell — 1',
      'zsh-like shell — 2',
    ]);
    expect(tabs[0]?.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tabpanel')).toBeTruthy();
    expect(screen.getByText('ai.agent pid 212 · Claude via gateway')).toBeTruthy();
    expect(screen.getByText('txn 8f2c committed')).toBeTruthy();
    expect(screen.getByText('UTF-8 · zsh-like · 120×36 · /home/student')).toBeTruthy();
  });

  it('UI-022 Alt+Shift+N opens a tab and Alt+Shift+W closes it before xterm sees the keys', () => {
    const { factory } = fakeFactory();
    render(() => <AppHarness factory={factory} />);
    const region = screen.getByRole('region', { name: 'Terminal, student@plotinium: ~' });
    const opened = fireEvent.keyDown(region, { code: 'KeyN', altKey: true, shiftKey: true });
    expect(opened).toBe(false);
    expect(screen.getAllByRole('tab')).toHaveLength(2);
    fireEvent.keyDown(region, { code: 'KeyW', altKey: true, shiftKey: true });
    expect(screen.getAllByRole('tab')).toHaveLength(1);
  });

  it('UI-022 the Chrome-reserved tab keys are not the Terminal’s: they reach xterm untouched', () => {
    const { factory } = fakeFactory();
    render(() => <AppHarness factory={factory} initial={2} />);
    const region = screen.getByRole('region', { name: 'Terminal, student@plotinium: ~' });
    for (const ev of [
      { code: 'KeyT', key: 'T', ctrlKey: true, shiftKey: true },
      { code: 'KeyW', key: 'W', ctrlKey: true, shiftKey: true },
      { code: 'PageDown', key: 'PageDown', ctrlKey: true },
      { code: 'Tab', key: 'Tab', ctrlKey: true },
    ]) {
      expect(fireEvent.keyDown(region, ev)).toBe(true);
    }
    expect(screen.getAllByRole('tab')).toHaveLength(2);
    expect(screen.getAllByRole('tab')[0]?.getAttribute('aria-selected')).toBe('true');
  });

  it('UI-022 Alt+Shift+] and Alt+Shift+[ switch tabs and focus the new terminal', async () => {
    const { factory, created } = fakeFactory();
    render(() => <AppHarness factory={factory} initial={3} />);
    const region = screen.getAllByRole('region', { name: 'Terminal, student@plotinium: ~' })[0];
    if (region === undefined) throw new Error('no terminal');
    fireEvent.keyDown(region, { code: 'BracketRight', altKey: true, shiftKey: true });
    expect(screen.getAllByRole('tab')[1]?.getAttribute('aria-selected')).toBe('true');
    await Promise.resolve();
    expect(created[1]?.focused).toBeGreaterThan(0);
    fireEvent.keyDown(region, { code: 'BracketLeft', altKey: true, shiftKey: true });
    fireEvent.keyDown(region, { code: 'BracketLeft', altKey: true, shiftKey: true });
    expect(screen.getAllByRole('tab')[2]?.getAttribute('aria-selected')).toBe('true');
  });

  it('UI-021 closing the selected tab puts the focus into the terminal of the tab that replaces it', async () => {
    const { factory, created } = fakeFactory();
    render(() => <AppHarness factory={factory} initial={3} />);
    const before = created[1]?.focused ?? 0;
    // The × button of the selected tab: the focus was on it, and it goes away with the tab.
    const region = screen.getAllByRole('region', { name: 'Terminal, student@plotinium: ~' })[0];
    if (region === undefined) throw new Error('no terminal');
    fireEvent.keyDown(region, { code: 'KeyW', altKey: true, shiftKey: true });
    expect(screen.getAllByRole('tab')).toHaveLength(2);
    await Promise.resolve();
    expect(created[1]?.focused).toBe(before + 1);
  });

  it('UI-126 Ctrl+Shift+C copies the selection, and Ctrl+V is kept from xterm for the browser paste', () => {
    const { factory, created } = fakeFactory();
    const onCopy = vi.fn();
    render(() => (
      <TerminalApp
        title="student@plotinium: ~"
        sessions={[{ id: 't1', label: 'sh 1 — ~' }]}
        selected="t1"
        onSelect={() => undefined}
        cwd="/home/student"
        createTerminal={factory}
        resolveToken={DARK_TOKENS}
        onCopy={onCopy}
      />
    ));
    const region = screen.getByRole('region', { name: 'Terminal, student@plotinium: ~' });
    // Nothing selected: the chord is still the Terminal's (no ^C), and nothing is copied.
    expect(fireEvent.keyDown(region, { code: 'KeyC', ctrlKey: true, shiftKey: true })).toBe(false);
    expect(onCopy).not.toHaveBeenCalled();
    const terminal = created[0];
    if (terminal === undefined) throw new Error('no terminal');
    terminal.selected = 'drwxr-xr-x  2 alice';
    fireEvent.keyDown(region, { code: 'KeyC', ctrlKey: true, shiftKey: true });
    expect(onCopy).toHaveBeenCalledWith('drwxr-xr-x  2 alice');

    // Ctrl+V: not cancelled (the browser pastes) but xterm's own listener never sees it.
    const inner = terminal.opened;
    if (inner === undefined) throw new Error('not opened');
    const xtermSaw = vi.fn();
    inner.addEventListener('keydown', xtermSaw);
    expect(fireEvent.keyDown(inner, { code: 'KeyV', key: 'v', ctrlKey: true })).toBe(true);
    expect(xtermSaw).not.toHaveBeenCalled();
    // Plain Ctrl+C is still the interrupt key and goes to xterm.
    fireEvent.keyDown(inner, { code: 'KeyC', key: 'c', ctrlKey: true });
    expect(xtermSaw).toHaveBeenCalledOnce();
  });

  it('UI-TerminalApp arrow keys move between tabs and Delete closes the focused tab', () => {
    const { factory } = fakeFactory();
    render(() => <AppHarness factory={factory} initial={3} />);
    const first = screen.getAllByRole('tab')[0];
    if (first === undefined) throw new Error('no tab');
    fireEvent.keyDown(first, { key: 'ArrowRight' });
    expect(screen.getAllByRole('tab')[1]?.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(first, { key: 'End' });
    expect(screen.getAllByRole('tab')[2]?.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(first, { key: 'Delete' });
    expect(screen.getAllByRole('tab')).toHaveLength(2);
  });

  it(`UI-TerminalApp "+" is disabled with a reason at ${TERMINAL_TAB_LIMIT} tabs`, () => {
    const { factory } = fakeFactory();
    render(() => <AppHarness factory={factory} initial={TERMINAL_TAB_LIMIT} />);
    const add = screen.getByRole('button', { name: 'New tab' });
    expect(add.getAttribute('aria-disabled')).toBe('true');
    expect(add.getAttribute('title')).toBe('Tab limit reached');
    fireEvent.click(add);
    expect(screen.getAllByRole('tab')).toHaveLength(TERMINAL_TAB_LIMIT);
  });

  it('SHL-01 keystrokes are routed with the id of the session they belong to', () => {
    const { factory, created } = fakeFactory();
    const onData = vi.fn();
    render(() => <AppHarness factory={factory} initial={2} onData={onData} />);
    created[1]?.emitData('x');
    expect(onData).toHaveBeenCalledWith('t2', 'x');
  });
});

describe('UI-TerminalStatusStrip', () => {
  it('DSN-08 every agent state is in words, not only in the dot colour', () => {
    expect(agentStatusText({ state: 'running', pid: 212, route: 'Claude via gateway' })).toBe(
      'ai.agent pid 212 · Claude via gateway',
    );
    expect(agentStatusText({ state: 'waiting', pid: 212, on: 'net:llm' })).toBe(
      'ai.agent pid 212 · waiting on net:llm',
    );
    expect(agentStatusText({ state: 'idle' })).toBe('ai.agent idle');
    expect(agentStatusText({ state: 'unavailable' })).toBe('AI unavailable · plain shell');
    expect(txnStatusText({ id: '8f2c', state: 'rejected' })).toBe('txn 8f2c · rejected on sync');
  });

  it('UI-TerminalStatusStrip announces changes politely and activates its items', () => {
    const onAgent = vi.fn();
    const onTxn = vi.fn();
    render(() => (
      <TerminalStatusStrip
        agent={{ state: 'waiting', pid: 212, on: 'net:llm' }}
        txn={{ id: '8f2c', state: 'syncing' }}
        cols={120}
        rows={36}
        cwd="/home/student"
        onAgentActivate={onAgent}
        onTxnActivate={onTxn}
      />
    ));
    const regions = screen.getAllByRole('status');
    expect(regions.every((r) => r.getAttribute('aria-live') === 'polite')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'ai.agent pid 212 · waiting on net:llm' }));
    fireEvent.click(screen.getByRole('button', { name: 'txn 8f2c · syncing' }));
    expect(onAgent).toHaveBeenCalledOnce();
    expect(onTxn).toHaveBeenCalledWith('8f2c');
  });
});

describe('UI-TerminalStyles', () => {
  it('UI-TerminalStyles the viewport is transparent, so no black bar shows below the last row', () => {
    // xterm.css paints .xterm-viewport #000; the fitted rows leave a strip of it uncovered.
    expect(terminalCss).toMatch(
      /:global\(\.xterm \.xterm-viewport\)\s*\{\s*background-color: transparent;/u,
    );
  });

  it('UI-TerminalStyles the host adopts the xterm styles the CSP refused and releases them on unmount', () => {
    // What xterm's DOM renderer does at open: <style> elements inside .xterm-screen. Under the
    // production CSP the browser gives them no sheet; one allowed element stays native.
    const refused = document.createElement('style');
    refused.textContent =
      '.xterm-dom-renderer-owner-9 .xterm-rows { font-family: "Geist Mono Variable"; }';
    Object.defineProperty(refused, 'sheet', { configurable: true, get: () => null });
    const allowed = document.createElement('style');
    allowed.textContent = '.xterm-dom-renderer-owner-9 .xterm-rows span { height: 100%; }';
    const { factory } = fakeFactory((parent) => {
      const screenEl = document.createElement('div');
      screenEl.className = 'xterm-screen';
      screenEl.append(refused, allowed);
      parent.append(screenEl);
    });
    const before = document.adoptedStyleSheets.length;
    const { unmount } = render(() => (
      <TerminalHost label="Terminal" createTerminal={factory} resolveToken={DARK_TOKENS} />
    ));
    expect(document.adoptedStyleSheets).toHaveLength(before + 1);
    const rules = [...(document.adoptedStyleSheets.at(-1)?.cssRules ?? [])].map((r) => r.cssText);
    expect(rules.join('\n')).toContain('Geist Mono Variable');
    expect(rules.join('\n')).not.toContain('height: 100%');
    unmount();
    expect(document.adoptedStyleSheets).toHaveLength(before);
  });

  const stage = (): { root: HTMLElement; screen: HTMLElement; style: HTMLStyleElement } => {
    const root = document.createElement('div');
    const screen = document.createElement('div');
    screen.className = 'xterm-screen';
    const style = document.createElement('style');
    style.textContent = '.owner-1 .xterm-rows { font-family: "Geist Mono Variable"; }';
    screen.append(style);
    root.append(screen);
    document.body.append(root);
    return { root, screen, style };
  };

  it('UI-TerminalStyles mirrors CSP-blocked xterm styles into adopted sheets and keeps them in step', async () => {
    const { root, screen, style } = stage();
    const before = document.adoptedStyleSheets.length;
    const dispose = mirrorBlockedStyles(root, () => true);
    expect(document.adoptedStyleSheets).toHaveLength(before + 1);
    const sheet = document.adoptedStyleSheets.at(-1);
    expect(sheet?.cssRules[0]?.cssText).toContain('Geist Mono Variable');

    // xterm rewrites its theme and dimensions by assigning textContent.
    style.textContent = '.owner-1 .xterm-fg-1 { color: rgb(255, 105, 97); }';
    await vi.waitFor(() => expect(sheet?.cssRules[0]?.cssText).toContain('xterm-fg-1'));

    // A style element added later is mirrored; a removed one is dropped.
    const extra = document.createElement('style');
    extra.textContent = '.owner-1 .xterm-rows span { height: 20px; }';
    screen.append(extra);
    await vi.waitFor(() => expect(document.adoptedStyleSheets).toHaveLength(before + 2));
    extra.remove();
    await vi.waitFor(() => expect(document.adoptedStyleSheets).toHaveLength(before + 1));

    dispose();
    expect(document.adoptedStyleSheets).toHaveLength(before);
    root.remove();
  });

  it('UI-TerminalStyles leaves style elements the CSP allowed alone', () => {
    const { root } = stage();
    const before = document.adoptedStyleSheets.length;
    const dispose = mirrorBlockedStyles(root, () => false);
    expect(document.adoptedStyleSheets).toHaveLength(before);
    dispose();
    root.remove();
  });
});
