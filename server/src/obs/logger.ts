/**
 * pino logging (C9, SRV-15; backend-api.md §3.16).
 *
 * JSON to stdout (Docker's `local` driver rotates it). Base fields on every line: `ts`, `level`,
 * `msg`, `build`. Correlation fields where known: reqId, uid, authSessionIdHash, osSessionId, opId,
 * pid, route, status, durMs, errno, reason. Secret-bearing fields are replaced with [redacted].
 * File contents, chunk text and LLM prompts are never logged (prompts go to audit_log only).
 */
import pino, { type DestinationStream, type Logger, type LoggerOptions } from 'pino';

import type { Config } from '../config.ts';

/** Redaction paths (backend-api.md §3.16). Tested by `SRV-15 ... never contain a cookie ...`. */
export const REDACT_PATHS: readonly string[] = [
  'req.headers.cookie',
  'req.headers.authorization',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
  'headers.cookie',
  'headers.authorization',
  'password',
  'current',
  'next',
  'secret',
  'token',
  'apiKey',
  '*.password',
  '*.current',
  '*.next',
  '*.secret',
  '*.token',
  '*.apiKey',
  '*.authorization',
  '*.cookie',
  'body',
  '*.body',
];

export function loggerOptions(config: Pick<Config, 'logLevel' | 'build'>): LoggerOptions {
  return {
    level: config.logLevel,
    base: { build: `${config.build.version}+${config.build.sha.slice(0, 12)}` },
    timestamp: () => `,"ts":"${new Date().toISOString()}"`,
    messageKey: 'msg',
    formatters: { level: (label) => ({ level: label }) },
    redact: { paths: [...REDACT_PATHS], censor: '[redacted]' },
  };
}

export function createLogger(
  config: Pick<Config, 'logLevel' | 'build'>,
  destination?: DestinationStream,
): Logger {
  return destination === undefined
    ? pino(loggerOptions(config))
    : pino(loggerOptions(config), destination);
}
