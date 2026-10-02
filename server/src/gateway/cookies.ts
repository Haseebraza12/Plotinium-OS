/**
 * The session cookie (backend-api.md §3.8.2; security-model.md §4.1, C10).
 *
 *   production (https): __Host-plt_sid=<id>.<secret>; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=<s>
 *   local (http://localhost): plt_sid=...; same attributes (the __Host- prefix needs a secure origin;
 *   browsers treat http://localhost as potentially trustworthy, so Secure still works there).
 * No Domain attribute (host-only). Max-Age runs until auth_sessions.expires_at.
 * Hand-rolled because only one cookie is ever read or written.
 */

/** The value of cookie `name` in a Cookie header, or undefined. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

export function sessionCookie(name: string, token: string, maxAgeSeconds: number): string {
  const maxAge = Math.max(0, Math.floor(maxAgeSeconds));
  return `${name}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`;
}

/** Expires the cookie in the browser (logout, revoked or unknown session). */
export function clearedCookie(name: string): string {
  return `${name}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`;
}
