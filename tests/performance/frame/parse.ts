/**
 * The frame metric (spec §3.11.3, §4.5, §5.2; TST-05; gates PROC-05, WM-03, PRE-04).
 *
 * The gate is the nearest-rank p95 of vsync-quantised frame durations taken from Chrome's
 * `PipelineReporter` trace events, plus zero long animation frames over 50 ms attributed to our
 * origin. Raw requestAnimationFrame deltas are never the gate.
 */
import { median, percentile, summarise } from '../../support/percentile.ts';

export type FrameState =
  'STATE_NO_UPDATE_DESIRED' | 'STATE_PRESENTED_ALL' | 'STATE_PRESENTED_PARTIAL' | 'STATE_DROPPED';

export interface FrameEvent {
  seq: number;
  /** Begin of the BeginFrame, µs. */
  ts: number;
  /** End of the pipeline slice (presentation), µs. */
  endTs: number;
  state: FrameState;
}

export interface FrameStats {
  vsyncMs: number;
  /** Number of frame durations D (presented frames after the first). */
  frames: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  droppedPct: number;
  partialPct: number;
  rawIntervalP95Ms: number;
  /** Share of D values with no dropped vsync before them (the gate on displays below 59.88 Hz). */
  onTimePct: number;
  valid: boolean;
  invalidReason?: string;
}

export interface LoafScript {
  sourceURL: string;
  duration?: number;
  invoker?: string;
}

/** The serialisable part of a `PerformanceLongAnimationFrameTiming` entry. */
export interface LoafEntry {
  duration: number;
  startTime?: number;
  renderStart?: number;
  styleAndLayoutStart?: number;
  scripts?: readonly LoafScript[];
}

export interface LoafSummary {
  over50Ours: number;
  over50Unattributed: number;
  worstOursMs: number;
  sources: string[];
}

const STATES: ReadonlySet<string> = new Set([
  'STATE_NO_UPDATE_DESIRED',
  'STATE_PRESENTED_ALL',
  'STATE_PRESENTED_PARTIAL',
  'STATE_DROPPED',
]);

/** 16.7 ms: the spec's absolute frame target (PROC-05, WM-03). */
export const FRAME_TARGET_MS = 16.7;
export const LOAF_LIMIT_MS = 50;
/** Share of raw intervals allowed to disagree with the quantised model before a run is invalid. */
export const MAX_MISMATCH_SHARE = 0.01;

type Rec = Record<string, unknown>;

