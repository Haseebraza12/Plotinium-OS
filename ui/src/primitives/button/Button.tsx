import { Show, splitProps, type JSX } from 'solid-js';

import { cx } from '../internal/cx.ts';
import styles from './Button.module.css';

export type ButtonVariant = 'primary' | 'secondary' | 'tinted' | 'ghost' | 'danger' | 'destructive';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends Omit<JSX.ButtonHTMLAttributes<HTMLButtonElement>, 'disabled'> {
  /** primary: the default action (accent fill). destructive: a confirmed danger action. Default secondary. */
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Leading icon, decorative (the label names the action). */
  icon?: JSX.Element;
  /** Trailing icon, decorative. */
  trailingIcon?: JSX.Element;
  /** Stretches to the container width. */
  fullWidth?: boolean;
  /**
   * Disabled buttons stay focusable (aria-disabled) so keyboard and screen-reader users can
   * still find them and read why; clicks are swallowed.
   */
  disabled?: boolean;
}

/** A push button: primary, secondary, tinted, ghost, danger and destructive; three sizes. */
export function Button(props: ButtonProps): JSX.Element {
  const [local, rest] = splitProps(props, [
    'variant',
    'size',
    'icon',
    'trailingIcon',
    'fullWidth',
    'disabled',
    'class',
    'children',
    'onClick',
    'type',
  ]);

  const onClick: JSX.EventHandler<HTMLButtonElement, MouseEvent> = (event) => {
    if (local.disabled === true) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    const handler = local.onClick;
    if (typeof handler === 'function') handler(event);
    else if (Array.isArray(handler))
      (handler[0] as (data: unknown, e: MouseEvent) => void)(handler[1], event);
  };

  return (
    <button
      type={local.type ?? 'button'}
      class={cx(
        styles.button,
        styles[local.variant ?? 'secondary'],
        styles[local.size ?? 'md'],
        local.fullWidth === true && styles.full,
        local.class,
      )}
      aria-disabled={local.disabled === true ? 'true' : undefined}
      onClick={onClick}
      {...rest}
    >
      <Show when={local.icon}>
        <span class={styles.icon} aria-hidden="true">
          {local.icon}
        </span>
      </Show>
      <span class={styles.label}>{local.children}</span>
      <Show when={local.trailingIcon}>
        <span class={styles.icon} aria-hidden="true">
          {local.trailingIcon}
        </span>
      </Show>
    </button>
  );
}
