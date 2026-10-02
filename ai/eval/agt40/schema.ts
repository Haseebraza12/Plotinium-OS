/**
 * The AGT-40 and INJ-20 case formats (agentic-shell.md §8.1, §8.2), plus our `reference` field:
 * the terminal tool input a correct model would submit (and, for INJ-20, the plan an injected
 * model would propose), so the kernel-side pipeline can be graded without a model.
 *
 * TODO(R4): the spec asks for a Valibot schema here; `valibot` is not a dependency of ai/
 * (requested), so this is a hand-written structural check with the same rules.
 */
import { isErrno, type Errno } from '@plotinium/protocol';

export type Tuple = [call: string, path: string, arg?: string];

export interface Reference {
  observe?: Array<{ name: string; input: unknown }>;
  tool: 'submit_plan' | 'ask_clarification' | 'cannot_comply';
  input: unknown;
}

export interface OverlayItem {
  path: string;
  type: 'f' | 'd';
  mode?: string;
  mtime?: string;
  content?: string;
}

export interface AgtCase {
  id: string;
  category: 'pipeline' | 'relative-date' | 'glob' | 'ambiguous' | 'must-reject';
  tags: Array<
    | 'needs-observation'
    | 'content-predicate'
    | 'extraction'
    | 'refusal-regression'
    | 'over-20-inodes'
  >;
  user: 'alice' | 'bob' | 'carol';
  cwd: string;
  now: string;
  tz: 'Asia/Karachi';
  fixture: 'fx-agt@v1';
  overlay?: OverlayItem[];
  prompt: string;
  clarificationAnswer?: string;
  expect:
    | { kind: 'plan'; ops: Tuple[]; confirm: boolean }
    | { kind: 'clarify' }
    | { kind: 'reject'; errno: Errno };
  reference: Reference;
}

export interface InjCase {
  id: string;
  vector: 'name' | 'content-grep' | 'content-extract' | 'content-rag-answer';
  technique:
    | 'plain-instruction'
    | 'fake-closing-tag'
    | 'unicode-tags'
    | 'bidi-override'
    | 'zero-width'
    | 'system-prefix'
    | 'base64'
    | 'marker-guess'
    | 'homoglyph'
    | 'tool-call-json';
  user: 'alice';
  cwd: string;
  now: string;
  fixture: 'fx-agt@v1';
  overlay: OverlayItem[];
  prompt: string;
  allowed: Tuple[];
  forbidden: Array<[call: string, pathGlob: string]>;
  /** The plan a model fooled by the payload would propose. */
  attack: Reference;
}

type Check = (v: unknown) => string | undefined;
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const oneOf =
  (list: readonly string[]): Check =>
  (v) =>
    typeof v === 'string' && list.includes(v) ? undefined : `not one of ${list.join('|')}`;
const str: Check = (v) =>
  typeof v === 'string' && v.length > 0 ? undefined : 'not a non-empty string';
const tuple: Check = (v) =>
  Array.isArray(v) && v.length >= 2 && v.length <= 3 && v.every((x) => typeof x === 'string')
    ? undefined
    : 'not a (call, path, arg?) tuple';

function field(
  o: Record<string, unknown>,
  key: string,
  check: Check,
  errors: string[],
  optional = false,
): void {
  if (o[key] === undefined) {
    if (!optional) errors.push(`${key}: missing`);
    return;
  }
  const e = check(o[key]);
  if (e !== undefined) errors.push(`${key}: ${e}`);
}

function overlayCheck(v: unknown): string | undefined {
  if (!Array.isArray(v)) return 'not an array';
  for (const o of v) {
    if (!isObj(o) || typeof o['path'] !== 'string' || (o['type'] !== 'f' && o['type'] !== 'd'))
      return 'bad overlay entry';
  }
  return undefined;
}

function referenceCheck(v: unknown): string | undefined {
  if (!isObj(v)) return 'not an object';
  if (oneOf(['submit_plan', 'ask_clarification', 'cannot_comply'])(v['tool']) !== undefined)
    return 'bad tool';
  if (v['observe'] !== undefined && !Array.isArray(v['observe'])) return 'bad observe';
  return v['input'] === undefined ? 'missing input' : undefined;
}

const EXPECT: Check = (v) => {
  if (!isObj(v)) return 'not an object';
  if (v['kind'] === 'clarify') return undefined;
  if (v['kind'] === 'reject') return isErrno(v['errno']) ? undefined : 'bad errno';
  if (v['kind'] === 'plan') {
    if (!Array.isArray(v['ops']) || v['ops'].some((t) => tuple(t) !== undefined)) return 'bad ops';
    return typeof v['confirm'] === 'boolean' ? undefined : 'bad confirm';
  }
  return 'bad kind';
};

/** Structural validation; returns the list of problems (empty when the case is well formed). */
export function checkAgtCase(v: unknown): string[] {
  const errors: string[] = [];
  if (!isObj(v)) return ['not an object'];
  field(
    v,
    'id',
    (x) => (typeof x === 'string' && /^AGT40-[PDGAR]\d\d$/.test(x) ? undefined : 'bad id'),
    errors,
  );
  field(
    v,
    'category',
    oneOf(['pipeline', 'relative-date', 'glob', 'ambiguous', 'must-reject']),
    errors,
  );
  field(v, 'tags', (x) => (Array.isArray(x) ? undefined : 'not an array'), errors);
  field(v, 'user', oneOf(['alice', 'bob', 'carol']), errors);
  field(v, 'cwd', str, errors);
  field(v, 'now', str, errors);
  field(v, 'tz', oneOf(['Asia/Karachi']), errors);
  field(v, 'fixture', oneOf(['fx-agt@v1']), errors);
  field(v, 'overlay', overlayCheck, errors, true);
  field(v, 'prompt', str, errors);
  field(v, 'clarificationAnswer', str, errors, true);
  field(v, 'expect', EXPECT, errors);
  field(v, 'reference', referenceCheck, errors);
  return errors;
}

export function checkInjCase(v: unknown): string[] {
  const errors: string[] = [];
  if (!isObj(v)) return ['not an object'];
  field(
    v,
    'id',
    (x) => (typeof x === 'string' && /^INJ-[NC]\d\d$/.test(x) ? undefined : 'bad id'),
    errors,
  );
  field(
    v,
    'vector',
    oneOf(['name', 'content-grep', 'content-extract', 'content-rag-answer']),
    errors,
  );
  field(
    v,
    'technique',
    oneOf([
      'plain-instruction',
      'fake-closing-tag',
      'unicode-tags',
      'bidi-override',
      'zero-width',
      'system-prefix',
      'base64',
      'marker-guess',
      'homoglyph',
      'tool-call-json',
    ]),
    errors,
  );
  field(v, 'user', oneOf(['alice']), errors);
  field(v, 'cwd', str, errors);
  field(v, 'now', str, errors);
  field(v, 'fixture', oneOf(['fx-agt@v1']), errors);
  field(v, 'overlay', overlayCheck, errors);
  field(v, 'prompt', str, errors);
  field(
    v,
    'allowed',
    (x) => (Array.isArray(x) && x.every((t) => tuple(t) === undefined) ? undefined : 'bad allowed'),
    errors,
  );
  field(
    v,
    'forbidden',
    (x) =>
      Array.isArray(x) && x.every((t) => tuple(t) === undefined) ? undefined : 'bad forbidden',
    errors,
  );
  field(v, 'attack', referenceCheck, errors);
  return errors;
}
