/**
 * Trace and LoAF capture for the frame metric (spec §3.11.3 "Trace capture"; WM §8.2 steps 4-7).
 */
import type { CDPSession, Page } from '@playwright/test';

import type { LoafEntry } from './parse.ts';

/**
 * The five categories of §3.11.3, plus `blink.user_timing`, which carries the
 * `perf:script:start|end` marks that bound the script window.
 */
export const TRACE_CATEGORIES = [
  'devtools.timeline',
  'disabled-by-default-devtools.timeline',
  'disabled-by-default-devtools.timeline.frame',
  'benchmark',
  'loading',
  'blink.user_timing',
] as const;

export interface TraceHandle {
  stop(): Promise<unknown[]>;
}

export async function startTrace(session: CDPSession): Promise<TraceHandle> {
  const events: unknown[] = [];
  const onData = (payload: { value: unknown[] }): void => {
    events.push(...payload.value);
  };
  session.on('Tracing.dataCollected', onData);
  await session.send('Tracing.start', {
    transferMode: 'ReportEvents',
    traceConfig: { includedCategories: [...TRACE_CATEGORIES], recordMode: 'recordContinuously' },
  });
  return {
    stop: async () => {
      const complete = new Promise<void>((resolve) => {
        session.once('Tracing.tracingComplete', () => resolve());
      });
      await session.send('Tracing.end');
      await complete;
      session.off('Tracing.dataCollected', onData);
      return events;
    },
  };
}

declare global {
  interface Window {
    __pltLoaf?: LoafEntry[];
  }
}

/** Runs in the page before any page script: a buffered long-animation-frame observer. */
function recordLoaf(): void {
  const entries: LoafEntry[] = [];
  window.__pltLoaf = entries;
  interface ScriptTiming {
    sourceURL: string;
    duration: number;
    invoker: string;
  }
  interface LoafTiming extends PerformanceEntry {
    renderStart: number;
    styleAndLayoutStart: number;
    scripts: readonly ScriptTiming[];
  }
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as LoafTiming[]) {
        entries.push({
          duration: e.duration,
          startTime: e.startTime,
          renderStart: e.renderStart,
          styleAndLayoutStart: e.styleAndLayoutStart,
          scripts: e.scripts.map((s) => ({
            sourceURL: s.sourceURL,
            duration: s.duration,
            invoker: s.invoker,
          })),
        });
      }
    }).observe({ type: 'long-animation-frame', buffered: true });
  } catch {
    // An older Chrome without LoAF: the harness reports zero entries and the probe flags it.
  }
}

export async function installLoafRecorder(page: Page): Promise<void> {
  await page.context().addInitScript(recordLoaf);
}

/** Entries recorded since `sinceMs` (page time), for the script window of one run. */
export async function loafEntries(page: Page, sinceMs = 0): Promise<LoafEntry[]> {
  return page.evaluate(
    (since) => (window.__pltLoaf ?? []).filter((e) => (e.startTime ?? 0) >= since),
    sinceMs,
  );
}

/** Resolves after the next animation frame in the page: pacing for "one mouse.move per frame". */
export async function nextFrame(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
}
