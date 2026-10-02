/**
 * Layout helpers for gallery pages (any agent's ui/gallery/pages/<area>.tsx may use them).
 * Only tokens style them; they carry no behaviour beyond replaying animations.
 */
import { createSignal, For, Show, splitProps, type JSX } from 'solid-js';

import { Button } from '../src/primitives/button/Button.tsx';
import { cx } from '../src/primitives/internal/cx.ts';
import styles from './kit.module.css';

export function Page(props: {
  title: string;
  lead?: JSX.Element;
  children: JSX.Element;
}): JSX.Element {
  return (
    <article class={styles.page}>
      <header class={styles.pageHeader}>
        <h1 class={styles.pageTitle}>{props.title}</h1>
        <Show when={props.lead}>
          <p class={styles.pageLead}>{props.lead}</p>
        </Show>
      </header>
      {props.children}
    </article>
  );
}

export function Section(props: {
  title: string;
  lead?: JSX.Element;
  id?: string;
  children: JSX.Element;
}): JSX.Element {
  return (
    <section class={styles.section} id={props.id} aria-label={props.title}>
      <h2 class={styles.sectionTitle}>{props.title}</h2>
      <Show when={props.lead}>
        <p class={styles.sectionLead}>{props.lead}</p>
      </Show>
      {props.children}
    </section>
  );
}

/** Auto-filling grid of demos; `min` is the minimum column width in px. */
export function Grid(props: { min?: number; children: JSX.Element }): JSX.Element {
  return (
    <div class={styles.grid} style={{ '--kit-min': `${props.min ?? 260}px` }}>
      {props.children}
    </div>
  );
}

/** A titled card holding one demo. */
export function Demo(props: {
  title: string;
  note?: string;
  column?: boolean;
  wallpaper?: boolean;
  class?: string;
  children: JSX.Element;
}): JSX.Element {
  return (
    <div class={cx(styles.demo, props.class)}>
      <div class={styles.demoHeader}>
        <h3 class={styles.demoTitle}>{props.title}</h3>
        <Show when={props.note}>
          <span class={styles.demoNote}>{props.note}</span>
        </Show>
      </div>
      <div
        class={cx(
          styles.demoBody,
          props.column === true && styles.column,
          props.wallpaper === true && styles.stage,
        )}
        style={props.wallpaper === true ? { 'border-radius': '0' } : undefined}
      >
        {props.children}
      </div>
    </div>
  );
}

/** The desktop wallpaper behind glass materials. */
export function Stage(props: {
  padded?: boolean;
  class?: string;
  style?: JSX.CSSProperties;
  children: JSX.Element;
}): JSX.Element {
  const [local] = splitProps(props, ['padded', 'class', 'style', 'children']);
  return (
    <div
      class={cx(styles.stage, local.padded !== false && styles.stagePad, local.class)}
      style={local.style}
    >
      {local.children}
    </div>
  );
}

/**
 * Renders the same content in a light pane and a dark pane side by side, using the scoped
 * [data-theme] support of tokens.css.
 */
export function ThemeSplit(props: {
  wallpaper?: boolean;
  children: () => JSX.Element;
}): JSX.Element {
  return (
    <div class={styles.split}>
      <For each={['light', 'dark'] as const}>
        {(theme) => (
          <div
            data-theme={theme}
            class={cx(styles.pane, props.wallpaper === true && styles.paneWallpaper)}
          >
            <span class={styles.paneLabel}>{theme === 'light' ? 'Light' : 'Dark'}</span>
            {props.children()}
          </div>
        )}
      </For>
    </div>
  );
}

export function Row(props: { children: JSX.Element; gap?: string }): JSX.Element {
  return (
    <div class={styles.row} style={props.gap === undefined ? undefined : { gap: props.gap }}>
      {props.children}
    </div>
  );
}

export function Stack(props: { children: JSX.Element; style?: JSX.CSSProperties }): JSX.Element {
  return (
    <div class={styles.stack} style={props.style}>
      {props.children}
    </div>
  );
}

export function Caption(props: { children: JSX.Element }): JSX.Element {
  return <span class={styles.caption}>{props.children}</span>;
}

export function Code(props: { children: JSX.Element }): JSX.Element {
  return <code class={styles.code}>{props.children}</code>;
}

/**
 * Re-mounts its children each time "Replay" is pressed, so a one-shot animation class plays
 * again. The render function receives the play count.
 */
export function Replay(props: {
  label?: string;
  children: (count: number) => JSX.Element;
}): JSX.Element {
  const [count, setCount] = createSignal(0);
  return (
    <div class={cx(styles.stack, styles.replay)}>
      <div>
        <Button size="sm" onClick={() => setCount((c) => c + 1)}>
          {props.label ?? 'Replay'}
        </Button>
      </div>
      <Show keyed when={count() + 1}>
        {(n) => props.children(n)}
      </Show>
    </div>
  );
}
