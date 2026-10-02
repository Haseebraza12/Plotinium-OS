import { Show, splitProps, type JSX } from 'solid-js';

import { cx } from '../internal/cx.ts';
import styles from './Avatar.module.css';

export type AvatarStatus = 'online' | 'away' | 'offline';

export interface AvatarProps {
  /** Display name: the accessible name and the source of the initials and colour. */
  name: string;
  /** Optional picture URL supplied by the caller (for example a blob: URL from the VFS). */
  src?: string;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  /** Presence dot; its meaning is also in the accessible name (DSN-08). */
  status?: AvatarStatus;
  /** Decorative when the name is already shown next to it. */
  decorative?: boolean;
  class?: string;
}

/** Up to two initials from a display name ("student" -> "S", "Ada Lovelace" -> "AL"). */
export function initialsOf(name: string): string {
  const words = name
    .trim()
    .split(/[\s._-]+/u)
    .filter((w) => w !== '');
  const first = words[0]?.[0] ?? '?';
  const last = words.length > 1 ? (words[words.length - 1]?.[0] ?? '') : '';
  return (first + last).toLocaleUpperCase();
}

/** A stable colour slot 1..6 from the name, so a user keeps the same colour everywhere. */
export function colourSlotOf(name: string): 1 | 2 | 3 | 4 | 5 | 6 {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
  return ((hash % 6) + 1) as 1 | 2 | 3 | 4 | 5 | 6;
}

/** A user picture or initials on a gradient disc, with an optional presence dot. */
export function Avatar(props: AvatarProps): JSX.Element {
  const [local] = splitProps(props, ['name', 'src', 'size', 'status', 'decorative', 'class']);
  const accessibleName = (): string =>
    local.status === undefined ? local.name : `${local.name}, ${local.status}`;
  return (
    <span
      class={cx(
        styles.avatar,
        styles[local.size ?? 'md'],
        local.src === undefined && styles[`c${colourSlotOf(local.name)}`],
        local.class,
      )}
      role={local.decorative === true ? undefined : 'img'}
      aria-label={local.decorative === true ? undefined : accessibleName()}
      aria-hidden={local.decorative === true ? 'true' : undefined}
    >
      <Show when={local.src} fallback={<span aria-hidden="true">{initialsOf(local.name)}</span>}>
        {(src) => <img class={styles.image} src={src()} alt="" draggable={false} />}
      </Show>
      <Show when={local.status}>
        {(status) => <span class={cx(styles.status, styles[status()])} aria-hidden="true" />}
      </Show>
    </span>
  );
}
