import { createUniqueId, Show, splitProps, type JSX } from 'solid-js';

import styles from '../dialog/Modal.module.css';
import { createModalFocus } from '../dialog/modal.ts';
import { cx } from '../internal/cx.ts';
import { trapTabKey } from '../internal/focus.ts';
import { createDismissableLayer } from '../internal/layers.ts';
import { createPresence } from '../internal/presence.ts';

export interface SheetProps {
  open: boolean;
  onClose: (reason: 'escape') => void;
  title: string;
  description?: JSX.Element;
  icon?: JSX.Element;
  children?: JSX.Element;
  actions?: JSX.Element;
  role?: 'dialog' | 'alertdialog';
  /** Escape closes it. Default true. */
  dismissible?: boolean;
  /** Detached: a gap below the title bar and all corners rounded (the agent confirmation). */
  floating?: boolean;
  class?: string;
}

/**
 * A window-modal sheet that drops from the top edge of its window (the nearest positioned
 * ancestor). It is not portalled: it belongs to that window and dims only it. Focus handling is
 * the dialog pattern; the drop is a transform-only spring (pl-anim-sheet-in).
 */
export function Sheet(props: SheetProps): JSX.Element {
  const [local] = splitProps(props, [
    'open',
    'onClose',
    'title',
    'description',
    'icon',
    'children',
    'actions',
    'role',
    'dismissible',
    'floating',
    'class',
  ]);
  const uid = createUniqueId();
  const presence = createPresence(() => local.open, 180);
  let panel: HTMLDivElement | undefined;
  const closing = (): boolean => presence.state() === 'closing';

  createModalFocus(
    () => local.open,
    () => panel,
  );
  createDismissableLayer({
    active: () => local.open,
    inside: () => [panel],
    onEscape: () => {
      if (local.dismissible !== false) local.onClose('escape');
    },
  });

  return (
    <Show when={presence.mounted()}>
      <div class={styles.sheetLayer} data-state={presence.state()}>
        <div
          class={cx(styles.sheetScrim, closing() ? 'pl-anim-scrim-out' : 'pl-anim-scrim-in')}
          aria-hidden="true"
        />
        <div
          ref={(el) => (panel = el)}
          role={local.role ?? 'dialog'}
          aria-modal="true"
          aria-labelledby={`pl-sheet-${uid}-title`}
          aria-describedby={local.description === undefined ? undefined : `pl-sheet-${uid}-desc`}
          tabindex={-1}
          class={cx(
            styles.panel,
            styles.sheet,
            local.floating === true && styles.floatingSheet,
            closing() ? 'pl-anim-sheet-out' : 'pl-anim-sheet-in',
            local.class,
          )}
          onKeyDown={(event) => {
            if (panel !== undefined) trapTabKey(event, panel);
          }}
        >
          <div class={styles.header}>
            <Show when={local.icon}>
              <div class={styles.icon} aria-hidden="true">
                {local.icon}
              </div>
            </Show>
            <div class={styles.headings}>
              <h2 class={styles.title} id={`pl-sheet-${uid}-title`}>
                {local.title}
              </h2>
              <Show when={local.description}>
                <p class={styles.description} id={`pl-sheet-${uid}-desc`}>
                  {local.description}
                </p>
              </Show>
            </div>
          </div>
          <Show when={local.children}>
            <div class={styles.body}>{local.children}</div>
          </Show>
          <Show when={local.actions}>
            <div class={styles.actions}>{local.actions}</div>
          </Show>
        </div>
      </div>
    </Show>
  );
}
