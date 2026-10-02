import { render } from '@solidjs/testing-library';
import { describe, expect, it } from 'vitest';

import { TerminalApp } from './TerminalApp.tsx';
import {
  bufferLines,
  type BufferLike,
  type TerminalFactory,
  type TerminalHandle,
  type TerminalLike,
} from './TerminalHost.tsx';
import type { TokenResolver } from './theme.ts';

/** An xterm buffer of fixed rows, as `IBuffer` answers `length` and `getLine`. */
function buffer(rows: readonly string[]): BufferLike {
  return {
    length: rows.length,
    getLine: (y) =>
      y < 0 || y >= rows.length
        ? undefined
        : { translateToString: (trim) => (trim === true ? (rows[y] ?? '').trimEnd() : rows[y]!) },
  };
}

const TOKENS: TokenResolver = (token) =>
  token === '--pl-font-mono' ? "'JetBrains Mono Variable', monospace" : '';

/** A terminal double: records writes, and answers `lines` from `rows` when given. */
function factory(rows: readonly string[] | undefined, written: string[]): TerminalFactory {
  return (options) => {
    let opts = { ...options };
    const terminal: TerminalLike = {
      cols: 80,
      rows: 24,
      get options() {
        return opts;
      },
      set options(next) {
        opts = { ...opts, ...next };
      },
      open: () => undefined,
      write: (data) => {
        written.push(typeof data === 'string' ? data : new TextDecoder().decode(data));
      },
      onData: () => ({ dispose: () => undefined }),
      onResize: () => ({ dispose: () => undefined }),
      onTitleChange: () => ({ dispose: () => undefined }),
      focus: () => undefined,
      clear: () => undefined,
      reset: () => undefined,
      getSelection: () => '',
      hasSelection: () => false,
      selectAll: () => undefined,
      paste: () => undefined,
      scrollToBottom: () => undefined,
      dispose: () => undefined,
      ...(rows === undefined ? {} : { lines: (max: number) => bufferLines(buffer(rows), max) }),
    };
    return { terminal, fit: () => undefined };
  };
}

describe('UI-127 terminal text for the window snapshot', () => {
  it('UI-127 bufferLines gives the last lines up to the last written row, right-trimmed', () => {
    const rows = ['one  ', 'two', '', 'three', '   ', ''];
    expect(bufferLines(buffer(rows), 10)).toEqual(['one', 'two', '', 'three']);
    expect(bufferLines(buffer(rows), 2)).toEqual(['', 'three']);
    expect(bufferLines(buffer(rows), 0)).toEqual([]);
    expect(bufferLines(buffer(['', '']), 5)).toEqual([]);
  });

  it('UI-127 a restored tab writes its saved text first, and the handle reads the screen back', () => {
    const written: string[] = [];
    let handle: TerminalHandle | undefined;
    render(() => (
      <TerminalApp
        sessions={[{ id: 'a', label: 'sh 1 — /tmp', initialText: 'old output\r\n' }]}
        selected="a"
        onSelect={() => undefined}
        title="demo@plotinium: /tmp"
        cwd="/tmp"
        createTerminal={factory(['old output', 'demo@plotinium:/tmp$ ', ''], written)}
        resolveToken={TOKENS}
        onReady={(_id, h) => (handle = h)}
      />
    ));
    expect(written[0]).toBe('old output\r\n');
    expect(handle?.lines(100)).toEqual(['old output', 'demo@plotinium:/tmp$']);
  });

  it('UI-127 a terminal that cannot read its buffer gives an empty snapshot', () => {
    let handle: TerminalHandle | undefined;
    render(() => (
      <TerminalApp
        sessions={[{ id: 'a', label: 'sh 1 — ~' }]}
        selected="a"
        onSelect={() => undefined}
        title="demo@plotinium: ~"
        cwd="~"
        createTerminal={factory(undefined, [])}
        resolveToken={TOKENS}
        onReady={(_id, h) => (handle = h)}
      />
    ));
    expect(handle?.lines(100)).toEqual([]);
  });
});

describe('UI-127 the real xterm buffer', () => {
  it('UI-127 createXterm reads the main screen, not the alternate one of a full-screen program', async () => {
    const { createXterm } = await import('./TerminalHost.tsx');
    const { terminal } = createXterm({ allowProposedApi: false });
    const write = (data: string): Promise<void> =>
      new Promise((resolve) => terminal.write(data, resolve));
    await write('first\r\nsecond\r\n$ ');
    // `top` switches to the alternate screen: the snapshot keeps the shell's text. (A space
    // the program wrote is text; only never-written cells are trimmed.)
    await write('\x1b[?1049hTOP FRAME');
    expect(terminal.lines?.(10)).toEqual(['first', 'second', '$ ']);
    expect(terminal.lines?.(1)).toEqual(['$ ']);
    terminal.dispose();
  });
});
