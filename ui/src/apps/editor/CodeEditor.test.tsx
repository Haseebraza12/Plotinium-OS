import { render, screen } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import { describe, expect, it, vi } from 'vitest';

import { CodeEditor, type CodeEditorHandle } from './CodeEditor.tsx';
import { classForTag, plotiniumHighlighter, SYNTAX_CLASSES } from './theme.ts';

const DOC = '## 4. Sync and conflicts\n\nA lock is a **lease**: `alice` holds it.\n';

describe('UI-CodeEditor', () => {
  it('UI-CodeEditor mounts CodeMirror as a labelled multi-line textbox with line numbers', () => {
    render(() => <CodeEditor doc={DOC} language="markdown" label="os-report.md" />);
    const box = screen.getByRole('textbox', { name: 'os-report.md' });
    expect(box.getAttribute('aria-multiline')).toBe('true');
    expect(box.getAttribute('aria-readonly')).toBe('false');
    expect(box.textContent).toContain('Sync and conflicts');
    expect(document.querySelector('.cm-lineNumbers')).not.toBeNull();
  });

  it('VFS-09 read-only mode refuses edits and reports the attempt', () => {
    const onChange = vi.fn();
    const onAttempt = vi.fn();
    let handle: CodeEditorHandle | undefined;
    render(() => (
      <CodeEditor
        doc={DOC}
        readOnly
        label="os-report.md"
        onChange={onChange}
        onReadOnlyAttempt={onAttempt}
        onReady={(h) => (handle = h)}
      />
    ));
    const box = screen.getByRole('textbox', { name: 'os-report.md' });
    expect(box.getAttribute('aria-readonly')).toBe('true');
    expect(box.closest('.cm-editor')?.classList.contains('pl-readonly')).toBe(true);
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true }));
    expect(onAttempt).toHaveBeenCalledOnce();
    expect(handle?.doc()).toBe(DOC);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('UI-CodeEditor reports the caret as 1-based line and column and replaces the doc on reload', () => {
    const onCursor = vi.fn();
    const [doc, setDoc] = createSignal(DOC);
    let handle: CodeEditorHandle | undefined;
    render(() => (
      <CodeEditor doc={doc()} label="notes" onCursor={onCursor} onReady={(h) => (handle = h)} />
    ));
    handle?.goTo(3, 7);
    expect(onCursor).toHaveBeenLastCalledWith({ line: 3, col: 7 });
    setDoc('reloaded\n');
    expect(handle?.doc()).toBe('reloaded\n');
    handle?.goTo(99);
    expect(onCursor).toHaveBeenLastCalledWith({ line: 2, col: 1 });
  });

  it('DSN-13 the highlighter maps tags to token classes, most specific first', () => {
    expect(plotiniumHighlighter.style([])).toBeNull();
    expect(SYNTAX_CLASSES.heading).toBeDefined();
    const fakeTag = (names: string[]) =>
      ({
        set: names.map((name) => ({ toString: () => name })),
      }) as unknown as Parameters<typeof classForTag>[0];
    expect(classForTag(fakeTag(['heading1', 'heading']))).toBe(SYNTAX_CLASSES.heading);
    expect(classForTag(fakeTag(['function(variableName)', 'variableName']))).toBe(
      SYNTAX_CLASSES['function(variableName)'],
    );
    expect(classForTag(fakeTag(['unknownTag']))).toBeUndefined();
  });

  it('UI-CodeEditor renders Markdown with syntax classes from the Plotinium highlighter', () => {
    render(() => <CodeEditor doc={DOC} language="markdown" label="md" />);
    const heading = SYNTAX_CLASSES.heading ?? '';
    const strong = SYNTAX_CLASSES.strong ?? '';
    expect(document.querySelector(`.cm-content .${CSS.escape(heading)}`)).not.toBeNull();
    const strongText = [...document.querySelectorAll(`.cm-content .${CSS.escape(strong)}`)]
      .map((el) => el.textContent)
      .join('');
    expect(strongText).toBe('**lease**');
  });
});
