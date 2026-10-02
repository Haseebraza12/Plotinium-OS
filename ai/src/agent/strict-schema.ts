/**
 * The strict-schema post-processor contract (agentic-shell.md §3.7; AGT-01, C3).
 *
 * The server's build step runs `@valibot/to-json-schema` over `protocol/ai/tools.ts` and then this
 * pure post-processor, which turns the output into Claude's strict tool subset:
 * - drop `$schema`; inline every `$ref` into `$defs`/`definitions` (a recursive schema is an error);
 * - rewrite `oneOf` to `anyOf`;
 * - every object gets `additionalProperties: false` and `required` = every key; a key that was
 *   optional becomes `anyOf: [T, {type: 'null'}]` (the gateway maps null back to absent);
 * - strip the keywords strict mode does not support (`minLength`, `maxLength`, `pattern`, numeric
 *   bounds, `multipleOf`, `minItems` other than 0 and 1, `maxItems`, `uniqueItems`, unsupported
 *   `format`s);
 * - sort object keys, and tools by name, so the serialisation is byte-stable.
 * Every stripped limit stays enforced: the kernel re-parses tool input with the ORIGINAL Valibot
 * schema. `strictViolations` is the walker of test `AGT-01 strict tool schemas contain no
 * unsupported keyword`.
 *
 * TODO(R4/server): ai/ may not be imported by server/, so this module moves to protocol/ (or is
 * mirrored by server/llm/tools/build.ts) when the gateway build lands.
 */
import { canonicalJson } from '../util/canonical.ts';
import { type Result, fail, ok } from '../util/errors.ts';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

export const STRIPPED_KEYWORDS = [
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
  'minProperties',
  'maxProperties',
] as const;

