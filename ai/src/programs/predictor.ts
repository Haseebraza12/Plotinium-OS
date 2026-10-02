/**
 * `ai.predictor`: the on-device next-app predictor daemon (predictive-prefetch.md §3.1, §3.4,
 * §3.6; PRE-01, PRE-02, PRE-06; AIN-C1..C4).
 *
 * An ordinary executor process at PRI 32 running as the login uid. It
 * - SEES through the kernel: `ai.telemetry.read` returns the caller's own ring (app ids and times
 *   only, I-C6, I-C7); the installed applications come from the `/bin/*.json` manifests of kind
 *   `app`;
 * - LEARNS incrementally: the Witten-Bell Markov-2 model updates in O(1) per launch; under 50
 *   launches it ranks by time-bucketed MFU with confidence 0 (cold start, no pre-fetch);
 * - ACTS through typed syscalls: `ai.predict.publish` (the kernel runs the pre-fetch policy and
 *   emits `ai.predict`), and `mem.hint` for the top-1 app when its confidence reaches θ (the
 *   residency hint of §3.6).
 * Between reads it sleeps on the kernel timer heap (the registry makes `ai.telemetry.read` a fast
 * call, so there is no blocking read to park on).
 */
import type { AppManifest, TelemetryEvent } from '@plotinium/protocol';

import { MarkovPredictor, type PredictionSet } from '../predictor/markov.ts';
import { HINT_MS, THETA_DEFAULT } from '../predictor/prefetch.ts';
import { makeEvent } from '../predictor/telemetry.ts';
import { type AiProgram, type AiProgramContext, type SysGen, attempt } from './model.ts';

export const PREDICTOR_PRIORITY = 22;
export const PREDICTOR_NICE = 10;
export const POLL_MS = 2_000;
/** Re-read the installed apps this often (a new app appears without a restart). */
const APPS_REFRESH_MS = 5 * 60_000;
const READ_LIMIT = 500;

export interface PredictorState {
  apps: string[];
  appsAt: number;
  model: MarkovPredictor | null;
  since: number;
  last: TelemetryEvent | null;
  running: Set<string>;
  published: string;
  theta: number;
}

export function initPredictor(argv: readonly string[]): PredictorState {
  const t = argv.find((a) => a.startsWith('--theta='));
  const theta = t === undefined ? THETA_DEFAULT : Number(t.slice('--theta='.length));
  return {
    apps: [],
    appsAt: Number.NEGATIVE_INFINITY,
    model: null,
    since: -1,
    last: null,
    running: new Set(),
    published: '',
    theta: Number.isFinite(theta) && theta > 0 && theta < 1 ? theta : THETA_DEFAULT,
  };
}

function isAppManifest(x: unknown): x is Pick<AppManifest, 'name' | 'kind'> {
  return (
    typeof x === 'object' &&
    x !== null &&
    'name' in x &&
    'kind' in x &&
    typeof x.name === 'string' &&
    x.kind === 'app'
  );
}

/** The installed applications: `/bin/<name>.json` manifests of kind `app`. */
function* installedApps(ctx: AiProgramContext): SysGen<string[]> {
  const listing = yield* attempt(ctx.sys, 'readdir', { path: '/bin' });
  if (!listing.ok) return [];
  const apps: string[] = [];
  const decoder = new TextDecoder();
  for (const e of listing.value.entries) {
    if (e.type !== 'f' || !e.name.endsWith('.json')) continue;
    const path = `/bin/${e.name}`;
    const opened = yield* attempt(ctx.sys, 'open', { path, flags: 'r' });
    if (!opened.ok) continue;
    const read = yield* attempt(ctx.sys, 'read', { fd: opened.value.fd, len: 16_384 });
    yield* attempt(ctx.sys, 'close', { fd: opened.value.fd });
    if (!read.ok) continue;
    try {
      const json: unknown = JSON.parse(decoder.decode(new Uint8Array(read.value)));
      if (isAppManifest(json)) apps.push(json.name);
    } catch {
      // Not JSON: not an application.
    }
  }
  return apps.sort();
}

