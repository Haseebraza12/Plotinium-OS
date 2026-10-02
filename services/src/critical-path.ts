/**
 * `bootlog --critical-path` (boot-and-services.md §5.8, BOOT-11). Under completion-driven start,
 * start(v) = max over requirements of end(u) + ε, so walking back from the target through the
 * requirement that ended last yields the chain that determined the boot time. O(V + E).
 */
import type { ServiceName } from './types.ts';

export interface ServiceTiming {
  readonly name: ServiceName;
  readonly level: number;
  /** ms since t0, or null when it never started / ended. */
  readonly start: number | null;
  readonly end: number | null;
  readonly userWaitMs?: number;
}

export interface CriticalPathRow {
  readonly name: ServiceName;
  readonly start: number;
  readonly end: number;
  /** Own duration, user wait excluded. */
  readonly own: number;
  readonly gatedBy: ServiceName | null;
  /** For every other requirement u: start(v) − end(u). */
  readonly slack: Readonly<Record<ServiceName, number>>;
}

type Ended = ServiceTiming & { readonly end: number };

export function criticalPath(
  timings: readonly ServiceTiming[],
  requires: ReadonlyMap<ServiceName, readonly ServiceName[]>,
  target: ServiceName,
): CriticalPathRow[] {
  const byName = new Map(timings.map((t) => [t.name, t] as const));
  const rows: CriticalPathRow[] = [];
  const seen = new Set<ServiceName>();
  let v: ServiceName | null = target;
  while (v !== null && !seen.has(v)) {
    seen.add(v);
    const s = byName.get(v);
    if (!s || s.start === null || s.end === null) break;
    const deps: Ended[] = [];
    for (const name of requires.get(v) ?? []) {
      const u = byName.get(name);
      if (u !== undefined && u.end !== null) deps.push({ ...u, end: u.end });
    }
    let gate: Ended | null = null;
    for (const u of deps) {
      if (
        gate === null ||
        u.end > gate.end ||
        (u.end === gate.end &&
          (u.level < gate.level || (u.level === gate.level && u.name < gate.name)))
      ) {
        gate = u;
      }
    }
    const slack: Record<ServiceName, number> = {};
    for (const u of deps) if (u.name !== gate?.name) slack[u.name] = s.start - u.end;
    rows.unshift({
      name: v,
      start: s.start,
      end: s.end,
      own: s.end - s.start - (s.userWaitMs ?? 0),
      gatedBy: gate?.name ?? null,
      slack,
    });
    v = gate?.name ?? null;
  }
  return rows;
}
