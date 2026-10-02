/**
 * Editor presentation fixes of the polish wave (docs/design/bug-hunt/BUGS.md, fix-files-editor):
 * UI-100 (Save As chord), UI-103 (focus after "+ New tab"), UI-116 (the selected tab in view,
 * the bell's name), UI-117 (no "synced" without sync).
 */
import { fireEvent, render, screen } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import { describe, expect, it, vi } from 'vitest';

import { CodeEditor } from './CodeEditor.tsx';
import { DocumentTabs, tabAccessibleName, type DocumentTab } from './DocumentTabs.tsx';
import { EditorStatusBar, syncText } from './EditorStatusBar.tsx';

const TABS: DocumentTab[] = Array.from({ length: 8 }, (_, i) => ({
  id: `t${String(i)}`,
  label: `file-${String(i)}.md`,
}));

describe('UI-100 Save As chord', () => {
  it('UI-100 Ctrl+Shift+S is Save As in the editor, and Ctrl+S is still Save', () => {
    const onSave = vi.fn();
    const onSaveAs = vi.fn();
    render(() => <CodeEditor doc="text" label="a.md" onSave={onSave} onSaveAs={onSaveAs} />);
    const box = screen.getByRole('textbox', { name: 'a.md' });
    const chord = (shiftKey: boolean): KeyboardEvent => {
      const ev = new KeyboardEvent('keydown', {
        key: shiftKey ? 'S' : 's',
        code: 'KeyS',
        keyCode: 83,
        ctrlKey: true,
        shiftKey,
        bubbles: true,
        cancelable: true,
      });
      box.dispatchEvent(ev);
      return ev;
    };
    expect(chord(true).defaultPrevented).toBe(true);
    expect(onSaveAs).toHaveBeenCalledOnce();
    expect(onSave).not.toHaveBeenCalled();
    chord(false);
    expect(onSave).toHaveBeenCalledOnce();
    expect(onSaveAs).toHaveBeenCalledOnce();
  });
});

describe('UI-103 and UI-116 document tabs', () => {
  it('UI-103 after "+ New tab" focus moves to the new tab, not left on "+"', async () => {
    const [tabs, setTabs] = createSignal<DocumentTab[]>(TABS.slice(0, 2));
    const [selected, setSelected] = createSignal('t0');
    render(() => (
      <DocumentTabs
        label="Open files"
        tabs={tabs()}
        selected={selected()}
        onSelect={setSelected}
        onNew={() => {
          setTabs([...tabs(), { id: 'new', label: 'Untitled' }]);
          setSelected('new');
        }}
      />
    ));
    const plus = screen.getByRole('button', { name: 'New tab' });
    plus.focus();
    fireEvent.click(plus);
    await Promise.resolve();
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Untitled' }));
    // A Space now acts on the tab (selection), not on "+": still one new tab.
    fireEvent.keyDown(document.activeElement as Element, { key: ' ' });
    expect(screen.getAllByRole('tab')).toHaveLength(3);
  });

  it('UI-103 a host that focuses the new document keeps that focus', async () => {
    const outside = document.createElement('textarea');
    document.body.append(outside);
    render(() => (
      <DocumentTabs
        label="Open files"
        tabs={TABS.slice(0, 2)}
        selected="t0"
        onSelect={() => undefined}
        onNew={() => outside.focus()}
      />
    ));
    const plus = screen.getByRole('button', { name: 'New tab' });
    plus.focus();
    fireEvent.click(plus);
    await Promise.resolve();
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  it('UI-116 the selected tab is scrolled into view in the strip', async () => {
    const [selected, setSelected] = createSignal('t0');
    render(() => (
      <DocumentTabs
        label="Terminal tabs"
        tabs={TABS}
        selected={selected()}
        onSelect={setSelected}
      />
    ));
    const list = screen.getByRole('tablist');
    // happy-dom has no layout: a 300 px strip, each tab 120 px wide at 120 × its index.
    Object.defineProperty(list, 'clientWidth', { configurable: true, value: 300 });
    screen.getAllByRole('tab').forEach((tab, i) => {
      Object.defineProperty(tab, 'offsetLeft', { configurable: true, value: i * 120 });
      Object.defineProperty(tab, 'offsetWidth', { configurable: true, value: 120 });
    });
    setSelected('t7');
    await Promise.resolve();
    // Tab 7 spans 840–960: the strip scrolls just far enough to show its right edge.
    expect(list.scrollLeft).toBe(660);
    setSelected('t1');
    await Promise.resolve();
    expect(list.scrollLeft).toBe(120);
  });

  it('UI-116 a background bell is named "bell", not "command failed"', () => {
    expect(tabAccessibleName({ id: 'a', label: 'bash', activity: 'bell' })).toBe('bash, bell');
  });
});

describe('UI-117 sync state', () => {
  it('UI-117 the status bar says "local only" while saves cannot reach the server', () => {
    expect(syncText({ kind: 'local' })).toBe('local only');
    render(() => (
      <EditorStatusBar
        line={1}
        col={1}
        language="Markdown"
        save={{ kind: 'saved', version: 3 }}
        sync={{ kind: 'local' }}
      />
    ));
    const bar = screen.getByRole('contentinfo');
    expect(bar.textContent).toContain('local only');
    expect(bar.textContent).not.toContain('synced');
    expect(bar.querySelector('[data-sync="local"]')).not.toBeNull();
  });
});

describe('VFS-09 Editor surface test id (tests/e2e/SELECTORS.md)', () => {
  it('VFS-09 the text surface is [data-testid="editor"] and carries aria-readonly', () => {
    const [ro, setRo] = createSignal(false);
    render(() => <CodeEditor doc="text" label="plan.md" readOnly={ro()} />);
    const surface = screen.getByTestId('editor');
    expect(surface).toBe(screen.getByRole('textbox', { name: 'plan.md' }));
    expect(surface.getAttribute('aria-readonly')).toBe('false');
    setRo(true);
    expect(screen.getByTestId('editor').getAttribute('aria-readonly')).toBe('true');
  });
});

describe('UI-018 Editor focus target', () => {
  it("UI-018 the text surface is the window manager's data-autofocus target", () => {
    const { container } = render(() => <CodeEditor doc="text" label="a.md" />);
    const marked = container.querySelectorAll('[data-autofocus]');
    expect(marked).toHaveLength(1);
    expect(marked[0]).toBe(screen.getByRole('textbox', { name: 'a.md' }));
  });
});
