// lint-as: apps/demo/fixture.ts
// expect: local/no-yieldless-loop-in-generator
// A loop that never yields cannot be pre-empted at its quantum (PROC-03).
export function* run(): Generator<undefined, number, unknown> {
  let n = 0;
  while (n < 1e9) {
    n += 1;
  }
  yield undefined;
  return n;
}
