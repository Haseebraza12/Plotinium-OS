/**
 * The process control block (processes-and-scheduling.md §4.1; fields marked [spec] are required
 * by the Spec §9.1 PCB table). Everything that runs has one (KPS-01): user processes, kernel
 * threads such as `init`, started services and the special workers.
 *
 * Field names are binding: the scheduler (`core/sched`, `SchedulableProcess`) and the memory
 * manager (`core/mm`) read the same PCB object without adapters.
 */
import type { Band, Cap, ProcClass, PState } from '@plotinium/protocol';
import { capsToBits } from '@plotinium/protocol';

import type { ProcMemStats, PTE } from '../mm/types.ts';

/** `service` is the kind of a started system service (boot-and-services.md §9.3 request (2)). */
export type ProcKind = 'user' | 'kthread' | 'special' | 'service';

/** [spec] `waitingOn`. */
export type WaitReason =
  | `io:${string}`
  | `lock:${string}`
  | `pipe:${number}`
  | `tty:read:${number}`
  | 'tty:confirm'
  | `page:${number}`
  | 'mem'
  | 'sleep'
  | `wait:${number}`
  | 'sigcont'
  | 'net:llm'
  | 'ai:embed'
  | 'ai:search-focus'
  | 'ai:query'
  | `svc:${string}`;

export type ExitReason =
  'normal' | 'signal' | 'watchdog' | 'collateral' | 'crash' | 'spawn-failed' | 'abi-violation';

/** Effective credentials plus `ruid`, the real login uid (differs under `su`). */
export interface ProcCred {
  readonly uid: number;
  readonly gid: number;
  readonly groups: readonly number[];
  readonly ruid: number;
}

export interface PCB {
  // identity
  pid: number;
  ppid: number;
  pgid: number;
  sid: number;
  kind: ProcKind;
  cls: ProcClass;
  /** `${uid}:${cls}`: the executor isolation key (syscall-abi.md §3.2.1). */
  isolation: string;
  name: string;
  argv: string[];
  manifestPath: string | null;
  cred: ProcCred;
  /** Capability bitset, `Uint32Array(2)` (syscall-abi.md §3.5). */
  caps: Uint32Array;
  fsScope: readonly string[] | null;
  cwdIno: string;
  cwdPath: string;
  env: Map<string, string>;
  umask: number;
  tty: number | null;
  sessionLeader: boolean;
  // lifecycle
  state: PState;
  waitingOn: WaitReason | null;
  wakePending: boolean;
  stopped: boolean;
  pendingCall: { id: number; call: string; restartable: boolean } | null;
  pendingReply: unknown;
  exitCode: number | null;
  exitReason: ExitReason | null;
  /** Bit n = signal n. */
  pendingSignals: number;
  /** Per signal number: 0 default, 1 ignore, 2 catch. */
  sigDisposition: Uint8Array;
  // scheduling
  priority: number;
  nice: number;
  base: number;
  effPrio: number;
  band: Band;
  boosted: boolean;
  preemptRequested: boolean;
  seq: number;
  cpuTimeMs: number;
  lastRunAt: number;
  waitingSince: number;
  createdAt: number;
  exitedAt: number | null;
  sliceStartedAt: number;
  slices: number;
  overruns: number;
  maxStepUs: number;
  /** Executor index where resident; null when not placed or SUSPENDED. */
  worker: number | null;
  exclusive: boolean;
  checkpointable: boolean;
  lastCheckpoint: { gen: number; sha256: string; atSlice: number } | null;
  // memory (owned by memory-and-paging.md §4.1)
  pageTable: Map<number, PTE>;
  residentBytes: number;
  declaredAssets: number;
  softLimit: number;
  stateBytes: number;
  mm: ProcMemStats;
  speculative: boolean;
  // resources
  fdTable: Map<number, number>;
  windows: Set<number>;
  leases: Set<string>;
  children: Set<number>;
  timers: Set<number>;
}

export const PRIORITY_MIN = 0;
export const PRIORITY_MAX = 39;
export const DEFAULT_PRIORITY = 20;
export const DEFAULT_UMASK = 0o022;

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

/** `clamp(priority + nice, 0, 39)` (processes-and-scheduling.md §3.9.1). */
export function baseOf(priority: number, nice: number): number {
  return clamp(priority + nice, PRIORITY_MIN, PRIORITY_MAX);
}

