/**
 * The op lane of one connection (offline-and-sync.md §3.6, §3.9, §5.3; SYN-02, SYN-06; AGT-09).
 *
 *   enqueue(ops): if unanswered + ops > creditWindow: error {code: 'limit'}  (a correct client never
 *                 exceeds the window it was advertised; the op.batch schema caps a frame at 32)
 *   run():        ops are applied ONE AT A TIME in arrival order, each in its own vfsTxn; ops of
 *                 different connections run concurrently (the L0-L4 lock order makes that safe)
 *   retry:        when an op gets `retry`, every op queued behind it is answered `retry`
 *                 `predecessor-retry` WITHOUT executing (nothing persisted), so later ops never run
 *                 out of order (a write into a file whose create is being retried)
 *   proc.signal:  a queued op is removed and recorded as rejected ECANCELED `killed`; the running op
 *                 gets its AbortSignal aborted and its statement cancelled (pg_cancel_backend);
 *                 an op that already committed is unaffected
 * The control lane never waits behind this queue (lock grants stay fast during a long rm -r).
 */
import type { OpResult, OpSubmit } from '@plotinium/protocol';

import { retry } from './outcome.ts';

export interface LaneDeps {
  /** Ops in flight without an op.result (advertised in hello.ok.limits.creditWindow). */
  readonly creditWindow: number;
  /** The engine: steps 1-8 of §3.10. May throw a ProtocolViolation (the connection closes). */
  apply(submit: OpSubmit, signal: AbortSignal): Promise<OpResult>;
  /** Records a queued op killed before it ran (rejected ECANCELED killed, persisted). */
  rejectKilled(submit: OpSubmit): Promise<OpResult>;
  /** Marks the op cancelled in the cancel registry and cancels its running statement. */
  cancelRunning(opId: string): void;
  /** Sends one op.result (on the origin connection only). */
  reply(result: OpResult): void;
  /** The engine threw something other than an op.result (a protocol violation). */
  fail(err: unknown): void;
  /** The server Lamport value for synthetic replies. */
  lamport(): number;
}

interface Item {
  readonly submit: OpSubmit;
  readonly controller: AbortController;
  /**
   * Where this op's result goes when it did not arrive on the socket: `POST /api/ops/{opId}`
   * joins the lane of its OS session and gets its result in the HTTP response, never on the
   * socket (backend-api.md §3.6.2).
   */
  readonly reply: ((r: OpResult) => void) | null;
}

export type EnqueueResult = 'queued' | 'limit' | 'closed';
export type SignalResult = 'queued-killed' | 'running-cancelled' | 'unknown';

export class OpLane {
  readonly #d: LaneDeps;
  #queue: Item[] = [];
  #running: Item | null = null;
  #loop: Promise<void> | null = null;
  #closed = false;
  #draining = false;

  constructor(deps: LaneDeps) {
    this.#d = deps;
  }

  /** Ops sent by the client that have no op.result yet (queued + running). */
  get unanswered(): number {
    return this.#queue.length + (this.#running === null ? 0 : 1);
  }

  get running(): string | null {
    return this.#running?.submit.opId ?? null;
  }

  /** `reply` routes the results of these ops elsewhere (an HTTP response) instead of the socket. */
  enqueue(ops: readonly OpSubmit[], reply: ((r: OpResult) => void) | null = null): EnqueueResult {
    if (this.#closed || this.#draining) return 'closed';
    if (this.unanswered + ops.length > this.#d.creditWindow) return 'limit';
    for (const submit of ops)
      this.#queue.push({ submit, controller: new AbortController(), reply });
    this.#loop ??= this.#run().finally(() => {
      this.#loop = null;
    });
    return 'queued';
  }

  /** proc.signal {target: {kind: 'op', opId}} for an op of this lane. */
  signal(opId: string): SignalResult {
    const i = this.#queue.findIndex((q) => q.submit.opId === opId);
    if (i >= 0) {
      const [item] = this.#queue.splice(i, 1);
      if (item !== undefined) {
        void this.#d.rejectKilled(item.submit).then(
          (r) => this.#answer(item, r),
          (err: unknown) => this.#d.fail(err),
        );
      }
      return 'queued-killed';
    }
    if (this.#running?.submit.opId === opId) {
      this.#d.cancelRunning(opId);
      this.#running.controller.abort();
      return 'running-cancelled';
    }
    return 'unknown';
  }

  /**
   * The connection is gone: queued ops are dropped without a reply (the client resends them; L0
   * deduplicates), the running op finishes. Resolves when the running op has finished.
   */
  close(): Promise<void> {
    this.#closed = true;
    this.#dropQueued();
    return this.#loop ?? Promise.resolve();
  }

  /**
   * Graceful shutdown (backend-api.md §3.17): stop taking new ops, drop the queued ones (they are
   * resent after the reconnect), let the running op finish AND answer it. Resolves when it has.
   */
  drain(): Promise<void> {
    this.#draining = true;
    this.#dropQueued();
    return this.#loop ?? Promise.resolve();
  }

  /** Socket ops are simply resent; an HTTP request still waiting is answered `retry`. */
  #dropQueued(): void {
    const dropped = this.#queue;
    this.#queue = [];
    for (const q of dropped) {
      q.reply?.(retry(q.submit.opId, 'EIO', 'server', this.#d.lamport(), 1_000));
    }
  }

  #answer(item: Item, result: OpResult): void {
    if (item.reply !== null) item.reply(result);
    else if (!this.#closed) this.#d.reply(result);
  }

  async #run(): Promise<void> {
    for (;;) {
      const item = this.#queue.shift();
      if (item === undefined || this.#closed || this.#draining) return;
      this.#running = item;
      let result: OpResult;
      try {
        result = await this.#d.apply(item.submit, item.controller.signal);
      } catch (err) {
        this.#running = null;
        item.reply?.(retry(item.submit.opId, 'EIO', 'server', this.#d.lamport(), 1_000));
        this.#dropQueued();
        this.#d.fail(err);
        return;
      }
      this.#running = null;
      this.#answer(item, result);
      if (this.#closed) return;
      if (result.status === 'retry') {
        // Head-of-line (§3.9 step 6): nothing behind a retried op may run before it.
        const behind = this.#queue;
        this.#queue = [];
        for (const q of behind) {
          this.#answer(
            q,
            retry(
              q.submit.opId,
              'EAGAIN',
              'predecessor-retry',
              this.#d.lamport(),
              result.retryAfterMs,
            ),
          );
        }
      }
    }
  }
}
