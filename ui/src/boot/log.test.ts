import { fireEvent, getByRole } from '@solidjs/testing-library';
import { afterEach, describe, expect, it } from 'vitest';

import { createVerboseLog, formatBootLine, formatBootTime, levelOf, parseBootLine } from './log.ts';
import type { BootLogLine } from './types.ts';

afterEach(() => {
  document.body.replaceChildren();
});

/** The illustrative verbose log of boot-and-services.md §3.7. */
const SAMPLE: readonly string[] = [
  '[    0.000] firmware: Plotinium 0.3.0 · POST ok (workers, indexeddb, opfs, crypto, isolated)',
  '[    0.058] kernel: process table ready (hash table, cap 64) · pid 1 = init · klog 8192',
  '[    0.122] storage: opened plotinium v7 (IndexedDB) in 61 ms · epoch 38',
  '[    0.402] sync: WARN backend unreachable · offline mode · outbox holds 3 ops · retry in 2 s',
  '[    0.405] lockd: DEGRADED (requires sync) · local advisory locks only',
  '[    0.731] desktop: interactive · 4 windows restored · boot 0.73 s · 2 services degraded',
];

const lines = (): BootLogLine[] =>
  SAMPLE.map((text) => {
    const line = parseBootLine(text);
    if (line === null) throw new Error(text);
    return line;
  });

function rows(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('.plb-sizer > .plb-row')].filter((r) => !r.hidden);
}

describe('UI-VerboseLog', () => {
  it('BOOT-05 lines read [ssss.mmm] subsystem: message with the timestamp right-aligned in 11 columns', () => {
    expect(formatBootTime(0)).toBe('[    0.000]');
    expect(formatBootTime(0.087)).toBe('[    0.087]');
    expect(formatBootTime(1234.5)).toBe('[ 1234.500]');
    for (const text of SAMPLE) {
      const line = parseBootLine(text);
      expect(line).not.toBeNull();
      if (line !== null) expect(formatBootLine(line)).toBe(text);
    }
    expect(parseBootLine('not a klog line')).toBeNull();
  });

  it('BOOT-05 verbose lines carry WARN and DEGRADED text prefixes, not colour alone', () => {
    const log = createVerboseLog({ schedule: null });
    document.body.append(log.el);
    log.append(...lines(), { t: 0.9, sub: 'ai.agent', msg: 'health probe failed', level: 'fail' });
    const shown = rows(log.el);
    const warn = shown.find((r) => r.dataset.l === 'warn');
    const degraded = shown.find((r) => r.dataset.l === 'degraded');
    const fail = shown.find((r) => r.dataset.l === 'fail');
    expect(warn?.textContent).toBe(SAMPLE[3]);
    expect(warn?.querySelector('.plb-pfx')?.textContent).toBe('WARN');
    expect(degraded?.textContent).toBe(SAMPLE[4]);
    // A level given without its word gets the word, so colour is never the only signal.
    expect(fail?.textContent).toBe('[    0.900] ai.agent: FAIL health probe failed');
    expect(levelOf({ t: 0, sub: 'svc', msg: 'KERNEL PANIC: dependency cycle detected' })).toBe(
      'panic',
    );
  });

  it('BOOT-05 the log is a keyboard-focusable role=log region that does not flood screen readers', () => {
    const log = createVerboseLog();
    document.body.append(log.el);
    const region = getByRole(log.el, 'log', { name: 'Boot log' });
    expect(region.getAttribute('aria-live')).toBe('off');
    expect(region.tabIndex).toBe(0);
    expect(region.textContent).toContain('waiting for firmware…');
  });

  it('BOOT-05 append-only and virtualised: 10,000 lines keep only a window of rows in the DOM', () => {
    const log = createVerboseLog({ schedule: null });
    document.body.append(log.el);
    const many: BootLogLine[] = Array.from({ length: 10_000 }, (_, i) => ({
      t: i / 1000,
      sub: 'svc',
      msg: `line ${i}`,
    }));
    log.append(...many);
    expect(log.length).toBe(10_000);
    const shown = rows(log.el);
    expect(shown.length).toBeLessThanOrEqual(60);
    expect(shown.at(-1)?.textContent).toBe('[    9.999] svc: line 9999');
    expect(log.el.querySelector<HTMLElement>('.plb-sizer')?.style.height).toBe('200000px');
  });

  it('BOOT-05 appends are batched per frame and render on flush, never on a timer', () => {
    const queue: (() => void)[] = [];
    const log = createVerboseLog({ schedule: (fn) => queue.push(fn) });
    document.body.append(log.el);
    log.append(...lines().slice(0, 2));
    log.append(...lines().slice(2, 3));
    expect(queue).toHaveLength(1);
    expect(rows(log.el)).toHaveLength(0);
    log.flush();
    expect(rows(log.el)).toHaveLength(3);
    queue.forEach((fn) => fn());
    expect(rows(log.el)).toHaveLength(3);
  });

  it('BOOT-05 scrolling up holds the view; new lines are counted on "Jump to latest"', () => {
    const log = createVerboseLog({ schedule: null });
    document.body.append(log.el);
    log.append(
      ...Array.from({ length: 100 }, (_, i) => ({ t: i / 100, sub: 'svc', msg: `line ${i}` })),
    );
    const scroller = getByRole(log.el, 'log');
    const jump = log.el.querySelector<HTMLButtonElement>('.plb-jump');
    expect(jump?.hidden).toBe(true);
    scroller.scrollTop = 0;
    fireEvent.scroll(scroller);
    log.append(...lines().slice(0, 3));
    expect(jump?.hidden).toBe(false);
    expect(jump?.textContent).toBe('↓ 3 new lines');
    expect(rows(log.el)[0]?.textContent).toBe('[    0.000] svc: line 0');
    if (jump !== null && jump !== undefined) fireEvent.click(jump);
    expect(jump?.hidden).toBe(true);
    expect(rows(log.el).at(-1)?.textContent).toBe(SAMPLE[2]);
  });
});
