/**
 * Where a window-level key or context menu of the Files and Editor windows should not act
 * (UI-015, UI-016). Every window frame is itself a non-modal `<section role="dialog">`
 * (window-manager.md §3.4), so "inside a dialog" alone would match the whole window. What counts
 * is a text field, a menu (menus are portalled overlays and own their keys), a modal dialog
 * anywhere, or a dialog or alert inside the app's own root (its sheets).
 */

const TEXT_FIELDS = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]';
const LAYERS = '[role="dialog"], [role="alertdialog"], [role="menu"]';

/** The target sits in a menu, in a modal dialog, or in a sheet or alert of this app. */
export function inAppLayer(target: EventTarget | null, root: Element | undefined): boolean {
  if (!(target instanceof Element)) return false;
  for (let layer = target.closest(LAYERS); layer !== null;) {
    if (layer.getAttribute('role') === 'menu') return true;
    if (layer.getAttribute('aria-modal') === 'true') return true;
    if (root !== undefined && root !== layer && root.contains(layer)) return true;
    layer = layer.parentElement?.closest(LAYERS) ?? null;
  }
  return false;
}

/** The key belongs to what has focus: a text field, or a sheet or menu. */
export function isTypingTarget(target: EventTarget | null, root: Element | undefined): boolean {
  if (!(target instanceof Element)) return false;
  return target.closest(TEXT_FIELDS) !== null || inAppLayer(target, root);
}
