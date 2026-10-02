const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
].join(',');

/** Tabbable descendants of `root`, in DOM order, skipping hidden and inert subtrees. */
export function focusableIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.closest('[hidden], [inert]') === null,
  );
}

/** Keeps Tab and Shift+Tab inside `root` (modal dialogs and sheets, WCAG 2.4.3). */
export function trapTabKey(event: KeyboardEvent, root: HTMLElement): void {
  if (event.key !== 'Tab') return;
  const items = focusableIn(root);
  const first = items[0];
  const last = items[items.length - 1];
  if (first === undefined || last === undefined) {
    event.preventDefault();
    root.focus();
    return;
  }
  const active = root.ownerDocument.activeElement;
  if (event.shiftKey && (active === first || active === root || !root.contains(active))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (active === last || !root.contains(active))) {
    event.preventDefault();
    first.focus();
  }
}

/**
 * Records the element that had focus before an overlay opened and returns a function that
 * gives focus back to it (APG dialog and menu patterns).
 */
export function rememberFocus(doc: Document): () => void {
  const previous = doc.activeElement;
  return () => {
    if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
  };
}

/** Moves focus to the element marked `data-autofocus`, else the first tabbable one, else root. */
export function focusInitial(root: HTMLElement): void {
  const marked = root.querySelector<HTMLElement>('[data-autofocus]');
  const target = marked ?? focusableIn(root)[0] ?? root;
  target.focus();
}
