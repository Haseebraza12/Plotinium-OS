/**
 * Parse model output with protocol's Valibot schemas through their Standard Schema interface.
 *
 * ai/ does not depend on valibot directly (it is not in ai/package.json), and every Valibot 1.x
 * schema exposes `~standard.validate`, so this is the whole bridge. Model output is only ever
 * parsed as data here (AGT-01, I-B1).
 */
interface Issue {
  readonly message: string;
}
type StandardResult<Out> =
  { readonly value: Out; readonly issues?: undefined } | { readonly issues: readonly Issue[] };

export interface Schema<Out> {
  readonly '~standard': {
    readonly validate: (value: unknown) => StandardResult<Out> | Promise<StandardResult<Out>>;
  };
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; message: string };

/** Synchronous parse; an async schema is a programming error and fails closed. */
export function parseWith<T>(schema: Schema<T>, value: unknown): Parsed<T> {
  const result = schema['~standard'].validate(value);
  if (result instanceof Promise) return { ok: false, message: 'async schema not supported' };
  if (result.issues !== undefined) {
    return {
      ok: false,
      message: result.issues
        .map((i) => i.message)
        .join('; ')
        .slice(0, 500),
    };
  }
  return { ok: true, value: result.value };
}
