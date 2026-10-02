/**
 * CSP-safe run-time styles (security-model.md §3.9).
 *
 * The production CSP allows `style-src 'self'` plus the hashes of the inline styles in
 * index.html, so a `<style>` element a library creates at run time is refused: it stays in the
 * DOM with `sheet === null` and styles nothing. Two libraries do that:
 *
 * - xterm's DOM renderer (the rows' font, cell size, ANSI colours, selection and scrollbar), in
 *   `<style>` elements inside each terminal;
 * - CodeMirror's style-mod (the base theme and our EditorView.theme), in one `<style>` at the
 *   top of `<head>`, shared by every editor and never removed.
 *
 * The CSP does not govern stylesheets built through the CSSOM, so each refused element is
 * mirrored into a constructable stylesheet adopted by the document, and kept in step when the
 * library rewrites it. The CSS is the libraries' own, built from our theme and options, never
 * from content. A `<style>` the CSP allowed (the dev server sends no CSP) is left alone.
 *
 * Mirroring restores the styling, but the browser has already refused the element and reported a
 * `securitypolicyviolation` (Chrome checks the CSP before it looks at the `type` attribute, so an
 * inert `type` does not help). Where the library creates its `<style>` elements inside a call we
 * make, `withInertStyles` stops the violation at its source: during that call
 * `document.createElement('style')` answers a hidden `<plt-inert-style>` stand-in, which the
 * library fills and moves exactly like a `<style>` but which the browser never treats as a style
 * sheet, and the mirror adopts its text. xterm is the case: its three `<style>` elements are
 * created inside `Terminal.open`.
 *
 * Adopted sheets cascade after the document's sheets. For style-mod that moves its rules from
 * first to last among the unlayered author styles. No Plotinium rule competes with them
 * (CodeEditor.module.css sets only the editor's height), so the result matches the dev server.
 */

/**
 * The tag of the stand-in `withInertStyles` hands out for `<style>`. An unknown element: the
 * browser renders it (as `hidden`, so not at all) but never parses its text as CSS.
 */
export const INERT_STYLE_TAG = 'plt-inert-style';

/** The elements whose text is CSS to mirror: refused `<style>` elements and the stand-ins. */
const MIRROR_SELECTOR = `style, ${INERT_STYLE_TAG}`;

function isStandIn(el: Element): boolean {
  return el.localName === INERT_STYLE_TAG;
}

/**
 * Runs `run` (a library's synchronous set-up, such as xterm's `Terminal.open`) with
 * `createElement('style')` on `doc`, and on the realm's global document when that is another
 * one, answering a hidden `<plt-inert-style>` stand-in instead of a `<style>`. Every other tag is
 * created as usual, and the documents' own `createElement` is back in place when `run` returns or
 * throws. Pair it with `mirrorBlockedStyles` on the element the library renders into, which
 * applies the stand-ins' CSS through adopted sheets.
 *
 * Only for libraries that use the element as a text container (assign `textContent`, append it,
 * remove it); the stand-in has no `sheet`.
 */
export function withInertStyles<T>(doc: Document, run: () => T): T {
  const docs = new Set<Document>([doc]);
  // xterm's viewport uses the realm's global document rather than its parent's owner document.
  const global = (globalThis as { document?: Document }).document;
  if (global !== undefined && global.nodeType === 9) docs.add(global);
  const restore: (() => void)[] = [];
  for (const d of docs) {
    const own = Object.getOwnPropertyDescriptor(d, 'createElement');
    const create: (tagName: string, options?: ElementCreationOptions) => HTMLElement =
      d.createElement.bind(d);
    const patched = (tagName: string, options?: ElementCreationOptions): HTMLElement => {
      if (tagName.toLowerCase() !== 'style') return create(tagName, options);
      const standIn = create(INERT_STYLE_TAG);
      standIn.hidden = true;
      return standIn;
    };
    Object.defineProperty(d, 'createElement', {
      configurable: true,
      writable: true,
      value: patched,
    });
    restore.push(() => {
      if (own === undefined) Reflect.deleteProperty(d, 'createElement');
      else Object.defineProperty(d, 'createElement', own);
    });
  }
  try {
    return run();
  } finally {
    for (const undo of restore) undo();
  }
}