function isRec(v: unknown): v is Rec {
  return typeof v === 'object' && v !== null;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function asyncId(e: Rec): string | undefined {
  const id2 = e['id2'];
  if (isRec(id2)) {
    const local = id2['local'] ?? id2['global'];
    if (typeof local === 'string') return local;
  }
  const id = e['id'];
  return typeof id === 'string' ? id : undefined;
}

/** Reads `{state, frame_sequence}` from either argument name used by Chrome over time. */
function reporter(e: Rec): { state: FrameState; seq: number } | undefined {
  const args = e['args'];
  if (!isRec(args)) return undefined;
  const r = args['chrome_frame_reporter'] ?? args['frame_reporter'];
  if (!isRec(r)) return undefined;
  const state = r['state'];
  const seq = num(r['frame_sequence']);
  if (typeof state !== 'string' || !STATES.has(state) || seq === undefined) return undefined;
  return { state: state as FrameState, seq };
}

/** The `[start, end]` window marked by `perf:script:start|end` user timings, µs. */
export function scriptWindow(
  traceEvents: readonly unknown[],
): { start: number; end: number } | undefined {
  let start: number | undefined;
  let end: number | undefined;
  for (const e of traceEvents) {
    if (!isRec(e)) continue;
    const ts = num(e['ts']);
    if (ts === undefined) continue;
    if (e['name'] === 'perf:script:start') start ??= ts;
    else if (e['name'] === 'perf:script:end') end = ts;
  }
  return start !== undefined && end !== undefined && end > start ? { start, end } : undefined;
}

/**
 * The renderer that drew the page: the process named by `TracingStartedInBrowser` for a frame on
 * `origin`, else the process with the most PipelineReporter events.
 */
export function rendererPid(traceEvents: readonly unknown[], origin: string): number | undefined {
  const counts = new Map<number, number>();
  for (const e of traceEvents) {
    if (!isRec(e)) continue;
    if (e['name'] === 'TracingStartedInBrowser') {
      const data = isRec(e['args']) ? e['args']['data'] : undefined;
      const frames = isRec(data) ? data['frames'] : undefined;
      if (Array.isArray(frames)) {
        for (const f of frames as unknown[]) {
          if (isRec(f) && typeof f['url'] === 'string' && f['url'].startsWith(origin)) {
            const pid = num(f['processId']);
            if (pid !== undefined) return pid;
          }
        }
      }
    }
    if (e['name'] === 'PipelineReporter') {
      const pid = num(e['pid']);
      if (pid !== undefined) counts.set(pid, (counts.get(pid) ?? 0) + 1);
    }
  }
  let best: number | undefined;
  let bestN = 0;
  for (const [pid, n] of counts) {
    if (n > bestN) {
      best = pid;
      bestN = n;
    }
  }
  return best;
}

/** §5.2 step 1: pair `b`/`e` PipelineReporter events of one renderer inside the window. */
export function extractFrames(
  traceEvents: readonly unknown[],
  window: { start: number; end: number },
  pid: number,
): FrameEvent[] {
  const open = new Map<string, { ts: number; state: FrameState; seq: number }>();
  const out: FrameEvent[] = [];
  for (const e of traceEvents) {
    if (!isRec(e) || e['name'] !== 'PipelineReporter' || e['pid'] !== pid) continue;
    const id = asyncId(e);
    const ts = num(e['ts']);
    if (id === undefined || ts === undefined) continue;
    if (e['ph'] === 'b') {
      const r = reporter(e);
      if (r !== undefined && ts >= window.start && ts <= window.end) open.set(id, { ts, ...r });
    } else if (e['ph'] === 'e') {
      const b = open.get(id);
      if (b !== undefined) {
        open.delete(id);
        out.push({ seq: b.seq, ts: b.ts, endTs: ts, state: b.state });
      }
    }
  }
  return out;
}

const isPresented = (s: FrameState): boolean =>
  s === 'STATE_PRESENTED_ALL' || s === 'STATE_PRESENTED_PARTIAL';

function invalid(reason: string, vsyncMs = 0): FrameStats {
  return {
    vsyncMs,
    frames: 0,
    p50Ms: 0,
    p95Ms: 0,
    p99Ms: 0,
    maxMs: 0,
    droppedPct: 0,
    partialPct: 0,
    rawIntervalP95Ms: 0,
    onTimePct: 0,
    valid: false,
    invalidReason: reason,
  };
}

/** §3.11.3 steps 1-5. */
export function frameStats(input: readonly FrameEvent[]): FrameStats {
  const bySeq = new Map<number, FrameEvent>();
  for (const f of input) if (!bySeq.has(f.seq)) bySeq.set(f.seq, f);
  const frames = [...bySeq.values()].sort((a, b) => a.seq - b.seq);

  const gaps: number[] = [];
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1];
    const b = frames[i];
    if (a !== undefined && b !== undefined && b.seq - a.seq === 1) gaps.push((b.ts - a.ts) / 1000);
  }
  if (gaps.length === 0) return invalid('fewer than two consecutive BeginFrames in the window');
  const v = median(gaps);

  const presented = frames.filter((f) => isPresented(f.state));
  if (presented.length < 2) return invalid('fewer than two presented frames in the window', v);

  const durations: number[] = [];
  const raw: number[] = [];
  let droppedTotal = 0;
  let onTime = 0;
  let mismatches = 0;
  let cursor = frames.indexOf(presented[0] as FrameEvent) + 1;
  for (let i = 1; i < presented.length; i++) {
    const prev = presented[i - 1] as FrameEvent;
    const cur = presented[i] as FrameEvent;
    let dropped = 0;
    for (; cursor < frames.length && (frames[cursor] as FrameEvent).seq < cur.seq; cursor++) {
      if ((frames[cursor] as FrameEvent).state === 'STATE_DROPPED') dropped++;
    }
    cursor++;
    droppedTotal += dropped;
    if (dropped === 0) onTime++;
    durations.push((1 + dropped) * v);
    const interval = (cur.endTs - prev.endTs) / 1000;
    raw.push(interval);
    // Compare with the vsyncs that elapsed, so idle (no-update) vsyncs, which D excludes on
    // purpose, do not invalidate a run; variable refresh and lost events still do.
    if (Math.abs(interval - (cur.seq - prev.seq) * v) > 0.25 * v) mismatches++;
  }

  const partial = presented.filter((f) => f.state === 'STATE_PRESENTED_PARTIAL').length;
  const mismatchShare = mismatches / raw.length;
  const d = summarise(durations);
  const stats: FrameStats = {
    vsyncMs: v,
    frames: durations.length,
    p50Ms: d.p50,
    p95Ms: d.p95,
    p99Ms: d.p99,
    maxMs: d.max,
    droppedPct: (100 * droppedTotal) / (droppedTotal + presented.length),
    partialPct: (100 * partial) / presented.length,
    rawIntervalP95Ms: percentile(raw, 0.95),
    onTimePct: (100 * onTime) / durations.length,
    valid: mismatchShare <= MAX_MISMATCH_SHARE,
  };
  if (!stats.valid) {
    stats.invalidReason = `${(100 * mismatchShare).toFixed(1)}% of presentation intervals disagree with the vsync model (variable refresh or trace loss)`;
  }
  return stats;
}

/**
 * Pass or fail of one run. On a display slower than 59.88 Hz (V > 16.7 ms) no renderer can meet
 * the absolute target, so the gate becomes "at least 95% of presented frames on time" (§3.11.3).
 */
export function framePasses(stats: FrameStats, targetMs = FRAME_TARGET_MS): boolean {
  if (!stats.valid) return false;
  if (stats.vsyncMs > targetMs) return stats.onTimePct >= 95;
  return stats.p95Ms <= targetMs;
}

/** The origin a script URL belongs to; blob: URLs carry their creator's origin inside. */
export function scriptOrigin(url: string): string | undefined {
  if (url === '') return undefined;
  try {
    const u = new URL(url);
    if (u.protocol === 'blob:') return new URL(u.pathname).origin;
    return u.origin === 'null' ? undefined : u.origin;
  } catch {
    return undefined;
  }
}

/** §3.11.3 LoAF attribution: an entry over 50 ms is ours if any script comes from our origin. */
export function attributeLoaf(entries: readonly LoafEntry[], origin: string): LoafSummary {
  const out: LoafSummary = { over50Ours: 0, over50Unattributed: 0, worstOursMs: 0, sources: [] };
  const sources = new Set<string>();
  for (const e of entries) {
    if (!(e.duration > LOAF_LIMIT_MS)) continue;
    const urls = (e.scripts ?? []).map((s) => s.sourceURL).filter((u) => u !== '');
    if (urls.length === 0) {
      out.over50Unattributed++;
      continue;
    }
    const ours = urls.filter((u) => scriptOrigin(u) === origin);
    if (ours.length === 0) continue;
    out.over50Ours++;
    out.worstOursMs = Math.max(out.worstOursMs, e.duration);
    for (const u of ours) sources.add(u);
  }
  out.sources = [...sources].sort();
  return out;
}
