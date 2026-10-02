import CircleX from 'lucide-solid/icons/circle-x';
import Search from 'lucide-solid/icons/search';
import { Show, splitProps, type JSX } from 'solid-js';

import { cx } from '../internal/cx.ts';
import styles from './SearchField.module.css';

export interface SearchFieldProps {
  value: string;
  onInput: (value: string) => void;
  /** Enter pressed. */
  onSubmit?: (value: string) => void;
  /** Accessible name (placeholders are not labels). */
  label: string;
  placeholder?: string;
  size?: 'md' | 'lg';
  /** Rounded capsule, as in toolbars and the Search palette. */
  pill?: boolean;
  /** Extra trailing content, e.g. a Kbd shortcut hint or a mode chip. */
  trailing?: JSX.Element;
  autofocus?: boolean;
  id?: string;
  class?: string;
  inputRef?: (el: HTMLInputElement) => void;
  onKeyDown?: (event: KeyboardEvent) => void;
}

/** A search box: magnifier, clear button, Escape clears (then bubbles when already empty). */
export function SearchField(props: SearchFieldProps): JSX.Element {
  const [local] = splitProps(props, [
    'value',
    'onInput',
    'onSubmit',
    'label',
    'placeholder',
    'size',
    'pill',
    'trailing',
    'autofocus',
    'id',
    'class',
    'inputRef',
    'onKeyDown',
  ]);
  let input: HTMLInputElement | undefined;

  const onKeyDown = (event: KeyboardEvent): void => {
    local.onKeyDown?.(event);
    if (event.defaultPrevented) return;
    if (event.key === 'Escape' && local.value !== '') {
      event.preventDefault();
      event.stopPropagation();
      local.onInput('');
    } else if (event.key === 'Enter') {
      local.onSubmit?.(local.value);
    }
  };

  return (
    <div
      role="search"
      class={cx(
        styles.root,
        local.size === 'lg' && styles.lg,
        local.pill === true && styles.pill,
        local.class,
      )}
    >
      <span class={styles.icon} aria-hidden="true">
        <Search size={local.size === 'lg' ? 18 : 14} />
      </span>
      <input
        ref={(el) => {
          input = el;
          local.inputRef?.(el);
        }}
        id={local.id}
        type="search"
        class={styles.input}
        aria-label={local.label}
        placeholder={local.placeholder}
        value={local.value}
        autofocus={local.autofocus}
        autocomplete="off"
        spellcheck={false}
        onInput={(event) => local.onInput(event.currentTarget.value)}
        onKeyDown={onKeyDown}
      />
      <span class={styles.trailing}>
        <Show when={local.value !== ''}>
          <button
            type="button"
            class={styles.clear}
            aria-label="Clear search"
            onClick={() => {
              local.onInput('');
              input?.focus();
            }}
          >
            <CircleX size={14} aria-hidden="true" />
          </button>
        </Show>
        {local.trailing}
      </span>
    </div>
  );
}
