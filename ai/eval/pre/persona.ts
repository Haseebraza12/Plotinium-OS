/**
 * Seeded 3-persona telemetry trace generator (predictive-prefetch.md §3.10; ai-safety §3.6).
 *
 * For UNIT TESTS ONLY: the PRE-02 claim rests on real, consented traces in ai/eval/pre/traces/,
 * never on these. Each persona has second-order habits (what follows a pair of apps), first-order
 * habits and time-of-day preferences, plus noise, so a Markov-2 model has something to learn that
 * MFU and MRU cannot see. Apps are closed now and then, so the candidate rule (running apps are
 * excluded) is exercised.
 */
import { makeEvent, type TelemetryEventT } from '../../src/predictor/telemetry.ts';
import { seededRandom } from '../../src/util/rng.ts';

export const APPS = [
  'terminal',
  'files',
  'editor',
  'taskmgr',
  'settings',
  'browser',
  'calendar',
  'music',
] as const;
export type PersonaName = 'developer' | 'writer' | 'operator';

type Weights = Readonly<Record<string, number>>;

interface Persona {
  first: Weights;
  order1: Readonly<Record<string, Weights>>;
  order2: Readonly<Record<string, Weights>>;
  /** Preferred start hour (local) of sessions. */
  hours: readonly number[];
}

const PERSONAS: Record<PersonaName, Persona> = {
  developer: {
    first: { terminal: 6, browser: 2, calendar: 1 },
    order1: {
      terminal: { editor: 5, files: 2, browser: 1 },
      editor: { terminal: 4, browser: 2, files: 1 },
      files: { editor: 4, terminal: 2 },
      browser: { editor: 3, terminal: 2, music: 1 },
      calendar: { terminal: 3, browser: 1 },
      music: { terminal: 3, editor: 1 },
      taskmgr: { terminal: 3 },
      settings: { terminal: 2 },
    },
    order2: {
      'files|editor': { terminal: 8 },
      'terminal|editor': { browser: 6, terminal: 1 },
      'browser|editor': { files: 6 },
      'editor|terminal': { taskmgr: 4, files: 2 },
    },
    hours: [9, 10, 14, 21],
  },
  writer: {
    first: { editor: 5, calendar: 3, files: 1 },
    order1: {
      editor: { files: 4, browser: 3, music: 1 },
      files: { editor: 5, settings: 1 },
      browser: { editor: 4, calendar: 1 },
      calendar: { editor: 4, browser: 2 },
      music: { editor: 4 },
      terminal: { files: 2 },
      settings: { editor: 2 },
      taskmgr: { editor: 1 },
    },
    order2: {
      'calendar|editor': { music: 6 },
      'files|editor': { browser: 6 },
      'editor|browser': { calendar: 5 },
    },
    hours: [8, 11, 15, 19],
  },
  operator: {
    first: { taskmgr: 5, terminal: 3, settings: 1 },
    order1: {
      taskmgr: { terminal: 5, settings: 2 },
      terminal: { taskmgr: 3, files: 2, settings: 1 },
      settings: { taskmgr: 3, terminal: 2 },
      files: { terminal: 3, editor: 1 },
      editor: { terminal: 3 },
      browser: { terminal: 2 },
      calendar: { taskmgr: 2 },
      music: { taskmgr: 1 },
    },
    order2: {
      'taskmgr|terminal': { settings: 7 },
      'settings|taskmgr': { files: 6 },
      'terminal|files': { editor: 5 },
    },
    hours: [7, 12, 16, 23],
  },
};

function pick(w: Weights, rnd: () => number, exclude: ReadonlySet<string>): string | undefined {
  const entries = Object.entries(w).filter(([a]) => !exclude.has(a));
  const total = entries.reduce((s, [, x]) => s + x, 0);
  if (total <= 0) return undefined;
  let r = rnd() * total;
  for (const [a, x] of entries) {
    r -= x;
    if (r < 0) return a;
  }
  return entries[entries.length - 1]?.[0];
}

export interface TraceOptions {
  persona: PersonaName;
  seed: number;
  /** Number of days to simulate (about 3 sessions a day). */
  days: number;
  /** Epoch ms of the first day's local midnight. */
  start: number;
  tzOffsetMin?: number;
  /** Probability of a random app instead of the habit (default 0.15). */
  noise?: number;
}

/** A chronological launch/close trace for one persona. */
export function generateTrace(o: TraceOptions): TelemetryEventT[] {
  const p = PERSONAS[o.persona];
  const next32 = seededRandom(o.seed);
  const rnd = (): number => next32() / 0x1_0000_0000;
  const tz = o.tzOffsetMin ?? 300;
  const noise = o.noise ?? 0.15;
  const events: TelemetryEventT[] = [];
  let seq = 0;
  for (let day = 0; day < o.days; day++) {
    const sessions = 2 + Math.floor(rnd() * 3);
    for (let s = 0; s < sessions; s++) {
      const hour = p.hours[Math.floor(rnd() * p.hours.length)] ?? 9;
      let ts =
        o.start + day * 86_400_000 + (hour * 60 - tz) * 60_000 + Math.floor(rnd() * 3_000_000);
      const session = `0192f0c1-${String(day).padStart(4, '0')}-7000-8000-${String(s).padStart(12, '0')}`;
      const open = new Set<string>();
      let prev1: string | null = null;
      let prev2: string | null = null;
      const launches = 3 + Math.floor(rnd() * 6);
      for (let i = 0; i < launches; i++) {
        let app: string | undefined;
        if (rnd() < noise) app = pick(Object.fromEntries(APPS.map((a) => [a, 1])), rnd, open);
        else if (prev1 !== null && prev2 !== null && p.order2[`${prev2}|${prev1}`] !== undefined)
          app = pick(p.order2[`${prev2}|${prev1}`] ?? {}, rnd, open);
        else if (prev1 !== null) app = pick(p.order1[prev1] ?? {}, rnd, open);
        else app = pick(p.first, rnd, open);
        app ??= pick(Object.fromEntries(APPS.map((a) => [a, 1])), rnd, open);
        if (app === undefined) break;
        events.push(
          makeEvent({
            seq: ++seq,
            ts,
            tzOffsetMin: tz,
            kind: 'launch',
            app,
            prev: prev1,
            sessionPos: i + 1,
            origin: 'user',
            osSessionId: session,
          }),
        );
        open.add(app);
        prev2 = prev1;
        prev1 = app;
        ts += 60_000 + Math.floor(rnd() * 900_000);
        // Close the oldest open app now and then, so running apps change.
        const oldest = [...open][0];
        if (oldest !== undefined && open.size > 1 && rnd() < 0.6) {
          events.push(
            makeEvent({
              seq: ++seq,
              ts,
              tzOffsetMin: tz,
              kind: 'close',
              app: oldest,
              prev: null,
              sessionPos: i + 1,
              origin: 'user',
              osSessionId: session,
            }),
          );
          open.delete(oldest);
          ts += 10_000;
        }
      }
    }
  }
  return events;
}
