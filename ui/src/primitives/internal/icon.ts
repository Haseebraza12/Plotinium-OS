import type { JSX } from 'solid-js';

/**
 * An icon component such as a lucide-solid icon or one of our app icons. Data-driven
 * primitives (segments, sidebar rows, menu items) take the component, not an element, so each
 * row renders its own instance.
 */
export type IconComponent = (props: { size?: number | string; class?: string }) => JSX.Element;
