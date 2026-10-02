import ChevronRight from 'lucide-solid/icons/chevron-right';
import { createUniqueId, Show, splitProps, type JSX } from 'solid-js';

import { cx } from '../internal/cx.ts';
import styles from './List.module.css';

export interface ListGroupProps {
  /** Section heading above the card (sentence case; shown in caps by CSS). */
  title?: string;
  footer?: JSX.Element;
  children: JSX.Element;
  class?: string;
}

/** A titled inset card of ListRows (the Settings layout). */
export function ListGroup(props: ListGroupProps): JSX.Element {
  const [local] = splitProps(props, ['title', 'footer', 'children', 'class']);
  const uid = createUniqueId();
  return (
    <section
      class={cx(styles.group, local.class)}
      aria-labelledby={local.title === undefined ? undefined : `pl-lg-${uid}`}
    >
      <Show when={local.title}>
        <h3 class={styles.groupTitle} id={`pl-lg-${uid}`}>
          {local.title}
        </h3>
      </Show>
      <ul class={styles.card} role="list">
        {local.children}
      </ul>
      <Show when={local.footer}>
        <div class={styles.groupFooter}>{local.footer}</div>
      </Show>
    </section>
  );
}

export interface ListRowProps {
  title: JSX.Element;
  subtitle?: JSX.Element;
  /** Icon tile or avatar. */
  leading?: JSX.Element;
  /**
   * Trailing value or controls (a Toggle, a Select, buttons). A row with onClick is itself a
   * button, so its trailing content must not be interactive.
   */
  trailing?: JSX.Element;
  /** Plain trailing text value ("mdbr-leaf-ir (local, 23 MB)"). */
  value?: JSX.Element;
  /** Makes the whole row a button (navigation rows). */
  onClick?: () => void;
  chevron?: boolean;
  selected?: boolean;
  disabled?: boolean;
  class?: string;
}

/** A row in a ListGroup: leading tile, title and subtitle, trailing value or control. */
export function ListRow(props: ListRowProps): JSX.Element {
  const [local] = splitProps(props, [
    'title',
    'subtitle',
    'leading',
    'trailing',
    'value',
    'onClick',
    'chevron',
    'selected',
    'disabled',
    'class',
  ]);
  const body = (): JSX.Element => (
    <>
      <Show when={local.leading}>
        <span class={styles.leading} aria-hidden="true">
          {local.leading}
        </span>
      </Show>
      <span class={styles.content}>
        <span class={styles.title}>{local.title}</span>
        <Show when={local.subtitle}>
          <span class={styles.subtitle}>{local.subtitle}</span>
        </Show>
      </span>
      <Show
        when={local.value !== undefined || local.trailing !== undefined || local.chevron === true}
      >
        <span class={styles.trailing}>
          <Show when={local.value}>
            <span class={styles.value}>{local.value}</span>
          </Show>
          {local.trailing}
          <Show when={local.chevron}>
            <span class={styles.chevron} aria-hidden="true">
              <ChevronRight size={14} />
            </span>
          </Show>
        </span>
      </Show>
    </>
  );
  const rowClass = (): string =>
    cx(
      styles.row,
      local.selected === true && styles.selected,
      local.disabled === true && styles.disabled,
      local.class,
    );
  return (
    <li class={styles.item}>
      <Show when={local.onClick} fallback={<div class={rowClass()}>{body()}</div>}>
        {(onClick) => (
          <button
            type="button"
            class={rowClass()}
            aria-current={local.selected === true ? 'true' : undefined}
            aria-disabled={local.disabled === true ? 'true' : undefined}
            onClick={() => {
              if (local.disabled !== true) onClick()();
            }}
          >
            {body()}
          </button>
        )}
      </Show>
    </li>
  );
}
