/**
 * Performance result files (spec §4.2; TST-06, TST-13).
 *
 * Every perf test writes `test-results/perf/<budget-id>.json`. Only results whose machine class is
 * `lab-spec` count as gate evidence (T-5); every file records the machine, the commit and the
 * sample counts, and a browser-based result also records the Chrome version and channel.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { cpus, platform, release, totalmem } from 'node:os';
import { join } from 'node:path';

import type { Env } from '../support/env.ts';

import type { MachineClass } from './budgets.schema.ts';
import { methodOf } from './methods.ts';

export type Verdict = 'pass' | 'fail' | 'ratchet-pass' | 'ratchet-fail' | 'invalid' | 'report';

export interface RunSummary {
  n: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  valid: boolean;
  notes?: string;
}

export interface MachineInfo {
  class: MachineClass;
  cpu: string;
  hwc: number;
  ramGiB: number;
  os: string;
  refreshHz?: number;
  dpr?: number;
  power?: 'ac' | 'battery';
  idbBackend?: 'leveldb' | 'sqlite';
}

export interface PerfResult {
  budgetId: string;
  commit: string;
  build: string;
  machine: MachineInfo;
  chrome?: { version: string; channel: 'stable' | 'beta' };
  startedAt: string;
  durationMs: number;
  runs: RunSummary[];
  value: number;
  verdict: Verdict;
  baseline?: { value: number; commit: string; date: string };
  extra?: Record<string, unknown>;
}

const MACHINES: readonly string[] = ['lab-spec', 'lab-matched', 'hosted', 'vps', 'any'];
type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** TST-06: every problem that stops `data` from being evidence; empty when it is acceptable. */
export function validatePerfResult(data: unknown, method?: string): string[] {
  if (!isRec(data)) return ['result is not an object'];
  const errors: string[] = [];
  if (typeof data['budgetId'] !== 'string' || data['budgetId'] === '')
    errors.push('budgetId missing');
  if (typeof data['commit'] !== 'string' || !/^[0-9a-f]{7,40}$/.test(data['commit']))
    errors.push('commit missing or not a git sha');
  if (typeof data['build'] !== 'string') errors.push('build missing');
  const m = data['machine'];
  if (!isRec(m)) errors.push('machine missing');
  else {
    if (typeof m['class'] !== 'string' || !MACHINES.includes(m['class']))
      errors.push('machine.class missing or unknown');
    if (typeof m['cpu'] !== 'string' || m['cpu'] === '') errors.push('machine.cpu missing');
    if (!isNum(m['hwc']) || !isNum(m['ramGiB']) || typeof m['os'] !== 'string')
      errors.push('machine.hwc, ramGiB or os missing');
  }
  const c = data['chrome'];
  if (
    c !== undefined &&
    (!isRec(c) ||
      typeof c['version'] !== 'string' ||
      (c['channel'] !== 'stable' && c['channel'] !== 'beta'))
  ) {
    errors.push('chrome must carry version and channel');
  }
  if (c === undefined && method !== undefined && methodOf(method)?.browser === true) {
    errors.push(`chrome version missing for browser method ${method}`);
  }
  if (typeof data['startedAt'] !== 'string' || Number.isNaN(Date.parse(data['startedAt'])))
    errors.push('startedAt missing');
  if (!isNum(data['durationMs'])) errors.push('durationMs missing');
  const runs = data['runs'];
  if (!Array.isArray(runs) || runs.length === 0) errors.push('runs missing');
  else if (
    !runs.every((r) => isRec(r) && isNum(r['n']) && r['n'] > 0 && typeof r['valid'] === 'boolean')
  ) {
    errors.push('every run needs a sample count n and valid');
  }
  if (!isNum(data['value'])) errors.push('value missing');
  return errors;
}

export function gitCommit(env: Env = process.env): string {
  return env['GITHUB_SHA'] ?? env['PLT_COMMIT'] ?? '0000000';
}

/** The Node side of the environment record (spec §3.11.1); the page adds refresh rate and dpr. */
export function machineInfo(cls: MachineClass, extra: Partial<MachineInfo> = {}): MachineInfo {
  const cpu = cpus();
  return {
    class: cls,
    cpu: cpu[0]?.model.trim() ?? 'unknown',
    hwc: cpu.length,
    ramGiB: Math.round((totalmem() / 2 ** 30) * 10) / 10,
    os: `${platform()} ${release()}`,
    ...extra,
  };
}

/** `lab-spec` only when the lab runner says so; everything else is hosted smoke (TST-21). */
export function machineClass(env: Env = process.env): MachineClass {
  const c = env['PLT_MACHINE_CLASS'];
  return c === 'lab-spec' || c === 'lab-matched' || c === 'vps' ? c : 'hosted';
}

export function resultsDir(env: Env = process.env): string {
  return env['PLT_PERF_RESULTS'] ?? join('test-results', 'perf');
}

export async function writePerfResult(
  result: PerfResult,
  dir: string = resultsDir(),
): Promise<string> {
  const errors = validatePerfResult(result);
  if (errors.length > 0)
    throw new TypeError(`refusing to write an invalid result: ${errors.join('; ')}`);
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${result.budgetId}.json`);
  await writeFile(file, `${JSON.stringify(result, null, 2)}\n`);
  return file;
}
