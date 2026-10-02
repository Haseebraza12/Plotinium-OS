/**
 * System and administration (syscall-abi.md §4.4.11).
 *
 * `UnameInfo` is the shape of identity-and-branding.md §4.3. `BootLogEntry` and `KlogEntry` are not
 * spelled out by any spec; they follow the kernel log line of boot-and-services.md §4.5
 * (`KlogLine {t, sub, level, msg}`) and are marked provisional.
 */
import * as v from 'valibot';

import { DMESG_PAGE_MAX } from '../limits.ts';
import { Argv, Env } from './proc.ts';
import {
  Count,
  EpochMs,
  Gid,
  Ino,
  Path,
  Pid,
  Sha256Hex,
  ShortText,
  Uid,
  Username,
} from './common.ts';

// ---------------------------------------------------------------------------------------------
// uname, users.list
// ---------------------------------------------------------------------------------------------

export const UnameInfo = v.strictObject({
  sysname: v.literal('Plotinium'),
  version: v.pipe(v.string(), v.regex(/^\d+\.\d+\.\d+(?:-(?:rc|dev)\.\d+)?$/)),
  build: v.pipe(v.string(), v.regex(/^[0-9a-f]{7}(?:\+dirty)?$/)),
  buildDate: v.pipe(v.string(), v.regex(/^\d{4}-\d{2}-\d{2}$/)),
  codename: v.nullable(v.pipe(v.string(), v.maxLength(32))),
  browser: v.strictObject({
    brand: v.picklist(['Chrome', 'Edge', 'Chromium', 'Unknown browser']),
    major: v.nullable(Count),
  }),
  cores: v.pipe(v.number(), v.integer(), v.minValue(1)),
  /** The caller's effective uid, from the port-bound PCB (never from args). */
  uid: Uid,
  user: Username,
});

export const UnameArgs = v.strictObject({});
export const UnameRet = UnameInfo;

export const UsersListArgs = v.strictObject({});
export const UsersListRet = v.strictObject({
  users: v.array(
    v.strictObject({
      uid: Uid,
      name: Username,
      gid: Gid,
      home: Path,
      groups: v.array(Gid),
    }),
  ),
  groups: v.array(v.strictObject({ gid: Gid, name: Username })),
});

// ---------------------------------------------------------------------------------------------
// bootlog, dmesg, services
// ---------------------------------------------------------------------------------------------

export const LogLevel = v.picklist(['info', 'warn', 'degraded', 'fail', 'panic']);

/** Provisional (see the module comment): one line of the boot log. `t` = seconds since t0. */
export const BootLogEntry = v.strictObject({
  t: v.pipe(v.number(), v.minValue(0)),
  sub: v.pipe(v.string(), v.maxLength(32)),
  level: LogLevel,
  msg: v.pipe(v.string(), v.maxLength(1024)),
});

/** Provisional (see the module comment): one kernel log entry as `dmesg` shows it. */
export const KlogEntry = v.strictObject({
  seq: Count,
  /** Epoch ms. */
  t: EpochMs,
  sub: v.pipe(v.string(), v.maxLength(32)),
  level: LogLevel,
  msg: v.pipe(v.string(), v.maxLength(1024)),
  pid: v.optional(Pid),
});

export const BootlogArgs = v.strictObject({
  criticalPath: v.optional(v.boolean()),
  verbose: v.optional(v.boolean()),
  boot: v.optional(v.picklist(['current', 'previous'])),
  /** `bootlog --list`: also return the stored boot records (UI-135). */
  list: v.optional(v.boolean()),
});
/** One stored boot record as `bootlog --list` shows it (boot-and-services.md §4.6, UI-135). */
export const BootSummary = v.strictObject({
  seq: Count,
  /** Epoch ms of t0. */
  at: v.pipe(v.number(), v.minValue(0)),
  profile: v.picklist(['normal', 'safe', 'recovery']),
  outcome: v.picklist(['interactive', 'panic', 'recovery', 'incomplete', 'unsupported']),
  /** Boot time to desktop-interactive, null when the desktop was never reached. */
  bootMs: v.nullable(v.pipe(v.number(), v.minValue(0))),
  build: v.pipe(v.string(), v.maxLength(32)),
  /** The login screen was reached (a boot left there is healthy). */
  reachedLogin: v.boolean(),
  current: v.boolean(),
});
export const BootlogRet = v.strictObject({
  entries: v.array(BootLogEntry),
  /** Service names from `kernel` to `desktop` (BOOT-11). */
  criticalPath: v.optional(v.array(v.pipe(v.string(), v.maxLength(32)))),
  totalMs: v.pipe(v.number(), v.minValue(0)),
  /** With `list`: the stored boot records, newest first (at most 20). */
  boots: v.optional(v.pipe(v.array(BootSummary), v.maxLength(20))),
});

export const DmesgArgs = v.strictObject({
  /** Entries with `seq` greater than this. */
  since: v.optional(Count),
  level: v.optional(LogLevel),
  limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(DMESG_PAGE_MAX))),
});
export const DmesgRet = v.strictObject({
  entries: v.pipe(v.array(KlogEntry), v.maxLength(DMESG_PAGE_MAX)),
});

export const SvcState = v.picklist(['stopped', 'starting', 'running', 'degraded', 'failed']);

