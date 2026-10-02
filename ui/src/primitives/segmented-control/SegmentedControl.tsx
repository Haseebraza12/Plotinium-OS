import { createMemo, For, Show, splitProps, type JSX } from 'solid-js';
import { Dynamic } from 'solid-js/web';

import { cx } from '../internal/cx.ts';
import type { IconComponent } from '../internal/icon.ts';
import { firstEnabled, lastEnabled, stepIndex } from '../internal/list-nav.ts';
import styles from './SegmentedControl.module.css';

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  icon?: IconComponent;
  /** Show only the icon; the label stays the accessible name. */
  iconOnly?: boolean;
  disabled?: boolean;
}

export interface SegmentedControlProps<T extends string> {
  options: readonly SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Accessible name of the group. */
  label: string;
  size?: 'sm' | 'md';
  /** accent: the selected segment is filled with the accent (Terminal/Editor mode switches). */
  tone?: 'neutral' | 'accent';
  fullWidth?: boolean;
  class?: string;
}

/**
 * Mutually exclusive choices (APG radio group): one tab stop, arrow keys move and select,
 * Home/End jump. The highlight slides between segments with a spring.
 */
export function SegmentedControl<T extends string>(props: SegmentedControlProps<T>): JSX.Element {
  const [local] = splitProps(props, [
    'options',
    'value',
    'onChange',
    'label',
    'size',
    'tone',
    'fullWidth',
    'class',
  ]);
  const refs: HTMLButtonElement[] = [];
  const selectedIndex = createMemo(() =>
    Math.max(
      0,
      local.options.findIndex((o) => o.value === local.value),
    ),
  );
  const isDisabled = (i: number): boolean => local.options[i]?.disabled === true;

  const select = (index: number): void => {
    const option = local.options[index];
    if (option === undefined || option.disabled === true) return;
    refs[index]?.focus();
    if (option.value !== local.value) local.onChange(option.value);
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    const count = local.options.length;
    let next: number;
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        next = stepIndex(selectedIndex(), 1, count, isDisabled, true);
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        next = stepIndex(selectedIndex(), -1, count, isDisabled, true);
        break;
      case 'Home':
        next = firstEnabled(count, isDisabled);
        break;
      case 'End':
        next = lastEnabled(count, isDisabled);
        break;
      default:
        return;
    }
    event.preventDefault();
    select(next);
  };

  return (
    <div
      role="radiogroup"
      aria-label={local.label}
      class={cx(
        styles.root,
        local.size === 'sm' && styles.sm,
        local.tone === 'accent' && styles.accent,
        local.fullWidth === true && styles.full,
        local.class,
      )}
      style={{
        '--pl-seg-count': String(local.options.length),
        '--pl-seg-index': String(selectedIndex()),
      }}
      onKeyDown={onKeyDown}
    >
      <span class={styles.thumb} aria-hidden="true" />
      <For each={local.options}>
        {(option, index) => (
          <button
            ref={(el) => (refs[index()] = el)}
            type="button"
            role="radio"
            class={styles.segment}
            aria-checked={option.value === local.value}
            tabindex={index() === selectedIndex() ? 0 : -1}
            disabled={option.disabled}
            onClick={() => select(index())}
          >
            <Show when={option.icon}>
              {(icon) => (
                <span class={styles.icon} aria-hidden="true">
                  <Dynamic component={icon()} size={14} />
                </span>
              )}
            </Show>
            <span class={option.iconOnly === true ? styles.hidden : undefined}>{option.label}</span>
          </button>
        )}
      </For>
    </div>
  );
}
