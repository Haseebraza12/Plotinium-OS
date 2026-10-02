import Check from 'lucide-solid/icons/check';
import CloudOff from 'lucide-solid/icons/cloud-off';
import Lock from 'lucide-solid/icons/lock';
import RefreshCw from 'lucide-solid/icons/refresh-cw';
import Sparkles from 'lucide-solid/icons/sparkles';
import TriangleAlert from 'lucide-solid/icons/triangle-alert';
import { Match, Show, splitProps, Switch, type JSX } from 'solid-js';

import { cx } from '../../primitives/internal/cx.ts';
import styles from './EditorStatusBar.module.css';

/**
 * Save state (ui-design-system.md §3.8.12; editor-conflict notes). `new`: an untitled document
 * that has never been saved; the bar says so instead of "saved v0".
 */
export type SaveState =
  | { kind: 'new' }
  | { kind: 'saved'; version: number }
  | { kind: 'edited' }
  | { kind: 'saving' }
  | { kind: 'queued'; queued: number }
  | { kind: 'failed' };

/**
 * `local`: saves stay on this device because the sync client is not linked (UI-117); the bar
 * never claims "synced" then. `none`: the document is not in any file yet (untitled), so there
 * is nothing to sync and the bar shows no sync state.
 */
export type SyncState =
  | { kind: 'none' }
  | { kind: 'local' }
  | { kind: 'synced' }
  | { kind: 'syncing' }
  | { kind: 'offline'; queued: number }
  | { kind: 'conflict'; count: number };

export interface EditorStatusBarProps {
  line: number;
  col: number;
  encoding?: string;
  /** Language label ("Markdown"). */
  language: string;
  save: SaveState;
  sync: SyncState;
  /** Shown only while another user holds the lease. */
  readOnly?: boolean;
  /** "Spaces: 2" or "Tabs". */
  indent?: string;
  onGoToLine?: () => void;
  onPickEncoding?: () => void;
  onPickLanguage?: () => void;
  onPickIndent?: () => void;
  onRetrySave?: () => void;
  /** Omitted in the AI-off build: the chip is hidden, not greyed out. */
  onAskAi?: () => void;
  class?: string;
}

export function saveText(save: SaveState): string {
  switch (save.kind) {
    case 'new':
      return 'not saved';
    case 'saved':
      return `saved v${save.version}`;
    case 'edited':
      return 'edited';
    case 'saving':
      return 'saving…';
    case 'queued':
      return `saved · offline, ${save.queued} queued`;
    case 'failed':
      return 'save failed · retry';
  }
}

export function syncText(sync: SyncState): string {
  switch (sync.kind) {
    case 'none':
      return '';
    case 'local':
      return 'local only';
    case 'synced':
      return 'synced';
    case 'syncing':
      return 'syncing…';
    case 'offline':
      return `offline · ${sync.queued} queued`;
    case 'conflict':
      return sync.count === 1 ? '1 conflict' : `${sync.count} conflicts`;
  }
}

function StatusItem(props: {
  label: string;
  onClick?: () => void;
  class?: string;
  children: JSX.Element;
}): JSX.Element {
  return (
    <button
      type="button"
      class={cx(styles.item, props.class)}
      aria-label={props.label}
      aria-disabled={props.onClick === undefined ? 'true' : undefined}
      onClick={() => props.onClick?.()}
    >
      {props.children}
    </button>
  );
}

/**
 * The 24 px editor status bar: `Ln 42, Col 7 · UTF-8 · Markdown · saved v8 · synced` on the left;
 * the read-only lock, indentation and the Ask AI chip on the right. Each item opens its picker.
 * Only save and sync changes are announced, never the caret position.
 */
export function EditorStatusBar(props: EditorStatusBarProps): JSX.Element {
  const [local] = splitProps(props, [
    'line',
    'col',
    'encoding',
    'language',
    'save',
    'sync',
    'readOnly',
    'indent',
    'onGoToLine',
    'onPickEncoding',
    'onPickLanguage',
    'onPickIndent',
    'onRetrySave',
    'onAskAi',
    'class',
  ]);

  return (
    <footer class={cx(styles.bar, local.class)}>
      <div class={styles.start}>
        <StatusItem
          label={`Line ${local.line}, column ${local.col}. Go to line`}
          onClick={local.onGoToLine}
        >
          Ln {local.line}, Col {local.col}
        </StatusItem>
        <span class={styles.sep} aria-hidden="true">
          {' · '}
        </span>
        <StatusItem label={`Encoding ${local.encoding ?? 'UTF-8'}`} onClick={local.onPickEncoding}>
          {local.encoding ?? 'UTF-8'}
        </StatusItem>
        <span class={styles.sep} aria-hidden="true">
          {' · '}
        </span>
        <StatusItem label={`Language ${local.language}`} onClick={local.onPickLanguage}>
          {local.language}
        </StatusItem>
        <span class={styles.sep} aria-hidden="true">
          {' · '}
        </span>
        <span role="status" aria-live="polite" class={styles.live}>
          <StatusItem
            label={saveText(local.save)}
            onClick={local.save.kind === 'failed' ? local.onRetrySave : undefined}
            class={local.save.kind === 'failed' ? styles.danger : undefined}
          >
            {saveText(local.save)}
          </StatusItem>
          <Show when={local.sync.kind !== 'none'}>
            <span class={styles.sep} aria-hidden="true">
              {' · '}
            </span>
            <span
              class={cx(
                styles.sync,
                local.sync.kind === 'conflict' && styles.warning,
                (local.sync.kind === 'offline' || local.sync.kind === 'local') && styles.muted,
              )}
              data-sync={local.sync.kind}
            >
              <span class={styles.syncIcon} aria-hidden="true">
                <Switch>
                  <Match when={local.sync.kind === 'synced'}>
                    <Check size={12} stroke-width={2.6} class={styles.check} />
                  </Match>
                  <Match when={local.sync.kind === 'syncing'}>
                    <RefreshCw size={12} stroke-width={2.2} class={styles.spinOnce} />
                  </Match>
                  <Match when={local.sync.kind === 'offline' || local.sync.kind === 'local'}>
                    <CloudOff size={12} stroke-width={2.2} />
                  </Match>
                  <Match when={local.sync.kind === 'conflict'}>
                    <TriangleAlert size={12} stroke-width={2.2} />
                  </Match>
                </Switch>
              </span>
              {syncText(local.sync)}
            </span>
          </Show>
        </span>
      </div>
      <div class={styles.end}>
        <Show when={local.readOnly === true}>
          <span class={styles.readOnly}>
            <Lock size={12} stroke-width={2.2} aria-hidden="true" />
            Read-only
          </span>
        </Show>
        <StatusItem
          label={`Indentation ${local.indent ?? 'Spaces: 2'}`}
          onClick={local.onPickIndent}
        >
          {local.indent ?? 'Spaces: 2'}
        </StatusItem>
        <Show when={local.onAskAi}>
          <button type="button" class={styles.askAi} onClick={() => local.onAskAi?.()}>
            <Sparkles size={12} stroke-width={2.2} aria-hidden="true" />
            Ask AI
          </button>
        </Show>
      </div>
    </footer>
  );
}
