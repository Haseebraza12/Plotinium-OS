import { For, splitProps, type JSX } from 'solid-js';

import { cx } from '../internal/cx.ts';
import styles from './Spinner.module.css';

export interface SpinnerProps {
  /** What is in progress, e.g. "Searching notes". Announced politely. */
  label: string;
  /** Show the label next to the glyph (otherwise it is visually hidden). */
  showLabel?: boolean;
  size?: 'sm' | 'md' | 'lg';
  class?: string;
}

const SPOKES = Array.from({ length: 12 }, (_, i) => i);

/**
 * Indeterminate activity for short in-app waits (an AI answer, a directory listing). Never on
 * the boot path or a system screen, where progress must be real (DSN-07).
 */
export function Spinner(props: SpinnerProps): JSX.Element {
  const [local] = splitProps(props, ['label', 'showLabel', 'size', 'class']);
  return (
    <span
      class={cx(styles.root, styles[local.size ?? 'sm'], local.class)}
      role="status"
      aria-live="polite"
    >
      <svg class={styles.glyph} viewBox="0 0 24 24" aria-hidden="true">
        <For each={SPOKES}>
          {(i) => (
            <rect
              x="11"
              y="1.5"
              width="2"
              height="6"
              rx="1"
              fill="currentColor"
              opacity={String(0.25 + (0.75 * i) / 11)}
              transform={`rotate(${i * 30} 12 12)`}
            />
          )}
        </For>
      </svg>
      <span class={local.showLabel === true ? undefined : styles.hidden}>{local.label}</span>
    </span>
  );
}