/** Learn from new events; returns whether a launch arrived. */
export function learn(st: PredictorState, events: readonly TelemetryEvent[]): boolean {
  let launched = false;
  for (const e of events) {
    st.since = Math.max(st.since, e.seq);
    if (st.last !== null && e.osSessionId !== st.last.osSessionId) st.running.clear();
    st.last = e;
    if (e.kind === 'launch') {
      st.running.add(e.app);
      launched = true;
      if (!st.apps.includes(e.app)) st.apps = [...st.apps, e.app].sort();
    } else if (e.kind === 'close') st.running.delete(e.app);
    st.model?.update(e);
  }
  return launched;
}

/** The prediction for the next launch at `now` (local time from `time.now`). */
export function predictNow(
  st: PredictorState,
  now: { epochMs: number; tzOffsetMin: number },
): PredictionSet | undefined {
  if (st.model === null || st.apps.length === 0) return undefined;
  const probe = makeEvent({
    seq: st.since + 1,
    ts: now.epochMs,
    tzOffsetMin: now.tzOffsetMin,
    kind: 'launch',
    app: st.apps[0] ?? 'app',
    prev: null,
    sessionPos: 1,
    origin: 'user',
    osSessionId: st.last?.osSessionId ?? '00000000-0000-7000-8000-000000000000',
  });
  const candidates = st.apps.filter((a) => !st.running.has(a));
  if (candidates.length === 0) return undefined;
  return st.model.predict(st.model.contextFor(probe), candidates, now.epochMs, 3);
}

export function* runPredictor(ctx: AiProgramContext, st: PredictorState): SysGen<number> {
  yield* attempt(ctx.sys, 'setpriority', {
    pid: 0,
    priority: PREDICTOR_PRIORITY,
    nice: PREDICTOR_NICE,
  });
  for (;;) {
    const clock = yield* ctx.sys.call('time.now', {});
    if (ctx.now() - st.appsAt > APPS_REFRESH_MS) {
      const apps = yield* installedApps(ctx);
      st.appsAt = ctx.now();
      const merged = [...new Set([...apps, ...st.apps])].sort();
      if (st.model === null || merged.join() !== st.model.apps.join()) {
        // A new candidate set: rebuild the model from the ring (it is at most 4,096 events).
        st.apps = merged;
        st.model = new MarkovPredictor(merged);
        st.since = -1;
        st.running.clear();
      }
    }
    let any = false;
    for (;;) {
      // `since` is a Count (≥ 0): the whole ring is read by leaving it out (-1 = nothing seen yet;
      // sending it failed the schema check and crashed the daemon at start, UI-049).
      const r = yield* ctx.sys.call(
        'ai.telemetry.read',
        st.since < 0 ? { limit: READ_LIMIT } : { since: st.since, limit: READ_LIMIT },
      );
      if (r.events.length === 0) break;
      any = learn(st, r.events) || any;
      if (r.events.length < READ_LIMIT) break;
      yield ctx.tick;
    }
    const set = predictNow(st, clock);
    if (set !== undefined) {
      const key = JSON.stringify([
        set.model,
        set.predictions.map((p) => [p.app, p.confidence.toFixed(3)]),
      ]);
      if (key !== st.published || any) {
        st.published = key;
        yield* attempt(ctx.sys, 'ai.predict.publish', {
          predictions: set.predictions,
          model: set.model,
          launches: set.launches,
        });
        const top = set.predictions[0];
        if (top !== undefined && top.confidence >= st.theta)
          yield* attempt(ctx.sys, 'mem.hint', { app: top.app, ttlMs: HINT_MS });
      }
    }
    yield* ctx.sleep(POLL_MS);
  }
}

const program: AiProgram<PredictorState> = {
  checkpointable: false,
  init: initPredictor,
  run: runPredictor,
};

export default program;
