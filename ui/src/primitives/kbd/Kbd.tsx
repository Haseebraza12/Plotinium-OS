import { For, Show, splitProps, type JSX } from 'solid-js';

import { cx } from '../internal/cx.ts';
import styles from './Kbd.module.css';

/** Spoken names for symbols, so "⌫" is announced as "Backspace". */
const SPOKEN: Readonly<Record<string, string>> = {
  '↵': 'Enter',
  '⏎': 'Enter',
  '⌫': 'Backspace',
  '⇧': 'Shift',
  '⇥': 'Tab',
  '↑': 'Up',
  '↓': 'Down',
  '←': 'Left',
  '→': 'Right',
  Esc: 'Escape',
};

/** aria-keyshortcuts key names (UI Events `key` values) for the labels we display. */
const ARIA_KEY: Readonly<Record<string, string>> = {
  Ctrl: 'Control',
  '⇧': 'Shift',
  '↵': 'Enter',
  '⏎': 'Enter',
  '⌫': 'Backspace',
  '⇥': 'Tab',
  '↑': 'ArrowUp',
  '↓': 'ArrowDown',
  '←': 'ArrowLeft',
  '→': 'ArrowRight',
  Esc: 'Escape',
  Space: 'Space',
};

/** Spoken form of a chord: ['Ctrl', '↵'] -> "Ctrl Enter". */
export function spokenKeys(keys: readonly string[]): string {
  return keys.map((k) => SPOKEN[k] ?? k).join(' ');
}

/** The aria-keyshortcuts value for a chord: ['Ctrl', '⇧', 'N'] -> "Control+Shift+N". */
export function ariaKeyShortcuts(keys: readonly string[]): string {
  return keys.map((k) => ARIA_KEY[k] ?? k).join('+');
}

export interface KbdProps {
  /** One key or a chord, e.g. ['Ctrl', 'K']. Symbols get spoken names. */
  keys: readonly string[];
  /** plain: no keycap chrome (menu shortcut column). */
  variant?: 'cap' | 'plain';
  /**
   * Hide it from assistive technology when the shortcut is already exposed another way (a menu
   * item's aria-keyshortcuts).
   */
  decorative?: boolean;
  class?: string;
}

/**
 * Whether a '+' goes between two keys. Keycaps always join with '+'. The plain (menu) variant
 * runs symbol modifiers together like macOS ("⇧⌘N") but keeps '+' after a word ("Ctrl+O").
 */
function joins(variant: KbdProps['variant'], previous: string | undefined): boolean {
  if (previous === undefined) return false;
  return variant !== 'plain' || [...previous].length > 1;
}

/**
 * Keyboard shortcut keycaps (menus, hints, the agent confirmation footer). The caps are hidden
 * from assistive technology; a visually hidden text gives the spoken form ("Ctrl Enter").
 */
export function Kbd(props: KbdProps): JSX.Element {
  const [local] = splitProps(props, ['keys', 'variant', 'decorative', 'class']);
  return (
    <kbd
      class={cx(styles.keys, local.variant === 'plain' && styles.plain, local.class)}
      aria-hidden={local.decorative === true ? 'true' : undefined}
    >
      <Show when={local.decorative !== true}>
        <span class={styles.hidden}>{spokenKeys(local.keys)}</span>
      </Show>
      <For each={local.keys}>
        {(key, index) => (
          <>
            <Show when={joins(local.variant, local.keys[index() - 1])}>
              <span class={styles.separator} aria-hidden="true">
                +
              </span>
            </Show>
            <kbd class={styles.key} aria-hidden="true">
              {key}
            </kbd>
          </>
        )}
      </For>
    </kbd>
  );
}
