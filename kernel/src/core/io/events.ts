/**
 * `sys.subscribe` and `sys.events` for processes (syscall-abi.md §3.8, §4.4.9; ABI-07; UI-049).
 *
 * A process subscribes to topic patterns and gets a descriptor; `sys.events` reads up to `max`
 * events from it, blocking until one arrives or `timeoutMs` passes (ETIMEDOUT; 0 = poll). The bus
 * filters every event by the subscriber's credentials at publish time (the VFS hook for `vfs.*`),
 * so a process only ever sees what its uid may see. With `path`, `vfs.*` events are further limited
 * to that subtree (the directory must exist and be searchable: ENOENT, EACCES). Subscriptions end
 * with the process; a blocked read then fails ECANCELED.
 *
 * The AI indexer daemon (`ai.indexer`, rag-semantic-search.md §3.1) is the first user: without
 * these calls it crashed at start and nothing was ever indexed (UI-049). Views keep receiving their
 * desktop events from the window service; a view's `sys.subscribe` answers ENOSYS here, as before.
 */
import type { KEvent } from '@plotinium/protocol';
import { EVENTS_READ_MAX, FD_TABLE_SIZE } from '@plotinium/protocol';
import { X, may } from '@plotinium/vfs';

import type { EventBus, Subscription } from '../events/bus.ts';
import { KernelError } from '../errors.ts';
import { actorOf } from '../fs/kfs.ts';
import type { KernelFs } from '../fs/kfs.ts';
import type { HandlerRegistry } from '../ipc/handlers.ts';

/** Subscriptions one process may hold. */
export const SUBSCRIPTIONS_PER_PROCESS_MAX = 16;
/**
 * Descriptors of subscriptions: the top of the fd range (`Fd` is 0..FD_TABLE_SIZE − 1), clear of
 * file descriptors, which are allocated lowest-first and hit EMFILE at 256 per process.
 */
export const SUBSCRIPTION_FD_BASE = FD_TABLE_SIZE - SUBSCRIPTIONS_PER_PROCESS_MAX;

interface Sub {
  readonly pid: number;
  readonly fd: number;
  readonly bus: Subscription;
  /** The subtree `vfs.*` events are limited to (its directory ino), if any. */
  readonly scope: string | null;
  wake: (() => void) | null;
}

export interface EventSyscallDeps {
  readonly bus: EventBus;
  readonly fs: () => KernelFs | null;
  /** Arm a one-shot kernel timer; returns its cancel function. */
  readonly after: (ms: number, fn: () => void) => () => void;
}

export interface EventSyscalls {
  /** Kill path: drop the process's subscriptions and fail its blocked read (ECANCELED). */
  releaseAll(pid: number): void;
  /** Open subscriptions (tests, diagnostics). */
  readonly count: number;
}

/** The directories a `vfs.*` event concerns (to test them against a subscription's subtree). */
export function eventDirs(ev: KEvent): string[] {
  const d = ev.data as Readonly<Record<string, unknown>>;
  const out: string[] = [];
  for (const k of ['parent', 'fromParent', 'toParent', 'root'])
    if (typeof d[k] === 'string') out.push(d[k]);
  return out;
}

/** Whether directory `dir` is `root` or below it, by the loaded tree's parent links. */
export function underDir(fs: KernelFs, dir: string, root: string): boolean {
  let cur: string | undefined = dir;
  for (let depth = 0; cur !== undefined && depth < 4_096; depth++) {
    if (cur === root) return true;
    const e = fs.tree.dirEntry(cur);
    if (e === undefined || e.parent === cur) return false;
    cur = e.parent;
  }
  return false;
}

