/**
 * The Trusted Types `default` policy of the main thread (UI-137; security-model.md §3.9, SEC-22).
 *
 * Caddy sends `Content-Security-Policy-Report-Only: require-trusted-types-for 'script'`. Solid's
 * compiled templates assign static HTML strings to `template.innerHTML`, so every component
 * template raised one report-only message: about 150 console lines per session that said nothing
 * (spec §3.9 keeps Trusted Types report-only for exactly this reason).
 *
 * This policy is NARROW: an HTML string passes only when it looks like markup, with no script,
 * frame, object, base or meta element, no inline event handler, and no `javascript:` or `data:`
 * URL. Anything else throws, which under report-only is still REPORTED (and would be blocked if
 * enforcement were ever turned on). Script URLs and scripts are not handled here: they keep their
 * own named policies (web/src/boot/trusted.ts) or are reported. Our own code has no HTML sink
 * (lint `no-html-sinks`); this concerns library templates only.
 */

/** Elements that can run script or change where the page loads from. */
const UNSAFE_TAGS: ReadonlySet<string> = new Set([
  'applet',
  'base',
  'embed',
  'frame',
  'frameset',
  'iframe',
  'link',
  'meta',
  'object',
  'portal',
  'script',
]);

/** One start tag: its name and its attribute text (quoted values may contain `>`). */
const START_TAG = /<([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>?/g;
/** One attribute: its name and its (optionally quoted) value. */
const ATTRIBUTE = /([^\s=/"'>]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/g;
const UNSAFE_URL = /^(?:javascript|vbscript|data):/;

function unsafeAttribute(name: string, raw: string | undefined): boolean {
  const n = name.toLowerCase();
  if (n.startsWith('on') || n === 'srcdoc' || n === 'formaction') return true;
  if (raw === undefined) return false;
  const quoted = raw.startsWith('"') || raw.startsWith("'");
  // Browsers ignore ASCII whitespace and control characters (U+0000–U+0020) inside a scheme.
  const value = [...(quoted ? raw.slice(1, -1) : raw)]
    .filter((ch) => ch.charCodeAt(0) > 0x20)
    .join('')
    .toLowerCase();
  return UNSAFE_URL.test(value);
}

/**
 * True when `html` carries markup a template never needs: a script-capable element, an inline
 * event handler, `srcdoc`, `formaction`, or an attribute value that is a `javascript:`,
 * `vbscript:` or `data:` URL. Text between tags is never inspected.
 */
export function unsafeHtml(html: string): boolean {
  for (const tag of html.matchAll(START_TAG)) {
    if (UNSAFE_TAGS.has((tag[1] ?? '').toLowerCase())) return true;
    for (const attr of (tag[2] ?? '').matchAll(ATTRIBUTE))
      if (unsafeAttribute(attr[1] ?? '', attr[2])) return true;
  }
  return false;
}

export const DEFAULT_POLICY_NAME = 'default';

/** The policy's `createHTML`: the string itself when it is inert template markup, else throws. */
export function templateHtml(input: string): string {
  if (unsafeHtml(input))
    throw new TypeError('Plotinium: HTML with script, frames or handlers is not a template');
  return input;
}

interface DefaultPolicyFactory {
  createPolicy(name: string, rules: { readonly createHTML: (input: string) => string }): unknown;
  readonly defaultPolicy?: unknown;
}

/**
 * Create the default policy once, before any Solid template exists. Returns whether this call
 * created it (false without Trusted Types, or when a default policy already exists).
 */
export function installDefaultPolicy(win: object): boolean {
  const tt = (win as { readonly trustedTypes?: DefaultPolicyFactory }).trustedTypes;
  if (tt === undefined || (tt.defaultPolicy ?? null) !== null) return false;
  try {
    tt.createPolicy(DEFAULT_POLICY_NAME, { createHTML: templateHtml });
    return true;
  } catch {
    // A `trusted-types` allow-list without `default`: keep reporting, as before.
    return false;
  }
}
