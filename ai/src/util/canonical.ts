/**
 * Canonical JSON (agentic-shell.md §3.12): sorted keys, NFC strings, no insignificant whitespace.
 * `undefined` members are dropped as in JSON.stringify. Used for plan, dry-run and cassette hashes.
 */
import { sha256Hex } from '@plotinium/protocol';

export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value.normalize('NFC'));
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value !== 'object') return 'null';
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  if (ArrayBuffer.isView(value)) {
    return canonicalJson(
      Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)),
    );
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort((a, b) => (a.normalize('NFC') < b.normalize('NFC') ? -1 : 1));
  return `{${keys.map((k) => `${JSON.stringify(k.normalize('NFC'))}:${canonicalJson(obj[k])}`).join(',')}}`;
}

export function canonicalHash(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}
