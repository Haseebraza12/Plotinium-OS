/**
 * Boot-progress sampling for BOOT-02 (truthful progress) and BOOT-13 (live progressbar values).
 *
 * The recorder is an init script, so it runs before the inlined boot-ui and sees every change of
 * `aria-valuenow` on the boot `progressbar` (boot-and-services §8.3: "samples aria-valuenow on
 * every mutation"). The analysis functions are pure and unit-tested.
 */
import type { BrowserContext, Page } from '@playwright/test';

export interface ProgressSample {
  /** ms since navigation start (`performance.now()` in the page). */
  t: number;
  /** `aria-valuenow`, 0–100. */
  v: number;
}

declare global {
  interface Window {
    __pltProgress?: ProgressSample[];
  }
}

/** Runs in the page before any page script. Kept free of closures over test-side values. */
function recordProgress(): void {
  const samples: ProgressSample[] = [];
  window.__pltProgress = samples;
  const read = (el: Element): void => {
    if (el.getAttribute('role') !== 'progressbar') return;
    const raw = el.getAttribute('aria-valuenow');
    if (raw === null) return;
    const v = Number(raw);
    const last = samples[samples.length - 1];
    if (Number.isFinite(v) && (last === undefined || last.v !== v))
      samples.push({ t: performance.now(), v });
  };
  const observer = new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'attributes' && r.target instanceof Element) read(r.target);
      for (const node of r.addedNodes) {
        if (node instanceof Element) {
          read(node);
          for (const el of node.querySelectorAll('[role="progressbar"]')) read(el);
        }
      }
    }
  });
  observer.observe(document, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['aria-valuenow', 'role'],
  });
}

export async function installProgressRecorder(context: BrowserContext): Promise<void> {
  await context.addInitScript(recordProgress);
}

export async function progressSamples(page: Page): Promise<ProgressSample[]> {
  return page.evaluate(() => window.__pltProgress ?? []);
}

/** The value shown at time `t` (the last sample at or before it), 0 before the first sample. */
export function valueAt(samples: readonly ProgressSample[], t: number): number {
  let v = 0;
  for (const s of samples) {
    if (s.t > t) break;
    v = s.v;
  }
  return v;
}

/** INV-B2: progress never goes backwards. */
export function isNonDecreasing(samples: readonly ProgressSample[]): boolean {
  return samples.every((s, i) => i === 0 || s.v >= (samples[i - 1]?.v ?? 0));
}

export function distinctValues(samples: readonly ProgressSample[]): number {
  return new Set(samples.map((s) => s.v)).size;
}

/** Samples strictly inside `[from, to)` ms, for "the kernel download produces at least 5 values". */
export function between(
  samples: readonly ProgressSample[],
  from: number,
  to: number,
): ProgressSample[] {
  return samples.filter((s) => s.t >= from && s.t < to);
}
