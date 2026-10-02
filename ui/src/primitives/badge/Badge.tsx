import { Show, splitProps, type JSX } from 'solid-js';

import { cx } from '../internal/cx.ts';
import styles from './Badge.module.css';

export type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info';

export interface PillProps {
  children: JSX.Element;
  tone?: Tone;
  /** subtle (tinted fill, default), solid (filled) or outline. */
  variant?: 'subtle' | 'solid' | 'outline';
  size?: 'sm' | 'md';
  /** Leading status dot. Decorative: the text carries the meaning (DSN-08). */
  dot?: boolean;
  icon?: JSX.Element;
  /** Uppercase operation tags such as DELETE, MOVE, CHMOD. */
  caps?: boolean;
  mono?: boolean;
  class?: string;
  title?: string;
}

/** A text tag: status chips, operation tags, "On-device", "Connected". Always has text. */
export function Pill(props: PillProps): JSX.Element {
  const [local] = splitProps(props, [
    'children',
    'tone',
    'variant',
    'size',
    'dot',
    'icon',
    'caps',
    'mono',
    'class',
    'title',
  ]);
  return (
    <span
      class={cx(
        styles.pill,
        styles[local.tone ?? 'neutral'],
        local.variant === 'solid' && styles.solid,
        local.variant === 'outline' && styles.outline,
        local.size === 'md' && styles.md,
        local.caps === true && styles.caps,
        local.mono === true && styles.mono,
        local.class,
      )}
      title={local.title}
    >
      <Show when={local.dot}>
        <span class={styles.dot} aria-hidden="true" />
      </Show>
      <Show when={local.icon}>
        <span class={styles.icon} aria-hidden="true">
          {local.icon}
        </span>
      </Show>
      {local.children}
    </span>
  );
}

export interface BadgeProps {
  /** The count. Values above `max` show as "max+". */
  count: number;
  max?: number;
  /** Accessible text, e.g. "3 unread notifications". The visual number is hidden from AT. */
  label: string;
  tone?: 'danger' | 'accent' | 'neutral';
  class?: string;
}

/** A numeric count badge (dock icons, sidebar rows, tabs). Renders nothing for 0. */
export function Badge(props: BadgeProps): JSX.Element {
  const [local] = splitProps(props, ['count', 'max', 'label', 'tone', 'class']);
  const text = (): string => {
    const max = local.max ?? 99;
    return local.count > max ? `${max}+` : String(local.count);
  };
  return (
    <Show when={local.count > 0}>
      <span
        class={cx(
          styles.count,
          local.tone === 'accent' && styles.countAccent,
          local.tone === 'neutral' && styles.countNeutral,
          local.class,
        )}
        role="status"
        aria-label={local.label}
      >
        <span aria-hidden="true">{text()}</span>
      </span>
    </Show>
  );
}
