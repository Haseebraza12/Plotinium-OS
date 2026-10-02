/**
 * Boot-time harness helpers (spec §3.11.2 "Boot harness"; boot-and-services §5.7, §7; BOOT-10).
 *
 * Boot time is the boot record's `bootMs` = desktop-interactive − t0 − userWaitMs. The budget is
 * the nearest-rank p95 of 20 runs (pooled). Large assets must not be requested before the mark.
 */
import { summarise } from '../../support/percentile.ts';
import type { Budget } from '../budgets.schema.ts';
import type { Envelope } from '../envelope.ts';
import type { PerfResult, RunSummary } from '../result.ts';

export type BootKind = 'warm' | 'cold' | 'cold-first';

export interface ResourceEntry {
  name: string;
  startTime: number;
}

/**
 * What BOOT-10 says loads only after `desktop-interactive`: /models, /ort, Transformers.js, xterm,
 * CodeMirror and app view chunks. TODO(R5): confirm the app-view chunk naming with web/ once the
 * Vite build emits boot-manifest.json (SVC-15).
 */
export const LARGE_ASSET_PATTERNS: readonly RegExp[] = [
  /\/models\//,
  /\/ort\//,
  /transformers/i,
  /xterm/i,
  /codemirror/i,
  /\/assets\/(?:app|view)[-.][^/]*\.js(?:$|\?)/,
];

/** Requests that started before the mark and match a large-asset pattern. */
export function largeAssetRequests(
  entries: readonly ResourceEntry[],
  interactiveAtMs: number,
  patterns: readonly RegExp[] = LARGE_ASSET_PATTERNS,
): string[] {
  return entries
    .filter((e) => e.startTime < interactiveAtMs && patterns.some((p) => p.test(e.name)))
    .map((e) => e.name);
}

export function bootRunSummary(bootMs: readonly number[]): RunSummary {
  const s = summarise(bootMs);
  return { n: s.n, p50: s.p50, p95: s.p95, p99: s.p99, max: s.max, valid: true };
}

export interface BootSample {
  kind: BootKind;
  bootMs: number | null;
  userWaitMs: number;
}

/** Keeps the samples of the expected kind; a boot of another kind means the setup was wrong. */
export function bootTimes(samples: readonly BootSample[], kind: BootKind): number[] {
  const wrong = samples.filter((s) => s.kind !== kind);
  if (wrong.length > 0)
    throw new Error(`${wrong.length} boot(s) were ${wrong[0]?.kind}, expected ${kind}`);
  const missing = samples.filter((s) => s.bootMs === null).length;
  if (missing > 0) throw new Error(`${missing} boot(s) never reached desktop-interactive`);
  return samples.map((s) => s.bootMs as number);
}

export function bootResult(
  b: Budget,
  bootMs: readonly number[],
  env: Envelope,
  timing: { startedAt: string; durationMs: number },
  extra: Record<string, unknown> = {},
): PerfResult {
  const run = bootRunSummary(bootMs);
  return {
    ...env,
    ...timing,
    budgetId: b.id,
    runs: [run],
    value: run.p95,
    verdict: 'report',
    extra: { max: run.max, ...extra },
  };
}

export function countResult(
  b: Budget,
  count: number,
  runs: number,
  env: Envelope,
  timing: { startedAt: string; durationMs: number },
  extra: Record<string, unknown> = {},
): PerfResult {
  return {
    ...env,
    ...timing,
    budgetId: b.id,
    runs: [{ n: runs, p50: count, p95: count, p99: count, max: count, valid: true }],
    value: count,
    verdict: 'report',
    extra,
  };
}
