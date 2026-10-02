import Lock from 'lucide-solid/icons/lock';
import LockOpen from 'lucide-solid/icons/lock-open';
import { createMemo, Match, Show, splitProps, Switch, type JSX } from 'solid-js';

import { Button } from '../../primitives/button/Button.tsx';
import { cx } from '../../primitives/internal/cx.ts';
import { FileIcon } from './FileIcon.tsx';
import {
  entrySize,
  formatAgo,
  formatDate,
  formatSize,
  kindLabel,
  permissionString,
  spokenMode,
} from './format.ts';
import styles from './Inspector.module.css';
import { ownsEntry } from './menu.ts';
import type { FileEntry, FileLock, Viewer } from './types.ts';

export type InspectorAction =
  'open' | 'open-in-editor' | 'share' | 'history' | 'chmod' | 'unlock' | 'copy-value';

export interface InspectorProps {
  /** The selection: none, one, or several. */
  entries: readonly FileEntry[];
  viewer: Viewer;
  now: number;
  /** Rows are loading (static skeleton). */
  loading?: boolean;
  /**
   * The actions the host can carry out; the others are not drawn (a control that cannot work is
   * never shown as if it could). Default: all of them.
   */
  actions?: readonly InspectorAction[];
  onAction: (action: InspectorAction, entry: FileEntry | undefined) => void;
  class?: string;
}

/** Lock chip text (files notes): unlocked, locked by you, locked by someone, or expired. */
export function lockText(lock: FileLock | undefined, now: number): string {
  if (lock === undefined) return 'Unlocked — no editors';
  if (lock.stale === true) return 'Lock expired';
  if (lock.mine === true) return 'Locked by you';
  return `Locked by ${lock.holder} · ${formatAgo(lock.since, now)}`;
}

function lockTone(lock: FileLock | undefined): 'free' | 'mine' | 'other' | 'stale' {
  if (lock === undefined) return 'free';
  if (lock.stale === true) return 'stale';
  return lock.mine === true ? 'mine' : 'other';
}

/**
 * The Files inspector (`aside` "File info"): the icon, name and kind; a description list of
 * permissions (symbolic, spelled out for screen readers), owner, group, size, dates and
 * version with its History link; the lock state as a chip whose words carry the meaning; and
 * Open, Open in Editor and Share. Several items show a combined summary.
 */
