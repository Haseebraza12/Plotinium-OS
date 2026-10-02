/**
 * Network, sync and lock system calls (syscall-abi.md §4.4.7, §4.4.8): `net.status`,
 * `sync.flush`, `lock.acquire`, `lock.release`, `lock.status`. Processes never reach the network
 * themselves (§3.2.3): these calls talk to the kernel's syncd/lockd bridge or, without a server
 * layer, to the local advisory lease table.
 */
import type { PermSubject } from '@plotinium/vfs';
import { may } from '@plotinium/vfs';

import { KernelError } from '../errors.ts';
import { actorOf } from '../fs/kfs.ts';
import type { KernelFs } from '../fs/kfs.ts';
import type { HandlerRegistry } from '../ipc/handlers.ts';
import type { Caller } from '../ipc/ports.ts';
import type { LockEngine, SyncEngine } from './engines.ts';
import type { LocalLocks } from './locks.ts';
import type { NetMonitor } from './monitor.ts';

const R = 4;
const W = 2;

export interface NetSyscallDeps {
  readonly monitor: NetMonitor;
  readonly locks: LocalLocks;
  readonly fs: () => KernelFs | null;
  /** The linked engines (null without them). */
  readonly sync: () => SyncEngine | null;
  readonly lockEngine: () => LockEngine | null;
  /** `user@host` for lease holders. */
  readonly holder: (uid: number) => string;
  readonly epochMs: () => number;
  /** Arm a one-shot kernel timer; returns its cancel function. */
  readonly after: (ms: number, fn: () => void) => () => void;
  readonly leaseTtlMs: number;
}

async function target(
  d: NetSyscallDeps,
  c: Caller,
  a: { path?: string; fd?: number },
): Promise<{ ino: string; path: string; node: PermSubject }> {
  const fs = d.fs();
  if (fs === null)
    throw new KernelError('EBUSY', { reason: 'starting' }, 'file system not mounted');
  if (a.fd !== undefined) {
    const f = fs.fds.get(c.pcb.pid, a.fd);
    const node = fs.tree.inode(f.ino);
    if (node === undefined) throw new KernelError('ENOENT', undefined, 'file is gone');
    return { ino: f.ino, path: f.pathAtOpen, node };
  }
  const path = a.path ?? '';
  const r = await fs.resolvePath(actorOf(c.pcb), path, { follow: true });
  const node = r.node;
  if (node === null || node === undefined)
    throw new KernelError('ENOENT', undefined, 'no such file');
  return { ino: node.ino, path, node };
}

export interface NetSyscalls {
  /** Kill path (PROC-07): forget the server leases of `pid` (the local table is released apart). */
  releaseAll(pid: number): void;
}

export function registerNetSyscalls(reg: HandlerRegistry, d: NetSyscallDeps): NetSyscalls {
  /**
   * Local lease id → the server lease it is backed by (UI-006). Local arbitration always runs
   * first (every process on this device, EBUSY for a second local writer, the holder's own writes
   * never blocked: UI-002); with the server layer LIVE the lease is then also taken on the server,
   * so another session or device gets EBUSY too (VFS-09).
   */
  const serverLease = new Map<string, { readonly pid: number; readonly id: string }>();

  reg.register('net.status', { handle: () => d.monitor.status() });

  reg.register('sync.flush', {
    handle: async (_c, a) => {
      const engine = d.sync();
      if (engine === null) {
        const remaining = d.monitor.queuedOps;
        if (remaining === 0) return { remaining: 0 as const };
        throw new KernelError('EAGAIN', { reason: 'offline', remaining }, 'sync is not live');
      }
      await new Promise<void>((resolve, reject) => {
        const cancel = d.after(a.timeoutMs, () => {
          reject(
            new KernelError(
              'ETIMEDOUT',
              { remaining: d.monitor.queuedOps },
              'the outbox was not acknowledged in time',
            ),
          );
        });
        engine.idle().then(
          () => {
            cancel();
            resolve();
          },
          (e: unknown) => {
            cancel();
            reject(e instanceof KernelError ? e : new KernelError('EAGAIN', { reason: 'offline' }));
          },
        );
      });
      return { remaining: 0 as const };
    },
  });

  reg.register('lock.acquire', {
    handle: async (c, a) => {
      const t = await target(d, c, a);
      if (t.node.type === 'd')
        throw new KernelError('EISDIR', undefined, 'directories cannot be locked');
      const cred = actorOf(c.pcb).cred;
      if (!may(cred, t.node, a.mode === 'X' ? W : R))
        throw new KernelError('EACCES', { path: t.path }, 'permission denied');
      const lease = await d.locks.acquire({
        pid: c.pcb.pid,
        ino: t.ino,
        path: t.path,
        holder: d.holder(c.pcb.cred.uid),
        mode: a.mode,
        wait: a.wait,
        timeoutMs: a.timeoutMs,
      });
      const engine = d.lockEngine();
      if (engine !== null && engine.serverEngaged) {
        let g: Awaited<ReturnType<typeof engine.acquire>>;
        try {
          g = await engine.acquire({
            pid: c.pcb.pid,
            ino: t.ino,
            path: t.path,
            mode: a.mode,
            wait: a.wait,
            principal: c.pcb.cred.uid,
            ...(a.timeoutMs === undefined ? {} : { timeoutMs: a.timeoutMs }),
          });
        } catch (e) {
          d.locks.release(lease.leaseId, c.pcb.pid);
          throw e;
        }
        if (g.scope === 'server') serverLease.set(lease.leaseId, { pid: c.pcb.pid, id: g.leaseId });
        else void engine.release(g.leaseId, c.pcb.pid).catch(() => undefined);
        c.pcb.leases.add(lease.leaseId);
        return {
          leaseId: lease.leaseId,
          fence: g.fence ?? lease.fence,
          expiresAt: g.expiresAt ?? Math.floor(d.epochMs()) + d.leaseTtlMs,
          scope: g.scope,
        };
      }
      c.pcb.leases.add(lease.leaseId);
      return {
        leaseId: lease.leaseId,
        fence: lease.fence,
        expiresAt: Math.floor(d.epochMs()) + d.leaseTtlMs,
        scope: 'local' as const,
      };
    },
  });

  reg.register('lock.release', {
    handle: async (c, a) => {
      if (!c.pcb.leases.has(a.leaseId)) throw new KernelError('EINVAL', undefined, 'no such lease');
      const engine = d.lockEngine();
      if (d.locks.leasesOf(c.pcb.pid).some((l) => l.leaseId === a.leaseId))
        d.locks.release(a.leaseId, c.pcb.pid);
      const server = serverLease.get(a.leaseId);
      serverLease.delete(a.leaseId);
      if (server !== undefined && engine !== null)
        await engine.release(server.id, c.pcb.pid).catch(() => undefined);
      c.pcb.leases.delete(a.leaseId);
      return {};
    },
  });

  reg.register('lock.status', {
    handle: async (c, a) => {
      const t = await target(d, c, { path: a.path });
      const expiresAt = Math.floor(d.epochMs()) + d.leaseTtlMs;
      return {
        holders: d.locks.holders(t.ino).map((l) => ({
          path: l.path,
          holder: l.holder,
          mode: l.mode,
          expiresAt,
          scope: 'local' as const,
        })),
        queued: d.locks.queued(t.ino),
      };
    },
  });

  return {
    releaseAll: (pid) => {
      for (const [local, s] of [...serverLease]) if (s.pid === pid) serverLease.delete(local);
      d.lockEngine()?.releaseAll(pid);
    },
  };
}
