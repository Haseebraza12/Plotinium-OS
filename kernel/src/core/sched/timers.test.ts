/**
 * KPS-13: every kernel timer fires from the timer heap, with one armed platform timer.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { TimerHeap } from './timers.ts';
import { ModelHeap } from './tests/model-heap.ts';
import { SimKernel } from './tests/sim.ts';

const heap = (): TimerHeap => new TimerHeap(() => new ModelHeap());

describe('KPS-13 kernel timer heap', () => {
  it('KPS-13 sleep, aging, watchdog and service timeouts all fire from the kernel timer heap with one armed platform timer', () => {
    const t = heap();
    const armed: (number | null)[] = [];
    t.onEarliestChange = (d) => armed.push(d);
    const fired: string[] = [];
    t.arm(100, () => fired.push('aging'), { label: 'sched:aging', periodMs: 100 });
    t.arm(50, () => fired.push('watchdog'), { label: 'watchdog', periodMs: 50 });
    t.arm(30, () => fired.push('sleep:412'), { label: 'sleep:412', pid: 412 });
    t.arm(1_000, () => fired.push('svc-timeout'), { label: 'svc:syncd' });
    // The host keeps exactly one platform timer, re-armed only when the minimum moves.
    expect(armed).toEqual([100, 50, 30]);
    // The host loop: the platform timer fires at the earliest deadline and calls runDue.
    const host = (until: number): void => {
      for (let d = t.nextDeadline(); d !== null && d <= until; d = t.nextDeadline()) t.runDue(d);
    };
    host(100);
    // At 100 both are due: equal priority, so arm order decides (aging was armed first).
    expect(fired).toEqual(['sleep:412', 'watchdog', 'aging', 'watchdog']);
    expect(armed.at(-1)).toBe(150);
    host(1_000);
    expect(fired.filter((f) => f === 'svc-timeout')).toHaveLength(1);
    expect(fired.filter((f) => f === 'aging')).toHaveLength(10);
    expect(fired.filter((f) => f === 'watchdog')).toHaveLength(20);
    // A late wake-up fires a periodic timer once and skips the missed periods.
    t.runDue(1_400);
    expect(fired.filter((f) => f === 'aging')).toHaveLength(11);
    expect(t.nextDeadline()).toBe(1_450);
    t.checkInvariants();
  });

  it('KPS-13 due timers run in (deadline, priority, arm order); a callback may arm, cancel and re-arm', () => {
    const t = heap();
    const order: string[] = [];
    t.arm(10, () => order.push('b'), { priority: 2 });
    t.arm(10, () => order.push('a'), { priority: 1 });
    const c = t.arm(10, () => order.push('c'), { priority: 2 });
    t.arm(5, () => {
      order.push('first');
      t.cancel(c);
      t.arm(8, () => order.push('armed-in-callback'));
      t.arm(10, () => order.push('reused-slot'), { priority: 3 }); // may reuse c's slot
    });
    expect(t.runDue(10)).toBe(5);
    expect(order).toEqual(['first', 'armed-in-callback', 'a', 'b', 'reused-slot']);
    expect(t.size).toBe(0);
    expect(t.nextDeadline()).toBeNull();
  });

  it('KPS-13 cancel and reschedule use generation-checked ids, so a stale id never touches a reused slot', () => {
    const t = heap();
    const fired: number[] = [];
    const a = t.arm(10, () => fired.push(1));
    expect(t.has(a)).toBe(true);
    expect(t.info(a)).toMatchObject({ deadline: 10, label: '', pid: 0, periodMs: 0 });
    expect(t.reschedule(a, 20)).toBe(true);
    expect(t.nextDeadline()).toBe(20);
    expect(t.cancel(a)).toBe(true);
    expect(t.cancel(a)).toBe(false);
    const b = t.arm(30, () => fired.push(2)); // reuses a's slot
    expect(t.cancel(a)).toBe(false);
    expect(t.reschedule(a, 1)).toBe(false);
    expect(t.info(a)).toBeUndefined();
    expect(t.has(b)).toBe(true);
    expect(t.cancel(-1)).toBe(false);
    expect(t.cancel(1.5)).toBe(false);
    t.runDue(30);
    expect(fired).toEqual([2]);
  });

  it('KPS-13 periodic timers skip missed periods and every timer of a pid can be cancelled (kill path)', () => {
    const t = heap();
    const at: number[] = [];
    t.arm(100, (now) => at.push(now), { periodMs: 100 });
    t.runDue(350); // one late firing; the next deadline is 400, not 200
    expect(at).toEqual([350]);
    expect(t.nextDeadline()).toBe(400);
    t.arm(500, () => at.push(-1), { pid: 7 });
    t.arm(600, () => at.push(-2), { pid: 7 });
    expect(t.timersOf(7)).toHaveLength(2);
    expect(t.cancelAllOf(7)).toBe(2);
    expect(t.timersOf(7)).toEqual([]);
  });

  it('KPS-13 arm rejects non-finite deadlines and non-positive periods; nested runDue is a no-op', () => {
    const t = heap();
    expect(() => t.arm(Number.NaN, () => undefined)).toThrow(RangeError);
    expect(() => t.arm(1, () => undefined, { periodMs: 0 })).toThrow(RangeError);
    const id = t.arm(1, () => {
      expect(t.runDue(5)).toBe(0);
    });
    expect(() => t.reschedule(id, Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(t.runDue(5)).toBe(1);
  });

  it('KPS-13 fires every timer exactly once and in deadline order (fast-check)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 1_000 }), { maxLength: 60 }),
        fc.array(fc.nat(), { maxLength: 20 }),
        (deadlines, cancels) => {
          const t = heap();
          const fired: number[] = [];
          const ids = deadlines.map((d, i) => t.arm(d, () => fired.push(i)));
          const cancelled = new Set<number>();
          for (const c of cancels) {
            const i = c % Math.max(1, ids.length);
            const id = ids[i];
            if (id !== undefined && t.cancel(id)) cancelled.add(i);
          }
          t.runDue(1_000);
          const expected = deadlines
            .map((d, i) => ({ d, i }))
            .filter((x) => !cancelled.has(x.i))
            .sort((a, b) => a.d - b.d || a.i - b.i)
            .map((x) => x.i);
          expect(fired).toEqual(expected);
        },
      ),
    );
  });

  it('KPS-13 the scheduler arms its aging tick and interactive boundaries on the same heap', () => {
    const sim = new SimKernel({ hwc: 4, watchdog: false });
    // Kernel-owned timers carry pid 0; ids are opaque, so read them back through timersOf(0).
    const labels = (): string[] =>
      sim.timers
        .timersOf(0)
        .map((id) => sim.timers.info(id)?.label ?? '')
        .sort();
    expect(labels()).toEqual(['sched:aging']);
    sim.sched.setInteractive(true, 0);
    expect(labels()).toEqual(['sched:aging', 'sched:interactive']);
    sim.runUntil(1_000);
    expect(labels()).toEqual(['sched:aging', 'sched:interactive']); // cool-down boundary at 2,000
    sim.sched.setInteractive(false, sim.now);
    expect(labels()).toEqual(['sched:aging']);
  });
});
