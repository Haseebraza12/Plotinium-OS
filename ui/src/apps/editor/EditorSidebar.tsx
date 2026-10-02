import FileText from 'lucide-solid/icons/file-text';
import FileWarning from 'lucide-solid/icons/file-warning';
import { createMemo, createUniqueId, For, Show, splitProps, type JSX } from 'solid-js';

import { Pill } from '../../primitives/badge/Badge.tsx';
import { cx } from '../../primitives/internal/cx.ts';
import styles from './EditorSidebar.module.css';
import type { OutlineHeading } from './format.ts';

export interface SidebarFile {
  id: string;
  name: string;
  /** The conflicted copy of a file (SYN-08). */
  conflict?: boolean;
}

export interface EditorSidebarProps {
  outline: readonly OutlineHeading[];
  /** Line of the heading the caret is in. */
  activeLine?: number;
  onOutlineSelect: (line: number) => void;
  /** The folder whose files are listed, e.g. /home/student/notes. */
  folder: string;
  files: readonly SidebarFile[];
  selectedFile?: string;
  onFileSelect: (id: string) => void;
  class?: string;
}

/** Up/Down/Home/End over a list of elements; returns the element to focus. */
function nextIndex(key: string, index: number, count: number): number | undefined {
  switch (key) {
    case 'ArrowDown':
      return Math.min(count - 1, index + 1);
    case 'ArrowUp':
      return Math.max(0, index - 1);
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return undefined;
  }
}

/**
 * The Editor's vibrancy sidebar: the document outline (a tree of headings that follows the
 * caret; Enter jumps to the heading) and the files of the current folder (a listbox; the
 * conflicted copy carries a CONFLICT badge in words, not only an amber icon).
 */
export function EditorSidebar(props: EditorSidebarProps): JSX.Element {
  const [local] = splitProps(props, [
    'outline',
    'activeLine',
    'onOutlineSelect',
    'folder',
    'files',
    'selectedFile',
    'onFileSelect',
    'class',
  ]);
  const uid = createUniqueId();
  const outlineRefs: HTMLElement[] = [];
  const fileRefs: HTMLElement[] = [];
  const minLevel = createMemo(() =>
    local.outline.reduce((min, h) => Math.min(min, h.level), Number.POSITIVE_INFINITY),
  );
  const outlineStop = createMemo(() => {
    const index = local.outline.findIndex((h) => h.line === local.activeLine);
    return index < 0 ? 0 : index;
  });
  const fileStop = createMemo(() => {
    const index = local.files.findIndex((f) => f.id === local.selectedFile);
    return index < 0 ? 0 : index;
  });

  return (
    <aside aria-label="Outline and files" class={cx(styles.sidebar, local.class)}>
      <h3 class={styles.heading} id={`pl-ed-outline-${uid}`}>
        Outline
      </h3>
      <Show when={local.outline.length > 0} fallback={<p class={styles.empty}>No headings</p>}>
        <ul role="tree" aria-labelledby={`pl-ed-outline-${uid}`} class={styles.list}>
          <For each={local.outline}>
            {(heading, index) => (
              <li
                ref={(el) => (outlineRefs[index()] = el)}
                role="treeitem"
                aria-level={heading.level - minLevel() + 1}
                aria-selected={heading.line === local.activeLine}
                tabindex={index() === outlineStop() ? 0 : -1}
                class={styles.row}
                style={{ '--ed-indent': String(heading.level - minLevel()) }}
                onClick={() => local.onOutlineSelect(heading.line)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    local.onOutlineSelect(heading.line);
                    return;
                  }
                  const next = nextIndex(event.key, index(), local.outline.length);
                  if (next === undefined) return;
                  event.preventDefault();
                  outlineRefs[next]?.focus();
                }}
              >
                <span class={styles.marker} aria-hidden="true">
                  {'#'.repeat(heading.level)}
                </span>
                <span class={styles.label}>{heading.text}</span>
              </li>
            )}
          </For>
        </ul>
      </Show>

      <div class={styles.filesHeader}>
        <h3 class={styles.heading} id={`pl-ed-files-${uid}`}>
          Files
        </h3>
        <span class={styles.count}>{local.files.length}</span>
      </div>
      <p class={styles.folder}>{local.folder}</p>
      <ul
        role="listbox"
        aria-labelledby={`pl-ed-files-${uid}`}
        aria-description={local.folder}
        class={styles.list}
      >
        <For each={local.files}>
          {(file, index) => (
            <li
              ref={(el) => (fileRefs[index()] = el)}
              role="option"
              aria-selected={file.id === local.selectedFile}
              aria-label={file.conflict === true ? `${file.name}, conflicted copy` : file.name}
              tabindex={index() === fileStop() ? 0 : -1}
              class={cx(styles.row, styles.fileRow)}
              onClick={() => local.onFileSelect(file.id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  local.onFileSelect(file.id);
                  return;
                }
                const next = nextIndex(event.key, index(), local.files.length);
                if (next === undefined) return;
                event.preventDefault();
                fileRefs[next]?.focus();
              }}
            >
              <span
                class={cx(styles.fileIcon, file.conflict === true && styles.conflictIcon)}
                aria-hidden="true"
              >
                <Show when={file.conflict === true} fallback={<FileText size={14} />}>
                  <FileWarning size={14} />
                </Show>
              </span>
              <span class={styles.fileName}>
                {/* Floated first, so a long conflicted name wraps under the badge (editor-conflict). */}
                <Show when={file.conflict === true}>
                  <Pill tone="warning" size="sm" caps class={styles.badge}>
                    Conflict
                  </Pill>
                </Show>
                {file.name}
              </span>
            </li>
          )}
        </For>
      </ul>
    </aside>
  );
}
