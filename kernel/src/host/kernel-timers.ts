/**
 * ONE kernel timer heap for the whole kernel (processes-and-scheduling.md §3.8, KPS-13).
 *
 * `core/sched/timers.ts` is the heap (on dsa/heap). This module binds it to the host:
 *   - `drivePlatformTimer(heap, clock, platform)`: the ONE platform timer, re-armed whenever the
 *     earliest deadline changes (`heap.onEarliestChange`); its callback runs `heap.runDue(now)`;
 *   - `kernelTimersOf(heap, now)`: the heap as the services' `KernelTimers` (`at`, `cancel`, `now`),
 *     so service start timeouts, back-off retries and the io layer's debounces share it with sleep,
 *     aging and the watchdog.
 *
 * `host/timers.ts` (`HostTimers`, a linear-scan stand-in) remains only for the bare BootSequence
 * tests that predate the heap.
 */
import type { TimerHeap } from '../core/sched/timers.ts';
import type { PlatformTimer } from './timers.ts';

/** The heap as `KernelTimers` (services, the io layer); defined next to the composition root. */
export { timerHeapKernelTimers as kernelTimersOf } from '../core/kernel.ts';

/**
 * Arm one platform timer for the heap's earliest deadline and keep it re-armed (KPS-13). Returns
 * the function that stops driving the heap.
 */
export function drivePlatformTimer(
  heap: TimerHeap,
  clock: { now(): number },
  platform: PlatformTimer,
): () => void {
  let handle: unknown = null;
  let stopped = false;
  const arm = (deadline: number | null): void => {
    if (handle !== null) platform.clear(handle);
    handle = null;
    if (deadline === null || stopped) return;
    handle = platform.set(
      () => {
        handle = null;
        heap.runDue(clock.now());
        // runDue re-notifies only when the minimum changed; re-arm for whatever is left.
        if (handle === null) arm(heap.nextDeadline());
      },
      Math.max(0, deadline - clock.now()),
    );
  };
  heap.onEarliestChange = arm;
  arm(heap.nextDeadline());
  return () => {
    stopped = true;
    heap.onEarliestChange = null;
    if (handle !== null) platform.clear(handle);
    handle = null;
  };
}