/** Band from `base`: interactive 0–9, normal 10–29, background 30–39 (§3.9.2). */
export function bandOf(base: number): Band {
  if (base <= 9) return 'interactive';
  if (base <= 29) return 'normal';
  return 'background';
}

export interface PcbInit {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid?: number;
  readonly sid?: number;
  readonly kind: ProcKind;
  readonly cls: ProcClass;
  readonly name: string;
  readonly argv?: readonly string[];
  readonly manifestPath?: string | null;
  readonly cred: ProcCred;
  readonly caps?: readonly Cap[];
  readonly fsScope?: readonly string[] | null;
  readonly cwdIno?: string;
  readonly cwdPath?: string;
  readonly env?: ReadonlyMap<string, string>;
  readonly umask?: number;
  readonly tty?: number | null;
  readonly priority?: number;
  readonly nice?: number;
  readonly checkpointable?: boolean;
  /** Kernel clock at creation. */
  readonly now: number;
}

function emptyMemStats(): ProcMemStats {
  return {
    faults: 0,
    hits: 0,
    bytesIn: 0,
    bytesOut: 0,
    lastPageInMs: null,
    swapLocalBytes: 0,
    swapRemoteBytes: 0,
    pagedOutBytes: 0,
    minimised: false,
    overSoftLimit: false,
  };
}

/** A PCB in no state yet (`state` is set to NEW by the lifecycle's spawn record). */
/**
 * A zombie: TERMINATED with its exit status recorded, so it may be reaped. A kill of a RUNNING
 * process marks it TERMINATED at once but completes (and records the status) only when its slice
 * ends (processes-and-scheduling.md §3.16 step 4); until then it must not be reaped or reported
 * by `wait`, since the executor still holds its slice.
 */
export function isZombie(p: Pick<PCB, 'state' | 'exitCode'>): boolean {
  return p.state === 'TERMINATED' && p.exitCode !== null;
}

export function createPcb(init: PcbInit): PCB {
  const priority = clamp(init.priority ?? DEFAULT_PRIORITY, PRIORITY_MIN, PRIORITY_MAX);
  const nice = clamp(init.nice ?? 0, -20, 19);
  const base = baseOf(priority, nice);
  return {
    pid: init.pid,
    ppid: init.ppid,
    pgid: init.pgid ?? init.pid,
    sid: init.sid ?? init.pid,
    kind: init.kind,
    cls: init.cls,
    isolation: `${String(init.cred.uid)}:${init.cls}`,
    name: init.name,
    argv: [...(init.argv ?? [init.name])],
    manifestPath: init.manifestPath ?? null,
    cred: { ...init.cred, groups: [...init.cred.groups] },
    caps: capsToBits(init.caps ?? []),
    fsScope: init.fsScope ?? null,
    cwdIno: init.cwdIno ?? '',
    cwdPath: init.cwdPath ?? '/',
    env: new Map(init.env ?? []),
    umask: init.umask ?? DEFAULT_UMASK,
    tty: init.tty ?? null,
    sessionLeader: (init.sid ?? init.pid) === init.pid,
    state: 'NEW',
    waitingOn: null,
    wakePending: false,
    stopped: false,
    pendingCall: null,
    pendingReply: null,
    exitCode: null,
    exitReason: null,
    pendingSignals: 0,
    sigDisposition: new Uint8Array(32),
    priority,
    nice,
    base,
    effPrio: base,
    band: bandOf(base),
    boosted: false,
    preemptRequested: false,
    seq: 0,
    cpuTimeMs: 0,
    lastRunAt: 0,
    waitingSince: init.now,
    createdAt: init.now,
    exitedAt: null,
    sliceStartedAt: 0,
    slices: 0,
    overruns: 0,
    maxStepUs: 0,
    worker: null,
    exclusive: false,
    checkpointable: init.checkpointable ?? false,
    lastCheckpoint: null,
    pageTable: new Map(),
    residentBytes: 0,
    declaredAssets: 0,
    softLimit: 0,
    stateBytes: 0,
    mm: emptyMemStats(),
    speculative: false,
    fdTable: new Map(),
    windows: new Set(),
    leases: new Set(),
    children: new Set(),
    timers: new Set(),
  };
}
