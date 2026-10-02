/**
 * Plotinium's CodeMirror 6 theme (ui-design-system.md §4.4, DSN-02, DSN-13). Every value is a
 * `var(--pl-*)` token, so one theme serves light and dark and follows a theme switch without
 * being rebuilt; the `dark` flag only tells CodeMirror's base theme which defaults to use.
 *
 * Syntax colours are CSS-module classes (CodeEditor.module.css) chosen by a small highlighter
 * that maps highlight tags by name, most specific first. Only text-safe tokens are used for
 * code (accent text, success, warning, info, danger and the text greys), so every colour meets
 * 4.5:1 on the editor surface in both themes.
 */
import type { syntaxHighlighting } from '@codemirror/language';
import { EditorView } from '@codemirror/view';

import styles from './CodeEditor.module.css';

type Highlighter = Parameters<typeof syntaxHighlighting>[0];
type HighlightTag = Parameters<Highlighter['style']>[0][number];

/** Highlight-tag name → class. Keys are lezer tag names (`String(tag)`). */
export const SYNTAX_CLASSES: Readonly<Record<string, string | undefined>> = {
  // Markdown
  heading: styles.synHeading,
  strong: styles.synStrong,
  emphasis: styles.synEmphasis,
  strikethrough: styles.synStrike,
  link: styles.synLink,
  url: styles.synUrl,
  monospace: styles.synCode,
  quote: styles.synQuote,
  processingInstruction: styles.synMark,
  contentSeparator: styles.synMark,
  // Code
  keyword: styles.synKeyword,
  controlKeyword: styles.synKeyword,
  moduleKeyword: styles.synKeyword,
  operatorKeyword: styles.synKeyword,
  definitionKeyword: styles.synKeyword,
  string: styles.synString,
  'special(string)': styles.synRegexp,
  regexp: styles.synRegexp,
  escape: styles.synRegexp,
  number: styles.synNumber,
  bool: styles.synNumber,
  null: styles.synNumber,
  atom: styles.synNumber,
  comment: styles.synComment,
  lineComment: styles.synComment,
  blockComment: styles.synComment,
  docComment: styles.synComment,
  'definition(variableName)': styles.synDefinition,
  'function(variableName)': styles.synFunction,
  'function(definition(variableName))': styles.synFunction,
  'definition(propertyName)': styles.synDefinition,
  'function(propertyName)': styles.synFunction,
  typeName: styles.synType,
  className: styles.synType,
  namespace: styles.synType,
  propertyName: styles.synProperty,
  operator: styles.synOperator,
  punctuation: styles.synPunctuation,
  bracket: styles.synPunctuation,
  meta: styles.synMark,
  invalid: styles.synInvalid,
  inserted: styles.synInserted,
  deleted: styles.synDeleted,
  changed: styles.synNumber,
};

/** The class for one tag: the most specific of its names (tag.set is ordered that way). */
export function classForTag(tag: HighlightTag): string | undefined {
  for (const candidate of tag.set) {
    const cls = SYNTAX_CLASSES[String(candidate)];
    if (cls !== undefined) return cls;
  }
  return undefined;
}

export const plotiniumHighlighter: Highlighter = {
  style(tags) {
    const classes = new Set<string>();
    for (const tag of tags) {
      const cls = classForTag(tag);
      if (cls !== undefined) classes.add(cls);
    }
    return classes.size === 0 ? null : [...classes].join(' ');
  },
};

/** The editor chrome: surface, gutters, caret, selection, active line, tooltips and panels. */
export function plotiniumEditorTheme(dark: boolean): ReturnType<typeof EditorView.theme> {
  return EditorView.theme(
    {
      '&': {
        height: '100%',
        color: 'var(--pl-text)',
        backgroundColor: 'transparent',
        fontSize: 'var(--pl-text-sm)',
      },
      '&.cm-focused': { outline: 'none' },
      '.cm-scroller': {
        fontFamily: 'var(--pl-font-mono)',
        lineHeight: 'var(--pl-leading-mono)',
        fontVariantLigatures: 'none',
      },
      '.cm-content': {
        caretColor: 'var(--pl-accent)',
        padding: 'var(--pl-space-2) 0 var(--pl-space-10)',
      },
      '.cm-line': { padding: '0 var(--pl-space-4) 0 var(--pl-space-1)' },
      '.cm-cursor, .cm-dropCursor': {
        borderLeftColor: 'var(--pl-accent)',
        borderLeftWidth: 'var(--pl-space-half)',
      },
      // Read-only: a hollow caret, so the lock is visible where the user is looking.
      '&.pl-readonly .cm-cursor': {
        borderLeftColor: 'var(--pl-text-muted)',
        borderLeftStyle: 'dotted',
      },
      '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection':
        { backgroundColor: 'var(--pl-text-selection)' },
      '.cm-activeLine': {
        backgroundColor: 'color-mix(in srgb, var(--pl-accent) 9%, transparent)',
      },
      '.cm-gutters': {
        backgroundColor: 'transparent',
        color: 'var(--pl-text-tertiary)',
        border: 'none',
        fontVariantNumeric: 'tabular-nums',
      },
      '.cm-lineNumbers .cm-gutterElement': {
        padding: '0 var(--pl-space-3) 0 var(--pl-space-4)',
      },
      '.cm-activeLineGutter': {
        backgroundColor: 'color-mix(in srgb, var(--pl-accent) 9%, transparent)',
        color: 'var(--pl-text)',
        boxShadow: 'inset var(--pl-space-half) 0 0 var(--pl-accent)',
      },
      '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
        backgroundColor: 'var(--pl-accent-subtle)',
        color: 'inherit',
      },
      '.cm-nonmatchingBracket, &.cm-focused .cm-nonmatchingBracket': {
        backgroundColor: 'var(--pl-danger-subtle)',
      },
      '.cm-tooltip': {
        border: 'none',
        borderRadius: 'var(--pl-radius-md)',
        backgroundColor: 'var(--pl-glass-popover-bg)',
        backdropFilter: 'var(--pl-glass-popover-filter)',
        boxShadow: 'var(--pl-shadow-pop)',
        color: 'var(--pl-text)',
      },
      '.cm-panels': {
        backgroundColor: 'var(--pl-surface-2)',
        color: 'var(--pl-text)',
        borderColor: 'var(--pl-separator)',
      },
      '.cm-placeholder': { color: 'var(--pl-text-tertiary)' },
    },
    { dark },
  );
}
