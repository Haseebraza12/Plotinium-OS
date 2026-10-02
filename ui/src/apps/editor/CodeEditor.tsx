import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { javascript, javascriptLanguage, typescriptLanguage } from '@codemirror/lang-javascript';
import { markdown } from '@codemirror/lang-markdown';
import { bracketMatching, indentOnInput, syntaxHighlighting } from '@codemirror/language';
import { Compartment, EditorSelection, EditorState, type Extension } from '@codemirror/state';
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  placeholder,
  type ViewUpdate,
} from '@codemirror/view';
import { createEffect, on, onCleanup, onMount, splitProps, type JSX } from 'solid-js';

import { mirrorBlockedHeadStyles, withInertStyles } from '../../primitives/internal/csp-styles.ts';
import { cx } from '../../primitives/internal/cx.ts';
import { prefersReducedMotion } from '../../primitives/internal/motion.ts';
import styles from './CodeEditor.module.css';
import { plotiniumEditorTheme, plotiniumHighlighter } from './theme.ts';

export type EditorLanguage = 'markdown' | 'javascript' | 'typescript' | 'plain';

/** 1-based line and column, as the status bar shows them. */
export interface CursorPosition {
  line: number;
  col: number;
}

export interface CodeEditorHandle {
  focus(): void;
  doc(): string;
  /** Replaces the document (a reload), keeping the caret where it can. */
  setDoc(doc: string): void;
  /** Moves the caret to a 1-based line (and column) and scrolls it into view. */
  goTo(line: number, col?: number): void;
  /** Viewport rectangle of the caret, for anchoring a hint. */
  caretRect(): { left: number; top: number; bottom: number } | undefined;
}

export interface CodeEditorProps {
  /** The document. A new value that differs from the buffer replaces it (reload). */
  doc: string;
  language?: EditorLanguage;
  /** Locked by another user or not writable (VFS-09): the buffer cannot change. */
  readOnly?: boolean;
  /** Accessible name of the text area, e.g. the file name. */
  label: string;
  placeholder?: string;
  /** Initial caret, 1-based. */
  cursor?: CursorPosition;
  lineWrapping?: boolean;
  /** Theme defaults for CodeMirror's base theme; colours always come from tokens. */
  scheme?: 'light' | 'dark';
  onChange?: (doc: string) => void;
  onCursor?: (position: CursorPosition) => void;
  /** A key that would edit was pressed while read-only (show "Locked by …"). */
  onReadOnlyAttempt?: () => void;
  /** Ctrl+S / Cmd+S. */
  onSave?: () => void;
  /** Ctrl+Shift+S / Cmd+Shift+S (Save As); without it the chord is left to the host. */
  onSaveAs?: () => void;
  onReady?: (handle: CodeEditorHandle) => void;
  class?: string;
}

function languageExtension(language: EditorLanguage | undefined): Extension {
  switch (language) {
    case 'markdown':
      return markdown({
        codeLanguages: (info) => {
          const name = info.trim().toLowerCase();
          if (name === 'ts' || name === 'typescript') return typescriptLanguage;
          if (name === 'js' || name === 'javascript') return javascriptLanguage;
          return null;
        },
      });
    case 'javascript':
      return javascript();
    case 'typescript':
      return javascript({ typescript: true });
    case 'plain':
    case undefined:
      return [];
  }
}

/** Printable input and editing keys: what a read-only buffer refuses. */
function isEditKey(event: KeyboardEvent): boolean {
  if (event.ctrlKey || event.metaKey || event.altKey) return false;
  return (
    event.key.length === 1 ||
    event.key === 'Backspace' ||
    event.key === 'Delete' ||
    event.key === 'Enter'
  );
}