export const SUPPORTED_FORMATS = new Set([
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

const isObject = (v: Json | undefined): v is JsonObject =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function sortKeys(o: JsonObject): JsonObject {
  const out: JsonObject = {};
  for (const k of Object.keys(o).sort()) {
    const v = o[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

function isNullable(s: Json): boolean {
  if (!isObject(s)) return false;
  if (s['type'] === 'null') return true;
  if (Array.isArray(s['type']) && s['type'].includes('null')) return true;
  const any = s['anyOf'];
  return Array.isArray(any) && any.some((b) => isNullable(b));
}

function refTarget(ref: string, defs: JsonObject): Json | undefined {
  const m = /^#\/(?:\$defs|definitions)\/(.+)$/.exec(ref);
  if (m?.[1] === undefined) return undefined;
  return defs[m[1].replace(/~1/g, '/').replace(/~0/g, '~')];
}

class Rewriter {
  private readonly defs: JsonObject;
  private readonly stack: string[] = [];

  constructor(defs: JsonObject) {
    this.defs = defs;
  }

  node(schema: Json): Result<Json> {
    if (Array.isArray(schema)) {
      const out: Json[] = [];
      for (const item of schema) {
        const r = this.node(item);
        if (!r.ok) return r;
        out.push(r.value);
      }
      return ok(out);
    }
    if (!isObject(schema)) return ok(schema);
    const ref = schema['$ref'];
    if (typeof ref === 'string') {
      if (this.stack.includes(ref))
        return fail('EINVAL', 'recursive-schema', undefined, `recursive $ref ${ref}`);
      const target = refTarget(ref, this.defs);
      if (target === undefined) return fail('EINVAL', 'unknown-ref', undefined, ref);
      this.stack.push(ref);
      const r = this.node(target);
      this.stack.pop();
      return r;
    }
    const out: JsonObject = {};
    for (const [key, value] of Object.entries(schema)) {
      if (key === 'properties' && isObject(value)) {
        // Property NAMES are data, not keywords: rewrite each property schema, keep every name.
        const props: JsonObject = {};
        for (const [name, sub] of Object.entries(value)) {
          const r = this.node(sub);
          if (!r.ok) return r;
          props[name] = r.value;
        }
        out['properties'] = props;
        continue;
      }
      if (key === '$schema' || key === '$defs' || key === 'definitions' || key === '$id') continue;
      if ((STRIPPED_KEYWORDS as readonly string[]).includes(key)) continue;
      if (key === 'minItems' && value !== 0 && value !== 1) continue;
      if (key === 'format' && (typeof value !== 'string' || !SUPPORTED_FORMATS.has(value)))
        continue;
      const r = this.node(value);
      if (!r.ok) return r;
      out[key === 'oneOf' ? 'anyOf' : key] = r.value;
    }
    const props = out['properties'];
    if (out['type'] === 'object' || isObject(props)) {
      const required = new Set(
        Array.isArray(schema['required'])
          ? schema['required'].filter((k) => typeof k === 'string')
          : [],
      );
      const fixed: JsonObject = {};
      if (isObject(props)) {
        for (const k of Object.keys(props).sort()) {
          const p = props[k];
          if (p === undefined) continue;
          // An optional key must stay optional in meaning: it becomes "T or null".
          fixed[k] = required.has(k) || isNullable(p) ? p : { anyOf: [p, { type: 'null' }] };
        }
      }
      out['type'] = 'object';
      out['properties'] = fixed;
      out['required'] = Object.keys(fixed);
      out['additionalProperties'] = false;
    }
    return ok(sortKeys(out));
  }
}

/** Post-process one tool input schema into the strict subset. */
export function toStrictSubset(schema: JsonObject): Result<JsonObject> {
  const defs: JsonObject = {};
  for (const key of ['$defs', 'definitions']) {
    const d = schema[key];
    if (isObject(d)) Object.assign(defs, d);
  }
  const r = new Rewriter(defs).node(schema);
  if (!r.ok) return r;
  return isObject(r.value) ? ok(r.value) : fail('EINVAL');
}

export interface ToolDefinition {
  name: string;
  description: string;
  strict: true;
  input_schema: JsonObject;
}

/** Tools sorted by name, each strict (the byte-stable form committed as plan-tools.v1.json). */
export function buildToolDefinitions(
  tools: ReadonlyArray<{ name: string; description: string; inputSchema: JsonObject }>,
): Result<ToolDefinition[]> {
  const out: ToolDefinition[] = [];
  for (const t of [...tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const s = toStrictSubset(t.inputSchema);
    if (!s.ok) return fail(s.error.errno, s.error.reason, t.name, s.error.message);
    out.push({ name: t.name, description: t.description, strict: true, input_schema: s.value });
  }
  return ok(out);
}

/** The byte-stable serialisation that prompt caching and cassette keys depend on. */
export function serialiseTools(tools: readonly ToolDefinition[]): string {
  return canonicalJson(tools);
}

/** Every violation of the strict subset, as `path: problem` strings (empty when compliant). */
export function strictViolations(schema: Json, path = '$'): string[] {
  const out: string[] = [];
  if (Array.isArray(schema)) {
    schema.forEach((s, i) => out.push(...strictViolations(s, `${path}[${i}]`)));
    return out;
  }
  if (!isObject(schema)) return out;
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'properties' && isObject(value)) {
      for (const [name, sub] of Object.entries(value))
        out.push(...strictViolations(sub, `${path}.properties.${name}`));
      continue;
    }
    if (key === 'oneOf') out.push(`${path}: oneOf`);
    if (key === '$ref' || key === '$defs' || key === 'definitions' || key === '$schema')
      out.push(`${path}: ${key}`);
    if ((STRIPPED_KEYWORDS as readonly string[]).includes(key)) out.push(`${path}: ${key}`);
    if (key === 'minItems' && value !== 0 && value !== 1)
      out.push(`${path}: minItems ${JSON.stringify(value)}`);
    if (key === 'format' && (typeof value !== 'string' || !SUPPORTED_FORMATS.has(value)))
      out.push(`${path}: format`);
    out.push(...strictViolations(value, `${path}.${key}`));
  }
  if (schema['type'] === 'object' || isObject(schema['properties'])) {
    if (schema['additionalProperties'] !== false)
      out.push(`${path}: additionalProperties not false`);
    const props = isObject(schema['properties']) ? Object.keys(schema['properties']) : [];
    const req = Array.isArray(schema['required']) ? schema['required'] : [];
    for (const k of props) if (!req.includes(k)) out.push(`${path}: key ${k} not required`);
  }
  return out;
}