export function registerEventSyscalls(reg: HandlerRegistry, d: EventSyscallDeps): EventSyscalls {
  const subs = new Map<string, Sub>();
  const key = (pid: number, fd: number): string => `${String(pid)}:${String(fd)}`;

  const inScope = (s: Sub, ev: KEvent): boolean => {
    if (s.scope === null || !ev.topic.startsWith('vfs.')) return true;
    const fs = d.fs();
    if (fs === null) return true;
    const dirs = eventDirs(ev);
    return dirs.length === 0 || dirs.some((dir) => underDir(fs, dir, s.scope ?? ''));
  };

  /** Up to `max` events of `s` in its subtree (out-of-scope ones are consumed and skipped). */
  const takeScoped = (s: Sub, max: number): { events: KEvent[]; dropped: number } => {
    let dropped = 0;
    const events: KEvent[] = [];
    while (events.length < max && s.bus.pending > 0) {
      const r = s.bus.take(max - events.length);
      dropped += r.dropped;
      for (const ev of r.events) if (inScope(s, ev)) events.push(ev);
    }
    return { events, dropped };
  };

  reg.register('sys.subscribe', {
    handle: async (c, a) => {
      if (c.origin === 'V')
        throw new KernelError('ENOSYS', undefined, 'views receive events from their window');
      const pid = c.pcb.pid;
      const mine = [...subs.values()].filter((s) => s.pid === pid);
      if (mine.length >= SUBSCRIPTIONS_PER_PROCESS_MAX)
        throw new KernelError('EMFILE', undefined, 'too many subscriptions');
      let scope: string | null = null;
      if (a.path !== undefined) {
        const fs = d.fs();
        if (fs === null) throw new KernelError('ENOENT', { path: a.path }, 'no file system');
        const actor = actorOf(c.pcb);
        const r = await fs.resolvePath(actor, a.path, { follow: true });
        const node = r.node;
        if (node === null || node === undefined)
          throw new KernelError('ENOENT', { path: a.path }, 'no such directory');
        if (node.type !== 'd') throw new KernelError('EINVAL', { path: a.path }, 'not a directory');
        if (!may(actor.cred, node, X))
          throw new KernelError('EACCES', { path: a.path }, 'permission denied');
        scope = node.ino;
      }
      let fd = SUBSCRIPTION_FD_BASE;
      while (subs.has(key(pid, fd))) fd++;
      const { uid, gid, groups } = c.pcb.cred;
      const s: Sub = {
        pid,
        fd,
        scope,
        wake: null,
        bus: d.bus.subscribe([...a.topics], {
          cred: { uid, gid, groups: [...groups] },
          onReady: () => {
            const w = s.wake;
            s.wake = null;
            w?.();
          },
        }),
      };
      subs.set(key(pid, fd), s);
      return { fd };
    },
  });

  reg.register('sys.events', {
    handle: async (c, a) => {
      const s = subs.get(key(c.pcb.pid, a.fd));
      if (s === undefined) throw new KernelError('EBADF', undefined, 'not a subscription');
      const max = a.max ?? EVENTS_READ_MAX;
      const timeoutMs = a.timeoutMs;
      for (;;) {
        const got = takeScoped(s, max);
        if (got.events.length > 0 || got.dropped > 0 || timeoutMs === 0) return got;
        const woke = await new Promise<'ready' | 'timeout' | 'gone'>((resolve) => {
          const cancel =
            timeoutMs === undefined
              ? () => undefined
              : d.after(timeoutMs, () => {
                  s.wake = null;
                  resolve('timeout');
                });
          s.wake = () => {
            cancel();
            resolve(s.bus.closed ? 'gone' : 'ready');
          };
        });
        if (woke === 'timeout') throw new KernelError('ETIMEDOUT', undefined, 'no event in time');
        if (woke === 'gone') throw new KernelError('ECANCELED', undefined, 'subscription closed');
      }
    },
  });

  return {
    releaseAll: (pid) => {
      for (const [k, s] of [...subs]) {
        if (s.pid !== pid) continue;
        subs.delete(k);
        d.bus.unsubscribe(s.bus);
        const w = s.wake;
        s.wake = null;
        w?.();
      }
    },
    get count() {
      return subs.size;
    },
  };
}
