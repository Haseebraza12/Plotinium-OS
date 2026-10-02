import { render } from '@solidjs/testing-library';
import { describe, expect, it } from 'vitest';

import { TerminalApp } from './TerminalApp.tsx';
import type { TerminalFactory } from './TerminalHost.tsx';

/** The smallest terminal double: the host only needs it to exist. */
const quiet: TerminalFactory = (options) => {
  let opts = { ...options };
  const none = { dispose: () => undefined };
  return {
    terminal: {
      cols: 80,
      rows: 24,
      get options() {
        return opts;
      },
      set options(next) {
        opts = { ...opts, ...next };
      },
      open: () => undefined,
      write: () => undefined,
      onData: () => none,
      onResize: () => none,
      onTitleChange: () => none,
      focus: () => undefined,
      clear: () => undefined,
      reset: () => undefined,
      getSelection: () => '',
      hasSelection: () => false,
      selectAll: () => undefined,
      paste: () => undefined,
      scrollToBottom: () => undefined,
      dispose: () => undefined,
    },
    fit: () => undefined,
  };
};

describe('UI-131 the Terminal keeps the e2e selector contract', () => {
  it('UI-131 each tab’s xterm host is data-testid="terminal" (tests/e2e/SELECTORS.md §1)', () => {
    render(() => (
      <TerminalApp
        sessions={[
          { id: 'a', label: 'sh 1 — ~' },
          { id: 'b', label: 'sh 2 — ~' },
        ]}
        selected="b"
        onSelect={() => undefined}
        title="demo@plotinium: ~"
        cwd="~"
        createTerminal={quiet}
        resolveToken={() => ''}
      />
    ));
    const hosts = [...document.querySelectorAll('[data-testid="terminal"]')];
    expect(hosts).toHaveLength(2);
    expect(hosts.every((h) => h.getAttribute('role') === 'region')).toBe(true);
    // Only the selected tab's host is shown.
    expect(hosts.filter((h) => h.closest('[hidden]') === null)).toHaveLength(1);
  });
});
