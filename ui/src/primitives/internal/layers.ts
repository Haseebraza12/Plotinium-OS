import { createEffect, onCleanup, type Accessor } from 'solid-js';

/**
 * Open overlays form a stack (a Select inside a Sheet inside a window). Escape and outside
 * clicks go to the topmost layer only, so one Escape closes one layer (APG). A layer leaves
 * the stack as soon as it starts closing, not when its exit animation ends.
 */
const stack: symbol[] = [];

export interface DismissableLayerOptions {
  active: Accessor<boolean>;
  /** Elements that count as inside (the surface and its anchor). */
  inside: () => readonly (Element | undefined)[];
  onEscape?: () => void;
  onOutside?: (event: PointerEvent) => void;
}

export function isTopLayerEmpty(): boolean {
  return stack.length === 0;
}

export function createDismissableLayer(options: DismissableLayerOptions): void {
  createEffect(() => {
    if (!options.active() || typeof document === 'undefined') return;
    const doc = document;
    const token = Symbol('pl-layer');
    stack.push(token);
    const isTop = (): boolean => stack[stack.length - 1] === token;

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented || !isTop()) return;
      if (options.onEscape === undefined) return;
      event.preventDefault();
      options.onEscape();
    };
    const onPointerDown = (event: PointerEvent): void => {
      if (!isTop() || options.onOutside === undefined) return;
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (options.inside().some((el) => el?.contains(target) === true)) return;
      options.onOutside(event);
    };

    doc.addEventListener('keydown', onKeyDown);
    doc.addEventListener('pointerdown', onPointerDown, true);
    onCleanup(() => {
      const index = stack.indexOf(token);
      if (index >= 0) stack.splice(index, 1);
      doc.removeEventListener('keydown', onKeyDown);
      doc.removeEventListener('pointerdown', onPointerDown, true);
    });
  });
}
