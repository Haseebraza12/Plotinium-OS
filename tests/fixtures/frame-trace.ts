/**
 * Synthetic Chrome traces for the frame-parser tests (spec §3.11.3, TST-05).
 *
 * Events follow the DevTools trace model: one async `PipelineReporter` slice (`ph` `b`/`e`, paired
 * by `id2.local`) per BeginFrame, with the frame state and sequence in `chrome_frame_reporter`
 * (or `frame_reporter` on newer Chrome), plus the `perf:script:start|end` user-timing marks.
 * The golden test pins this shape; when the nightly probe sees a Chrome major that breaks it, a
 * real trace is recorded and a fixture built from it replaces the synthetic one (spec §6.3).
 */
export type FixtureFrameState =
  'STATE_NO_UPDATE_DESIRED' | 'STATE_PRESENTED_ALL' | 'STATE_PRESENTED_PARTIAL' | 'STATE_DROPPED';

export interface TraceEvent {
  name: string;
  cat: string;
  ph: string;
  ts: number;
  pid: number;
  tid: number;
  id2?: { local?: string; global?: string };
  args?: Record<string, unknown>;
}

export interface SyntheticTraceOptions {
  /** Display refresh rate. */
  hz: number;
  /** One state per vsync, in order. */
  states: readonly FixtureFrameState[];
  pid?: number;
  /** First vsync, µs. */
  startUs?: number;
  argName?: 'chrome_frame_reporter' | 'frame_reporter';
  /** Adds this many µs to the presentation end of vsync i (variable refresh, trace loss). */
  jitterUs?: (i: number) => number;
  firstSeq?: number;
}

export const RENDERER_PID = 4242;
const MAIN_TID = 1;
const COMPOSITOR_TID = 7;

export function syntheticTrace(opts: SyntheticTraceOptions): TraceEvent[] {
  const pid = opts.pid ?? RENDERER_PID;
  const period = 1e6 / opts.hz;
  const start = opts.startUs ?? 1_000_000;
  const arg = opts.argName ?? 'chrome_frame_reporter';
  const firstSeq = opts.firstSeq ?? 1000;
  const events: TraceEvent[] = [
    {
      name: 'perf:script:start',
      cat: 'blink.user_timing',
      ph: 'R',
      ts: start - 1,
      pid,
      tid: MAIN_TID,
    },
  ];
  opts.states.forEach((state, i) => {
    const ts = start + Math.round(i * period);
    const endTs = ts + Math.round(period) + (opts.jitterUs?.(i) ?? 0);
    const id2 = { local: `0x${(firstSeq + i).toString(16)}` };
    events.push(
      {
        name: 'PipelineReporter',
        cat: 'benchmark,graphics.pipeline',
        ph: 'b',
        ts,
        pid,
        tid: COMPOSITOR_TID,
        id2,
        args: { [arg]: { state, frame_sequence: firstSeq + i } },
      },
      {
        name: 'PipelineReporter',
        cat: 'benchmark,graphics.pipeline',
        ph: 'e',
        ts: endTs,
        pid,
        tid: COMPOSITOR_TID,
        id2,
      },
    );
  });
  const end = start + Math.round(opts.states.length * period) + 1;
  events.push({
    name: 'perf:script:end',
    cat: 'blink.user_timing',
    ph: 'R',
    ts: end,
    pid,
    tid: MAIN_TID,
  });
  return events;
}

/** `n` vsyncs, every one presented. */
export function allPresented(n: number): FixtureFrameState[] {
  return Array.from({ length: n }, () => 'STATE_PRESENTED_ALL' as const);
}
