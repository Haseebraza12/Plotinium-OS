/**
 * Loads the facts of About Plotinium through system calls (all origin EV, so a view port can make
 * them): `uname`, `proc.cred`, `sysctl.get` (the memory budget), `mem.stat`, `statfs`, `quota`
 * and `net.status` (whether the update service runs).
 * Each call may fail on its own; the model then says "unknown" for that fact instead of inventing
 * one (identity-and-branding.md I-1: one BuildIdentity for every surface).
 */
import type { UnameInfo } from '@plotinium/protocol';
import type { AboutModel } from '@plotinium/ui/apps/settings';

import type { AppEnv, AppSys } from '../src/descriptor.ts';
import { trySys } from '../src/descriptor.ts';
import { toAboutModel } from './model.ts';

const MIB = 1024 * 1024;

export interface AboutState {
  readonly model: AboutModel;
  readonly uname: UnameInfo | null;
  /** Why uname failed, when it did. */
  readonly unameError?: string;
}

/**
 * The memory budget in bytes from `sysctl.get` values (`mm.budget` bytes or `mm.budgetMB`). The
 * kernel reports 0 while the memory manager is not running: that is unknown, not a 0 MB budget.
 */
export function budgetFromSysctl(
  values: Readonly<Record<string, string | number | boolean>>,
): number | null {
  const bytes = values['mm.budget'];
  if (typeof bytes === 'number' && Number.isFinite(bytes) && bytes > 0) return bytes;
  const mb = values['mm.budgetMB'];
  if (typeof mb === 'number' && Number.isFinite(mb) && mb > 0) return mb * MIB;
  return null;
}

export async function loadAbout(
  sys: AppSys,
  env: Pick<AppEnv, 'identity' | 'team' | 'user'>,
  updateAvailable: string | null = null,
): Promise<AboutState> {
  const [uname, cred, sysctl, stat, statfs, quota, net] = await Promise.all([
    trySys(sys, 'uname', {}),
    trySys(sys, 'proc.cred', {}),
    trySys(sys, 'sysctl.get', {}),
    trySys(sys, 'mem.stat', {}),
    trySys(sys, 'statfs', {}),
    trySys(sys, 'quota', {}),
    trySys(sys, 'net.status', {}),
  ]);
  const budget = stat.ok
    ? stat.value.budget
    : sysctl.ok
      ? budgetFromSysctl(sysctl.value.values)
      : null;
  const user = cred.ok
    ? { name: cred.value.user, uid: cred.value.uid }
    : env.user === undefined
      ? null
      : { name: env.user.name, uid: env.user.uid };
  const model = toAboutModel({
    identity: env.identity,
    ...(env.team === undefined ? {} : { team: env.team }),
    uname: uname.ok ? uname.value : null,
    budgetBytes: budget,
    storage: statfs.ok
      ? {
          localBytes: statfs.value.usageBytes,
          cloudBytes: quota.ok && quota.value.source === 'server' ? quota.value.usedBytes : null,
        }
      : null,
    user,
    updateAvailable,
    updateServiceDown: net.ok && net.value.degraded.includes('update'),
  });
  return uname.ok
    ? { model, uname: uname.value }
    : { model, uname: null, unameError: uname.message };
}
