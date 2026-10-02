/**
 * Valibot parsing of request input (SRV-05; backend-api.md §3.3 step 9): a schema failure is
 * 400 EINVAL with `detail.field` naming the first offending field, never echoing its value.
 */
import * as v from 'valibot';

import { HttpError } from './errors.ts';

export function parseInput<S extends v.GenericSchema>(schema: S, input: unknown): v.InferOutput<S> {
  const r = v.safeParse(schema, input ?? {}, { abortPipeEarly: true });
  if (r.success) return r.output;
  const first = r.issues[0];
  const field = first === undefined ? undefined : (v.getDotPath(first) ?? undefined);
  throw new HttpError(400, 'EINVAL', 'invalid request', field === undefined ? {} : { field });
}
