import CircleAlert from 'lucide-solid/icons/circle-alert';
import { createUniqueId, Show, splitProps, type JSX } from 'solid-js';

import { cx } from '../internal/cx.ts';
import styles from './TextField.module.css';

export interface TextFieldProps {
  label: string;
  value: string;
  onInput: (value: string) => void;
  type?: 'text' | 'password' | 'email' | 'url' | 'number' | 'tel';
  placeholder?: string;
  /** Help text under the field (aria-describedby). */
  hint?: string;
  /** Error text; also sets aria-invalid. Shown with an icon, never colour alone. */
  error?: string;
  hideLabel?: boolean;
  required?: boolean;
  disabled?: boolean;
  readOnly?: boolean;
  size?: 'md' | 'lg';
  mono?: boolean;
  leading?: JSX.Element;
  trailing?: JSX.Element;
  name?: string;
  autocomplete?: string;
  autofocus?: boolean;
  id?: string;
  class?: string;
  inputRef?: (el: HTMLInputElement) => void;
  onKeyDown?: (event: KeyboardEvent) => void;
  onBlur?: (event: FocusEvent) => void;
}

/** A labelled single-line text input with hint and error lines. Paste is always allowed. */
export function TextField(props: TextFieldProps): JSX.Element {
  const [local] = splitProps(props, [
    'label',
    'value',
    'onInput',
    'type',
    'placeholder',
    'hint',
    'error',
    'hideLabel',
    'required',
    'disabled',
    'readOnly',
    'size',
    'mono',
    'leading',
    'trailing',
    'name',
    'autocomplete',
    'autofocus',
    'id',
    'class',
    'inputRef',
    'onKeyDown',
    'onBlur',
  ]);
  const uid = createUniqueId();
  const id = (): string => local.id ?? `pl-text-${uid}`;
  const describedBy = (): string | undefined => {
    const ids = [
      local.hint === undefined ? '' : `${id()}-hint`,
      local.error === undefined ? '' : `${id()}-error`,
    ]
      .filter((s) => s !== '')
      .join(' ');
    return ids === '' ? undefined : ids;
  };
  return (
    <div
      class={cx(
        styles.root,
        local.size === 'lg' && styles.lg,
        local.mono === true && styles.mono,
        local.error !== undefined && styles.invalid,
        local.disabled === true && styles.disabled,
        local.class,
      )}
    >
      <label for={id()} class={cx(styles.label, local.hideLabel === true && styles.hidden)}>
        {local.label}
        <Show when={local.required}>
          <span class={styles.required} aria-hidden="true">
            {' '}
            (required)
          </span>
        </Show>
      </label>
      <div class={styles.field}>
        <Show when={local.leading}>
          <span class={styles.adornment} aria-hidden="true">
            {local.leading}
          </span>
        </Show>
        <input
          ref={(el) => local.inputRef?.(el)}
          id={id()}
          class={styles.input}
          type={local.type ?? 'text'}
          name={local.name}
          value={local.value}
          placeholder={local.placeholder}
          required={local.required}
          disabled={local.disabled}
          readOnly={local.readOnly}
          autocomplete={local.autocomplete}
          autofocus={local.autofocus}
          aria-invalid={local.error === undefined ? undefined : true}
          aria-describedby={describedBy()}
          onInput={(event) => local.onInput(event.currentTarget.value)}
          onKeyDown={(event) => local.onKeyDown?.(event)}
          onBlur={(event) => local.onBlur?.(event)}
        />
        <Show when={local.trailing}>
          <span class={styles.adornment}>{local.trailing}</span>
        </Show>
      </div>
      <Show when={local.hint}>
        <p class={styles.hint} id={`${id()}-hint`}>
          {local.hint}
        </p>
      </Show>
      <Show when={local.error}>
        <p class={styles.error} id={`${id()}-error`} aria-live="polite">
          <CircleAlert size={12} aria-hidden="true" />
          {local.error}
        </p>
      </Show>
    </div>
  );
}
