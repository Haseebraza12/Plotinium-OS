/**
 * Telemetry events and the per-uid ring (predictive-prefetch.md §3.2; PRE-05, I-C2, I-C6).
 *
 * Events hold application ids and times only: no file names, paths, window titles or content; the
 * protocol schema is strict, so any extra field fails validation. The ring is the team's
 * `dsa/ringbuffer` (4,096 events per uid, the oldest overwritten), injected here (C16). Spawns by
 * `prefetch:*` jobs are never recorded, and `restore` launches never train the model.
 */
import { TELEMETRY_RING_SIZE, TelemetryEvent } from '@plotinium/protocol';
import type { TelemetryEvent as TelemetryEventT } from '@plotinium/protocol';

import type { Ring, RingFactory } from '../util/deps.ts';
import { type Schema, parseWith } from '../util/schema.ts';

export type { TelemetryEventT };

/** Local days that count as weekend (configurable in Settings; default Saturday and Sunday). */
export const DEFAULT_WEEKEND: ReadonlySet<number> = new Set([0, 6]);

export interface EventInput {
  seq: number;
  ts: number;
  /** Local offset from UTC in minutes at `ts` (east positive). */
  tzOffsetMin: number;
  kind: 'launch' | 'focus' | 'close';
  app: string;
  prev: string | null;
  sessionPos: number;
  origin: 'user' | 'restore';
  osSessionId: string;
  weekendDays?: ReadonlySet<number>;
}

/** Build an event with its derived time features (hour bucket, day of week, weekend). */
export function makeEvent(i: EventInput): TelemetryEventT {
  const local = new Date(i.ts + i.tzOffsetMin * 60_000);
  const dow = local.getUTCDay();
  return {
    v: 1,
    seq: i.seq,
    ts: i.ts,
    tzOffsetMin: i.tzOffsetMin,
    kind: i.kind,
    app: i.app,
    prev: i.kind === 'launch' ? i.prev : null,
    hourBucket: Math.floor(local.getUTCHours() / 4),
    dow,
    weekend: (i.weekendDays ?? DEFAULT_WEEKEND).has(dow),
    sessionPos: i.sessionPos,
    origin: i.origin,
    osSessionId: i.osSessionId,
  };
}

/** Strict schema check: anything beyond app ids and times is rejected (I-C6). */
export function validateEvent(value: unknown): value is TelemetryEventT {
  return parseWith(TelemetryEvent as unknown as Schema<TelemetryEventT>, value).ok;
}

/** Launches that train the model: user launches only (I-C2). */
export function isTrainingLaunch(e: TelemetryEventT): boolean {
  return e.kind === 'launch' && e.origin === 'user';
}

/** Where a spawn came from; only user launches and session restore are recorded. */
export type SpawnOrigin = 'user' | 'restore' | 'prefetch';

export function shouldRecord(origin: SpawnOrigin): boolean {
  return origin !== 'prefetch';
}

/** The per-uid telemetry ring over the injected `dsa/ringbuffer`. */
export class TelemetryRing {
  private readonly ring: Ring<TelemetryEventT>;

  constructor(factory: RingFactory, capacity = TELEMETRY_RING_SIZE) {
    this.ring = factory<TelemetryEventT>(capacity);
  }

  /** Record a valid event; returns false for an invalid one (never stored). */
  record(e: TelemetryEventT): boolean {
    if (!validateEvent(e)) return false;
    this.ring.push(e);
    return true;
  }

  /** Events with `seq > since`, oldest first, at most `limit`. */
  read(since = -1, limit = TELEMETRY_RING_SIZE): { events: TelemetryEventT[]; next?: number } {
    const events = this.ring
      .toArray()
      .filter((e) => e.seq > since)
      .slice(0, limit);
    const last = events[events.length - 1];
    return last === undefined ? { events } : { events, next: last.seq };
  }

  clear(): number {
    const n = this.ring.size;
    this.ring.clear();
    return n;
  }

  get size(): number {
    return this.ring.size;
  }

  /** JSON Lines export, one event per line (Settings → Export). */
  exportJsonl(): string {
    return this.ring
      .toArray()
      .map((e) => JSON.stringify(e))
      .join('\n');
  }
}
