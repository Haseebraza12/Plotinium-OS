import Check from 'lucide-solid/icons/check';
import ChevronsUpDown from 'lucide-solid/icons/chevrons-up-down';
import {
  createMemo,
  createSignal,
  createUniqueId,
  For,
  Show,
  splitProps,
  type JSX,
} from 'solid-js';
import { Dynamic } from 'solid-js/web';

import { cx } from '../internal/cx.ts';
import { Floating } from '../internal/Floating.tsx';
import type { IconComponent } from '../internal/icon.ts';
import { createDismissableLayer } from '../internal/layers.ts';
import {
  createTypeahead,
  firstEnabled,
  isPrintableKey,
  lastEnabled,
  matchTypeahead,
  stepIndex,
} from '../internal/list-nav.ts';
import { createPresence } from '../internal/presence.ts';
import styles from './Select.module.css';

export interface SelectOption<T extends string> {
  value: T;
  label: string;
  icon?: IconComponent;
  disabled?: boolean;
}

export interface SelectProps<T extends string> {
  value: T | undefined;
  options: readonly SelectOption<T>[];
  onChange: (value: T) => void;
  label: string;
  hideLabel?: boolean;
  placeholder?: string;
  size?: 'sm' | 'md';
  disabled?: boolean;
  /** Id of an element that describes the control (a hint or why it is disabled). */
  describedBy?: string;
  id?: string;
  class?: string;
}

/**
 * A pop-up button (APG select-only combobox). Focus stays on the button; the glass list shows
 * the active option with aria-activedescendant. Closed: arrows, Enter, Space open; type-ahead
 * selects directly. Open: arrows, Home/End, type-ahead move; Enter/Space choose; Escape and
 * Tab close.
 */
