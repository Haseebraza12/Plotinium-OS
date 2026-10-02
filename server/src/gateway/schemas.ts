/**
 * Request and response shapes of /api/auth/* (backend-api.md §4.1).
 *
 * TODO(R1, protocol/): these belong in protocol/src/http/auth.ts (backend-api.md §4: "All request
 * and response schemas are Valibot modules under protocol/src/http/"), which does not exist yet.
 * They are declared here with the protocol's own Username schema until it lands; the kernel's
 * HTTP client must use the same shapes.
 */
import * as v from 'valibot';

import { Username, type BuildIdentity } from '@plotinium/protocol';

const Password = v.pipe(v.string(), v.minLength(1), v.maxLength(1024));

export const LoginReq = v.strictObject({ username: Username, password: Password });
export const SuReq = v.strictObject({ target: Username, password: Password });
export const PasswordReq = v.strictObject({
  current: Password,
  next: v.pipe(v.string(), v.minLength(12), v.maxLength(1024)),
});
/** `DELETE /api/auth/su/{uid}` path parameter. */
export const SuParams = v.strictObject({
  uid: v.pipe(v.string(), v.regex(/^\d{1,10}$/), v.transform(Number)),
});

export interface AuthMe {
  readonly uid: number;
  readonly username: string;
  readonly kind: 'root' | 'user' | 'guest' | 'demo' | 'examiner';
  readonly gid: number;
  readonly groups: readonly { readonly gid: number; readonly name: string }[];
  readonly home: string;
  readonly quota: {
    quotaBytes: number;
    quotaInodes: number;
    usedBytes: number;
    usedInodes: number;
  };
  readonly suGrants: readonly {
    readonly uid: number;
    readonly username: string;
    readonly expiresAt: string;
  }[];
  readonly session: { readonly expiresAt: string; readonly absoluteExpiresAt: string };
  readonly passwordVersion: number;
  readonly offlineVerifier: { readonly allowed: boolean };
  readonly telemetryOptIn: boolean;
  readonly server: BuildIdentity;
}

export interface SuRes {
  readonly grant: { readonly uid: number; readonly username: string; readonly expiresAt: string };
}
