/**
 * Strict tool schemas (agentic-shell.md §3.7, AGT-01): every tool the gateway sends has
 * `strict: true` and an input schema inside Claude's strict subset, so the API guarantees that a
 * tool_use input validates. The gateway refuses to send a tool that breaks the subset (EINVAL),
 * and the kernel validator still re-parses every input with the ORIGINAL Valibot schema, because
 * the stripped limits (lengths, ranges, patterns) are not expressible here.
 *
 * Rules checked on every schema node:
 *   - objects: `additionalProperties: false`, and `required` lists every property;
 *   - no `oneOf` (use `anyOf`), no `$ref` / `$defs` / `definitions` (inline, no recursion);
 *   - none of the stripped keywords (minLength, maxLength, pattern, minimum, maximum,
 *     exclusiveMinimum, exclusiveMaximum, multipleOf, maxItems, uniqueItems; minItems other than
 *     0 or 1);
 *   - `format` only from the supported list.
 */
import { ErrnoError } from '../../errno.ts';

const FORBIDDEN = [
  'oneOf',
  '$ref',
  '$defs',
  'definitions',
  'minLength',
  'maxLength',
  'pattern',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'maxItems',
  'uniqueItems',
] as const;

const FORMATS = new Set([
  'date-time',
  'time',
  'date',
  'duration',
  'email',
  'hostname',
  'uri',
  'ipv4',
  'ipv6',
  'uuid',
]);

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Every problem found in `schema`, as `path: message` strings (empty when strict-compatible). */
export function strictSchemaProblems(schema: unknown, path = '$'): string[] {
  if (!isObject(schema)) return typeof schema === 'boolean' ? [] : [`${path}: not a schema object`];
  const problems: string[] = [];
  for (const k of FORBIDDEN) {
    if (k in schema) problems.push(`${path}: unsupported keyword ${k}`);
  }
  if ('minItems' in schema && schema['minItems'] !== 0 && schema['minItems'] !== 1) {
    problems.push(`${path}: minItems other than 0 or 1`);
  }
  if ('format' in schema && !FORMATS.has(String(schema['format']))) {
    problems.push(`${path}: unsupported format ${String(schema['format'])}`);
  }
  const props = schema['properties'];
  const isObjectType = schema['type'] === 'object' || isObject(props);
  if (isObjectType) {
    if (schema['additionalProperties'] !== false) {
      problems.push(`${path}: additionalProperties must be false`);
    }
    const keys = isObject(props) ? Object.keys(props) : [];
    const required = Array.isArray(schema['required']) ? schema['required'].map(String) : [];
    for (const k of keys) {
      if (!required.includes(k)) problems.push(`${path}.${k}: not in required`);
    }
    for (const r of required) {
      if (!keys.includes(r)) problems.push(`${path}: required names unknown property ${r}`);
    }
    if (isObject(props)) {
      for (const [k, sub] of Object.entries(props)) {
        problems.push(...strictSchemaProblems(sub, `${path}.${k}`));
      }
    }
  }
  const items = schema['items'];
  if (items !== undefined) problems.push(...strictSchemaProblems(items, `${path}[]`));
  for (const combinator of ['anyOf', 'allOf', 'prefixItems'] as const) {
    const list = schema[combinator];
    if (Array.isArray(list)) {
      list.forEach((sub, i) =>
        problems.push(...strictSchemaProblems(sub, `${path}.${combinator}[${i}]`)),
      );
    }
  }
  return problems;
}

export interface StrictToolLike {
  readonly name: string;
  readonly input_schema: unknown;
}

/** Throws EINVAL naming every non-strict tool (a build-time bug, never a user error). */
export function assertStrictTools(tools: readonly StrictToolLike[]): void {
  const problems: string[] = [];
  const names = new Set<string>();
  for (const t of tools) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(t.name)) problems.push(`${t.name}: invalid tool name`);
    if (names.has(t.name)) problems.push(`${t.name}: duplicate tool name`);
    names.add(t.name);
    const s = t.input_schema;
    if (!isObject(s) || s['type'] !== 'object')
      problems.push(`${t.name}: input_schema must be an object schema`);
    for (const p of strictSchemaProblems(s)) problems.push(`${t.name} ${p}`);
  }
  if (problems.length > 0) {
    throw new ErrnoError(
      'EINVAL',
      { reason: 'bad-tool', problems },
      `non-strict tool schema: ${problems[0] ?? ''}`,
    );
  }
}

/** Replaces every `null` member of an object tree by absence (strict tools model optionals as nullable). */
export function nullsToAbsent(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(nullsToAbsent);
  if (isObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (v !== null) out[k] = nullsToAbsent(v);
    }
    return out;
  }
  return value;
}
