/**
 * `v.safeParse(schema, input, {abortEarly: true})` without importing valibot here.
 *
 * The kernel package does not declare valibot as a dependency, so it cannot import it. Every
 * protocol schema is a valibot schema object whose `~run` method is exactly what `v.safeParse`
 * calls (valibot 1.x `methods/safeParse`), so this is behaviourally identical, never throws and
 * needs no `eval` (CSP-safe). TODO(R1): once `valibot` is added to kernel/package.json, replace the
 * body with `v.safeParse(schema, input, { abortEarly: true })`.
 */
import type { CallSpec } from '@plotinium/protocol';

type Schema = CallSpec['args'];
type RunResult = ReturnType<Schema['~run']>;

/** A valibot issue as produced by protocol schemas. */
export type SchemaIssue = NonNullable<RunResult['issues']>[number];

export type ParseResult<T> =
  | { readonly success: true; readonly output: T }
  | { readonly success: false; readonly issue: SchemaIssue | undefined };

/**
 * Parse `input` with `schema`, stopping at the first issue. `T` is the schema's output type,
 * supplied by the caller from the protocol's inferred types; the cast is sound because the schema
 * accepted the value.
 */
export function safeParse<T = unknown>(schema: Schema, input: unknown): ParseResult<T> {
  const dataset = schema['~run']({ value: input }, { abortEarly: true });
  if (dataset.issues === undefined) return { success: true, output: dataset.value as T };
  return { success: false, issue: dataset.issues[0] };
}