export function Select<T extends string>(props: SelectProps<T>): JSX.Element {
  const [local] = splitProps(props, [
    'value',
    'options',
    'onChange',
    'label',
    'hideLabel',
    'placeholder',
    'size',
    'disabled',
    'describedBy',
    'id',
    'class',
  ]);
  const uid = createUniqueId();
  const id = (): string => local.id ?? `pl-select-${uid}`;
  const [open, setOpen] = createSignal(false);
  const [active, setActive] = createSignal(-1);
  const presence = createPresence(open, 100);
  const typeahead = createTypeahead();
  const [button, setButton] = createSignal<HTMLButtonElement>();
  let list: HTMLDivElement | undefined;

  const selectedIndex = createMemo(() => local.options.findIndex((o) => o.value === local.value));
  const selected = (): SelectOption<T> | undefined => local.options[selectedIndex()];
  const isDisabled = (i: number): boolean => local.options[i]?.disabled === true;
  const optionId = (i: number): string => `${id()}-opt-${i}`;

  const show = (focus: 'selected' | 'first' | 'last' = 'selected'): void => {
    if (local.disabled === true) return;
    const count = local.options.length;
    const start =
      focus === 'last'
        ? lastEnabled(count, isDisabled)
        : focus === 'first' || selectedIndex() < 0
          ? firstEnabled(count, isDisabled)
          : selectedIndex();
    setActive(start);
    setOpen(true);
  };
  const hide = (): void => {
    setOpen(false);
  };
  const choose = (index: number): void => {
    const option = local.options[index];
    if (option === undefined || option.disabled === true) return;
    if (option.value !== local.value) local.onChange(option.value);
    hide();
    button()?.focus();
  };

  createDismissableLayer({
    active: open,
    inside: () => [list, button()],
    onEscape: hide,
    onOutside: hide,
  });

  const onKeyDown = (event: KeyboardEvent): void => {
    if (local.disabled === true) return;
    const count = local.options.length;
    if (!open()) {
      if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') show();
      else if (event.key === 'ArrowUp') show('selected');
      else if (event.key === 'Home') show('first');
      else if (event.key === 'End') show('last');
      else if (isPrintableKey(event)) {
        const labels = local.options.map((o) => o.label);
        const match = matchTypeahead(
          labels,
          typeahead(event.key, event.timeStamp),
          selectedIndex(),
          isDisabled,
        );
        if (match >= 0) choose(match);
      } else return;
      event.preventDefault();
      return;
    }
    switch (event.key) {
      case 'ArrowDown':
        setActive(stepIndex(active(), 1, count, isDisabled, false));
        break;
      case 'ArrowUp':
        setActive(stepIndex(active(), -1, count, isDisabled, false));
        break;
      case 'Home':
        setActive(firstEnabled(count, isDisabled));
        break;
      case 'End':
        setActive(lastEnabled(count, isDisabled));
        break;
      case 'Enter':
      case ' ':
        choose(active());
        break;
      case 'Tab':
        choose(active());
        return;
      case 'Escape':
        // The dismissable layer closes it.
        return;
      default: {
        if (!isPrintableKey(event)) return;
        const labels = local.options.map((o) => o.label);
        const match = matchTypeahead(
          labels,
          typeahead(event.key, event.timeStamp),
          active(),
          isDisabled,
        );
        if (match >= 0) setActive(match);
      }
    }
    event.preventDefault();
  };

  return (
    <div class={cx(styles.root, local.size === 'sm' && styles.sm, local.class)}>
      <span
        id={`${id()}-label`}
        class={cx(styles.label, local.hideLabel === true && styles.hidden)}
      >
        {local.label}
      </span>
      <button
        ref={setButton}
        id={id()}
        type="button"
        role="combobox"
        class={styles.button}
        aria-labelledby={`${id()}-label ${id()}-value`}
        aria-haspopup="listbox"
        aria-expanded={open()}
        aria-describedby={local.describedBy}
        // Only while the listbox exists: a reference to a missing id is invalid ARIA.
        aria-controls={presence.mounted() ? `${id()}-list` : undefined}
        aria-activedescendant={open() && active() >= 0 ? optionId(active()) : undefined}
        aria-disabled={local.disabled === true ? 'true' : undefined}
        onClick={() => (open() ? hide() : show())}
        onKeyDown={onKeyDown}
      >
        <span
          id={`${id()}-value`}
          class={cx(styles.value, selected() === undefined && styles.placeholder)}
        >
          {selected()?.label ?? local.placeholder ?? 'Choose…'}
        </span>
        <span class={styles.chevron} aria-hidden="true">
          <ChevronsUpDown size={12} stroke-width={2.4} />
        </span>
      </button>
      <Show when={presence.mounted()}>
        <Floating
          anchor={button()}
          placement="bottom-start"
          offset={4}
          matchAnchorWidth
          id={`${id()}-list`}
          role="listbox"
          aria-labelledby={`${id()}-label`}
          tabindex={-1}
          data-state={presence.state()}
          class={cx(
            styles.listbox,
            presence.state() === 'closing' ? 'pl-anim-menu-out' : 'pl-anim-menu-in',
          )}
          floatingRef={(el) => (list = el)}
        >
          <For each={local.options}>
            {(option, index) => (
              <div
                id={optionId(index())}
                role="option"
                class={styles.option}
                aria-selected={option.value === local.value}
                aria-disabled={option.disabled === true ? 'true' : undefined}
                data-active={active() === index()}
                onPointerMove={() => {
                  if (!isDisabled(index())) setActive(index());
                }}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => choose(index())}
              >
                <span class={styles.check} aria-hidden="true">
                  <Show when={option.value === local.value}>
                    <Check size={13} stroke-width={2.6} />
                  </Show>
                </span>
                <Show when={option.icon} fallback={<span />}>
                  {(icon) => (
                    <span class={styles.optionIcon} aria-hidden="true">
                      <Dynamic component={icon()} size={15} />
                    </span>
                  )}
                </Show>
                <span>{option.label}</span>
              </div>
            )}
          </For>
        </Floating>
      </Show>
    </div>
  );
}
