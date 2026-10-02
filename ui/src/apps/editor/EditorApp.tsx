import Lock from 'lucide-solid/icons/lock';
import {
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  on,
  onCleanup,
  Show,
  splitProps,
  type JSX,
} from 'solid-js';

import { cx } from '../../primitives/internal/cx.ts';
import {
  CodeEditor,
  type CodeEditorHandle,
  type CursorPosition,
  type EditorLanguage,
} from './CodeEditor.tsx';
import { DocumentTabs, type DocumentTab, type DocumentTabState } from './DocumentTabs.tsx';
import { ConflictBanner, type ConflictAction, type ConflictState } from './EditorBanner.tsx';
import styles from './EditorApp.module.css';
import { EditorSidebar, type SidebarFile } from './EditorSidebar.tsx';
import { EditorStatusBar, type SaveState, type SyncState } from './EditorStatusBar.tsx';
import {
  activeHeading,
  languageBadge,
  languageLabel,
  languageOf,
  markdownOutline,
} from './format.ts';

export interface EditorDocument {
  id: string;
  /** File name shown on the tab ("os-report.md"). */
  name: string;
  /** Full path, the tab tooltip. */
  path?: string;
  language?: EditorLanguage;
  state?: DocumentTabState;
}

export interface EditorAppProps {
  documents: readonly EditorDocument[];
  selected: string;
  onSelect: (id: string) => void;
  onClose?: (id: string) => void;
  onNew?: () => void;
  /** Contents of the selected document. */
  doc: string;
  /** Another user holds the lease (VFS-09): the buffer is read-only. */
  lockHolder?: string;
  /** Not writable for another reason (EACCES). */
  readOnly?: boolean;
  conflict?: ConflictState;
  onConflictAction?: (action: ConflictAction) => void;
  onConflictDismiss?: () => void;
  /** Sidebar: outline of the document and files of its folder. */
  showSidebar?: boolean;
  folder: string;
  files: readonly SidebarFile[];
  selectedFile?: string;
  onFileSelect?: (id: string) => void;
  save: SaveState;
  sync: SyncState;
  /** Initial caret. */
  cursor?: CursorPosition;
  indent?: string;
  onChange?: (doc: string) => void;
  onSave?: () => void;
  /** Hidden in the AI-off build. */
  onAskAi?: () => void;
  /** A key was refused because the file is locked (bump the lock chip's shake). */
  onReadOnlyAttempt?: () => void;
  onReady?: (handle: CodeEditorHandle) => void;
  scheme?: 'light' | 'dark';
  class?: string;
}

/** How long the "Locked by …" hint stays after a refused key. */
const HINT_MS = 2000;

/**
 * The Editor window's content (ui-design-system.md §3.8.12; editor-conflict): document tabs,
 * the outline and files sidebar, the sync-conflict banner, CodeMirror, and the status bar.
 * Typing into a locked file changes nothing and shows "Locked by alice · you can read, not
 * edit" at the caret.
 */
