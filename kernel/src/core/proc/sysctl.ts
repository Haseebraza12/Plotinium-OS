/**
 * `sysctl.get` / `sysctl.set` (syscall-abi.md §4.4.11): a table of kernel parameters. The
 * scheduler keys (`sched.quantum.*`, `sched.tAge`, processes-and-scheduling.md §4.5) and the
 * memory keys (`mm.budget`, `mm.softLimit`, `mm.swap.tier`, memory-and-paging.md §4.6) are
 * defined here; other subsystems add theirs with `define`. Session keys (`ui.*`, `mm.*`,
 * `sched.*`, `boot.showMenuNextBoot`) need no capability; every other key needs `sys.admin`
 * (the registry's `capsFor`). An undefined session key is stored as a plain value so Settings can
 * keep UI preferences; an undefined global key is EINVAL.
 */
import { isSessionSysctlKey } from '@plotinium/protocol';

import { KernelError } from '../errors.ts';
import type { HandlerRegistry } from '../ipc/handlers.ts';
import { applySysctl, SCHED_SYSCTL_KEYS } from '../sched/params.ts';
import type { SchedSysctlKey } from '../sched/params.ts';
import type { ProcessSystem } from './system.ts';
import { toKernelError } from './system.ts';

export type SysctlValue = string | number | boolean;

export interface SysctlKey {
  get(): SysctlValue;
  /** Validate and apply; throw KernelError EINVAL on a bad value. */
  set(value: SysctlValue): void;
}

export class SysctlTable {
  private readonly keys = new Map<string, SysctlKey>();
  private readonly plain = new Map<string, SysctlValue>();

  define(key: string, impl: SysctlKey): void {
    this.keys.set(key, impl);
  }

  get(key: string): SysctlValue | undefined {
    return this.keys.get(key)?.get() ?? this.plain.get(key);
  }

  all(): Record<string, SysctlValue> {
    const out: Record<string, SysctlValue> = {};
    for (const [k, v] of this.plain) out[k] = v;
    for (const [k, impl] of this.keys) out[k] = impl.get();
    return out;
  }

  set(key: string, value: SysctlValue): { old: SysctlValue | null; value: SysctlValue } {
    const impl = this.keys.get(key);
    if (impl !== undefined) {
      const old = impl.get();
      impl.set(value);
      return { old, value: impl.get() };
    }
    if (!isSessionSysctlKey(key)) throw new KernelError('EINVAL', undefined, `unknown key ${key}`);
    const old = this.plain.get(key) ?? null;
    this.plain.set(key, value);
    return { old, value };
  }
}

function num(v: SysctlValue): number {
  if (typeof v !== 'number' || !Number.isFinite(v))
    throw new KernelError('EINVAL', undefined, 'a number is required');
  return v;
}

/** The scheduler and memory keys on `sys`. */
export function defineProcSysctls(t: SysctlTable, sys: ProcessSystem, now: () => number): void {
  for (const key of SCHED_SYSCTL_KEYS) {
    t.define(key, {
      get: () => {
        const p = sys.sched.params;
        if (key === 'sched.tAge') return p.tAgeMs;
        const band =
          key === 'sched.quantum.interactive'
            ? 'interactive'
            : key === 'sched.quantum.normal'
              ? 'normal'
              : 'background';
        return p.quantumMs[band];
      },
      set: (v) => {
        const r = applySysctl(sys.sched.params, key satisfies SchedSysctlKey, num(v));
        if (!r.ok) throw new KernelError('EINVAL', undefined, r.reason);
        sys.sched.setParams(r.params, now());
        sys.watchdog.setParams(r.params);
      },
    });
  }
  const mm = (): NonNullable<ProcessSystem['mm']> => {
    const m = sys.mm;
    if (m === null)
      throw new KernelError('EAGAIN', { reason: 'not-idle' }, 'the memory manager is not running');
    return m;
  };
  const guard = (f: () => void): void => {
    try {
      f();
    } catch (e) {
      throw toKernelError(e);
    }
  };
  t.define('mm.budget', {
    get: () => sys.mm?.budget ?? 0,
    set: (v) => {
      guard(() => {
        mm().setBudget(num(v));
      });
    },
  });
  // The manager keeps the default soft limit private: remember the value that was set.
  let softLimit: number | null = null;
  t.define('mm.softLimit', {
    get: () => (sys.mm === null ? 0 : (softLimit ?? sys.mm.params.softLimit)),
    set: (v) => {
      guard(() => {
        const bytes = num(v);
        mm().setSoftLimit(bytes);
        softLimit = bytes;
      });
    },
  });
  t.define('mm.swap.tier', {
    get: () => sys.mm?.swapTier ?? 'auto',
    set: (v) => {
      if (v !== 'auto' && v !== 'local' && v !== 'remote')
        throw new KernelError('EINVAL', undefined, 'auto, local or remote');
      mm().setTier(v);
    },
  });
}

export function registerSysctlSyscalls(reg: HandlerRegistry, t: SysctlTable): void {
  reg.register('sysctl.get', {
    handle: (_c, args) => {
      if (args.key === undefined) return { values: t.all() };
      const v = t.get(args.key);
      if (v === undefined) throw new KernelError('EINVAL', undefined, `unknown key ${args.key}`);
      return { values: { [args.key]: v } };
    },
  });
  reg.register('sysctl.set', {
    handle: (_c, args) => t.set(args.key, args.value),
    securityRelevant: (_c, args) => !isSessionSysctlKey(args.key),
  });
}
