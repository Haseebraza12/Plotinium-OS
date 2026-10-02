/**
 * Requirement ID grammar for tools/traceability.ts (C18).
 *
 * Normative source: specs/00-product/requirements-traceability.md §4.1 (the ID grammar) and §3.13
 * (the registered Plotinium design ID prefixes). The first whitespace-delimited token of a test
 * title is its requirement ID. It must be one of the 84 spec IDs or match a registered prefix; a
 * token that looks like an ID but is not registered is reported (TRC-02). A new prefix is added
 * here only by the PR that registers it in requirements-traceability.md §3.13.
 */

export type Keyword = 'Must' | 'Should' | 'May';

export interface SpecRequirement {
  readonly id: string;
  readonly keyword: Keyword;
  readonly section: string;
}

/** The 84 numbered requirements of the capstone specification, with keyword and section. */
const AREAS: ReadonlyArray<readonly [prefix: string, section: string, keywords: string]> = [
  // One letter per requirement, in order: M = Must, S = Should, Y = May.
  ['BOOT', '§6.5', 'MMMMMMMMMMMMMS'],
  ['PROC', '§9.1', 'MMMMMMMMS'],
  ['MEM', '§9.2', 'MMMMMMMY'],
  ['VFS', '§9.3', 'MMMMMMMMMMS'],
  ['WM', '§9.4', 'MMMMMMS'],
  ['OFF', '§9.5', 'MMMMS'],
  ['SYS', '§9.6', 'MMM'],
  ['DB', '§11.5', 'MMMMM'],
  ['RAG', '§12.2', 'MMMMMM'],
  ['AGT', '§12.3', 'MMMMMMMMMY'],
  ['PRE', '§12.4', 'MMMMMM'],
];

const KEYWORDS: Readonly<Record<string, Keyword>> = { M: 'Must', S: 'Should', Y: 'May' };

export const SPEC_REQUIREMENTS: readonly SpecRequirement[] = AREAS.flatMap(
  ([prefix, section, keywords]) =>
    [...keywords].map((letter, index) => ({
      id: `${prefix}-${String(index + 1).padStart(2, '0')}`,
      keyword: KEYWORDS[letter] ?? 'Must',
      section,
    })),
);

/** requirements-traceability.md §4.1: the 84 spec IDs. Nothing else is a spec ID. */
export const SPEC_ID =
  /^(?:BOOT-(?:0[1-9]|1[0-4])|PROC-0[1-9]|MEM-0[1-8]|VFS-(?:0[1-9]|1[01])|WM-0[1-7]|OFF-0[1-5]|SYS-0[1-3]|DB-0[1-5]|RAG-0[1-6]|AGT-(?:0[1-9]|10)|PRE-0[1-6])$/;

/** requirements-traceability.md §3.13: registered Plotinium design ID forms. */
export const PLOTINIUM_ID: readonly RegExp[] = [
  /^PLT-(?:ID|DSA|DOC|DEL|TEAM|AI)-\d{2}$/,
  /^(?:TRC|GLO|SPX|ARC|ABI|SVC|KPS|KMM|PVFS|WMD|DSN|SYN|AIS)-\d{2}$/,
  /^INV-ABI-\d{1,2}$/,
  /^DSA-(?:GEN|TREE|TRIE|HEAP|DAG|LRU|HASH|RING|BLOOM|ZORD|IVT|DB|MAP)-\d{2}$/,
  /^AIN-[ABC][1-4]$/,
  /^CPL-[ABC]-(?:SCHED|MEM|VFS|SHELL|DB|SEC)$/,
  /^I-[ABCS]\d{1,2}$/,
];

/** Anything shaped like an ID (upper-case words joined by hyphens, ending in a number or cell). */
const ID_SHAPE = /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+$/;

export type IdKind = 'spec' | 'plotinium' | 'unregistered';

export interface TitleId {
  readonly id: string;
  readonly kind: IdKind;
}

/** Classify the first whitespace-delimited token of a test title; null when it is not an ID. */
export function idOfTitle(title: string): TitleId | null {
  const token = title.trimStart().split(/\s/, 1)[0] ?? '';
  if (SPEC_ID.test(token)) return { id: token, kind: 'spec' };
  if (PLOTINIUM_ID.some((pattern) => pattern.test(token))) return { id: token, kind: 'plotinium' };
  if (ID_SHAPE.test(token) && /\d/.test(token)) return { id: token, kind: 'unregistered' };
  return null;
}