/** Decides whether a `<style>` needs a mirror; tests inject one, since happy-dom has no CSP. */
export type BlockedTest = (el: HTMLStyleElement) => boolean;

/** The browser gave this `<style>` no stylesheet: the CSP refused it. */
export const refusedByCsp: BlockedTest = (el) => el.sheet === null;

/**
 * Mirrors the refused `<style>` elements under `root` (now and later), and the stand-ins of
 * `withInertStyles`, into adopted sheets. Observes only `root`'s children, the parents of
 * mirrored elements and the mirrored elements themselves, so terminal row repaints never reach
 * the observer. Returns the disposer, which removes the mirrors. A no-op without constructable
 * stylesheets.
 */
export function mirrorBlockedStyles(
  root: Element,
  isBlocked: BlockedTest = refusedByCsp,
): () => void {
  const doc = root.ownerDocument;
  const view = doc.defaultView;
  if (view === null || typeof view.CSSStyleSheet !== 'function') return () => undefined;
  if (!Array.isArray(doc.adoptedStyleSheets)) return () => undefined;

  const mirrors = new Map<Element, { sheet: CSSStyleSheet; text: string | null }>();
  const watched = new WeakSet<Node>();
  const observer = new MutationObserver(() => sync());
  const watch = (node: Node, options: MutationObserverInit): void => {
    if (watched.has(node)) return;
    watched.add(node);
    observer.observe(node, options);
  };
  const unadopt = (sheets: ReadonlySet<CSSStyleSheet>): void => {
    if (sheets.size > 0)
      doc.adoptedStyleSheets = doc.adoptedStyleSheets.filter((s) => !sheets.has(s));
  };

  const sync = (): void => {
    const live = new Set<Element>(root.querySelectorAll(MIRROR_SELECTOR));
    for (const el of live) {
      let mirror = mirrors.get(el);
      if (mirror === undefined) {
        if (!isStandIn(el) && !(el instanceof view.HTMLStyleElement && isBlocked(el))) continue;
        mirror = { sheet: new view.CSSStyleSheet(), text: null };
        mirrors.set(el, mirror);
        doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, mirror.sheet];
        // The library rewrites textContent; new siblings join the same parent.
        watch(el, { childList: true, characterData: true, subtree: true });
        if (el.parentNode !== null) watch(el.parentNode, { childList: true });
      }
      const text = el.textContent ?? '';
      if (mirror.text === text) continue;
      mirror.text = text;
      try {
        mirror.sheet.replaceSync(text);
      } catch {
        // replaceSync refuses only @import, which neither library writes.
      }
    }
    const gone = new Set<CSSStyleSheet>();
    for (const [el, mirror] of mirrors) {
      if (live.has(el)) continue;
      gone.add(mirror.sheet);
      mirrors.delete(el);
    }
    unadopt(gone);
  };

  watch(root, { childList: true });
  sync();
  return () => {
    observer.disconnect();
    unadopt(new Set([...mirrors.values()].map((m) => m.sheet)));
    mirrors.clear();
  };
}

const headMirrors = new WeakSet<Document>();

/**
 * Mirrors the refused `<style>` elements of `doc`'s `<head>` for the life of the document.
 * CodeMirror's style-mod keeps its one `<style>` there for as long as the page lives, so the
 * mirror is never disposed. Idempotent: the first call per document installs it.
 */
export function mirrorBlockedHeadStyles(
  doc: Document,
  isBlocked: BlockedTest = refusedByCsp,
): void {
  if (headMirrors.has(doc)) return;
  headMirrors.add(doc);
  mirrorBlockedStyles(doc.head, isBlocked);
}
