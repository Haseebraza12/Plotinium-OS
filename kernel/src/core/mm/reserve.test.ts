/**
 * Reservation-based admission (memory-and-paging.md §3.7; MEM-06, KMM-06).
 */
import { describe, expect, it, vi } from 'vitest';

import { MmError } from './errors.ts';
import { ArrayHeap, ManualClock } from './fixtures/doubles.ts';
import { Reservations } from './reserve.ts';
import type { ReservationHooks, Ticket } from './reserve.ts';

const MiB = 1_048_576;

function setup(
  budget = 10 * MiB,
  hooks: ReservationHooks = {},
): { r: Reservations; clock: ManualClock } {
  const clock = new ManualClock();
  const r = new Reservations(budget, clock, 10_000, hooks, () => new ArrayHeap());
  return { r, clock };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe('Reservations (§3.7)', () => {
  it('MEM-06 a reservation that fits is granted at once and commit moves it to accounted', async () => {
    const { r } = setup();
    const t = await r.reserve(1, 4 * MiB);
    expect(r.reserved).toBe(4 * MiB);
    expect(r.committed).toBe(4 * MiB);
    r.commit(t, 3 * MiB);
    expect(r.reserved).toBe(0);
    expect(r.accounted).toBe(3 * MiB);
    expect(r.free).toBe(7 * MiB);
    expect(() => r.commit(t)).toThrow(MmError);
    r.cancel(t); // no-op on a used ticket
    expect(r.committed).toBe(3 * MiB);
  });

  it('MEM-06 an allocation larger than the budget fails with EINVAL exceeds-budget (ENOMEM is only requested)', async () => {
    const { r } = setup();
    await expect(r.reserve(1, 11 * MiB)).rejects.toMatchObject({
      errno: 'EINVAL',
      reason: 'exceeds-budget',
    });
    await expect(r.reserve(1, -1)).rejects.toMatchObject({ errno: 'EINVAL' });
    await expect(r.reserve(1, 1.5)).rejects.toMatchObject({ errno: 'EINVAL' });
  });

  it('MEM-06 mem.alloc blocks on mem until space is freed, then succeeds; committed never exceeds the budget', async () => {
    const onBlock = vi.fn();
    const onWake = vi.fn();
    const onDeficit = vi.fn();
    const { r } = setup(10 * MiB, { onBlock, onWake, onDeficit });
    const a = await r.reserve(1, 8 * MiB);
    r.commit(a);
    let granted: Ticket | null = null;
    void r.reserve(2, 4 * MiB).then((t) => {
      granted = t;
    });
    await flush();
    expect(granted).toBeNull();
    expect(r.blocked).toBe(1);
    expect(r.waitingBytes).toBe(4 * MiB);
    expect(onBlock).toHaveBeenCalledWith(2, 4 * MiB, 'alloc');
    expect(onDeficit).toHaveBeenCalledWith(2 * MiB);
    expect(r.headDeficit()).toBe(2 * MiB);
    expect(r.committed).toBeLessThanOrEqual(r.budget);
    r.uncharge(2 * MiB);
    await flush();
    expect(granted).not.toBeNull();
    expect(onWake).toHaveBeenCalledWith(2, true);
    expect(r.committed).toBe(10 * MiB);
    expect(r.blocked).toBe(0);
    expect(r.maxOverBudgetMs()).toBe(0);
  });

  it('MEM-06 a reservation blocked longer than 10 s fails with EAGAIN mem-pressure and allocates nothing', async () => {
    const onTimeout = vi.fn();
    const { r, clock } = setup(10 * MiB, { onTimeout });
    r.commit(await r.reserve(1, 9 * MiB));
    const p = r.reserve(2, 2 * MiB);
    clock.advance(9_999);
    await flush();
    expect(r.blocked).toBe(1);
    clock.advance(1);
    await expect(p).rejects.toMatchObject({ errno: 'EAGAIN', reason: 'mem-pressure' });
    expect(onTimeout).toHaveBeenCalledWith(2, 2 * MiB, 'alloc', 10_000);
    expect(r.blocked).toBe(0);
    expect(r.committed).toBe(9 * MiB);
  });

  it('MEM-06 waiters are served by priority then arrival, and a large head is never overtaken', async () => {
    const { r } = setup(10 * MiB);
    r.commit(await r.reserve(1, 10 * MiB));
    const order: string[] = [];
    void r.reserve(2, 6 * MiB, { prio: 20 }).then(() => order.push('big-20'));
    void r.reserve(3, 1 * MiB, { prio: 20 }).then(() => order.push('small-20'));
    void r.reserve(4, 2 * MiB, { prio: 0 }).then(() => order.push('focused-0'));
    await flush();
    // Nothing fits the head yet; the non-blocking path must not overtake waiters either.
    expect(r.tryReserve(9, 1)).toBeNull();
    r.uncharge(3 * MiB); // 3 MiB free: focused (2) fits; big (6) is next and does not fit; small waits behind it
    await flush();
    expect(order).toEqual(['focused-0']);
    r.uncharge(5 * MiB); // committed = 2 (focused) + 2 left accounted → 6 free: big fits, then small
    await flush();
    expect(order).toEqual(['focused-0', 'big-20']);
    r.uncharge(2 * MiB);
    await flush();
    expect(order).toEqual(['focused-0', 'big-20', 'small-20']);
    expect(r.committed).toBeLessThanOrEqual(r.budget);
  });

  it('MEM-06 tryReserve never waits and respects a lower limit (mem.prefetch uses LOW_WM)', () => {
    const { r } = setup(10 * MiB);
    expect(r.tryReserve(1, 8 * MiB, 7.5 * MiB)).toBeNull();
    const t = r.tryReserve(1, 7 * MiB, 7.5 * MiB);
    expect(t?.bytes).toBe(7 * MiB);
    expect(r.tryReserve(1, 1 * MiB, 7.5 * MiB)).toBeNull();
    expect(r.tryReserve(1, 1 * MiB)).not.toBeNull();
  });

  it('MEM-06 lowering the budget below committed asks reclaim for the deficit and records the excursion', async () => {
    const onDeficit = vi.fn();
    const onOverBudget = vi.fn();
    const { r, clock } = setup(10 * MiB, { onDeficit, onOverBudget });
    r.commit(await r.reserve(1, 8 * MiB));
    r.setBudget(6 * MiB);
    expect(onDeficit).toHaveBeenCalledWith(2 * MiB);
    expect(onOverBudget).toHaveBeenCalledWith(true, 0);
    clock.advance(250);
    expect(r.maxOverBudgetMs()).toBe(250);
    r.uncharge(2 * MiB);
    expect(onOverBudget).toHaveBeenCalledWith(false, 250);
    expect(r.maxOverBudgetMs()).toBe(250);
    expect(r.overBudgetEpisodes).toBe(1);
    r.setBudget(12 * MiB);
    expect(r.free).toBe(6 * MiB);
  });

  it('MEM-06 state growth beyond its headroom is the only unreserved charge and is recorded (§3.2.2)', async () => {
    const { r, clock } = setup(10 * MiB);
    const headroom = await r.reserve(1, 1 * MiB, { why: 'headroom' });
    r.commit(await r.reserve(2, 9 * MiB));
    // Growth within the headroom: committed unchanged.
    const rest = r.consume(headroom, 512 * 1024);
    expect(rest.bytes).toBe(512 * 1024);
    expect(r.committed).toBe(10 * MiB);
    // Growth beyond it: charged unreserved, committed exceeds the budget until reclaim frees space.
    r.chargeUnreserved(1 * MiB);
    expect(r.committed).toBe(11 * MiB);
    const wait = r.reserve(1, 0, { why: 'state-growth' });
    clock.advance(40);
    r.uncharge(1 * MiB);
    await expect(wait).resolves.toMatchObject({ bytes: 0 });
    expect(r.maxOverBudgetMs()).toBe(40);
    const merged = r.merge(rest, r.tryReserve(1, 0) as Ticket);
    expect(merged.bytes).toBe(512 * 1024);
    expect(r.merge(null, merged)).toBe(merged);
  });

  it('MEM-06 killing a process fails its blocked reservations with ECANCELED', async () => {
    const { r, clock } = setup(10 * MiB);
    r.commit(await r.reserve(1, 10 * MiB));
    const a = r.reserve(2, 1 * MiB);
    const b = r.reserve(3, 1 * MiB);
    expect(r.oldestBlockedMs()).toBe(0);
    clock.advance(380);
    expect(r.oldestBlockedMs()).toBe(380);
    expect(r.cancelWaiters(2)).toBe(1);
    await expect(a).rejects.toMatchObject({ errno: 'ECANCELED', reason: 'killed' });
    r.uncharge(1 * MiB);
    await expect(b).resolves.toMatchObject({ pid: 3 });
    expect(r.cancelWaiters(99)).toBe(0);
    expect(r.oldestBlockedMs()).toBe(0);
  });

  it('MEM-06 commit of more than the reservation is refused and uncharge never goes negative', async () => {
    const { r } = setup(10 * MiB);
    const t = await r.reserve(1, 1 * MiB);
    expect(() => r.commit(t, 2 * MiB)).toThrow(MmError);
    r.cancel(t);
    expect(r.reserved).toBe(0);
    r.uncharge(5);
    expect(r.accounted).toBe(0);
  });
});
