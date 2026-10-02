/**
 * A fake view system-call client for the apps-sys tests (Task Manager, Settings, About): handlers
 * per call name, a call log, and `SysError`-shaped failures. A call without a handler rejects with
 * ENOSYS, as a kernel that does not implement it would.
 */
import type { ArgsIn, CallName, Errno, ProcInfo, RetOf } from '@plotinium/protocol';
import { strerror } from '@plotinium/protocol';

import type { AppSys } from '../../src/descriptor.ts';

export class FakeSysError extends Error {
  readonly errno: Errno;

  constructor(errno: Errno, message?: string) {
    super(message ?? strerror(errno));
    this.name = 'SysError';
    this.errno = errno;
  }
}

type Handler<C extends CallName> = (args: ArgsIn<C>) => RetOf<C> | Promise<RetOf<C>>;

export interface LoggedCall {
  readonly name: CallName;
  readonly args: unknown;
}

export class FakeSys implements AppSys {
  readonly log: LoggedCall[] = [];
  private readonly handlers = new Map<CallName, (args: unknown) => unknown>();

  on<C extends CallName>(name: C, handler: Handler<C>): this {
    this.handlers.set(name, handler as (args: unknown) => unknown);
    return this;
  }

  fail(name: CallName, errno: Errno, message?: string): this {
    this.handlers.set(name, () => {
      throw new FakeSysError(errno, message);
    });
    return this;
  }

  call<C extends CallName>(name: C, args: ArgsIn<C>): Promise<RetOf<C>> {
    this.log.push({ name, args });
    const handler = this.handlers.get(name);
    if (handler === undefined)
      return Promise.reject(new FakeSysError('ENOSYS', `${name}: not available here`));
    try {
      return Promise.resolve(handler(args) as RetOf<C>);
    } catch (e) {
      return Promise.reject(e instanceof Error ? e : new Error(String(e)));
    }
  }

  calls(name: CallName): unknown[] {
    return this.log.filter((c) => c.name === name).map((c) => c.args);
  }

  count(name: CallName): number {
    return this.calls(name).length;
  }
}

export const MB = 1024 * 1024;
export const T0 = Date.UTC(2026, 8, 26, 9, 0, 0);

/** A `proc.list` row with sensible defaults. */
export function proc(over: Partial<ProcInfo> & Pick<ProcInfo, 'pid'>): ProcInfo {
  return {
    ppid: 1,
    pgid: over.pid,
    uid: 1001,
    user: 'student',
    state: 'READY',
    class: 'user',
    waitingOn: null,
    priority: 20,
    nice: 0,
    effPrio: 20,
    cpuPct: 0,
    cpuTimeMs: 0,
    residentBytes: 0,
    swappedBytes: 0,
    faults: 0,
    hitRatio: 1,
    speculative: false,
    argv: [`proc${String(over.pid)}`],
    executor: 0,
    windows: [],
    startedAt: T0,
    ...over,
  };
}

/** A manual clock plus a timer queue, for controllers that poll. */
export class FakeTimers {
  t = T0;
  private seq = 0;
  private readonly queue = new Map<number, { at: number; fn: () => void }>();

  now(): number {
    return this.t;
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.seq;
    this.queue.set(id, { at: this.t + ms, fn });
    return id;
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle === 'number') this.queue.delete(handle);
  }

  get pending(): number {
    return this.queue.size;
  }

  /** Advance the clock and run due timers in order. */
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      const due = [...this.queue.entries()]
        .filter(([, v]) => v.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (due === undefined) break;
      this.queue.delete(due[0]);
      this.t = due[1].at;
      due[1].fn();
    }
    this.t = end;
  }
}

/** Let queued promise callbacks run. */
export async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}
