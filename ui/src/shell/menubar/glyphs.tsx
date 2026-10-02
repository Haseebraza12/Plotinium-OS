import type { JSX } from 'solid-js';

/**
 * Plotinium's own Control Centre glyph: two stacked switches, drawn on the lucide 24-unit grid
 * with the same 2-unit stroke so it sits with lucide icons. Decorative; the button is labelled.
 */
export function ControlCentreGlyph(props: { size?: number }): JSX.Element {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={props.size ?? 16}
      height={props.size ?? 16}
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <rect x="2.5" y="3.5" width="19" height="7" rx="3.5" />
      <circle cx="17.5" cy="7" r="1.6" fill="currentColor" stroke="none" />
      <rect x="2.5" y="13.5" width="19" height="7" rx="3.5" />
      <circle cx="6.5" cy="17" r="1.6" fill="currentColor" stroke="none" />
    </svg>
  );
}
