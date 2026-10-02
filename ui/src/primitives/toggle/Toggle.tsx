import { createUniqueId, Show, splitProps, type JSX } from 'solid-js';

import { cx } from '../internal/cx.ts';
import styles from './Toggle.module.css';

export interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Visible label (or the accessible name only, with hideLabel). */
  label: string;
  /** Secondary line under the label, linked with aria-describedby. */
  description?: string;
  hideLabel?: boolean;
  disabled?: boolean;
  size?: 'sm' | 'md';
  id?: string;
  class?: string;
}

/**
 * A switch (role="switch"). Space and Enter toggle it because it is a native button; the text
 * is a <label>, so clicking the label also toggles it.
 */
export function Toggle(props: ToggleProps): JSX.Element {
  const [local] = splitProps(props, [
    'checked',
    'onChange',
    'label',
    'description',
    'hideLabel',
    'disabled',
    'size',
    'id',
    'class',
  ]);
  const uid = createUniqueId();
  const id = (): string => local.id ?? `pl-toggle-${uid}`;
  const toggle = (): void => {
    if (local.disabled !== true) local.onChange(!local.checked);
  };
  return (
    <label class={cx(styles.root, local.size === 'sm' && styles.sm, local.class)}>
      <span class={cx(styles.text, local.hideLabel === true && styles.hidden)}>
        <span class={styles.label} id={`${id()}-label`}>
          {local.label}
        </span>
        <Show when={local.description}>
          <span class={styles.description} id={`${id()}-desc`}>
            {local.description}
          </span>
        </Show>
      </span>
      <button
        type="button"
        role="switch"
        id={id()}
        class={styles.track}
        aria-checked={local.checked}
        aria-labelledby={`${id()}-label`}
        aria-describedby={local.description === undefined ? undefined : `${id()}-desc`}
        aria-disabled={local.disabled === true ? 'true' : undefined}
        onClick={toggle}
      >
        <span class={styles.knob} aria-hidden="true" />
      </button>
    </label>
  );
}
