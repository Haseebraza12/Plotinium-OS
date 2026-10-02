/**
 * fast-check run profiles (spec §3.7, TST-10; invariant Q-6).
 *
 * Pull requests: seed 42 and 100 runs per property, so the same commit always gives the same
 * verdict. Nightly (`PLT_FC_PROFILE=deep`): 10,000 runs with a random seed that is printed, so a
 * failure can be pinned in regressions.json and replayed on every PR from then on.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { Env } from '../support/env.ts';

export interface RunParams {
  seed: number;
  numRuns: number;
  path?: string;
}

export const PR_SEED = 42;
export const PR_RUNS = 100;
export const DEEP_RUNS = 10_000;

export function fcParams(
  env: Env = process.env,
  random: () => number = Math.random,
  log: (s: string) => void = console.log,
): RunParams {
  if (env['PLT_FC_PROFILE'] === 'deep') {
    const seed = Math.floor(random() * 0x7fff_ffff);
    log(`fast-check deep profile: seed ${seed}, ${DEEP_RUNS} runs`);
    return { seed, numRuns: DEEP_RUNS };
  }
  return { seed: PR_SEED, numRuns: PR_RUNS };
}

/** Same as fcParams but with fewer runs for properties that touch a database or a browser. */
export function fcParamsHeavy(runs: number, env: Env = process.env): RunParams {
  const p = fcParams(env, Math.random, () => undefined);
  return {
    ...p,
    numRuns: Math.min(p.numRuns, env['PLT_FC_PROFILE'] === 'deep' ? runs * 10 : runs),
  };
}

export interface Regression {
  /** The property's test title. */
  property: string;
  seed: number;
  /** fast-check's shrink path, replayed exactly. */
  path: string;
  issue: number;
  since: string;
}

export const REGRESSIONS_PATH = fileURLToPath(new URL('./regressions.json', import.meta.url));

export function parseRegressions(data: unknown): Regression[] {
  if (
    typeof data !== 'object' ||
    data === null ||
    !('regressions' in data) ||
    !Array.isArray(data.regressions)
  ) {
    throw new TypeError('regressions.json must be { "regressions": [...] }');
  }
  return (data.regressions as unknown[]).map((r, i) => {
    const ok =
      typeof r === 'object' &&
      r !== null &&
      'property' in r &&
      typeof r.property === 'string' &&
      'seed' in r &&
      Number.isInteger(r.seed) &&
      'path' in r &&
      typeof r.path === 'string' &&
      'issue' in r &&
      Number.isInteger(r.issue) &&
      'since' in r &&
      typeof r.since === 'string';
    if (!ok) throw new TypeError(`regressions[${i}] needs property, seed, path, issue and since`);
    return r as Regression;
  });
}

export function loadRegressions(path: string = REGRESSIONS_PATH): Regression[] {
  return parseRegressions(JSON.parse(readFileSync(path, 'utf8')));
}

/** The pinned replays of one property (by title), as fast-check parameters. */
export function regressionsFor(
  property: string,
  all: readonly Regression[] = loadRegressions(),
): RunParams[] {
  return all
    .filter((r) => r.property === property)
    .map((r) => ({ seed: r.seed, path: r.path, numRuns: 1 }));
}
