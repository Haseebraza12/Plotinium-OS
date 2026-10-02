import ChevronRight from 'lucide-solid/icons/chevron-right';
import Lock from 'lucide-solid/icons/lock';
import { createUniqueId, Show, splitProps, type JSX } from 'solid-js';

import { cx } from '../../primitives/internal/cx.ts';
import { Select, type SelectOption } from '../../primitives/select/Select.tsx';
import { Slider } from '../../primitives/slider/Slider.tsx';
import { Toggle } from '../../primitives/toggle/Toggle.tsx';
import { Tooltip } from '../../primitives/tooltip/Tooltip.tsx';
import styles from './controls.module.css';

/** A titled inset card (macOS grouped list). The pane title is the h1, so groups are h2. */
export function Group(props: {
  title?: string;
  description?: JSX.Element;
  footer?: JSX.Element;
  /** Stagger slot for the first-show rise (30 ms per group). */
  index?: number;
  class?: string;
  children: JSX.Element;
}): JSX.Element {
  const uid = createUniqueId();
  return (
    <section
      class={cx(styles.group, props.class)}
      aria-labelledby={props.title === undefined ? undefined : `pl-sg-${uid}`}
      style={{ '--pl-stagger-index': String(props.index ?? 0) }}
    >
      <Show when={props.title}>
        <h2 class={styles.groupTitle} id={`pl-sg-${uid}`}>
          {props.title}
        </h2>
      </Show>
      <Show when={props.description}>
        {(description) => <p class={styles.groupDescription}>{description()}</p>}
      </Show>
      <div class={styles.card}>{props.children}</div>
      <Show when={props.footer}>
        {(footer) => <div class={styles.groupFooter}>{footer()}</div>}
      </Show>
    </section>
  );
}

/** A row: title and description on the left, a control or value on the right. */
export function Row(props: {
  title: JSX.Element;
  description?: JSX.Element;
  control?: JSX.Element;
  /** Content under the row (a table, a bar). */
  children?: JSX.Element;
  titleId?: string;
  descriptionId?: string;
  /** Visual only: the control carries the accessible name. */
  hideTextFromAT?: boolean;
  class?: string;
}): JSX.Element {
  return (
    <div class={cx(styles.row, props.class)}>
      <div class={styles.rowLine}>
        <div
          class={styles.rowText}
          aria-hidden={props.hideTextFromAT === true ? 'true' : undefined}
        >
          <span class={styles.rowTitle} id={props.titleId}>
            {props.title}
          </span>
          <Show when={props.description}>
            {(description) => (
              <span class={styles.rowDescription} id={props.descriptionId}>
                {description()}
              </span>
            )}
          </Show>
        </div>
        <Show when={props.control}>
          {(control) => <div class={styles.rowControl}>{control()}</div>}
        </Show>
      </div>
      {props.children}
    </div>
  );
}

/** A read-only value row ("Kernel · plotinium 0.3.0-a1f93c2"). */
export function ValueRow(props: {
  title: string;
  value: JSX.Element;
  mono?: boolean;
}): JSX.Element {
  return (
    <Row
      title={props.title}
      control={
        <span class={cx(styles.value, props.mono === true && styles.mono)}>{props.value}</span>
      }
    />
  );
}

/** A switch row. The whole label toggles it; `locked` keeps it focusable and states the reason. */
export function ToggleRow(props: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  /** Locked on (or off) by policy: the reason is the tooltip and part of the description. */
  locked?: string;
  /**
   * The setting has no effect in this build (UI-042): the switch is disabled and this note
   * replaces the description.
   */
  unavailable?: string;
}): JSX.Element {
  const [local] = splitProps(props, [
    'label',
    'description',
    'checked',
    'onChange',
    'disabled',
    'locked',
    'unavailable',
  ]);
  const toggle = (): JSX.Element => (
    <Toggle
      class={styles.toggle}
      label={local.label}
      description={local.unavailable ?? local.description}
      checked={local.checked}
      disabled={
        local.disabled === true || local.locked !== undefined || local.unavailable !== undefined
      }
      onChange={(next) => local.onChange(next)}
    />
  );
  return (
    <div class={cx(styles.row, local.locked !== undefined && styles.locked)}>
      <Show when={local.locked} fallback={toggle()}>
        {(reason) => (
          <div class={styles.lockedLine}>
            <span class={styles.lockGlyph} aria-hidden="true">
              <Lock size={11} />
            </span>
            <Tooltip content={reason()} placement="top">
              {toggle()}
            </Tooltip>
          </div>
        )}
      </Show>
    </div>
  );
}

