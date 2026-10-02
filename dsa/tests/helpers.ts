/**
 * Shared test helpers for dsa/ (tests only). Property tests use fast-check with 1,000 runs on pull
 * requests and more nightly (PLT_PROP_RUNS=10000). fast-check prints the seed and path of a failing
 * run; replay it with PLT_PROP_SEED and PLT_PROP_PATH (specs/08-dsa/data-structures.md §8).
 */
import { expect } from 'vitest';

import { DsaError } from '../src/_shared/errors.ts';
import type { DsaErrorCode } from '../src/_shared/errors.ts';

/** Assert that `fn` throws a DsaError with `code`. */
export function expectDsaError(fn: () => unknown, code: DsaErrorCode): void {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  expect(thrown, `expected DsaError ${code}`).toBeInstanceOf(DsaError);
  expect((thrown as DsaError).code).toBe(code);
}

const env = process.env;

/** fast-check parameters shared by every property test. */
export const PROP: { numRuns: number; seed?: number; path?: string } = {
  numRuns: Number(env['PLT_PROP_RUNS'] ?? 1000),
  ...(env['PLT_PROP_SEED'] === undefined ? {} : { seed: Number(env['PLT_PROP_SEED']) }),
  ...(env['PLT_PROP_PATH'] === undefined ? {} : { path: env['PLT_PROP_PATH'] }),
};

/**
 * Per-test timeout for a property test, proportional to PROP.numRuns: 30 ms per run, never below
 * 60 s (60 s on pull requests, 300 s nightly at 10,000 runs). The root vitest.config.ts already
 * gives the whole dsa project this timeout. A suite that needs its own per-test timeout (the
 * third argument of `it`) must pass this value rather than a lower local one, because an explicit
 * timeout replaces the project's. At 1,000 runs the slowest properties took 4-6 s with the dsa
 * project in parallel, 6-14.4 s inside a full `pnpm test` run and 7.8-16.1 s inside a full
 * `pnpm test:coverage` run on the shared dev machine (lru 16.1 s, 2026-09-26), which is why
 * Vitest's 5 s default was not enough.
 */
export const PROP_TIMEOUT_MS = Math.max(60_000, 30 * (PROP.numRuns || 1000));
