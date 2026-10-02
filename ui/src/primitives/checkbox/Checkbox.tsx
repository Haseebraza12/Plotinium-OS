import Check from 'lucide-solid/icons/check';
import Minus from 'lucide-solid/icons/minus';
import { createEffect, createSignal, createUniqueId, Show, splitProps, type JSX } from 'solid-js';

import { cx } from '../internal/cx.ts';
import styles from './Checkbox.module.css';

export interface CheckboxProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  description?: string;
  /** Mixed state (a parent row with some children selected); shown as a dash. */
  indeterminate?: boolean;
  disabled?: boolean;
  name?: string;
  value?: string;
  id?: string;
  class?: string;
}

/** A native checkbox with the macOS look; keyboard, forms and mixed state come for free. */
export function Checkbox(props: CheckboxProps): JSX.Element {
  const [local] = splitProps(props, [
    'checked',
    'onChange',
    'label',
    'description',
    'indeterminate',
    'disabled',
    'name',
    'value',
    'id',
    'class',
  ]);
  const uid = createUniqueId();
  const id = (): string => local.id ?? `pl-checkbox-${uid}`;
  const [input, setInput] = createSignal<HTMLInputElement>();
  // `indeterminate` is a DOM property with no attribute.
  createEffect(() => {
    const el = input();
    if (el !== undefined) el.indeterminate = local.indeterminate === true;
  });
  return (
    <label
      class={cx(styles.root, local.disabled === true && styles.disabled, local.class)}
      for={id()}
    >
      <span class={styles.control}>
        <input
          ref={setInput}
          type="checkbox"
          class={styles.input}
          id={id()}
          name={local.name}
          value={local.value}
          checked={local.checked}
          disabled={local.disabled}
          aria-describedby={local.description === undefined ? undefined : `${id()}-desc`}
          onChange={(event) => local.onChange(event.currentTarget.checked)}
        />
        <span class={styles.box} aria-hidden="true">
          <span class={cx(styles.mark, styles.check)}>
            <Check size={12} stroke-width={3.2} />
          </span>
          <span class={cx(styles.mark, styles.dash)}>
            <Minus size={12} stroke-width={3.2} />
          </span>
        </span>
      </span>
      <span class={styles.text}>
        <span>{local.label}</span>
        <Show when={local.description}>
          <span class={styles.description} id={`${id()}-desc`}>
            {local.description}
          </span>
        </Show>
      </span>
    </label>
  );
}
