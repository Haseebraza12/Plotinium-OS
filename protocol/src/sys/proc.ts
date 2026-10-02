/**
 * Processes and job control (syscall-abi.md §4.4.1; semantics in processes-and-scheduling.md).
 */
import * as v from 'valibot';

import { Cap, ProcClass } from '../caps.ts';
import { ARGV_ENV_MAX_BYTES, ARGV_MAX, PID_MAX, PROC_LIST_PAGE_MAX } from '../limits.ts';
import { SignalName } from '../signals.ts';
import {
  Count,
  Cursor,
  EpochMs,
  Fd,
  Gid,
  Ino,
  Nice,
  Path,
  Pid,
  PidOrZero,
  PState,
  Priority,
  Ratio,
  ShortText,
  Uid,
  Username,
  WaitStatus,
  Wid,
} from './common.ts';
import { LeaseInfo } from './fs.ts';

const encoder = new TextEncoder();
const utf8Bytes = (s: string): number => encoder.encode(s).length;

/** One argv entry. The whole argv plus env is limited to 60 KiB (checked on the object). */
export const Arg = v.pipe(v.string(), v.maxBytes(ARGV_ENV_MAX_BYTES));
export const Argv = v.pipe(v.array(Arg), v.maxLength(ARGV_MAX));
/** Environment variables: `NAME=value` pairs as a record (at most 256 entries). */
export const Env = v.pipe(
  v.record(
    v.pipe(v.string(), v.regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/)),
    v.pipe(v.string(), v.maxBytes(ARGV_ENV_MAX_BYTES)),
  ),
  v.maxEntries(256),
);

/** Total UTF-8 bytes of argv and env (`NAME=value` per entry), the 60 KiB rule of §4.4.1. */
export function argvEnvBytes(
  argv: readonly string[],
  env?: Readonly<Record<string, string>>,
): number {
  let total = 0;
  for (const a of argv) total += utf8Bytes(a);
  if (env) for (const [k, val] of Object.entries(env)) total += utf8Bytes(k) + 1 + utf8Bytes(val);
  return total;
}

export const SpawnArgs = v.pipe(
  v.strictObject({
    path: Path,
    argv: Argv,
    env: v.optional(Env),
    cwd: v.optional(Path),
    fds: v.optional(v.strictObject({ 0: v.optional(Fd), 1: v.optional(Fd), 2: v.optional(Fd) })),
    /** 0 = a new group with id = pid; otherwise an existing group of the caller's session. */
    pgid: v.optional(PidOrZero),
    priority: v.optional(Priority),
    nice: v.optional(Nice),
    dropCaps: v.optional(v.pipe(v.array(Cap), v.maxLength(32))),
  }),
  v.check((a) => argvEnvBytes(a.argv, a.env) <= ARGV_ENV_MAX_BYTES),
);
export const SpawnRet = v.strictObject({ pid: Pid });

export const ExitArgs = v.strictObject({
  code: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(255)),
});
/** `exit` never replies. */
export const ExitRet = v.never();

/** > 0: that child; -1: any child; < -1: any child in group |pid|. 0 is invalid. */
const WaitTarget = v.pipe(
  v.number(),
  v.integer(),
  v.minValue(-PID_MAX),
  v.maxValue(PID_MAX),
  v.check((pid) => pid !== 0),
);
export const WaitArgs = v.strictObject({
  pid: WaitTarget,
  nohang: v.optional(v.boolean()),
  untraced: v.optional(v.boolean()),
  continued: v.optional(v.boolean()),
});
export const WaitRet = v.union([
  v.strictObject({ pid: Pid, status: WaitStatus }),
  /** `nohang` and no child has changed state. */
  v.strictObject({ pid: v.literal(0) }),
]);

/** > 0: one process; < 0: the process group |pid|; 0: the caller's group. */
export const KillArgs = v.strictObject({
  pid: v.pipe(v.number(), v.integer(), v.minValue(-PID_MAX), v.maxValue(PID_MAX)),
  /** 0 only checks existence and permission (§3.9). */
  sig: v.union([SignalName, v.literal(0)]),
});
/** Number of processes the signal was delivered to (0 for signal 0). */
export const KillRet = v.strictObject({ delivered: Count });

export const GetpidArgs = v.strictObject({});
export const GetpidRet = v.strictObject({ pid: Pid, ppid: PidOrZero, pgid: Pid, sid: Pid });

export const ProcCredArgs = v.strictObject({});
export const ProcCredRet = v.strictObject({
  uid: Uid,
  gid: Gid,
  groups: v.pipe(v.array(Gid), v.maxLength(64)),
  user: Username,
  groupNames: v.pipe(v.array(Username), v.maxLength(64)),
  home: Path,
  /** The real login uid (differs from `uid` under `su`). */
  ruid: Uid,
  grantExpiresAt: v.optional(EpochMs),
});

export const GetcwdArgs = v.strictObject({});
export const GetcwdRet = v.strictObject({ path: Path, ino: Ino });

