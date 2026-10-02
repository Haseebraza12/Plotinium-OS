/**
 * Budget lookup for performance tests. Tests read every threshold from budgets.json through this
 * module and never write a numeric threshold themselves (invariant Q-1).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { parseBudgetFile, type Budget, type BudgetFile, type Op } from './budgets.schema.ts';

export const BUDGETS_PATH = fileURLToPath(new URL('./budgets.json', import.meta.url));

let cached: BudgetFile | undefined;

export function loadBudgets(path: string = BUDGETS_PATH): BudgetFile {
  if (path !== BUDGETS_PATH) return parseBudgetFile(JSON.parse(readFileSync(path, 'utf8')));
  cached ??= parseBudgetFile(JSON.parse(readFileSync(path, 'utf8')));
  return cached;
}

export function budget(id: string, file: BudgetFile = loadBudgets()): Budget {
  const b = file.budgets.find((x) => x.id === id);
  if (b === undefined) throw new RangeError(`no budget ${id} in budgets.json`);
  return b;
}

/** A human-readable reason when `value` misses the budget, or undefined when it meets it. */
export function miss(
  b: Pick<Budget, 'id' | 'op' | 'threshold' | 'unit'>,
  value: number,
): string | undefined {
  const ok: Record<Op, boolean> = {
    '<=': value <= b.threshold,
    '<': value < b.threshold,
    '>=': value >= b.threshold,
    '>': value > b.threshold,
    '==': value === b.threshold,
  };
  return ok[b.op]
    ? undefined
    : `${b.id}: ${value} ${b.unit} is not ${b.op} ${b.threshold} ${b.unit}`;
}
