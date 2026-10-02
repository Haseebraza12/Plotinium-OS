import Check from 'lucide-solid/icons/check';
import { For, Show, splitProps, type JSX } from 'solid-js';

import { cx } from '../../../primitives/internal/cx.ts';
import { firstEnabled, lastEnabled, stepIndex } from '../../../primitives/internal/list-nav.ts';
import { Group, SelectRow } from '../controls.tsx';
import type { AccentId, SettingChange, SettingValues, ThemePref } from '../models.ts';
import styles from './AppearancePane.module.css';

const THEMES: readonly { value: ThemePref; label: string }[] = [
  { value: 'system', label: 'Follow system' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

export const ACCENTS: readonly { value: AccentId; label: string }[] = [
  { value: 'violet', label: 'Violet' },
  { value: 'blue', label: 'Blue' },
  { value: 'purple', label: 'Purple' },
  { value: 'pink', label: 'Pink' },
  { value: 'red', label: 'Red' },
  { value: 'orange', label: 'Orange' },
  { value: 'yellow', label: 'Yellow' },
  { value: 'green', label: 'Green' },
  { value: 'graphite', label: 'Graphite' },
];

/** Arrow keys move and select inside a radio group (APG radio group, wrapping). */
function radioKeys<T>(
  event: KeyboardEvent,
  values: readonly T[],
  current: T,
  select: (value: T, index: number) => void,
): void {
  const count = values.length;
  const index = Math.max(0, values.indexOf(current));
  const none = (): boolean => false;
  let next: number;
  switch (event.key) {
    case 'ArrowRight':
    case 'ArrowDown':
      next = stepIndex(index, 1, count, none, true);
      break;
    case 'ArrowLeft':
    case 'ArrowUp':
      next = stepIndex(index, -1, count, none, true);
      break;
    case 'Home':
      next = firstEnabled(count, none);
      break;
    case 'End':
      next = lastEnabled(count, none);
      break;
    default:
      return;
  }
  event.preventDefault();
  const value = values[next];
  if (value !== undefined) select(value, next);
}

/** A miniature desktop drawn in one theme (data-theme scopes the tokens). */
function Preview(props: { theme: 'light' | 'dark'; class?: string }): JSX.Element {
  return (
    <span class={cx(styles.preview, props.class)} data-theme={props.theme} aria-hidden="true">
      <span class={styles.previewBar} />
      <span class={styles.previewWindow}>
        <span class={styles.previewLights}>
          <span />
          <span />
          <span />
        </span>
        <span class={styles.previewLine} />
        <span class={cx(styles.previewLine, styles.previewShort)} />
      </span>
      <span class={styles.previewDock} />
    </span>
  );
}

export interface AppearancePaneProps {
  values: Pick<
    SettingValues,
    | 'appearance.theme'
    | 'appearance.accent'
    | 'appearance.reduceMotion'
    | 'appearance.reduceTransparency'
  >;
  onChange: (change: SettingChange) => void;
}

/** Appearance: theme thumbnails, accent colour, reduce motion and reduce transparency. */
export function AppearancePane(props: AppearancePaneProps): JSX.Element {
  const [local] = splitProps(props, ['values', 'onChange']);
  const themeRefs: HTMLButtonElement[] = [];
  const accentRefs: HTMLButtonElement[] = [];
  const theme = (): ThemePref => local.values['appearance.theme'];
  const accent = (): AccentId => local.values['appearance.accent'];

  const setTheme = (value: ThemePref, index: number): void => {
    themeRefs[index]?.focus();
    if (value !== theme()) local.onChange({ key: 'appearance.theme', value });
  };
  const setAccent = (value: AccentId, index: number): void => {
    accentRefs[index]?.focus();
    if (value !== accent()) local.onChange({ key: 'appearance.accent', value });
  };

  return (
    <div class={styles.pane}>
      <Group title="Theme" index={0}>
        <div class={styles.themeRow}>
          <div
            role="radiogroup"
            aria-label="Theme"
            data-testid="theme-toggle"
            class={styles.themes}
            onKeyDown={(event) =>
              radioKeys(
                event,
                THEMES.map((t) => t.value),
                theme(),
                setTheme,
              )
            }
          >
            <For each={THEMES}>
              {(option, index) => (
                <button
                  ref={(el) => (themeRefs[index()] = el)}
                  type="button"
                  role="radio"
                  class={styles.themeCard}
                  aria-checked={theme() === option.value}
                  tabindex={theme() === option.value ? 0 : -1}
                  onClick={() => setTheme(option.value, index())}
                >
                  <span class={styles.thumb}>
                    <Show
                      when={option.value === 'system'}
                      fallback={<Preview theme={option.value === 'dark' ? 'dark' : 'light'} />}
                    >
                      <span class={styles.split}>
                        <Preview theme="light" class={styles.half} />
                        <Preview theme="dark" class={cx(styles.half, styles.halfDark)} />
                      </span>
                    </Show>
                  </span>
                  <span class={styles.themeLabel}>{option.label}</span>
                </button>
              )}
            </For>
          </div>
        </div>
      </Group>

      <Group
        title="Accent colour"
        index={1}
        footer="Controls, selections and focus rings use the accent."
      >
        <div class={styles.accentRow}>
          <div
            role="radiogroup"
            aria-label="Accent colour"
            class={styles.swatches}
            onKeyDown={(event) =>
              radioKeys(
                event,
                ACCENTS.map((a) => a.value),
                accent(),
                setAccent,
              )
            }
          >
            <For each={ACCENTS}>
              {(option, index) => (
                <button
                  ref={(el) => (accentRefs[index()] = el)}
                  type="button"
                  role="radio"
                  class={cx(styles.swatch, styles[`swatch-${option.value}`])}
                  aria-checked={accent() === option.value}
                  aria-label={option.label}
                  tabindex={accent() === option.value ? 0 : -1}
                  onClick={() => setAccent(option.value, index())}
                >
                  <Show when={accent() === option.value}>
                    <Check
                      size={12}
                      stroke-width={3}
                      aria-hidden="true"
                      class={styles.swatchCheck}
                    />
                  </Show>
                </button>
              )}
            </For>
          </div>
          <span class={styles.accentName} aria-hidden="true">
            {ACCENTS.find((a) => a.value === accent())?.label}
          </span>
        </div>
      </Group>

      <Group title="Accessibility" index={2}>
        <SelectRow
          label="Reduce motion"
          description="Animations become instant changes. Live charts redraw in place."
          value={local.values['appearance.reduceMotion']}
          options={[
            { value: 'system', label: 'Follow system' },
            { value: 'always', label: 'Always' },
          ]}
          onChange={(value) => local.onChange({ key: 'appearance.reduceMotion', value })}
        />
        <SelectRow
          label="Reduce transparency"
          description="Glass surfaces become solid for easier reading."
          value={local.values['appearance.reduceTransparency']}
          options={[
            { value: 'system', label: 'Follow system' },
            { value: 'always', label: 'Always' },
          ]}
          onChange={(value) => local.onChange({ key: 'appearance.reduceTransparency', value })}
        />
      </Group>
    </div>
  );
}
