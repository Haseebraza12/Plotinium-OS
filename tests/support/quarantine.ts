/**
 * The flaky-test quarantine (spec §3.14, §4.4; TST-16): at most two entries, each expiring at most
 * seven days after it was added; an expired entry or a third one fails the lint job, and no gate
 * is tagged while a gate-relevant test is quarantined.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface QuarantineEntry {
  title: string;
  file: string;
  project: string;
  issue: number;
  owner: 'R1' | 'R2' | 'R3' | 'R4' | 'R5';
  since: string;
  expires: string;
}

export const QUARANTINE_PATH = fileURLToPath(new URL('../quarantine.json', import.meta.url));
export const MAX_ENTRIES = 2;
const DAY_MS = 24 * 3600 * 1000;
const OWNERS: readonly string[] = ['R1', 'R2', 'R3', 'R4', 'R5'];

/** Every rule the quarantine file breaks at `now`; empty when it is acceptable. */
export function checkQuarantine(data: unknown, now: number = Date.now()): string[] {
  if (
    typeof data !== 'object' ||
    data === null ||
    !('entries' in data) ||
    !Array.isArray(data.entries)
  ) {
    return ['quarantine.json must be { "entries": [...] }'];
  }
  const entries = data.entries as unknown[];
  const errors: string[] = [];
  if (entries.length > MAX_ENTRIES)
    errors.push(`${entries.length} tests in quarantine; at most ${MAX_ENTRIES} are allowed`);
  entries.forEach((raw, i) => {
    const e = raw as Partial<QuarantineEntry>;
    const at = `entries[${i}]${typeof e.title === 'string' ? ` (${e.title})` : ''}`;
    if (typeof e.title !== 'string' || !/^[A-Z][A-Z0-9-]*-\d{2}\s/.test(e.title))
      errors.push(`${at}: title must begin with its requirement ID`);
    if (typeof e.file !== 'string' || typeof e.project !== 'string')
      errors.push(`${at}: file and project are required`);
    if (!Number.isInteger(e.issue)) errors.push(`${at}: an issue number is required`);
    if (typeof e.owner !== 'string' || !OWNERS.includes(e.owner))
      errors.push(`${at}: owner must be R1-R5`);
    const since = Date.parse(e.since ?? '');
    const expires = Date.parse(e.expires ?? '');
    if (Number.isNaN(since) || Number.isNaN(expires)) {
      errors.push(`${at}: since and expires must be ISO dates`);
      return;
    }
    if (expires - since > 7 * DAY_MS) errors.push(`${at}: expires more than 7 days after since`);
    if (expires < now) errors.push(`${at}: expired on ${e.expires}`);
  });
  return errors;
}

/** Quarantined titles whose requirement ID is due at the gate being tagged (release check). */
export function blockingGate(
  entries: readonly Pick<QuarantineEntry, 'title'>[],
  gateIds: ReadonlySet<string>,
): string[] {
  return entries.filter((e) => gateIds.has(e.title.split(/\s/, 1)[0] ?? '')).map((e) => e.title);
}

export function loadQuarantine(path: string = QUARANTINE_PATH): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}