export const ChdirArgs = v.strictObject({ path: Path });
export const ChdirRet = v.strictObject({ path: Path, ino: Ino });

export const UmaskArgs = v.strictObject({
  mask: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(0o777))),
});
export const UmaskRet = v.strictObject({
  old: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(0o777)),
});

const SchedulingRet = v.strictObject({
  priority: Priority,
  nice: Nice,
  effPrio: Priority,
});

export const NiceArgs = v.strictObject({
  inc: v.pipe(v.number(), v.integer(), v.minValue(-39), v.maxValue(39)),
});
export const NiceRet = SchedulingRet;

export const SetpriorityArgs = v.strictObject({
  /** 0 = the caller (or the caller's group with `group`). */
  pid: PidOrZero,
  /** Apply to the process group `pid` instead of one process. */
  group: v.optional(v.boolean()),
  priority: v.optional(Priority),
  nice: v.optional(Nice),
});
export const SetpriorityRet = SchedulingRet;

export const Band = v.picklist(['interactive', 'normal', 'background']);
export const GetpriorityArgs = v.strictObject({ pid: Pid });
export const GetpriorityRet = v.strictObject({
  priority: Priority,
  nice: Nice,
  effPrio: Priority,
  band: Band,
});

export const SetpgidArgs = v.strictObject({ pid: PidOrZero, pgid: PidOrZero });
export const SetpgidRet = v.strictObject({ pgid: Pid });

export const SigDisposition = v.picklist(['default', 'ignore', 'catch']);
/** SIGKILL and SIGSTOP cannot be caught or ignored: EINVAL at the schema stage. */
export const SigActionArgs = v.pipe(
  v.strictObject({ sig: SignalName, action: SigDisposition }),
  v.check((a) => a.action === 'default' || (a.sig !== 'SIGKILL' && a.sig !== 'SIGSTOP')),
);
export const SigActionRet = v.strictObject({ old: SigDisposition });

export const ProcInfo = v.strictObject({
  pid: Pid,
  ppid: PidOrZero,
  pgid: Pid,
  uid: Uid,
  user: Username,
  state: PState,
  class: ProcClass,
  waitingOn: v.nullable(v.pipe(v.string(), v.maxLength(128))),
  priority: Priority,
  nice: Nice,
  effPrio: Priority,
  cpuPct: v.pipe(v.number(), v.minValue(0)),
  cpuTimeMs: v.pipe(v.number(), v.minValue(0)),
  residentBytes: Count,
  swappedBytes: Count,
  faults: Count,
  hitRatio: Ratio,
  speculative: v.boolean(),
  /** Other uids' argv is reduced to argv[0] (privacy, §4.4.1). */
  argv: Argv,
  executor: v.nullable(Count),
  windows: v.pipe(v.array(Wid), v.maxLength(32)),
  startedAt: EpochMs,
});

export const PageLoc = v.picklist(['RESIDENT', 'LOCAL_SWAP', 'REMOTE_SWAP']);

export const ProcDetail = v.strictObject({
  ...ProcInfo.entries,
  /** `pmap`: same uid or root only. */
  pages: v.optional(
    v.array(
      v.strictObject({
        pageId: Count,
        loc: PageLoc,
        dirty: v.boolean(),
        size: Count,
        lastAccess: EpochMs,
        pinned: v.boolean(),
        speculative: v.boolean(),
      }),
    ),
  ),
  fds: v.optional(
    v.array(
      v.strictObject({
        fd: Fd,
        kind: v.picklist(['file', 'dir', 'pipe', 'tty', 'events']),
        path: v.optional(Path),
        flags: v.pipe(v.string(), v.maxLength(8)),
      }),
    ),
  ),
  leases: v.optional(v.array(LeaseInfo)),
  caps: v.optional(v.array(Cap)),
  exitReason: v.optional(ShortText),
});

export const ProcListArgs = v.strictObject({
  uid: v.optional(Uid),
  pgid: v.optional(Pid),
  cursor: v.optional(Cursor),
  limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(PROC_LIST_PAGE_MAX))),
});
export const ProcListRet = v.strictObject({
  procs: v.pipe(v.array(ProcInfo), v.maxLength(PROC_LIST_PAGE_MAX)),
  next: v.optional(Cursor),
});

export const ProcInfoArgs = v.strictObject({ pid: Pid });
export const ProcInfoRet = ProcDetail;

export type SpawnArgs = v.InferOutput<typeof SpawnArgs>;
export type WaitArgs = v.InferOutput<typeof WaitArgs>;
export type WaitRet = v.InferOutput<typeof WaitRet>;
export type KillArgs = v.InferOutput<typeof KillArgs>;
export type ProcInfo = v.InferOutput<typeof ProcInfo>;
export type ProcDetail = v.InferOutput<typeof ProcDetail>;
export type Band = v.InferOutput<typeof Band>;
export type SigDisposition = v.InferOutput<typeof SigDisposition>;
