/**
 * Trusted Types on the boot path (security-model.md §3.9 and §4.1, SEC-22). Caddy sends
 * `Content-Security-Policy-Report-Only: require-trusted-types-for 'script'`, so every string
 * handed to a script-URL sink (`new Worker(url)`) is reported. The router creates its two
 * workers (the POST probe and the kernel) through ONE named policy that only lets same-origin
 * URLs through, including same-origin `blob:` URLs, so the boot path is clean under the
 * report-only policy today and would keep working if it were enforced.
 */
interface ScriptUrlPolicy {
  createScriptURL(input: string): unknown;
}

interface TrustedTypesFactory {
  createPolicy(
    name: string,
    rules: { readonly createScriptURL: (input: string) => string },
  ): ScriptUrlPolicy;
}

export const BOOT_POLICY_NAME = 'plotinium-boot';

/** The URL itself when it resolves to `origin` (a `blob:` URL carries its creator's origin). */
export function sameOriginScriptUrl(input: string, origin: string, base: string): string {
  let resolved: URL;
  try {
    resolved = new URL(input, base);
  } catch {
    throw new TypeError(`Plotinium: not a script URL: ${input}`);
  }
  if (resolved.origin !== origin)
    throw new TypeError(`Plotinium: refusing a cross-origin script URL: ${input}`);
  return input;
}

/**
 * A `(url) => script URL` function for `new Worker(...)`. With Trusted Types it returns a
 * TrustedScriptURL; `Worker` accepts one wherever a string is accepted (hence the cast). Without
 * Trusted Types, or if the policy name is refused, it returns the checked string.
 */
export function scriptUrlFactory(win: {
  readonly location: Pick<Location, 'origin' | 'href'>;
}): (url: string) => string {
  const check = (s: string): string =>
    sameOriginScriptUrl(s, win.location.origin, win.location.href);
  const tt = (win as { readonly trustedTypes?: TrustedTypesFactory }).trustedTypes;
  if (tt === undefined) return check;
  let policy: ScriptUrlPolicy;
  try {
    policy = tt.createPolicy(BOOT_POLICY_NAME, { createScriptURL: check });
  } catch {
    return check;
  }
  return (url) => policy.createScriptURL(url) as string;
}
