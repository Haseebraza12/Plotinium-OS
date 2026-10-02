/**
 * The self-healing loop of a DEGRADED service (boot-and-services.md §3.5, SVC-04): the service
 * keeps running in its fallback mode and retries on the §5.3 back-off schedule (`ctx.backoff`,
 * on the kernel timer heap, never `setTimeout`), reporting each attempt so `svcctl status` shows
 * `attempts` and `nextRetryAt`. A successful attempt calls `ctx.recovered()`.
 */
import type { ServiceContext } from '../types.ts';

export interface Healer {
  /** Retry now (the router's `online` event, OFF-04), without waiting for the back-off. */
  kick(): void;
  /** Stop retrying (the service stopped, or it recovered through another path). */
  cancel(): void;
  readonly active: boolean;
}

/**
 * Start retrying `attempt` until it resolves true. The first try happens after the first back-off
 * delay: the caller has just seen the failure.
 */
export function selfHeal(ctx: ServiceContext, attempt: () => Promise<boolean>): Healer {
  let timer: number | null = null;
  let active = true;
  let inFlight = false;

  const disarm = (): void => {
    if (timer !== null) ctx.timers.cancel(timer);
    timer = null;
  };

  const arm = (): void => {
    if (!active) return;
    disarm();
    const b = ctx.backoff();
    timer = ctx.timers.at(b.retryAt, () => {
      timer = null;
      run();
    });
  };

  const run = (): void => {
    if (!active || inFlight) return;
    inFlight = true;
    attempt().then(
      (ok) => {
        inFlight = false;
        if (!active) return;
        if (ok) {
          active = false;
          disarm();
          ctx.recovered();
        } else arm();
      },
      (e: unknown) => {
        inFlight = false;
        ctx.log('warn', `retry failed: ${e instanceof Error ? e.message : String(e)}`);
        arm();
      },
    );
  };

  ctx.signal.addEventListener('abort', () => {
    active = false;
    disarm();
  });
  arm();

  return {
    kick: () => {
      if (!active) return;
      disarm();
      run();
    },
    cancel: () => {
      active = false;
      disarm();
    },
    get active(): boolean {
      return active;
    },
  };
}
