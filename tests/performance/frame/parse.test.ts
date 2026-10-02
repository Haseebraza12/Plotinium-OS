import { describe, expect, it } from 'vitest';

import {
  allPresented,
  RENDERER_PID,
  syntheticTrace,
  type FixtureFrameState,
} from '../../fixtures/frame-trace.ts';

import {
  attributeLoaf,
  extractFrames,
  framePasses,
  frameStats,
  rendererPid,
  scriptOrigin,
  scriptWindow,
  type FrameStats,
} from './parse.ts';

function statsOf(
  hz: number,
  states: readonly FixtureFrameState[],
  extra: Parameters<typeof syntheticTrace>[0] = { hz, states },
): FrameStats {
  const trace = syntheticTrace({ ...extra, hz, states });
  const win = scriptWindow(trace);
  if (win === undefined) throw new Error('synthetic trace has no script window');
  return frameStats(extractFrames(trace, win, RENDERER_PID));
}

/** `n` presented vsyncs with one dropped vsync inserted every `every` frames. */
function withDrops(n: number, every: number): FixtureFrameState[] {
  const out: FixtureFrameState[] = [];
  for (let i = 0; i < n; i++)
    out.push(i > 0 && i % every === 0 ? 'STATE_DROPPED' : 'STATE_PRESENTED_ALL');
  return out;
}

describe('TST-05 frame parser', () => {
  it('TST-05 frame parser returns p95 of one vsync and 0 dropped frames on the golden 60 Hz trace', () => {
    const s = statsOf(60, allPresented(1200));
    expect(s.valid).toBe(true);
    expect(s.vsyncMs).toBeCloseTo(16.667, 2);
    expect(s.p95Ms).toBeCloseTo(s.vsyncMs, 6); // invariant F-1
    expect(s.frames).toBe(1199);
    expect(s.droppedPct).toBe(0);
    expect(framePasses(s)).toBe(true);
  });

  it('TST-05 frame parser counts one dropped vsync as a 33.3 ms frame at 60 Hz and as 16.7 ms at 120 Hz', () => {
    // A drop every 10th vsync puts about 11% of durations at 2V, above the 5% the p95 tolerates.
    const at60 = statsOf(60, withDrops(600, 10));
    expect(at60.p95Ms).toBeCloseTo(33.33, 1);
    expect(framePasses(at60)).toBe(false);
    const at120 = statsOf(120, withDrops(1200, 10));
    expect(at120.p95Ms).toBeCloseTo(16.67, 1);
    expect(framePasses(at120)).toBe(true);
  });

  it('TST-05 dropped percentage is dropped over dropped plus presented (invariant F-2)', () => {
    const s = statsOf(60, withDrops(100, 10));
    const dropped = 9;
    expect(s.droppedPct).toBeCloseTo((100 * dropped) / (dropped + 91), 6);
    expect(s.onTimePct).toBeCloseTo((100 * (90 - 9)) / 90, 6);
  });

  it('TST-05 frame parser excludes no-update-desired vsyncs from frame durations', () => {
    const states: FixtureFrameState[] = [...allPresented(50)];
    for (let i = 10; i < 30; i++) states[i] = 'STATE_NO_UPDATE_DESIRED';
    const s = statsOf(60, states);
    expect(s.valid).toBe(true);
    expect(s.p95Ms).toBeCloseTo(s.vsyncMs, 6);
    expect(s.droppedPct).toBe(0);
  });

  it('TST-05 frame parser accepts both chrome_frame_reporter and frame_reporter argument names', () => {
    const states = withDrops(200, 7);
    const old = statsOf(60, states, { hz: 60, states, argName: 'chrome_frame_reporter' });
    const neu = statsOf(60, states, { hz: 60, states, argName: 'frame_reporter' });
    expect(neu).toEqual(old);
    expect(old.frames).toBeGreaterThan(0);
  });

  it('TST-05 frame parser marks a variable-refresh trace invalid', () => {
    const states = allPresented(300);
    const s = statsOf(60, states, { hz: 60, states, jitterUs: (i) => (i % 3 === 0 ? 7000 : 0) });
    expect(s.valid).toBe(false);
    expect(s.invalidReason).toMatch(/variable refresh or trace loss/);
    expect(framePasses(s)).toBe(false);
  });

  it('TST-05 partially presented frames count as presented and are reported', () => {
    const states: FixtureFrameState[] = allPresented(100).map((st, i) =>
      i % 4 === 0 ? 'STATE_PRESENTED_PARTIAL' : st,
    );
    const s = statsOf(60, states);
    expect(s.partialPct).toBe(25);
    expect(s.p95Ms).toBeCloseTo(s.vsyncMs, 6);
  });

  it('TST-05 on a display slower than 59.88 Hz the gate is 95% of frames on time', () => {
    expect(framePasses(statsOf(50, allPresented(300)))).toBe(true);
    expect(framePasses(statsOf(50, withDrops(300, 10)))).toBe(false);
  });

  it('TST-05 duplicate sequences, other renderers and events outside the window are ignored', () => {
    const trace = syntheticTrace({ hz: 60, states: allPresented(100) });
    const noise = syntheticTrace({ hz: 60, states: withDrops(100, 2), pid: 99 });
    const win = scriptWindow(trace);
    if (win === undefined) throw new Error('no window');
    const dup = trace.filter((e) => e.name === 'PipelineReporter').slice(0, 2);
    const late = { ...dup[0], ts: win.end + 5_000_000, id2: { local: '0xlate' } };
    const frames = extractFrames([...trace, ...noise, ...dup, late], win, RENDERER_PID);
    expect(frameStats(frames).p95Ms).toBeCloseTo(16.667, 2);
    expect(frameStats(frames).frames).toBe(99);
  });

  it('TST-05 a trace without enough frames is invalid rather than passing', () => {
    expect(frameStats([]).valid).toBe(false);
    const one = frameStats([
      { seq: 1, ts: 0, endTs: 16_000, state: 'STATE_PRESENTED_ALL' },
      { seq: 2, ts: 16_667, endTs: 33_000, state: 'STATE_DROPPED' },
    ]);
    expect(one.valid).toBe(false);
    expect(one.invalidReason).toMatch(/presented/);
  });

  it('TST-05 the script window and the renderer are found from the trace itself', () => {
    const trace = syntheticTrace({ hz: 60, states: allPresented(10) });
    expect(scriptWindow(trace)).toEqual({
      start: 999_999,
      end: 1_000_000 + Math.round((10 * 1e6) / 60) + 1,
    });
    expect(scriptWindow([])).toBeUndefined();
    expect(rendererPid(trace, 'http://localhost:4717')).toBe(RENDERER_PID);
    const started = {
      name: 'TracingStartedInBrowser',
      ph: 'I',
      ts: 0,
      pid: 1,
      args: { data: { frames: [{ processId: 777, url: 'http://localhost:4717/' }] } },
    };
    expect(rendererPid([started, ...trace], 'http://localhost:4717')).toBe(777);
    expect(rendererPid([], 'http://localhost:4717')).toBeUndefined();
  });
});