export function EditorApp(props: EditorAppProps): JSX.Element {
  const [local] = splitProps(props, [
    'documents',
    'selected',
    'onSelect',
    'onClose',
    'onNew',
    'doc',
    'lockHolder',
    'readOnly',
    'conflict',
    'onConflictAction',
    'onConflictDismiss',
    'showSidebar',
    'folder',
    'files',
    'selectedFile',
    'onFileSelect',
    'save',
    'sync',
    'cursor',
    'indent',
    'onChange',
    'onSave',
    'onAskAi',
    'onReadOnlyAttempt',
    'onReady',
    'scheme',
    'class',
  ]);
  const uid = createUniqueId();
  const [buffer, setBuffer] = createSignal('');
  const [position, setPosition] = createSignal<CursorPosition>({ line: 1, col: 1 });
  // The outline follows the prop until the user types; the caret starts at the prop's cursor.
  createEffect(() => setBuffer(local.doc));
  createEffect(
    on(
      () => local.cursor,
      (cursor) => {
        if (cursor !== undefined) setPosition(cursor);
      },
    ),
  );
  const [hint, setHint] = createSignal<{ left: number; top: number }>();
  let handle: CodeEditorHandle | undefined;
  let codeArea: HTMLDivElement | undefined;
  let hintTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(hintTimer));

  const current = createMemo(() => local.documents.find((d) => d.id === local.selected));
  const language = (): EditorLanguage => {
    const doc = current();
    return doc?.language ?? languageOf(doc?.name ?? '');
  };
  const locked = (): boolean => local.lockHolder !== undefined || local.readOnly === true;
  const outline = createMemo(() => (language() === 'markdown' ? markdownOutline(buffer()) : []));
  const active = createMemo(() => activeHeading(outline(), position().line));
  const tabs = (): DocumentTab[] =>
    local.documents.map((d) => ({
      id: d.id,
      label: d.name,
      title: d.path,
      badge: languageBadge(d.language ?? languageOf(d.name)),
      state: d.state,
    }));

  const showHint = (): void => {
    local.onReadOnlyAttempt?.();
    const caret = handle?.caretRect();
    const box = codeArea?.getBoundingClientRect();
    setHint(
      caret === undefined || box === undefined
        ? { left: 0, top: 0 }
        : { left: caret.left - box.left, top: caret.top - box.top },
    );
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => setHint(undefined), HINT_MS);
  };

  return (
    <div class={cx(styles.app, local.class)}>
      <DocumentTabs
        variant="editor"
        label="Open files"
        tabs={tabs()}
        selected={local.selected}
        onSelect={(id) => local.onSelect(id)}
        onClose={local.onClose === undefined ? undefined : (id) => local.onClose?.(id)}
        onNew={local.onNew === undefined ? undefined : () => local.onNew?.()}
        panelId={`pl-editor-panel-${uid}`}
      />
      <div class={styles.body}>
        <Show when={local.showSidebar !== false}>
          <EditorSidebar
            outline={outline()}
            activeLine={active()?.line}
            onOutlineSelect={(line) => handle?.goTo(line)}
            folder={local.folder}
            files={local.files}
            selectedFile={local.selectedFile}
            onFileSelect={(id) => local.onFileSelect?.(id)}
          />
        </Show>
        <div id={`pl-editor-panel-${uid}`} role="tabpanel" class={styles.main}>
          <ConflictBanner
            state={local.conflict}
            onAction={(action) => local.onConflictAction?.(action)}
            onDismiss={
              local.onConflictDismiss === undefined ? undefined : () => local.onConflictDismiss?.()
            }
          />
          <div ref={(el) => (codeArea = el)} class={styles.code}>
            <CodeEditor
              doc={local.doc}
              language={language()}
              readOnly={locked()}
              label={`${current()?.name ?? 'Untitled'}${locked() ? ' (read-only)' : ''}`}
              cursor={local.cursor}
              scheme={local.scheme}
              onChange={(doc) => {
                setBuffer(doc);
                local.onChange?.(doc);
              }}
              onCursor={setPosition}
              onReadOnlyAttempt={showHint}
              onSave={() => local.onSave?.()}
              onReady={(h) => {
                handle = h;
                local.onReady?.(h);
              }}
            />
            <Show when={locked() ? hint() : undefined}>
              {(at) => (
                <div
                  class={styles.hint}
                  role="status"
                  style={{ left: `${at().left}px`, top: `${at().top}px` }}
                >
                  <Lock size={12} stroke-width={2.2} aria-hidden="true" />
                  {local.lockHolder === undefined
                    ? 'You can read this file but not write it.'
                    : `Locked by ${local.lockHolder} · you can read, not edit`}
                </div>
              )}
            </Show>
          </div>
        </div>
      </div>
      <EditorStatusBar
        line={position().line}
        col={position().col}
        language={languageLabel(language())}
        save={local.save}
        sync={local.sync}
        readOnly={locked()}
        indent={local.indent}
        onGoToLine={() => handle?.focus()}
        onAskAi={local.onAskAi}
      />
    </div>
  );
}