/** A pop-up button row. */
export function SelectRow<T extends string>(props: {
  label: string;
  description?: string;
  value: T;
  options: readonly SelectOption<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
  /** The setting has no effect in this build (UI-042): disabled, with this note. */
  unavailable?: string;
}): JSX.Element {
  const uid = createUniqueId();
  const description = (): string | undefined => props.unavailable ?? props.description;
  return (
    <Row
      title={props.label}
      description={description()}
      descriptionId={`pl-sel-${uid}-desc`}
      hideTextFromAT
      control={
        <Select
          label={props.label}
          hideLabel
          size="sm"
          value={props.value}
          options={props.options}
          disabled={props.disabled === true || props.unavailable !== undefined}
          describedBy={description() === undefined ? undefined : `pl-sel-${uid}-desc`}
          onChange={(value) => props.onChange(value)}
        />
      }
    />
  );
}

/** A slider row with its value, range hints and an optional warning line. */
export function SliderRow(props: {
  label: string;
  description?: JSX.Element;
  value: number;
  min: number;
  max: number;
  step?: number;
  format: (value: number) => string;
  onInput: (value: number) => void;
  onCommit?: (value: number) => void;
  /** A note under the slider (warning tone), e.g. "Lowering below 231 MB starts reclaim now". */
  note?: string;
  disabled?: boolean;
}): JSX.Element {
  const uid = createUniqueId();
  return (
    <div class={styles.row}>
      <div class={styles.rowLine}>
        <div class={styles.rowText}>
          <label class={styles.rowTitle} for={`pl-sr-${uid}`}>
            {props.label}
          </label>
          <Show when={props.description}>
            {(description) => <span class={styles.rowDescription}>{description()}</span>}
          </Show>
        </div>
        <output class={styles.readout} for={`pl-sr-${uid}`}>
          {props.format(props.value)}
        </output>
      </div>
      <div class={styles.sliderLine}>
        <span class={styles.rangeEdge} aria-hidden="true">
          {props.format(props.min)}
        </span>
        <Slider
          id={`pl-sr-${uid}`}
          class={styles.slider}
          label={props.label}
          min={props.min}
          max={props.max}
          step={props.step}
          value={props.value}
          format={props.format}
          disabled={props.disabled}
          onInput={(v) => props.onInput(v)}
          onCommit={(v) => props.onCommit?.(v)}
        />
        <span class={styles.rangeEdge} aria-hidden="true">
          {props.format(props.max)}
        </span>
      </div>
      <Show when={props.note}>
        {(note) => (
          <p class={styles.note} role="status">
            {note()}
          </p>
        )}
      </Show>
    </div>
  );
}

/** A navigation row that jumps to another section. */
export function NavRow(props: {
  title: string;
  value?: string;
  icon?: JSX.Element;
  onClick: () => void;
}): JSX.Element {
  return (
    <button type="button" class={cx(styles.row, styles.navRow)} onClick={() => props.onClick()}>
      <span class={styles.rowLine}>
        <span class={styles.navTitle}>
          <Show when={props.icon}>
            {(icon) => (
              <span class={styles.navIcon} aria-hidden="true">
                {icon()}
              </span>
            )}
          </Show>
          {props.title}
        </span>
        <span class={styles.navValue}>
          {props.value}
          <ChevronRight size={14} aria-hidden="true" />
        </span>
      </span>
    </button>
  );
}

/** An in-pane banner (guests, safe mode, errors). */
export function Banner(props: {
  tone?: 'info' | 'warning' | 'danger';
  children: JSX.Element;
  icon?: JSX.Element;
}): JSX.Element {
  return (
    <div
      class={cx(styles.banner, styles[`banner-${props.tone ?? 'info'}`])}
      role={props.tone === 'danger' ? 'alert' : 'status'}
    >
      <Show when={props.icon}>
        {(icon) => (
          <span class={styles.bannerIcon} aria-hidden="true">
            {icon()}
          </span>
        )}
      </Show>
      <span>{props.children}</span>
    </div>
  );
}
