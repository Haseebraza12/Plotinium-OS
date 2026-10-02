/**
 * Shape of tests/performance/budgets.json, the single source of every budget (spec §4.1, TST-04).
 *
 * The spec validates it with Valibot in tools/check-budgets.ts; tests/ is not a workspace package
 * and cannot import valibot (hoist: false), so this hand-written validator mirrors the schema
 * exactly. TODO(R5): switch to the Valibot schema when check-budgets moves under tools/.
 */
import { isKnownMethod } from './methods.ts';

export type Cadence = 'pr' | 'main' | 'nightly' | 'release' | 'weekly';
export type MachineClass = 'lab-spec' | 'lab-matched' | 'hosted' | 'vps' | 'any';
export type Stat = 'p50' | 'p95' | 'p99' | 'max' | 'min' | 'median' | 'value' | 'count' | 'ratio';
export type Unit =
  'ns' | 'us' | 'ms' | 's' | 'bytes' | 'KiB' | 'MiB' | 'count' | 'ratio' | 'percent';
export type Op = '<=' | '<' | '>=' | '>' | '==';
export type Role = 'R1' | 'R2' | 'R3' | 'R4' | 'R5';
export type Kind = 'hard' | 'ratchet' | 'report';

export interface Budget {
  /** `<REQ-ID>.<slug>`; the first token is a spec or registered Plotinium ID. */
  id: string;
  req: string[];
  metric: string;
  stat: Stat;
  unit: Unit;
  op: Op;
  threshold: number;
  warn?: number;
  source: 'spec' | 'plotinium';
  specRef?: string;
  kind: Kind;
  hardFrom?: `W${number}`;
  ratchetPct?: number;
  /** Key into methods.ts. */
  method: string;
  cadence: Cadence[];
  machine: MachineClass;
  samples: {
    runs: number;
    perRun?: number;
    warmupPct?: number;
    aggregate: 'median-of-runs' | 'pooled';
  };
  owner: Role;
  reviewer: Role;
  ourSpec: string;
  params?: Record<string, number | string>;
}

export interface BudgetFile {
  schema: 1;
  updated: string;
  budgets: Budget[];
}

const CADENCES: readonly Cadence[] = ['pr', 'main', 'nightly', 'release', 'weekly'];
const MACHINES: readonly MachineClass[] = ['lab-spec', 'lab-matched', 'hosted', 'vps', 'any'];
const STATS: readonly Stat[] = [
  'p50',
  'p95',
  'p99',
  'max',
  'min',
  'median',
  'value',
  'count',
  'ratio',
];
const UNITS: readonly Unit[] = [
  'ns',
  'us',
  'ms',
  's',
  'bytes',
  'KiB',
  'MiB',
  'count',
  'ratio',
  'percent',
];
const OPS: readonly Op[] = ['<=', '<', '>=', '>', '=='];
const ROLES: readonly Role[] = ['R1', 'R2', 'R3', 'R4', 'R5'];
const KINDS: readonly Kind[] = ['hard', 'ratchet', 'report'];

/** A requirement ID: spec IDs (`BOOT-10`) and registered Plotinium IDs (`DSA-GEN-09`, `TST-03`). */
export const REQ_ID = /^[A-Z][A-Z0-9]*(?:-[A-Z]+)?-\d{2}$/;
export const BUDGET_ID = /^([A-Z][A-Z0-9]*(?:-[A-Z]+)?-\d{2})\.[a-z0-9]+(?:[-.][a-z0-9]+)*$/;

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const oneOf = <T extends string>(allowed: readonly T[], v: unknown): v is T =>
  typeof v === 'string' && (allowed as readonly string[]).includes(v);