export function Inspector(props: InspectorProps): JSX.Element {
  const [local] = splitProps(props, [
    'entries',
    'viewer',
    'now',
    'loading',
    'actions',
    'onAction',
    'class',
  ]);
  const single = createMemo(() => (local.entries.length === 1 ? local.entries[0] : undefined));
  const totalSize = createMemo(() =>
    local.entries.reduce((sum, e) => sum + (e.type === 'dir' ? 0 : e.size), 0),
  );
  const offers = (action: InspectorAction): boolean =>
    local.actions === undefined || local.actions.includes(action);
  const canChmod = (entry: FileEntry): boolean => offers('chmod') && ownsEntry(local.viewer, entry);

  return (
    <aside aria-label="File info" class={cx(styles.inspector, local.class)}>
      <Switch>
        <Match when={local.loading === true}>
          <div class={styles.skeleton} aria-busy="true" aria-label="Loading file info">
            <span class={styles.skeletonIcon} />
            <span class={styles.skeletonLine} />
            <span class={styles.skeletonLine} />
            <span class={styles.skeletonLine} />
          </div>
        </Match>
        <Match when={local.entries.length === 0}>
          <p class={styles.empty}>Select a file to see its info</p>
        </Match>
        <Match when={single()}>
          {(entry) => (
            <div class={styles.content}>
              <div class={styles.hero}>
                <FileIcon entry={entry()} size={56} />
                <h3 class={styles.name}>{entry().name}</h3>
                <p class={styles.kind}>{kindLabel(entry())}</p>
              </div>
              <dl class={styles.rows}>
                <div class={styles.row}>
                  <dt>Permissions</dt>
                  <dd class={styles.mono}>
                    <span aria-hidden="true">{permissionString(entry().mode)}</span>
                    <span class={styles.hidden}>{spokenMode(entry().mode)}</span>
                    <Show when={canChmod(entry())}>
                      <button
                        type="button"
                        class={styles.link}
                        onClick={() => local.onAction('chmod', entry())}
                      >
                        Change…
                      </button>
                    </Show>
                  </dd>
                </div>
                <div class={styles.row}>
                  <dt>Owner</dt>
                  <dd>
                    {entry().owner}
                    <Show when={entry().uid !== undefined}> (uid {entry().uid})</Show>
                  </dd>
                </div>
                <Show when={entry().group}>
                  {(group) => (
                    <div class={styles.row}>
                      <dt>Group</dt>
                      <dd>{group()}</dd>
                    </div>
                  )}
                </Show>
                <div class={styles.row}>
                  <dt>Size</dt>
                  <dd>{entrySize(entry())}</dd>
                </div>
                <div class={styles.row}>
                  <dt>Modified</dt>
                  <dd>{formatDate(entry().mtime, local.now)}</dd>
                </div>
                <Show when={entry().ctime}>
                  {(ctime) => (
                    <div class={styles.row}>
                      <dt>Created</dt>
                      <dd>{formatDate(ctime(), local.now)}</dd>
                    </div>
                  )}
                </Show>
                <Show when={entry().version}>
                  {(version) => (
                    <div class={styles.row}>
                      <dt>Version</dt>
                      <dd>
                        {version()}
                        <Show when={offers('history')}>
                          <button
                            type="button"
                            class={styles.link}
                            onClick={() => local.onAction('history', entry())}
                          >
                            History
                          </button>
                        </Show>
                      </dd>
                    </div>
                  )}
                </Show>
              </dl>
              <div class={styles.lockRow}>
                <span class={styles.lockLabel}>Lock</span>
                <Show keyed when={lockTone(entry().lock)}>
                  {(tone) => (
                    <span class={styles.lock} data-tone={tone} role="status">
                      <Show
                        when={tone === 'free'}
                        fallback={<Lock size={12} stroke-width={2.4} aria-hidden="true" />}
                      >
                        <LockOpen size={12} stroke-width={2.4} aria-hidden="true" />
                      </Show>
                      {lockText(entry().lock, local.now)}
                    </span>
                  )}
                </Show>
                <Show when={entry().lock?.mine === true && offers('unlock')}>
                  <button
                    type="button"
                    class={styles.link}
                    onClick={() => local.onAction('unlock', entry())}
                  >
                    Unlock
                  </button>
                </Show>
              </div>
              <div class={styles.actions}>
                <Button
                  variant="primary"
                  size="sm"
                  fullWidth
                  disabled={entry().readable === false}
                  onClick={() => local.onAction('open', entry())}
                >
                  Open
                </Button>
                <Show when={entry().type !== 'dir' && offers('open-in-editor')}>
                  <Button
                    size="sm"
                    fullWidth
                    disabled={entry().readable === false}
                    onClick={() => local.onAction('open-in-editor', entry())}
                  >
                    {entry().lock !== undefined &&
                    entry().lock?.mine !== true &&
                    entry().lock?.stale !== true
                      ? 'Open read-only'
                      : 'Open in Editor'}
                  </Button>
                </Show>
                <Show when={offers('share')}>
                  <Button
                    size="sm"
                    variant="ghost"
                    fullWidth
                    onClick={() => local.onAction('share', entry())}
                  >
                    Share
                  </Button>
                </Show>
              </div>
            </div>
          )}
        </Match>
        <Match when={local.entries.length > 1}>
          <div class={styles.content}>
            <div class={styles.hero}>
              <FileIcon entry={{ type: 'file', name: 'items' }} size={56} />
              <h3 class={styles.name}>{local.entries.length} items</h3>
              <p class={styles.kind}>{formatSize(totalSize())} in files</p>
            </div>
          </div>
        </Match>
      </Switch>
    </aside>
  );
}
