import { splitProps, type JSX } from 'solid-js';

import { cx } from '../internal/cx.ts';
import styles from './IconButton.module.css';

export type IconButtonVariant = 'ghost' | 'glass' | 'bordered';

export interface IconButtonProps extends Omit<
  JSX.ButtonHTMLAttributes<HTMLButtonElement>,
  'children' | 'disabled' | 'aria-label'
> {
  /** Accessible name; icon-only buttons always have one (WCAG 4.1.2). */
  label: string;
  /** The glyph, typically a lucide-solid icon at 16 px. Decorative. */
  icon: JSX.Element;
  variant?: IconButtonVariant;
  size?: 'sm' | 'md' | 'lg';
  /** Circular instead of rounded-square. */
  round?: boolean;
  /** Makes it a toggle button (aria-pressed). */
  pressed?: boolean;
  disabled?: boolean;
}

/** A square, icon-only button (toolbar buttons, clear buttons, navigation arrows). */
export function IconButton(props: IconButtonProps): JSX.Element {
  const [local, rest] = splitProps(props, [
    'label',
    'icon',
    'variant',
    'size',
    'round',
    'pressed',
    'disabled',
    'class',
    'type',
    'onClick',
  ]);
  const onClick: JSX.EventHandler<HTMLButtonElement, MouseEvent> = (event) => {
    if (local.disabled === true) {
      event.preventDefault();
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
        local.variant !== undefined && local.variant !== 'ghost' && styles[local.variant],
        local.size !== undefined && local.size !== 'md' && styles[local.size],
        local.round === true && styles.round,
        local.class,
      )}
      aria-label={local.label}
      aria-pressed={local.pressed === undefined ? undefined : local.pressed}
      aria-disabled={local.disabled === true ? 'true' : undefined}
      onClick={onClick}
      {...rest}
    >
      <span aria-hidden="true" class={styles.icon}>
        {local.icon}
      </span>
    </button>
  );
}
