/**
 * The kernel surface the AI runtime plugs into, as STRUCTURAL types.
 *
 * ai/ may import only protocol, dsa and `@plotinium/kernel/hooks` (architecture.md §3.7, ESLint
 * `boundaries`), and the kernel may not import ai/ at all (C12: the AI-off litmus build removes
 * this package). So the composition happens one level up: web's kernel-worker entry imports both
 * and hands the kernel's objects to `installAi` (install.ts). Every interface below is a subset of
 * a kernel type, written so the kernel object is assignable to it without an adapter:
 *
 *   AiCaller        ⊇ kernel `Caller` (core/ipc/ports.ts) with its `PCB`
 *   HandlerTarget   ⊇ kernel `HandlerRegistry` (core/ipc/handlers.ts)
 *   HookTarget      ⊇ kernel `HookRegistry` (@plotinium/kernel/hooks)
 *   AiBus           ⊇ kernel `EventBus` (core/events/bus.ts)
 *
 * Handlers fail by throwing the kernel's own `KernelError`, built through the injected
 * `makeError` (the dispatcher recognises it with `instanceof`; anything else becomes EIO).
 */
import type { KernelHooks } from '@plotinium/kernel/hooks';
import type {
  ArgsOf,
  CallName,
  ErrDetail,
  Errno,
  EventData,
  KEvent,
  RetOf,
  Topic,
} from '@plotinium/protocol';

/** Credentials of a process: effective uid/gid/groups plus the real login uid (`ruid`). */
export interface AiProcCred {
  readonly uid: number;
  readonly gid: number;
  readonly groups: readonly number[];
  readonly ruid: number;
}

/** The PCB fields the AI handlers read. */
export interface AiPcb {
  readonly pid: number;
  readonly pgid: number;
  readonly sid: number;
  readonly name: string;
  readonly cls: 'user' | 'agent' | 'system';
  readonly cred: AiProcCred;
  readonly tty: number | null;
  readonly cwdPath: string;
}

/** Who is calling: derived from the port by the dispatcher (C3), never from the arguments. */
export interface AiCaller {
  readonly pcb: AiPcb;
  readonly origin: 'E' | 'V';
  readonly wid: number | null;
}

/** One syscall implementation (stage 7 of the dispatcher). */
export interface AiCallImpl<C extends CallName> {
  handle(caller: AiCaller, args: ArgsOf<C>): RetOf<C> | Promise<RetOf<C>>;
}

/** The kernel's handler registry: a call answers ENOSYS until it is registered (C12). */
export interface HandlerTarget {
  register<C extends CallName>(name: C, impl: AiCallImpl<C>): void;
}

/** The kernel's hook registry (`@plotinium/kernel/hooks` HookRegistry). */
export interface HookTarget {
  register(partial: Partial<KernelHooks>): void;
  reset(): void;
}

/** The subset of a bus subscription the runtime drains. */
export interface AiSubscription {
  take(max?: number): { events: KEvent[]; dropped: number };
}

/** The kernel event bus. */
export interface AiBus {
  publish<T extends Topic>(topic: T, data: EventData[T]): unknown;
  subscribe(
    patterns: readonly string[],
    opts: {
      readonly cred: {
        readonly uid: number;
        readonly gid: number;
        readonly groups: readonly number[];
      };
      readonly onReady?: (sub: AiSubscription) => void;
    },
  ): unknown;
}

/** Builds the kernel's `KernelError` (so the dispatcher replies with this errno). */
export type MakeError = (errno: Errno, detail?: ErrDetail, message?: string) => Error;

export type AiLogLevel = 'info' | 'warn' | 'degraded' | 'fail';

/** The kernel services the runtime needs everywhere. */
export interface AiKernel {
  readonly handlers: HandlerTarget;
  readonly hooks: HookTarget;
  readonly bus: AiBus;
  readonly makeError: MakeError;
  /** Monotonic kernel milliseconds. */
  now(): number;
  /** Wall clock (epoch ms). */
  epochMs(): number;
  log(level: AiLogLevel, msg: string): void;
}

/** `fetch` as the kernel host provides it (the session cookie rides along; same origin only). */
export type HostFetch = (
  input: string,
  init: {
    method: 'GET' | 'POST';
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}>;
