/**
 * Graceful shutdown (C6, C9; backend-api.md §3.17, §5.5; SRV-16). About 20 lines, replacing
 * close-with-grace. On the FIRST SIGTERM or SIGINT:
 *   1. drain: /api/readyz answers 503 'draining'; new WebSocket upgrades get 503;
 *   2. close: fastify.close() stops accepting connections, lets in-flight requests and
 *      transactions finish, runs onClose hooks (sockets get `bye restart` + close 1012 once the
 *      sync plugin lands; leases stay in the database), ends the pool;
 *   3. exit 0; if anything still runs after SHUTDOWN_GRACE_MS, exit 1.
 * A second signal during draining is ignored; a third forces exit 1.
 */
export interface ShutdownOptions {
  readonly graceMs: number;
  readonly drain: () => void;
  readonly close: () => Promise<void>;
  readonly exit: (code: number) => void;
  readonly log: (msg: string, fields?: Record<string, unknown>) => void;
  readonly setTimer?: (fn: () => void, ms: number) => { unref?: () => unknown };
}

export function createShutdownHandler(options: ShutdownOptions): (signal: string) => void {
  let signals = 0;
  const setTimer = options.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  return (signal: string) => {
    signals++;
    if (signals === 2) {
      options.log('shutdown already in progress; send the signal again to force exit', { signal });
      return;
    }
    if (signals >= 3) {
      options.log('forced exit', { signal });
      options.exit(1);
      return;
    }
    options.log('shutdown: draining', { signal, graceMs: options.graceMs });
    options.drain();
    const timer = setTimer(() => {
      options.log('shutdown: grace period exceeded', { graceMs: options.graceMs });
      options.exit(1);
    }, options.graceMs);
    timer.unref?.();
    options.close().then(
      () => {
        options.log('shutdown: complete');
        options.exit(0);
      },
      (err: unknown) => {
        options.log('shutdown: close failed', { err: String(err) });
        options.exit(1);
      },
    );
  };
}
