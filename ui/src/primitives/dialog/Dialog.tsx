import { createUniqueId, Show, splitProps, type JSX } from 'solid-js';
import { Portal } from 'solid-js/web';

import { cx } from '../internal/cx.ts';
import { trapTabKey } from '../internal/focus.ts';
import { createDismissableLayer } from '../internal/layers.ts';
import { createPresence } from '../internal/presence.ts';
import styles from './Modal.module.css';
import { createModalFocus } from './modal.ts';

export type ModalCloseReason = 'escape' | 'scrim';

export interface DialogProps {
  open: boolean;
  onClose: (reason: ModalCloseReason) => void;
  title: string;
  description?: JSX.Element;
  /** Decorative icon (the app icon or a warning glyph). */
  icon?: JSX.Element;
  children?: JSX.Element;
  /** Footer buttons. Put the safe action first in focus order with data-autofocus (DSN-15). */
  actions?: JSX.Element;
  /** alertdialog for destructive or urgent questions. */
  role?: 'dialog' | 'alertdialog';
  /** Escape and scrim clicks close it. Default true; an alertdialog ignores scrim clicks. */
  dismissible?: boolean;
  size?: 'sm' | 'md' | 'lg';
  /** Centred icon, title and stacked full-width buttons (alert style). */
  centered?: boolean;
  class?: string;
}

/**
 * A modal dialog over a scrim (APG dialog): focus moves in, Tab is trapped, Escape closes and
 * focus returns to the invoker. It springs in (scale + fade) and fades out.
 */
export function Dialog(props: DialogProps): JSX.Element {
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
    'size',
    'centered',
    'class',
  ]);
  const uid = createUniqueId();
  const presence = createPresence(() => local.open, 160);
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
      <Portal>
        <div
          class={cx(styles.layer, local.centered === true && styles.centered)}
          data-state={presence.state()}
        >
          <div
            class={cx(styles.scrim, closing() ? 'pl-anim-scrim-out' : 'pl-anim-scrim-in')}
            aria-hidden="true"
            onClick={() => {
              if (local.dismissible !== false && local.role !== 'alertdialog')
                local.onClose('scrim');
            }}
          />
          <div
            ref={(el) => (panel = el)}
            role={local.role ?? 'dialog'}
            aria-modal="true"
            aria-labelledby={`pl-dialog-${uid}-title`}
            aria-describedby={local.description === undefined ? undefined : `pl-dialog-${uid}-desc`}
            tabindex={-1}
            class={cx(
              styles.panel,
              local.size !== undefined && local.size !== 'md' && styles[local.size],
              closing() ? 'pl-anim-dialog-out' : 'pl-anim-dialog-in',
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
                <h2 class={styles.title} id={`pl-dialog-${uid}-title`}>
                  {local.title}
                </h2>
                <Show when={local.description}>
                  <p class={styles.description} id={`pl-dialog-${uid}-desc`}>
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
      </Portal>
    </Show>
  );
}
