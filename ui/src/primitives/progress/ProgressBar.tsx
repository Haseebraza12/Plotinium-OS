import { Show, splitProps, type JSX } from 'solid-js';

import { cx } from '../internal/cx.ts';
import styles from './Progress.module.css';

export type ProgressTone = 'accent' | 'success' | 'warning' | 'danger' | 'neutral';

export interface ProgressBarProps {
  /** 0..max. There is no indeterminate state (DSN-07): progress shows real work. */
  value: number;
  max?: number;
  /** Accessible name; shown above the bar unless hideLabel. */
  label: string;
  hideLabel?: boolean;
  /** Spoken and shown value, e.g. "3,118 of 3,530 chunks". Defaults to a percentage. */
  valueText?: string;
  showValue?: boolean;
  tone?: ProgressTone;
  size?: 'sm' | 'md';
  /** A sheen crosses the fill (boot and restore); bounded, off under reduced motion. */
  sweep?: boolean;
  class?: string;
}

/** A determinate progress bar (role="progressbar" with live values; BOOT-13). */
export function ProgressBar(props: ProgressBarProps): JSX.Element {
  const [local] = splitProps(props, [
    'value',
    'max',
    'label',
    'hideLabel',
    'valueText',
    'showValue',
    'tone',
    'size',
    'sweep',
    'class',
  ]);
  const max = (): number => (local.max !== undefined && local.max > 0 ? local.max : 100);
  const ratio = (): number => Math.min(1, Math.max(0, local.value / max()));
  const text = (): string => local.valueText ?? `${Math.round(ratio() * 100)}%`;
  return (
    <div
      class={cx(
        styles.root,
        local.size === 'sm' && styles.sm,
        local.tone !== undefined && local.tone !== 'accent' && styles[local.tone],
        local.class,
      )}
    >
      <Show when={local.hideLabel !== true || local.showValue === true}>
        <div class={styles.header} aria-hidden="true">
          <span class={styles.label}>{local.hideLabel === true ? '' : local.label}</span>
          <Show when={local.showValue}>
            <span class={styles.value}>{text()}</span>
          </Show>
        </div>
      </Show>
      <div
        class={styles.track}
        role="progressbar"
        aria-label={local.label}
        aria-valuemin={0}
        aria-valuemax={max()}
        aria-valuenow={Math.min(max(), Math.max(0, local.value))}
        aria-valuetext={text()}
      >
        <div class={styles.fill} style={{ '--pl-progress-ratio': String(ratio()) }}>
          <Show when={local.sweep}>
            <span class={cx(styles.sheen, 'pl-anim-progress-sweep')} />
          </Show>
        </div>
      </div>
    </div>
  );
}
