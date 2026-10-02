/**
 * A fake kernel for the dev harness and the shell tests: it speaks the compositor-port protocol
 * of window-manager.md §4.3 (the shape kernel/src/core/window/service.ts implements) on an
 * in-memory port pair, so the shell runs its real path (launch → `create` → window, close button
 * → `closeRequested` → `close`) without a worker. It also serves kernel event batches through a
 * `subscribe` feed. Framework-free; timers are injectable so tests run synchronously.
 */
import type { KEvent, Topic } from '@plotinium/protocol';

import type { AppRegistry, PortLike } from '../env.ts';

export interface FakeKernelOptions {
  readonly apps: AppRegistry;
  /** Window titles by app id (defaults to the registry title). */
  readonly titles?: Readonly<Record<string, string>>;
  /** Delay between `launch` and `create` (a process start); 0 answers synchronously. */
  readonly launchDelayMs?: number;
  readonly now?: () => number;
  readonly schedule?: (fn: () => void, ms: number) => void;
}

export interface FakeKernel {
  /** The shell's end of the compositor port (`kernel.compositorPort`). */
  readonly port: PortLike;
  /** Every message the shell posted, in order (tests read it). */
  readonly sent: unknown[];
  /** Post a kernel → compositor message (`create`, `focus`, `notify`, `events`, …). */
  emit(msg: unknown): void;
  /** Publish one event to `subscribe` listeners (at most one batch per call). */
  publish<T extends Topic>(topic: T, data: KEvent<T>['data']): void;
  /** The `kernel.subscribe` feed. */
  subscribe(fn: (batch: readonly KEvent[]) => void): () => void;
  /** Launch requests the fake kernel answered, oldest first. */
  readonly launched: { app: string; argv: readonly string[] }[];
  /** The last window id handed out. */
  readonly lastWid: number;
}

function rec(x: unknown): Record<string, unknown> | null {
  return x !== null && typeof x === 'object' ? (x as Record<string, unknown>) : null;
}

export function createFakeKernel(opts: FakeKernelOptions): FakeKernel {
  const now = opts.now ?? (() => Date.now());
  const schedule =
    opts.schedule ??
    ((fn: () => void, ms: number) => {
      if (ms <= 0) fn();
      else setTimeout(fn, ms);
    });
  const delay = opts.launchDelayMs ?? 0;
  const sent: unknown[] = [];
  const launched: { app: string; argv: readonly string[] }[] = [];
  const listeners = new Set<(batch: readonly KEvent[]) => void>();
  let wid = 0;
  let pid = 40;
  let seq = 0;
  let eventSeq = 0;
  const open = new Set<number>();

  const port: PortLike = {
    onmessage: null,
    postMessage: (m: unknown) => {
      sent.push(m);
      handle(m);
    },
  };

  const emit = (msg: unknown): void => {
    port.onmessage?.(new MessageEvent('message', { data: msg }));
  };

  function handle(m: unknown): void {
    const r = rec(m);
    if (r === null) return;
    switch (r['t']) {
      case 'launch': {
        const app = typeof r['app'] === 'string' ? r['app'] : '';
        const argv = Array.isArray(r['argv'])
          ? r['argv'].filter((a): a is string => typeof a === 'string')
          : [];
        launched.push({ app, argv });
        const entry = opts.apps.get(app);
        if (entry === undefined) return;
        schedule(() => {
          wid += 1;
          pid += 1;
          seq += 1;
          open.add(wid);
          emit({
            t: 'create',
            wid,
            pid,
            app,
            title: opts.titles?.[app] ?? entry.title,
            icon: `app-${app}`,
            seq,
            activation: true,
            argv,
          });
        }, delay);
        return;
      }
      case 'closeRequested':
      case 'kill': {
        const w = r['wid'];
        if (typeof w !== 'number' || !open.has(w)) return;
        open.delete(w);
        seq += 1;
        emit({ t: 'close', wid: w, seq });
        return;
      }
      default:
        return;
    }
  }

  return {
    port,
    sent,
    emit,
    launched,
    get lastWid(): number {
      return wid;
    },
    publish(topic, data) {
      eventSeq += 1;
      const e = { topic, seq: eventSeq, t: now(), data } as KEvent;
      for (const fn of listeners) fn([e]);
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}