function detectScheme(el: Element): 'light' | 'dark' {
  const scoped = el.closest('[data-theme]')?.getAttribute('data-theme');
  if (scoped === 'light' || scoped === 'dark') return scoped;
  return typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

/**
 * CodeMirror 6 in a Solid component: Plotinium theme in both modes, Markdown (with TS/JS
 * fenced code) and JavaScript/TypeScript, history, bracket matching, and read-only mode for a
 * lock held by someone else. Tab is not bound, so keyboard focus is never trapped (WCAG 2.1.2).
 * The caret does not blink under reduced motion.
 */
export function CodeEditor(props: CodeEditorProps): JSX.Element {
  const [local] = splitProps(props, [
    'doc',
    'language',
    'readOnly',
    'label',
    'placeholder',
    'cursor',
    'lineWrapping',
    'scheme',
    'onChange',
    'onCursor',
    'onReadOnlyAttempt',
    'onSave',
    'onSaveAs',
    'onReady',
    'class',
  ]);
  let host: HTMLDivElement | undefined;
  let view: EditorView | undefined;
  const languageSlot = new Compartment();
  const readOnlySlot = new Compartment();
  const themeSlot = new Compartment();
  const wrapSlot = new Compartment();
  const labelSlot = new Compartment();

  const readOnlyExtensions = (readOnly: boolean): Extension => [
    EditorState.readOnly.of(readOnly),
    EditorView.editorAttributes.of(readOnly ? { class: 'pl-readonly' } : {}),
  ];
  const labelExtension = (label: string, readOnly: boolean): Extension =>
    EditorView.contentAttributes.of({
      tabindex: '0',
      // A launched or refocused Editor window puts focus in the text (UI-018, wm focusInto).
      'data-autofocus': '',
      // The e2e contract's Editor surface, whose aria-readonly the lock tests read (SELECTORS.md).
      'data-testid': 'editor',
      'aria-label': label,
      'aria-multiline': 'true',
      'aria-readonly': readOnly ? 'true' : 'false',
    });

  const clampPosition = (state: EditorState, line: number, col = 1): number => {
    const target = state.doc.line(Math.min(Math.max(1, line), state.doc.lines));
    return target.from + Math.min(Math.max(0, col - 1), target.length);
  };

  const replaceDoc = (doc: string): void => {
    const current = view;
    if (current === undefined || current.state.doc.toString() === doc) return;
    const head = Math.min(current.state.selection.main.head, doc.length);
    current.dispatch({
      changes: { from: 0, to: current.state.doc.length, insert: doc },
      selection: { anchor: head },
    });
  };

  onMount(() => {
    if (host === undefined) return;
    const readOnly = local.readOnly === true;
    // Handlers read the latest props when CodeMirror calls them.
    const handlers = {
      onUpdate: (update: ViewUpdate): void => {
        if (update.docChanged) local.onChange?.(update.state.doc.toString());
        if (update.docChanged || update.selectionSet) {
          const head = update.state.selection.main.head;
          const line = update.state.doc.lineAt(head);
          local.onCursor?.({ line: line.number, col: head - line.from + 1 });
        }
      },
      onKeyDown: (event: KeyboardEvent): boolean => {
        if (local.readOnly === true && isEditKey(event)) local.onReadOnlyAttempt?.();
        return false;
      },
      onPaste: (): boolean => {
        if (local.readOnly === true) local.onReadOnlyAttempt?.();
        return false;
      },
      onSaveKey: (): boolean => {
        local.onSave?.();
        return true;
      },
      // Bound before Mod-s so the Shift chord is never taken for Save (UI-100).
      onSaveAsKey: (): boolean => {
        if (local.onSaveAs === undefined) return false;
        local.onSaveAs();
        return true;
      },
    };
    const state = EditorState.create({
      doc: local.doc,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightSpecialChars(),
        history(),
        drawSelection({ cursorBlinkRate: prefersReducedMotion(host.ownerDocument) ? 0 : 1060 }),
        indentOnInput(),
        bracketMatching(),
        highlightActiveLine(),
        syntaxHighlighting(plotiniumHighlighter),
        keymap.of([
          { key: 'Mod-Shift-s', run: handlers.onSaveAsKey },
          { key: 'Mod-s', preventDefault: true, run: handlers.onSaveKey },
        ]),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        placeholder(local.placeholder ?? 'Empty file. Start typing.'),
        languageSlot.of(languageExtension(local.language)),
        readOnlySlot.of(readOnlyExtensions(readOnly)),
        labelSlot.of(labelExtension(local.label, readOnly)),
        themeSlot.of(plotiniumEditorTheme((local.scheme ?? detectScheme(host)) === 'dark')),
        wrapSlot.of(local.lineWrapping === true ? EditorView.lineWrapping : []),
        EditorView.updateListener.of(handlers.onUpdate),
        EditorView.domEventHandlers({ keydown: handlers.onKeyDown, paste: handlers.onPaste }),
      ],
      selection:
        local.cursor === undefined
          ? undefined
          : EditorSelection.cursor(
              clampPosition(
                EditorState.create({ doc: local.doc }),
                local.cursor.line,
                local.cursor.col,
              ),
            ),
    });
    // CodeMirror (style-mod) keeps its base theme and ours in one <style> at the top of <head>,
    // made when the first editor of the page mounts. The production CSP refuses a run-time
    // <style> and reports a violation (UI-051), so that element is made as an inert stand-in
    // (withInertStyles) and its CSS applied through an adopted sheet (mirrorBlockedHeadStyles).
    // Later editors reuse the same element. Both only through csp-styles.ts.
    const parent = host;
    const created = withInertStyles(parent.ownerDocument, () => new EditorView({ state, parent }));
    mirrorBlockedHeadStyles(parent.ownerDocument);
    view = created;
    if (local.cursor !== undefined) {
      created.dispatch({
        effects: EditorView.scrollIntoView(created.state.selection.main.head, { y: 'center' }),
      });
    }
    local.onReady?.({
      focus: () => created.focus(),
      doc: () => created.state.doc.toString(),
      setDoc: (doc) => replaceDoc(doc),
      goTo: (line, col) => {
        const pos = clampPosition(created.state, line, col);
        created.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
        created.focus();
      },
      caretRect: () => {
        const coords = created.coordsAtPos(created.state.selection.main.head);
        return coords === null
          ? undefined
          : { left: coords.left, top: coords.top, bottom: coords.bottom };
      },
    });
    onCleanup(() => {
      created.destroy();
      view = undefined;
    });
  });

  createEffect(on(() => local.doc, replaceDoc, { defer: true }));
  createEffect(
    on(
      () => local.language,
      (language) =>
        view?.dispatch({ effects: languageSlot.reconfigure(languageExtension(language)) }),
      { defer: true },
    ),
  );
  createEffect(
    on(
      () => [local.readOnly === true, local.label] as const,
      ([readOnly, label]) =>
        view?.dispatch({
          effects: [
            readOnlySlot.reconfigure(readOnlyExtensions(readOnly)),
            labelSlot.reconfigure(labelExtension(label, readOnly)),
          ],
        }),
      { defer: true },
    ),
  );
  createEffect(
    on(
      () => local.scheme,
      (scheme) => {
        if (view === undefined || host === undefined) return;
        view.dispatch({
          effects: themeSlot.reconfigure(
            plotiniumEditorTheme((scheme ?? detectScheme(host)) === 'dark'),
          ),
        });
      },
      { defer: true },
    ),
  );
  createEffect(
    on(
      () => local.lineWrapping === true,
      (wrap) =>
        view?.dispatch({ effects: wrapSlot.reconfigure(wrap ? EditorView.lineWrapping : []) }),
      { defer: true },
    ),
  );

  return <div ref={(el) => (host = el)} class={cx(styles.host, local.class)} />;
}
