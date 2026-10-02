/**
 * Icons are stored once as a small element tree, so the Solid components and the raw SVG
 * strings (favicon, manifest, boot-ui inlining) cannot drift apart. Ids inside a tree are
 * written with a `$` placeholder and made unique per instance, so two icons on one page never
 * share gradient or filter ids.
 */
export type SvgAttrs = Readonly<Record<string, string | number>>;
export type SvgNode = readonly [tag: string, attrs: SvgAttrs, children?: readonly SvgNode[]];

export interface SvgIconDef {
  readonly name: string;
  readonly viewBox: string;
  readonly children: readonly SvgNode[];
}

/** Replaces the `$` id placeholder in every attribute value. */
export function resolveAttrs(attrs: SvgAttrs, prefix: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(attrs)) {
    out[key] = String(value).replaceAll('$', prefix);
  }
  return out;
}

function escapeAttr(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
}

function serializeNode(node: SvgNode, prefix: string): string {
  const [tag, attrs, children] = node;
  const attrText = Object.entries(resolveAttrs(attrs, prefix))
    .map(([key, value]) => ` ${key}="${escapeAttr(value)}"`)
    .join('');
  if (children === undefined || children.length === 0) return `<${tag}${attrText}/>`;
  return `<${tag}${attrText}>${children.map((c) => serializeNode(c, prefix)).join('')}</${tag}>`;
}

/** Serialises an icon to a standalone SVG document string at the given pixel size. */
export function toSvgString(def: SvgIconDef, size: number, prefix = 'pl'): string {
  const body = def.children.map((c) => serializeNode(c, `${prefix}-${def.name}-`)).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${def.viewBox}">${body}</svg>`;
}
