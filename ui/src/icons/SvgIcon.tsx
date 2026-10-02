import { createUniqueId, For, Show, splitProps, type JSX } from 'solid-js';
import { Dynamic } from 'solid-js/web';

import { cx } from '../primitives/internal/cx.ts';
import styles from './SvgIcon.module.css';
import { resolveAttrs, type SvgIconDef, type SvgNode } from './svg-tree.ts';

function Node(props: { node: SvgNode; prefix: string }): JSX.Element {
  return (
    <Dynamic component={props.node[0]} {...resolveAttrs(props.node[1], props.prefix)}>
      <For each={props.node[2] ?? []}>{(child) => <Node node={child} prefix={props.prefix} />}</For>
    </Dynamic>
  );
}

export interface SvgIconProps extends Omit<JSX.SvgSVGAttributes<SVGSVGElement>, 'children'> {
  /** Pixel size of the square icon. */
  size?: number;
  /** Accessible name. Without it the icon is decorative (aria-hidden). */
  label?: string;
}

/** Renders a stored icon tree as inline SVG. */
export function SvgIcon(props: SvgIconProps & { def: SvgIconDef }): JSX.Element {
  const [local, rest] = splitProps(props, ['def', 'size', 'label', 'class']);
  const uid = createUniqueId();
  const prefix = (): string => `${uid}-${local.def.name}-`;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={local.def.viewBox}
      width={local.size ?? 24}
      height={local.size ?? 24}
      role={local.label === undefined ? undefined : 'img'}
      aria-label={local.label}
      aria-hidden={local.label === undefined ? 'true' : undefined}
      {...rest}
      class={cx(styles.icon, local.class)}
    >
      <Show when={local.label}>{(label) => <title>{label()}</title>}</Show>
      <For each={local.def.children}>{(child) => <Node node={child} prefix={prefix()} />}</For>
    </svg>
  );
}
