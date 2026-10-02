/**
 * System and administration calls of the I/O layer (syscall-abi.md §4.4.11): `bootlog` (with
 * `--critical-path`, BOOT-11), `svc.status`, `svc.restart`, `users.list`, `shutdown`, `reboot`,
 * `auth.logout` and `auth.lock`.
 */
import type { ServiceManager, ServiceState } from '@plotinium/services';
import type { RetOf } from '@plotinium/protocol';
import type { GroupRec } from '@plotinium/vfs';

import { KernelError } from '../errors.ts';
import type { KernelFs } from '../fs/kfs.ts';
import type { HandlerRegistry } from '../ipc/handlers.ts';
import type { Caller } from '../ipc/ports.ts';
import type { BootRecorder } from './bootlog.ts';
import { BOOT_RECORDS_KEPT } from './bootlog.ts';
import type { ConsoleSession } from './login.ts';
import type { PowerAction, RebootNext } from './types.ts';

type SvcState = RetOf<'svc.status'>['services'][number]['state'];

const STATE: Readonly<Record<ServiceState, SvcState>> = {
  pending: 'stopped',
  blocked: 'degraded',
  starting: 'starting',
  running: 'running',
  degraded: 'degraded',
  failed: 'failed',
  'retry-wait': 'failed',
  skipped: 'stopped',
  stopping: 'stopped',
  stopped: 'stopped',
};

export interface SystemCallDeps {
  readonly recorder: BootRecorder;
  readonly services: () => ServiceManager | null;
  readonly fs: () => KernelFs | null;
  readonly console: () => ConsoleSession | null;
  readonly epochMs: () => number;
  readonly now: () => number;
  /** Arm a one-shot kernel timer. */
  readonly after: (ms: number, fn: () => void) => void;
  /** BOOT-12 then halt (the host). */
  readonly power: (kind: PowerAction, next: RebootNext) => void;
  readonly logout: () => Promise<void>;
  readonly lock: () => void;
}

/** Who may power the machine off: root, or the console user (the one at the desktop). */
function mayPower(c: Caller, s: ConsoleSession | null): boolean {
  return c.pcb.cred.uid === 0 || (s !== null && c.pcb.cred.ruid === s.uid);
}

export function registerSystemSyscalls(reg: HandlerRegistry, d: SystemCallDeps): void {
  reg.register('bootlog', {
    handle: async (_c, a) => {
      const rec = a.boot === 'previous' ? await d.recorder.previous() : d.recorder.current;
      if (rec === null && a.boot === 'previous')
        throw new KernelError('ENOENT', undefined, 'no previous boot is recorded');
      // The current boot answers from its timeline, frozen at desktop-interactive (UI-135).
      const entries = a.boot === 'previous' ? (rec?.log ?? []) : d.recorder.timeline();
      const cur = d.recorder.current;
      const totalMs =
        a.boot === 'previous'
          ? (rec?.bootMs ?? 0)
          : (cur?.bootMs ?? Math.round(d.recorder.secs(d.now()) * 1_000));
      const boots =
        a.list === true
          ? (await d.recorder.records()).slice(0, BOOT_RECORDS_KEPT).map((r) => ({
              seq: r.seq,
              at: Math.max(0, r.t0),
              profile: r.profile,
              outcome: r.outcome,
              bootMs: r.bootMs,
              build: r.build.build.slice(0, 32),
              reachedLogin: r.loginAt !== undefined || r.interactiveAt !== null,
              current: r.bootId === cur?.bootId,
            }))
          : undefined;
      return {
        ...(boots === undefined ? {} : { boots }),
        entries: entries.map((e) => ({
          t: e.t,
          sub: e.sub.slice(0, 32),
          level: e.level,
          msg: e.msg.slice(0, 1_024),
        })),
        ...(a.criticalPath === true && a.boot !== 'previous'
          ? { criticalPath: d.recorder.criticalPath().map((r) => r.name) }
          : {}),
        totalMs: Math.max(0, totalMs),
      };
    },
  });

  reg.register('svc.status', {
    handle: () => {
      const mgr = d.services();
      if (mgr === null) return { services: [] };
      return {
        services: mgr.status().map((s) => ({
          name: s.name,
          state: STATE[s.state],
          critical: s.critical,
          ...(s.pid === null ? {} : { pid: s.pid }),
          restarts: s.attempts,
          ...(s.reason === null ? {} : { lastError: s.reason.slice(0, 256) }),
        })),
      };
    },
  });

  reg.register('svc.restart', {
    handle: (_c, a) => {
      const mgr = d.services();
      if (mgr === null)
        throw new KernelError(
          'EAGAIN',
          { reason: 'starting' },
          'the service manager is not running',
        );
      if (mgr.stateOf(a.name) === undefined)
        throw new KernelError('ENOENT', undefined, `no service ${a.name}`);
      // Failed: start again; degraded: stop and start again, or retry the degraded requirement
      // it inherits (UI-075).
      if (mgr.retryNow(a.name).outcome !== 'restarted')
        throw new KernelError('EINVAL', { reason: 'state' }, `${a.name} is not failed or degraded`);
      return {};
    },
  });

  reg.register('users.list', {
    handle: async () => {
      const fs = d.fs();
      if (fs === null) return { users: [], groups: [] };
      const groups: { gid: number; name: string }[] = [];
      await fs.store.scan<GroupRec>('groups', null, (g) => {
        groups.push({ gid: g.gid, name: g.name });
      });
      // The console account's groups by the server's names (`/api/auth/me`), for gids this device
      // has no group row for: `id` says `300(examiners)`, not `300(300)` (UI-012).
      for (const g of d.console()?.me?.groups ?? []) {
        if (groups.some((x) => x.gid === g.gid) || !/^[a-z_][a-z0-9_-]{0,31}$/.test(g.name))
          continue;
        groups.push({ gid: g.gid, name: g.name });
      }
      const users = [...fs.tree.users.values()]
        .sort((a, b) => a.uid - b.uid)
        .map((u) => ({
          uid: u.uid,
          name: u.username,
          gid: u.gid,
          home: u.uid === 0 ? '/root' : `/home/${u.username}`,
          groups: [...u.groups],
        }));
      return { users, groups: groups.sort((a, b) => a.gid - b.gid) };
    },
  });

  const schedule = (
    c: Caller,
    kind: PowerAction,
    next: RebootNext,
    delayMs: number | undefined,
  ): { scheduledAt: number } => {
    if (!mayPower(c, d.console()))
      throw new KernelError('EPERM', { reason: 'owner' }, 'only the console user or root');
    const ms = delayMs ?? 0;
    d.after(ms, () => {
      d.power(kind, next);
    });
    return { scheduledAt: Math.floor(d.epochMs()) + ms };
  };

  reg.register('shutdown', {
    handle: (c, a) => schedule(c, 'poweroff', 'normal', a.delayMs),
  });

  reg.register('reboot', {
    handle: (c, a) =>
      schedule(
        c,
        'reboot',
        a.menu === true ? 'menu' : a.safe === true ? 'safe' : 'normal',
        a.delayMs,
      ),
  });

  reg.register('auth.logout', {
    handle: async (c) => {
      if (!mayPower(c, d.console()))
        throw new KernelError('EPERM', { reason: 'owner' }, 'not the console session');
      await d.logout();
      return {};
    },
  });

  reg.register('auth.lock', {
    handle: (c) => {
      if (!mayPower(c, d.console()))
        throw new KernelError('EPERM', { reason: 'owner' }, 'not the console session');
      d.lock();
      return {};
    },
  });
}
