/**
 * Switches of the Demo Day rehearsal suite (spec §17.1; testing §3.16). The suite is long: it
 * builds or brings up a stack, reboots, cuts the network, burns CPU and allocates twice the
 * memory budget. It therefore runs only when asked for (`PLT_DEMO_DAY=1`), at the rehearsals of
 * testing §3.16.1 and on the lab runner, never on every push. Everything that depends on UI or
 * selectors that have not landed yet is `fixme` with the reason below (T-3: skipped is never
 * verified). The full table of variables is in README.md next to this file.
 */
import { stackControl, uiReady, type Env } from '../../support/env.ts';

export { stackControl, uiReady };

function on(env: Env, name: string): boolean {
  return env[name] === '1';
}

function value(env: Env, name: string): string | undefined {
  const v = env[name];
  return v === undefined || v.trim() === '' ? undefined : v.trim();
}

/** `PLT_DEMO_DAY=1`: run the rehearsal suite at all. */
export function demoDay(env: Env = process.env): boolean {
  return on(env, 'PLT_DEMO_DAY');
}

/** `PLT_DEMO_BRINGUP=1`: the bring-up test may run `docker compose up` (DOCKER gate). */
export function bringupAllowed(env: Env = process.env): boolean {
  return on(env, 'PLT_DEMO_BRINGUP');
}

/** `PLT_DEMO_AI=1`: a planner answers (production, `LLM_MODE=replay`, or the upstream token). */
export function plannerAvailable(env: Env = process.env): boolean {
  return on(env, 'PLT_DEMO_AI');
}

/** `PLT_DEMO_PROPOSED_TIDS=1`: the test ids in {@link PROPOSED_TID} are in SELECTORS.md. */
export function proposedSelectorsAdopted(env: Env = process.env): boolean {
  return on(env, 'PLT_DEMO_PROPOSED_TIDS');
}

/** Headed by default: frame production in headless Chrome is not what the examiner sees. */
export function headless(env: Env = process.env): boolean {
  return on(env, 'PLT_DEMO_HEADLESS');
}

/** The examiner's hidden semantic query, or the rehearsal default (rag §3.5 example). */
export function hiddenQuery(env: Env = process.env): string {
  return value(env, 'PLT_DEMO_QUERY') ?? 'how does LRU eviction work';
}

/** The examiner's hidden agent instruction; undefined means the prepared rehearsal instruction. */
export function hiddenInstruction(env: Env = process.env): string | undefined {
  return value(env, 'PLT_DEMO_INSTRUCTION');
}

/** Node at which the server fault fires; "the examiner may choose N" (testing §3.16.5 item 6). */
export function faultNode(env: Env = process.env): number {
  const raw = value(env, 'PLT_DEMO_FAULT_NODE');
  const n = raw === undefined ? 500 : Number(raw);
  if (!Number.isInteger(n) || n < 1)
    throw new RangeError(`PLT_DEMO_FAULT_NODE must be a positive integer, got ${raw}`);
  return n;
}

/** Production URL for the T-1 hour check (testing §3.16.2); undefined when not deployed. */
export function productionUrl(env: Env = process.env): string | undefined {
  return value(env, 'PLT_PRODUCTION_URL');
}

/** The release the stack must report, for example `1.0.0` on Demo Day. */
export function expectedVersion(env: Env = process.env): string | undefined {
  return value(env, 'PLT_EXPECT_VERSION');
}

/** Rehearsal label for the log (`rehearsal-3`, `T-1`); defaults to the date. */
export function rehearsalLabel(env: Env = process.env, now: Date = new Date()): string {
  return value(env, 'PLT_DEMO_REHEARSAL') ?? now.toISOString().slice(0, 10);
}

/** Network the rehearsal ran on (`campus`, `4G hotspot`, `lab LAN`); TST-18 logs it. */
export function networkLabel(env: Env = process.env): string {
  return value(env, 'PLT_DEMO_NETWORK') ?? 'unspecified';
}

/**
 * C7: fault injection exists only where the server runs with `FAULT_INJECTION=1`, which is the
 * local Compose stack (and CI), never production. The local stack listens on loopback only.
 */
export function isLocalStack(baseUrl: string): boolean {
  const host = new URL(baseUrl).hostname;
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
}

/**
 * Test ids the rehearsal needs that tests/e2e/SELECTORS.md does not list yet. Each is proposed to
 * the owner named here (integration notes of this suite); once SELECTORS.md adopts them, set
 * `PLT_DEMO_PROPOSED_TIDS=1` and the `fixme` steps that use them run.
 */
export const PROPOSED_TID = {
  /** WM §3.18 overlay; `data-p95-ms` and `data-loaf-ours` carry its numbers. Owner R3. */
  frameMeter: 'frame-meter',
  /** Task Manager tabs (many); `data-tab` ∈ processes, memory, predictions, services, performance. Owner R3. */
  taskManagerTab: 'task-manager-tab',
  /** Task Manager → Memory, one row per process (many); `data-pid`, `data-faults`, `data-bytes-out`. Owner R3/R1. */
  memoryRow: 'task-manager-memory-row',
  /** Task Manager → Predictions, one row per prediction (many); `data-app`, `data-confidence`. Owner R3/R4. */
  predictionRow: 'task-manager-prediction-row',
  /** WM §3.12 "Restoring… n / m MB" progressbar inside a window. Owner R3. */
  windowRestoring: 'window-restoring',
  /** File Explorer semantic search box (RAG-06). Owner of Files. */
  filesSearch: 'files-search',
  /** One Files search result (many); `data-path`, `data-line-start`. Owner of Files. */
  filesSearchResult: 'files-search-result',
} as const;

export { FIXME_STACK, FIXME_UI } from '../../support/env.ts';

export const SKIP_DEMO_DAY =
  'Demo Day rehearsal suite: set PLT_DEMO_DAY=1 (long; reboots, cuts the network, burns CPU and memory; runs at rehearsals and on the lab runner)';

export const FIXME_BRINGUP =
  'DOCKER gate: set PLT_DEMO_BRINGUP=1 to let this test run docker compose up (it never deletes an existing stack; see README.md)';

export const FIXME_PROPOSED =
  'needs test ids not yet in tests/e2e/SELECTORS.md (PROPOSED_TID in tests/e2e/demo-day/env.ts): set PLT_DEMO_PROPOSED_TIDS=1 once they are adopted';

export const FIXME_PLANNER =
  'needs a planner: run against production (PLOTINIUM_BASE_URL=https://<domain>), a stack with LLM_MODE=replay, or the upstream token (testing §3.16.5 item 8), then set PLT_DEMO_AI=1';

export const SKIP_HAS_PLANNER =
  'a planner is configured (PLT_DEMO_AI=1): the AGT tests of this file show the agent instead';

export const SKIP_NOT_LOCAL =
  'C7: fault injection exists only on the local Compose stack (FAULT_INJECTION=1), never on production';

export const FIXME_PRODUCTION =
  'no production deployment to check: set PLT_PRODUCTION_URL=https://<domain> (T-1 hour check, testing §3.16.2)';
