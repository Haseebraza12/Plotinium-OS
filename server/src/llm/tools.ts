/**
 * The model's tools, built from the protocol's Valibot schemas (agentic-shell.md §3.6, §3.7;
 * AGT-01, C3). Valibot is the only schema language: `@valibot/to-json-schema` turns each tool
 * input into JSON Schema, and `toStrictSubset` post-processes it into Claude's strict tool subset:
 *   - drop `$schema`; inline every `$ref` (a recursive schema is a build error);
 *   - `oneOf` becomes `anyOf`;
 *   - every object: `additionalProperties: false` and `required` = every key; a key that was
 *     optional becomes `anyOf: [T, {type: 'null'}]` (the protocol already models optionals so);
 *   - strip the keywords strict mode does not support (lengths, patterns, numeric bounds,
 *     `multipleOf`, `maxItems`, `uniqueItems`, `minItems` other than 0 and 1, unsupported formats);
 *   - sort object keys and tools by name, so the serialisation is byte-stable (prompt caching and
 *     cassette keys depend on it).
 * Every stripped limit stays enforced: the route re-parses the model's input with the ORIGINAL
 * Valibot schema (nulls intact, because the protocol models optionals as nullable-required), and the
 * kernel validator parses it again. `assertStrictTools` (engine/llm/strict-tools.ts) is the check.
 *
 * Mirrors ai/src/agent/strict-schema.ts, which the server may not import (package boundaries).
 */
import { toJsonSchema } from '@valibot/to-json-schema';
import * as v from 'valibot';

import { READ_ONLY_TOOLS, TERMINAL_TOOLS } from '@plotinium/protocol';

import type { BetaTool } from '../engine/llm/anthropic.ts';
import { assertStrictTools } from '../engine/llm/strict-tools.ts';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

const STRIPPED = new Set([
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
]);
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

const isObject = (x: Json | undefined): x is JsonObject =>
  typeof x === 'object' && x !== null && !Array.isArray(x);

function isNullable(s: Json | undefined): boolean {
  if (!isObject(s)) return false;
  if (s['type'] === 'null') return true;
  const any = s['anyOf'];
  return Array.isArray(any) && any.some((b) => isNullable(b));
}

function sortKeys(o: JsonObject): JsonObject {
  const out: JsonObject = {};
  for (const k of Object.keys(o).sort()) {
    const x = o[k];
    if (x !== undefined) out[k] = x;
  }
  return out;
}

/** One tool input schema in the strict subset (throws on a recursive or unknown `$ref`). */
export function toStrictSubset(schema: JsonObject): JsonObject {
  const defs: JsonObject = {};
  for (const key of ['$defs', 'definitions']) {
    const d = schema[key];
    if (isObject(d)) Object.assign(defs, d);
  }
  const stack: string[] = [];
  const node = (s: Json): Json => {
    if (Array.isArray(s)) return s.map(node);
    if (!isObject(s)) return s;
    const ref = s['$ref'];
    if (typeof ref === 'string') {
      if (stack.includes(ref)) throw new Error(`recursive $ref ${ref}`);
      const m = /^#\/(?:\$defs|definitions)\/(.+)$/.exec(ref);
      const target = m?.[1] === undefined ? undefined : defs[m[1]];
      if (target === undefined) throw new Error(`unknown $ref ${ref}`);
      stack.push(ref);
      const r = node(target);
      stack.pop();
      return r;
    }
    const out: JsonObject = {};
    for (const [key, value] of Object.entries(s)) {
      if (key === 'properties' && isObject(value)) {
        const props: JsonObject = {};
        for (const [name, sub] of Object.entries(value)) props[name] = node(sub);
        out['properties'] = props;
        continue;
      }
      if (key === '$schema' || key === '$defs' || key === 'definitions' || key === '$id') continue;
      if (STRIPPED.has(key)) continue;
      if (key === 'minItems' && value !== 0 && value !== 1) continue;
      if (key === 'format' && (typeof value !== 'string' || !FORMATS.has(value))) continue;
      out[key === 'oneOf' ? 'anyOf' : key] = node(value);
    }
    const props = out['properties'];
    if (out['type'] === 'object' || isObject(props)) {
      const required = new Set(
        Array.isArray(s['required']) ? s['required'].filter((k) => typeof k === 'string') : [],
      );
      const fixed: JsonObject = {};
      if (isObject(props)) {
        for (const k of Object.keys(props).sort()) {
          const p = props[k];
          if (p === undefined) continue;
          fixed[k] = required.has(k) || isNullable(p) ? p : { anyOf: [p, { type: 'null' }] };
        }
      }
      out['type'] = 'object';
      out['properties'] = fixed;
      out['required'] = Object.keys(fixed);
      out['additionalProperties'] = false;
    }
    return sortKeys(out);
  };
  const r = node(schema);
  if (!isObject(r)) throw new Error('a tool input must be an object schema');
  return r;
}

