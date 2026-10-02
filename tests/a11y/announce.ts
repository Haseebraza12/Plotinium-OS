/**
 * BOOT-13 status announcements (boot-and-services §7; testing §3.9): the boot screen's status
 * region announces at most once per 750 ms, except for stage changes and failures, which are
 * always announced. The recorder watches every `role="status"` region from the first byte.
 */
import type { BrowserContext, Page } from '@playwright/test';

export interface Announcement {
  /** ms since navigation start. */
  t: number;
  text: string;
}

declare global {
  interface Window {
    __pltAnnouncements?: Announcement[];
  }
}

export const MIN_INTERVAL_MS = 750;

/** Stage changes and failures may be announced at any time (boot-and-services §7). */
export const EXEMPT = /^(Stage \d|Stage:|FAIL|KERNEL PANIC|DEGRADED|WARN)|\b(failed|degraded)\b/i;

function recordAnnouncements(): void {
  const out: Announcement[] = [];
  window.__pltAnnouncements = out;
  const statusOf = (n: Node | null): Element | null => {
    for (
      let el = n instanceof Element ? n : (n?.parentElement ?? null);
      el !== null;
      el = el.parentElement
    ) {
      if (el.getAttribute('role') === 'status' || el.getAttribute('aria-live') === 'polite')
        return el;
    }
    return null;
  };
  new MutationObserver((records) => {
    const seen = new Set<Element>();
    for (const r of records) {
      const region = statusOf(r.target);
      if (region !== null && !seen.has(region)) {
        seen.add(region);
        const text = (region.textContent ?? '').trim();
        const last = out[out.length - 1];
        if (text !== '' && last?.text !== text) out.push({ t: performance.now(), text });
      }
    }
  }).observe(document, { subtree: true, childList: true, characterData: true });
}

export async function installAnnouncementRecorder(context: BrowserContext): Promise<void> {
  await context.addInitScript(recordAnnouncements);
}

export async function announcements(page: Page): Promise<Announcement[]> {
  return page.evaluate(() => window.__pltAnnouncements ?? []);
}

/** Pairs of non-exempt announcements closer together than the minimum interval. */
export function tooFrequent(
  list: readonly Announcement[],
  minMs = MIN_INTERVAL_MS,
  exempt: RegExp = EXEMPT,
): Array<[Announcement, Announcement]> {
  const out: Array<[Announcement, Announcement]> = [];
  let prev: Announcement | undefined;
  for (const a of list) {
    if (exempt.test(a.text)) continue;
    if (prev !== undefined && a.t - prev.t < minMs) out.push([prev, a]);
    prev = a;
  }
  return out;
}
