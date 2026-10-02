/**
 * xterm's DOM renderer and the strict CSP (security-model.md §3.9; UI-050).
 *
 * xterm 6 colours a cell that no palette class covers — a selected cell (the selection is drawn
 * opaque, so every selected cell gets an RGB background), a true-colour SGR, and any colour
 * `minimumContrastRatio` adjusts — with one private helper of its row factory:
 *
 *     _addStyle(element, style) { element.setAttribute('style', `${…}${style};`) }
 *
 * A `style` attribute is inline style: the CSP (`style-src 'self'`, no `'unsafe-inline'`, no
 * `style-src-attr` relaxation) refuses it, reports a `securitypolicyviolation` per cell group
 * (16 for "Select All" on a short screen), and the selected text loses its colour. The same
 * declarations set through the CSSOM (`element.style.cssText`) are not governed by the CSP, so
 * `cspSafeRowStyles` gives the terminal's row factory a `_addStyle` that appends to `cssText`.
 * The CSS is xterm's own (`color:#rrggbb`, `background-color:#rrggbb`), never content.
 *
 * The helper is private, so this reaches it through xterm's internals (`_core._renderService.
 * _renderer.value._rowFactory`, names the minified bundle keeps). If a later xterm renames any of
 * them the function returns false and changes nothing; the UI-050 unit test with the real xterm
 * then fails, so an upgrade cannot silently bring the violations back.
 */

type AddStyle = (element: HTMLElement, style: string) => void;

interface RowFactoryLike {
  _addStyle?: AddStyle;
}

interface XtermInternals {
  _core?: {
    _renderService?: {
      _renderer?: { value?: { _rowFactory?: RowFactoryLike } };
    };
  };
}

/** `_addStyle` through the CSSOM: the declarations are appended as xterm appends them. */
export const addStyleViaCssom: AddStyle = (element, style) => {
  element.style.cssText = `${element.style.cssText}${style};`;
};

/**
 * Makes the row factory of an opened xterm `Terminal` set its per-cell colours through the CSSOM
 * instead of a `style` attribute. Call it after `open` (the renderer is created there). Returns
 * whether the factory was found and patched; idempotent.
 */
export function cspSafeRowStyles(terminal: unknown): boolean {
  const factory = (terminal as XtermInternals | null)?._core?._renderService?._renderer?.value
    ?._rowFactory;
  if (factory === undefined || typeof factory._addStyle !== 'function') return false;
  factory._addStyle = addStyleViaCssom;
  return true;
}