export const SvcStatusArgs = v.strictObject({});
export const SvcStatusRet = v.strictObject({
  services: v.array(
    v.strictObject({
      name: v.pipe(v.string(), v.maxLength(32)),
      state: SvcState,
      critical: v.boolean(),
      pid: v.optional(Pid),
      restarts: Count,
      lastError: v.optional(ShortText),
    }),
  ),
});

export const SvcRestartArgs = v.strictObject({
  name: v.pipe(v.string(), v.minLength(1), v.maxLength(32)),
});
export const SvcRestartRet = v.strictObject({});

// ---------------------------------------------------------------------------------------------
// sysctl
// ---------------------------------------------------------------------------------------------

/** Dotted lower-camel keys such as `mm.budgetMB` or `sched.quantum.normal`. */
export const SysctlKey = v.pipe(
  v.string(),
  v.regex(/^[a-z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9]*){0,4}$/),
  v.maxLength(64),
);
export const SysctlValue = v.union([
  v.pipe(v.string(), v.maxLength(256)),
  v.pipe(v.number(), v.finite()),
  v.boolean(),
]);

/**
 * Session keys (§4.4.11 `sysctl.set`): the console session's user or root may set them without a
 * capability. Every other key is global and needs `sys.admin` (security audit).
 */
export const SESSION_SYSCTL_PREFIXES = ['ui.', 'mm.', 'sched.'] as const;
export const SESSION_SYSCTL_KEYS = ['boot.showMenuNextBoot'] as const;

export function isSessionSysctlKey(key: string): boolean {
  return (
    (SESSION_SYSCTL_KEYS as readonly string[]).includes(key) ||
    SESSION_SYSCTL_PREFIXES.some((prefix) => key.startsWith(prefix))
  );
}

export const SysctlGetArgs = v.strictObject({ key: v.optional(SysctlKey) });
export const SysctlGetRet = v.strictObject({ values: v.record(SysctlKey, SysctlValue) });

export const SysctlSetArgs = v.strictObject({ key: SysctlKey, value: SysctlValue });
export const SysctlSetRet = v.strictObject({ old: v.nullable(SysctlValue), value: SysctlValue });

// ---------------------------------------------------------------------------------------------
// shutdown, reboot, su, auth
// ---------------------------------------------------------------------------------------------

export const ShutdownArgs = v.strictObject({
  delayMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(3_600_000))),
});
export const ShutdownRet = v.strictObject({ scheduledAt: EpochMs });

export const RebootArgs = v.strictObject({
  /** Show the boot menu on the next boot (BOOT-06). */
  menu: v.optional(v.boolean()),
  safe: v.optional(v.boolean()),
  delayMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(3_600_000))),
});
export const RebootRet = v.strictObject({ scheduledAt: EpochMs });

export const SuArgs = v.strictObject({
  user: v.optional(Username, 'root'),
  spawn: v.strictObject({ path: Path, argv: Argv, env: v.optional(Env) }),
});
export const SuRet = v.strictObject({ pid: Pid, uid: Uid, grantExpiresAt: EpochMs });

/** View origin, login view only; the secret is never logged or audited. */
export const AuthLoginArgs = v.strictObject({
  user: Username,
  secret: v.pipe(v.string(), v.minLength(1), v.maxLength(1024)),
});
export const AuthLoginRet = v.strictObject({ uid: Uid, offline: v.boolean() });

export const AuthLogoutArgs = v.strictObject({});
export const AuthLogoutRet = v.strictObject({});
export const AuthLockArgs = v.strictObject({});
export const AuthLockRet = v.strictObject({});

// ---------------------------------------------------------------------------------------------
// fsck, fault injection
// ---------------------------------------------------------------------------------------------

export const FsckArgs = v.strictObject({
  repair: v.optional(v.boolean()),
  checksum: v.optional(v.boolean()),
  scope: v.optional(v.picklist(['local', 'server', 'both'])),
});
export const FsckReport = v.strictObject({
  inodes: Count,
  orphans: Count,
  parentless: Count,
  unreachable: Count,
  nlinkErrors: Count,
  quotaDrift: Count,
  cycles: Count,
  danglingLinks: Count,
  checksum: v.optional(Sha256Hex),
  serverChecksum: v.optional(Sha256Hex),
  /** Number of repairs applied (repair mode only). */
  repaired: v.optional(Count),
  durationMs: v.pipe(v.number(), v.minValue(0)),
});
export const FsckRet = FsckReport;

export const DebugInjectArgs = v.strictObject({
  target: v.picklist(['client', 'server', 'both']),
  op: v.picklist(['unlink', 'rename', 'copy', 'chmod', 'chown', 'batch', 'any']),
  /** Fail at the N-th node operation (one inode-row write). */
  after: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100_000)),
});
export const DebugInjectRet = v.strictObject({ armed: v.literal(true), faultId: Ino });

export const DebugDelayArgs = v.strictObject({
  op: v.picklist(['batch', 'unlink', 'copy']),
  ms: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(10_000)),
});
export const DebugDelayRet = v.strictObject({ armed: v.literal(true) });

export type UnameInfo = v.InferOutput<typeof UnameInfo>;
export type FsckReport = v.InferOutput<typeof FsckReport>;
export type BootLogEntry = v.InferOutput<typeof BootLogEntry>;
export type BootSummary = v.InferOutput<typeof BootSummary>;
export type KlogEntry = v.InferOutput<typeof KlogEntry>;
