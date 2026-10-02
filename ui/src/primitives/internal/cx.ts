export type ClassValue = string | false | null | undefined;

/** Joins class names, skipping empty values. CSS-module lookups may be undefined under noUncheckedIndexedAccess. */
export function cx(...values: readonly ClassValue[]): string {
  let out = '';
  for (const value of values) {
    if (value) out = out === '' ? value : `${out} ${value}`;
  }
  return out;
}