export type ToolKind = 'observe' | 'plan' | 'clarify' | 'cannot' | 'extract' | 'answer';

/** A tool as the route uses it: the provider definition, its kind and the ORIGINAL schema. */
export interface ModelTool {
  readonly definition: BetaTool;
  readonly kind: ToolKind;
  readonly schema: v.GenericSchema;
}

function tool(
  name: string,
  description: string,
  schema: v.GenericSchema,
  kind: ToolKind,
): ModelTool {
  const json = toJsonSchema(schema, { errorMode: 'ignore' }) as unknown as JsonObject;
  return {
    kind,
    schema,
    definition: {
      name,
      description,
      strict: true,
      input_schema: toStrictSubset(json) as BetaTool['input_schema'],
    },
  };
}

const TERMINAL_KIND: Record<keyof typeof TERMINAL_TOOLS, ToolKind> = {
  submit_plan: 'plan',
  ask_clarification: 'clarify',
  cannot_comply: 'cannot',
};

/** The planner's tools (read-only observation tools plus the three terminal tools), by name. */
export function buildPlanTools(): readonly ModelTool[] {
  const out: ModelTool[] = [];
  for (const t of Object.values(READ_ONLY_TOOLS))
    out.push(tool(t.name, t.description, t.input, 'observe'));
  for (const [key, t] of Object.entries(TERMINAL_TOOLS) as [
    keyof typeof TERMINAL_TOOLS,
    (typeof TERMINAL_TOOLS)[keyof typeof TERMINAL_TOOLS],
  ][])
    out.push(tool(t.name, t.description, t.input, TERMINAL_KIND[key]));
  out.sort((a, b) =>
    a.definition.name < b.definition.name ? -1 : a.definition.name > b.definition.name ? 1 : 0,
  );
  assertStrictTools(out.map((t) => t.definition));
  return out;
}

/** An extracted value must be a valid file name (agentic-shell.md §3.6 `extract_list`). */
const ExtractItem = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxBytes(255),
  v.check(
    (s) =>
      !s.includes('/') &&
      s !== '.' &&
      s !== '..' &&
      [...s].every((ch) => (ch.codePointAt(0) ?? 0) >= 0x20 && ch !== '\u007f'),
  ),
);

/** The quarantined extraction: its only tool returns `{items}`; the planner never sees them. */
export const ExtractOutput = v.strictObject({
  items: v.pipe(v.array(ExtractItem), v.maxLength(100)),
});

/** The optional RAG answer (rag-semantic-search.md §3.11): sentences citing retrieved chunks. */
export const AnswerOutput = v.strictObject({
  sentences: v.pipe(
    v.array(
      v.strictObject({
        text: v.pipe(v.string(), v.minLength(1), v.maxLength(1000)),
        chunk_ids: v.pipe(v.array(v.pipe(v.string(), v.maxLength(64))), v.maxLength(10)),
      }),
    ),
    v.maxLength(20),
  ),
});

export function buildExtractTools(): readonly ModelTool[] {
  const t = [
    tool(
      'return_items',
      'Return the requested short values found in the untrusted text, each a valid file name.',
      ExtractOutput,
      'extract',
    ),
  ];
  assertStrictTools(t.map((x) => x.definition));
  return t;
}

export function buildAnswerTools(): readonly ModelTool[] {
  const t = [
    tool(
      'answer',
      'Answer the question in sentences; every sentence cites the ids of the chunks it uses.',
      AnswerOutput,
      'answer',
    ),
  ];
  assertStrictTools(t.map((x) => x.definition));
  return t;
}