describe('TST-05 long-animation-frame attribution', () => {
  const origin = 'http://localhost:4717';

  it('TST-05 LoAF filter attributes an entry to our origin when any script sourceURL is same-origin, including blob URLs', () => {
    const s = attributeLoaf(
      [
        {
          duration: 80,
          scripts: [
            { sourceURL: 'chrome-extension://abc/x.js' },
            { sourceURL: `${origin}/assets/kernel-1a2b.js` },
          ],
        },
        {
          duration: 120,
          scripts: [{ sourceURL: `blob:${origin}/6f1c0b2e-9d7a-4b8c-a2d1-0c3f5e7a9b11` }],
        },
        { duration: 60, scripts: [{ sourceURL: 'https://cdn.example/other.js' }] },
        { duration: 50, scripts: [{ sourceURL: `${origin}/assets/boot.js` }] },
      ],
      origin,
    );
    expect(s.over50Ours).toBe(2);
    expect(s.worstOursMs).toBe(120);
    expect(s.sources).toEqual([
      `blob:${origin}/6f1c0b2e-9d7a-4b8c-a2d1-0c3f5e7a9b11`,
      `${origin}/assets/kernel-1a2b.js`,
    ]);
  });

  it('TST-05 entries over 50 ms without script attribution are counted separately and never as ours', () => {
    const s = attributeLoaf(
      [{ duration: 70 }, { duration: 90, scripts: [{ sourceURL: '' }] }],
      origin,
    );
    expect(s).toEqual({ over50Ours: 0, over50Unattributed: 2, worstOursMs: 0, sources: [] });
  });

  it('TST-05 inline scripts report the document URL and are ours; malformed URLs are not', () => {
    expect(scriptOrigin(`${origin}/`)).toBe(origin);
    expect(scriptOrigin('not a url')).toBeUndefined();
    expect(scriptOrigin('')).toBeUndefined();
    expect(scriptOrigin('data:text/javascript,1')).toBeUndefined();
  });
});