function checkBudget(b: unknown, where: string, errors: string[]): void {
  if (!isRec(b)) {
    errors.push(`${where}: not an object`);
    return;
  }
  const id = typeof b['id'] === 'string' ? b['id'] : '';
  const at = `${where} (${id || 'no id'})`;
  const m = BUDGET_ID.exec(id);
  if (m === null) errors.push(`${at}: id must be '<REQ-ID>.<slug>'`);
  const req = b['req'];
  if (
    !Array.isArray(req) ||
    req.length === 0 ||
    !req.every((r) => typeof r === 'string' && REQ_ID.test(r))
  ) {
    errors.push(`${at}: req must be a non-empty list of requirement IDs`);
  } else if (m !== null && !req.includes(m[1])) {
    errors.push(`${at}: req must include the id's own requirement ${m[1]}`);
  }
  if (typeof b['metric'] !== 'string' || b['metric'] === '') errors.push(`${at}: metric missing`);
  if (!oneOf(STATS, b['stat'])) errors.push(`${at}: bad stat`);
  if (!oneOf(UNITS, b['unit'])) errors.push(`${at}: bad unit`);
  if (!oneOf(OPS, b['op'])) errors.push(`${at}: bad op`);
  if (typeof b['threshold'] !== 'number' || !Number.isFinite(b['threshold']))
    errors.push(`${at}: threshold must be a number`);
  if (b['warn'] !== undefined && typeof b['warn'] !== 'number')
    errors.push(`${at}: warn must be a number`);
  if (b['source'] !== 'spec' && b['source'] !== 'plotinium') errors.push(`${at}: bad source`);
  if (b['specRef'] !== undefined && typeof b['specRef'] !== 'string')
    errors.push(`${at}: bad specRef`);
  if (!oneOf(KINDS, b['kind'])) errors.push(`${at}: bad kind`);
  const hf = b['hardFrom'];
  if (hf !== undefined && !(typeof hf === 'string' && /^W([1-9]|1[0-8])$/.test(hf)))
    errors.push(`${at}: hardFrom must be W1..W18`);
  if (b['kind'] === 'hard' && hf === undefined) errors.push(`${at}: a hard budget needs hardFrom`);
  const rp = b['ratchetPct'];
  if (rp !== undefined && !(typeof rp === 'number' && rp > 0)) errors.push(`${at}: bad ratchetPct`);
  if (typeof b['method'] !== 'string' || !isKnownMethod(b['method']))
    errors.push(`${at}: method is not a key of methods.ts`);
  const cad = b['cadence'];
  if (!Array.isArray(cad) || cad.length === 0 || !cad.every((c) => oneOf(CADENCES, c)))
    errors.push(`${at}: bad cadence`);
  if (!oneOf(MACHINES, b['machine'])) errors.push(`${at}: bad machine`);
  else if (b['machine'] !== 'any' && Array.isArray(cad) && cad.includes('pr')) {
    errors.push(
      `${at}: a budget checked on pull requests (hosted runners) must have machine 'any'`,
    );
  }
  const s = b['samples'];
  if (
    !isRec(s) ||
    typeof s['runs'] !== 'number' ||
    !(s['runs'] >= 1) ||
    (s['aggregate'] !== 'median-of-runs' && s['aggregate'] !== 'pooled') ||
    (s['perRun'] !== undefined && typeof s['perRun'] !== 'number') ||
    (s['warmupPct'] !== undefined && typeof s['warmupPct'] !== 'number')
  ) {
    errors.push(`${at}: bad samples`);
  }
  if (!oneOf(ROLES, b['owner']) || !oneOf(ROLES, b['reviewer']))
    errors.push(`${at}: bad owner or reviewer`);
  else if (b['owner'] === b['reviewer']) errors.push(`${at}: owner and reviewer must differ`);
  if (
    typeof b['ourSpec'] !== 'string' ||
    !/^\d{2}-[a-z0-9-]+\/[a-z0-9-]+\.md(#\S+)?$/.test(b['ourSpec'])
  ) {
    errors.push(`${at}: ourSpec must be '<nn-dir>/<file>.md#<section>'`);
  }
  const p = b['params'];
  if (
    p !== undefined &&
    (!isRec(p) || !Object.values(p).every((v) => typeof v === 'number' || typeof v === 'string'))
  ) {
    errors.push(`${at}: params must map to numbers or strings`);
  }
}

/** Every problem in `data`, or an empty list; ids must be unique. */
export function validateBudgetFile(data: unknown): string[] {
  const errors: string[] = [];
  if (!isRec(data)) return ['budget file is not an object'];
  if (data['schema'] !== 1) errors.push('schema must be 1');
  if (typeof data['updated'] !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(data['updated']))
    errors.push('updated must be an ISO date');
  const budgets = data['budgets'];
  if (!Array.isArray(budgets)) return [...errors, 'budgets must be a list'];
  const seen = new Set<string>();
  budgets.forEach((b: unknown, i) => {
    checkBudget(b, `budgets[${i}]`, errors);
    const id = isRec(b) && typeof b['id'] === 'string' ? b['id'] : undefined;
    if (id !== undefined) {
      if (seen.has(id)) errors.push(`budgets[${i}]: duplicate id ${id}`);
      seen.add(id);
    }
  });
  return errors;
}

export function parseBudgetFile(data: unknown): BudgetFile {
  const errors = validateBudgetFile(data);
  if (errors.length > 0) throw new TypeError(`invalid budgets.json:\n  ${errors.join('\n  ')}`);
  return data as BudgetFile;
}

/** 'W7' → 7. */
export function weekNumber(w: `W${number}`): number {
  return Number(w.slice(1));
}
