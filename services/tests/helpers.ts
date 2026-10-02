/**
 * Test doubles for the service manager: a manual kernel timer heap (a sorted array, test-only)
 * and controllable service implementations.
 */
import type {
  ManifestFile,
  ServiceImpl,
  ServiceManifest,
  ServiceName,
  StartResult,
} from '../src/index.ts';
import { BUILTIN_MANIFEST_FILES } from '../src/index.ts';
import type { KernelTimers } from '../src/types.ts';

export class FakeTimers implements KernelTimers {
  t = 0;
  private nextId = 1;
  private entries: { id: number; at: number; prio: number; fire: () => void }[] = [];

  at(deadlineMs: number, fire: () => void, priority = 0): number {
    const id = this.nextId++;
    this.entries.push({ id, at: deadlineMs, prio: priority, fire });
    return id;
  }

  cancel(handle: number): boolean {
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.id !== handle);
    return this.entries.length !== before;
  }

  now(): number {
    return this.t;
  }

  get armed(): number {
    return this.entries.length;
  }

  /** Move time forward, firing due timers in (deadline, priority, arm order) order. */
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      const due = this.entries
        .filter((e) => e.at <= end)
        .sort((a, b) => a.at - b.at || a.prio - b.prio || a.id - b.id)[0];
      if (!due) break;
      this.entries = this.entries.filter((e) => e !== due);
      this.t = Math.max(this.t, due.at);
      due.fire();
    }
    this.t = end;
  }
}

/** Let pending promise callbacks run. */
export async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise<void>((r) => setTimeout(r, 0));
}

export interface Controlled extends ServiceImpl {
  readonly starts: number;
  readonly stops: number;
  resolve(res?: StartResult): void;
  reject(e?: Error): void;
}

/** A service whose start settles only when the test says so. */
export function controlled(onStart?: () => void): Controlled {
  let resolveFn: ((r: StartResult) => void) | null = null;
  let rejectFn: ((e: Error) => void) | null = null;
  const c = {
    starts: 0,
    stops: 0,
    start() {
      c.starts++;
      onStart?.();
      return new Promise<StartResult>((res, rej) => {
        resolveFn = res;
        rejectFn = rej;
      });
    },
    stop() {
      c.stops++;
      return Promise.resolve();
    },
    resolve(res: StartResult = { status: 'running' }) {
      resolveFn?.(res);
    },
    reject(e = new Error('boom')) {
      rejectFn?.(e);
    },
  };
  return c;
}

/** A service that starts immediately. */
export function instant(
  res: StartResult = { status: 'running' },
  log?: string[],
  name?: string,
): ServiceImpl {
  return {
    start: () => Promise.resolve(res),
    stop: () => {
      if (log && name) log.push(name);
      return Promise.resolve();
    },
  };
}

export const builtin = (): ServiceManifest[] =>
  BUILTIN_MANIFEST_FILES.map((f) => f.json as ServiceManifest);

export function filesOf(manifests: readonly object[]): ManifestFile[] {
  return manifests.map((json) => ({ file: `${(json as { name: string }).name}.json`, json }));
}

export function registryOf(
  names: readonly ServiceName[],
  make: (name: ServiceName) => ServiceImpl,
): Map<ServiceName, ServiceImpl> {
  return new Map(names.map((n) => [n, make(n)] as const));
}
