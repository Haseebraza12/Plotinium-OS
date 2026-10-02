/**
 * Tiny DOM helpers for the boot screens. Plain TypeScript: these screens are inlined into
 * index.html and run before any framework loads (DSN-14, C11).
 *
 * Screens are written once as element trees with h(). render() builds real nodes from a tree
 * (text always becomes text nodes, so nothing is ever parsed as HTML: AGT-06), and html()
 * serialises the same tree, escaped, for the build step that inlines the splash into
 * index.html (the BOOT-01 first paint needs no script).
 *
 * The CSP has no 'unsafe-inline' (security-model.md §3): a `style` attribute is never written.
 * Custom properties go in attrs as `'--name': value` and are set through the CSSOM, which the
 * CSP does not restrict; html() leaves them out, so a serialised tree relies on CSS fallbacks.
 */

export type Attr = string | number | boolean | undefined;
export type Attrs = Readonly<Record<string, Attr>>;
export interface VNode {
  readonly tag: string;
  readonly attrs: Attrs;
  readonly kids: readonly Kid[];
}
export type Kid = VNode | string | number | false | null | undefined | readonly Kid[];

/** An element tree node: `h('p', { class: 'x' }, 'text', h('b', null, 'bold'))`. */
export const h = (tag: string, attrs?: Attrs | null, ...kids: Kid[]): VNode => ({
  tag,
  attrs: attrs ?? {},
  kids,
});

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Never written: script-carrying attributes (AGT-06) and inline styles (CSP, no unsafe-inline). */
const unsafeAttr = (name: string): boolean =>
  /^on/iu.test(name) || name === 'srcdoc' || name === 'style';

function build(kid: Kid, doc: Document, svg: boolean, out: Node[]): void {
  if (kid === null || kid === undefined || kid === false) return;
  if (Array.isArray(kid)) {
    for (const k of kid as readonly Kid[]) build(k, doc, svg, out);
    return;
  }
  if (typeof kid !== 'object') {
    out.push(doc.createTextNode(String(kid)));
    return;
  }
  const node = kid as VNode;
  const inSvg = svg || node.tag === 'svg';
  const elem = inSvg ? doc.createElementNS(SVG_NS, node.tag) : doc.createElement(node.tag);
  for (const [name, value] of Object.entries(node.attrs)) {
    if (value === undefined || value === false || unsafeAttr(name)) continue;
    if (name.startsWith('--')) (elem as HTMLElement).style.setProperty(name, String(value));
    else elem.setAttribute(name, value === true ? '' : String(value));
  }
  const kids: Node[] = [];
  for (const k of node.kids) build(k, doc, inSvg, kids);
  elem.append(...kids);
  out.push(elem);
}

/** Builds real DOM nodes from a tree and returns the root element. */
export function render(node: VNode, doc: Document): HTMLElement {
  const out: Node[] = [];
  build(node, doc, false, out);
  return out[0] as HTMLElement;
}

/** Builds DOM nodes for any tree fragment (text, arrays, SVG children of `svg`). */
export function nodes(kid: Kid, doc: Document, svg = false): Node[] {
  const out: Node[] = [];
  build(kid, doc, svg, out);
  return out;
}

const ENTITIES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
const esc = (value: string): string => value.replace(/[&<>"']/gu, (c) => ENTITIES[c] ?? c);

/** Serialises a tree as escaped HTML, for inlining into index.html at build time. */
export function html(kid: Kid): string {
  if (kid === null || kid === undefined || kid === false) return '';
  if (Array.isArray(kid)) return (kid as readonly Kid[]).map(html).join('');
  if (typeof kid !== 'object') return esc(String(kid));
  const node = kid as VNode;
  const attrs = Object.entries(node.attrs)
    .filter(
      ([name, value]) =>
        value !== undefined && value !== false && !unsafeAttr(name) && !name.startsWith('--'),
    )
    .map(([name, value]) => (value === true ? ` ${name}` : ` ${name}="${esc(String(value))}"`))
    .join('');
  return `<${node.tag}${attrs}>${node.kids.map(html).join('')}</${node.tag}>`;
}

let seq = 0;

/** A page-unique id prefix, so two screens (the gallery shows light and dark) never share ids. */
export const uid = (prefix = 'plb'): string => `${prefix}${(++seq).toString(36)}-`;

/** querySelector that fails loudly: a missing part is a template bug, not a runtime state. */
export function q<T extends Element = HTMLElement>(root: ParentNode, selector: string): T {
  const found = root.querySelector<T>(selector);
  if (found === null) throw new Error(`boot-ui: missing ${selector}`);
  return found;
}

export function qa<T extends Element = HTMLElement>(root: ParentNode, selector: string): T[] {
  return [...root.querySelectorAll<T>(selector)];
}

/**
 * Replays a one-shot transition without a timer: the attribute applies the start state with no
 * transition, a style read commits it, and removing the attribute lets the element ease back.
 * Under reduced motion every duration is 0 ms, so nothing visible happens.
 */
export function replay(node: Element, attr: string): void {
  node.setAttribute(attr, '');
  node.getBoundingClientRect();
  node.removeAttribute(attr);
}

/** A two-slot text swap box holding `text` (see swapText). */
export const swapBox = (cls: string, text: string, attrs: Attrs = {}): VNode =>
  h(
    'span',
    { ...attrs, class: `plb-swap ${cls}` },
    h('span', { 'data-on': true }, text),
    h('span', { 'aria-hidden': 'true' }),
  );

/**
 * Two-slot text swap: the new text rises into the idle slot while the old one leaves upwards.
 * Pure transitions on transform and opacity; no transitionend bookkeeping, so it also works
 * when reduced motion makes every duration 0 ms.
 */
export function swapText(box: Element, text: string): void {
  const [a, b] = box.children;
  if (a === undefined || b === undefined) return;
  const on = a.hasAttribute('data-on') ? a : b;
  const off = on === a ? b : a;
  if (on.textContent === text) return;
  off.textContent = text;
  replay(off, 'data-pre');
  on.removeAttribute('data-on');
  on.setAttribute('aria-hidden', 'true');
  off.setAttribute('data-on', '');
  off.removeAttribute('aria-hidden');
}

/** True when the key event should not fire single-key shortcuts (typing, or a modifier held). */
export function typing(e: KeyboardEvent): boolean {
  if (e.ctrlKey || e.metaKey || e.altKey) return true;
  const t = e.target;
  return (
    t instanceof Element && t.closest('input, textarea, select, [contenteditable="true"]') !== null
  );
}

/** Adds a document keydown listener and returns its remover. */
export function listenKeys(doc: Document, handler: (e: KeyboardEvent) => void): () => void {
  doc.addEventListener('keydown', handler);
  return () => doc.removeEventListener('keydown', handler);
}

/** The document a screen builds in. */
export const docOf = (doc: Document | undefined): Document => doc ?? document;
