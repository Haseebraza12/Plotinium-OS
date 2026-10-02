import { splitProps, type JSX } from 'solid-js';

import { cx } from '../../primitives/internal/cx.ts';
import styles from './Wallpaper.module.css';

export interface WallpaperProps {
  /**
   * Plays the slow aurora drift (transform only, about a minute per cycle). Off by default: the
   * desktop has no looping motion unless the user opts in, and it always pauses under reduced
   * motion.
   */
  animate?: boolean;
  /** Freezes the drift where it is (the host pauses it while the tab is hidden or a game runs). */
  paused?: boolean;
  class?: string;
}

/**
 * The desktop wallpaper: the luminous --pl-wallpaper field of the active theme with two soft
 * aurora layers. Decorative (aria-hidden) and click-through; the host listens for desktop clicks.
 */
export function Wallpaper(props: WallpaperProps): JSX.Element {
  const [local] = splitProps(props, ['animate', 'paused', 'class']);
  return (
    <div
      aria-hidden="true"
      data-animated={local.animate === true ? 'true' : 'false'}
      class={cx(
        styles.wallpaper,
        local.animate === true && styles.animated,
        local.paused === true && styles.paused,
        local.class,
      )}
    >
      <div class={styles.aurora} />
      <div class={styles.bloom} />
      <div class={styles.grain} />
    </div>
  );
}
