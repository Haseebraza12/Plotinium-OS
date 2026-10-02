/**
 * The server's build identity as it travels on the wire (`hello.ok.server`, backend-api.md §3.16,
 * identity spec request). protocol's BuildIdentity requires a 7-12 hex `build` and an ISO date;
 * a development image built without BUILD_SHA / BUILD_DATE carries 'unknown', which is mapped to
 * fixed placeholders so the frame still validates on the client.
 */
import type { BuildIdentity } from '@plotinium/protocol';

import type { Config } from '../config.ts';

export const UNKNOWN_BUILD_SHA = '0000000';
export const UNKNOWN_BUILD_DATE = '1970-01-01';

const SHA_RE = /^[0-9a-f]{7,40}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const VERSION_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/;

export function wireBuild(build: Config['build']): BuildIdentity {
  const sha = build.sha.toLowerCase();
  return {
    name: 'Plotinium',
    version: VERSION_RE.test(build.version) && build.version.length <= 32 ? build.version : '0.0.0',
    build: SHA_RE.test(sha) ? sha.slice(0, 12) : UNKNOWN_BUILD_SHA,
    date: DATE_RE.test(build.date) ? build.date : UNKNOWN_BUILD_DATE,
  };
}
