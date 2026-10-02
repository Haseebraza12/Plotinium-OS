import { Show, splitProps, type JSX } from 'solid-js';

import { cx } from '../internal/cx.ts';
import styles from './Slider.module.css';

export interface SliderProps {
  value: number;
  onInput: (value: number) => void;
  /** Fires once when the user releases the thumb or commits with the keyboard. */
  onCommit?: (value: number) => void;
  label: string;
  min?: number;
  max?: number;
  step?: number;
  /** Human-readable value for assistive tech and the optional readout, e.g. "128 MB". */
  format?: (value: number) => string;
  showValue?: boolean;
  /** Decorative icons at the low and high ends (e.g. volume). */
  startIcon?: JSX.Element;
  endIcon?: JSX.Element;
  variant?: 'default' | 'large';
  disabled?: boolean;
  id?: string;
  class?: string;
}

/** A continuous or stepped value (native range input: arrows, Page Up/Down, Home/End). */
export function Slider(props: SliderProps): JSX.Element {
  const [local] = splitProps(props, [
    'value',
    'onInput',
    'onCommit',
    'label',
    'min',
    'max',
    'step',
    'format',
    'showValue',
    'startIcon',
    'endIcon',
    'variant',
    'disabled',
    'id',
    'class',
  ]);
  const min = (): number => local.min ?? 0;
  const max = (): number => local.max ?? 100;
  const pct = (): number => {
    const span = max() - min();
    return span <= 0 ? 0 : Math.min(100, Math.max(0, ((local.value - min()) / span) * 100));
  };
  const text = (): string => local.format?.(local.value) ?? String(local.value);
  return (
    <div
      class={cx(
        styles.root,
        local.variant === 'large' && styles.large,
        local.disabled === true && styles.disabled,
        local.class,
      )}
    >
      <Show when={local.startIcon}>
        <span class={styles.edge} aria-hidden="true">
          {local.startIcon}
        </span>
      </Show>
      <input
        id={local.id}
        type="range"
        class={styles.input}
        style={{ '--pl-slider-pct': `${pct()}%` }}
        aria-label={local.label}
        aria-valuetext={local.format === undefined ? undefined : text()}
        min={min()}
        max={max()}
        step={local.step ?? 1}
        value={local.value}
        disabled={local.disabled}
        onInput={(event) => local.onInput(event.currentTarget.valueAsNumber)}
        onChange={(event) => local.onCommit?.(event.currentTarget.valueAsNumber)}
      />
      <Show when={local.endIcon}>
        <span class={styles.edge} aria-hidden="true">
          {local.endIcon}
        </span>
      </Show>
      <Show when={local.showValue}>
        <output class={styles.value} aria-hidden="true">
          {text()}
        </output>
      </Show>
    </div>
  );
}
