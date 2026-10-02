/**
 * The executor control protocol (processes-and-scheduling.md §4.3; memory-and-paging.md §4.3):
 * every frame that crosses an executor's control port, in both directions, plus the transport the
 * kernel core uses to reach executors.
 *
 * The syscall-carrying frames (`dispatch`, `resume`, `syscall`, `yield`, `exit`) match protocol's
 * `KernelToExec` / `ExecToKernel`. The rest (`load`, `drop`, `preempt`, the page frames, `loaded`,
 * `killed`, `error`, `fault`) are the kernel-internal half of the port and are declared here.
 * TODO(protocol): move them to protocol/src/host/executor.ts and executor-mem.ts (spec §4.3).
 *
 * Thread-agnostic: the browser host (`host/executors.ts`) carries these over a Worker's port and
 * the Node loopback host (`host/loopback.ts`) calls an in-process `ExecutorRuntime` directly.
 */
import type { SysRes } from '@plotinium/protocol';

import type { ControlBlock } from '../sched/control-block.ts';

/** Page file of the deterministic codec (header + body + SHA-256 of the body). */
export interface PageFile {
  readonly header: ArrayBuffer;
  readonly body: ArrayBuffer;
  readonly sha256: string;
}

/** `{t:'load'}`: make a program resident (or restore it from its state page). */
export interface LoadFrame {
  readonly t: 'load';
  readonly pid: number;
  /** Program module id (`manifest.entry`), resolved by the executor's program loaders. */
  readonly entry: string;
  /**
   * Module ids of the start-up closure's `lib` manifests in topological order (dependencies
   * first, KPS-07): the executor imports each before the program; a missing one fails the load.
   */
  readonly libs?: readonly string[];
  readonly ppid: number;
  readonly pgid: number;
  readonly sid: number;
  readonly uid: number;
  readonly gid: number;
  readonly argv: readonly string[];
  readonly env: readonly (readonly [string, string])[];
  readonly cwd: string;
  readonly tty: number | null;
  /** Restore `st` from a verified state page instead of calling `init(argv)`. */
  readonly restore?: PageFile & { readonly from: 'page-in' | 'migration' | 'session' };
}

export interface DispatchFrame {
  readonly t: 'dispatch' | 'resume';
  readonly pid: number;
  readonly sliceSeq: number;
  readonly quantumMs: number;
  readonly pendingSigs: number;
  readonly res?: SysRes;
  /** The process's cwd at this dispatch (`ctx.cwd`). */
  readonly cwd?: string;
}

/**
 * The transfer list of a reply carried by a `dispatch` / `resume` frame: every MessagePort in the
 * reply value (for example the display port `window.create` returns), which `postMessage` can
 * only move, never copy. Searched to a small depth; ArrayBuffers are copied, never transferred,
 * because a reply buffer may be the kernel's own cached copy of a file.
 */
export function replyTransfer(res: SysRes | null | undefined): Transferable[] {
  if (res === null || res === undefined || !res.ok) return [];
  const out: Transferable[] = [];
  const walk = (v: unknown, depth: number): void => {
    if (v === null || typeof v !== 'object' || depth > 3) return;
    if (typeof MessagePort !== 'undefined' && v instanceof MessagePort) {
      if (!out.includes(v)) out.push(v);
      return;
    }
    if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) return;
    for (const x of Array.isArray(v) ? v : Object.values(v)) walk(x, depth + 1);
  };
  walk(res.value, 0);
  return out;
}

/** Kernel → executor. */
export type KernelToExecutor =
  | LoadFrame
  | DispatchFrame
  /** Message fallback without SAB (§3.7.4): only honoured between slices. */
  | { readonly t: 'preempt'; readonly level: 1 | 2 }
  /** Kill of a resident that is not running: discard its generator, state and pages. */
  | { readonly t: 'drop'; readonly pid: number }
  | {
      readonly t: 'checkpoint';
      readonly reqId: number;
      readonly pid: number;
      readonly release: boolean;
    }
  | {
      readonly t: 'pageOut';
      readonly reqId: number;
      readonly pid: number;
      readonly pageIds: readonly number[];
      /** Page sizes, so a page the executor never materialised is sent as zeros. */
      readonly sizes?: readonly number[];
    }
  | {
      readonly t: 'pageIn';
      readonly reqId: number;
      readonly pid: number;
      readonly pageId: number;
      readonly body: ArrayBuffer;
      readonly sha256: string;
    }
  | {
      readonly t: 'release';
      readonly reqId: number;
      readonly pid: number;
      readonly pageIds: readonly number[];
      readonly dropProcess: boolean;
    };

/** Accounting carried by slice-ending frames (§4.3). */
export interface SliceAcct {
  readonly cpuMs: number;
  readonly steps: number;
  readonly maxStepUs: number;
  /** Page ids accessed during the slice (memory-and-paging.md §4.3). */
  readonly touched?: readonly number[];
  /** Page ids written during the slice. */
  readonly dirtied?: readonly number[];
}

/** A request the program yielded; the runtime stamped the id. */
export interface StampedRequest {
  readonly id: number;
  readonly call: string;
  readonly args: unknown;
}

/** Slice reports: every slice ends in exactly one of these (§3.7.3). */
export type SliceReport =
  | ({ readonly t: 'yield'; readonly pid: number; readonly sliceSeq: number } & SliceAcct)
  | ({
      readonly t: 'syscall';
      readonly pid: number;
      readonly sliceSeq: number;
      readonly req: StampedRequest;
    } & SliceAcct)
  /** `ctx.mem.get` of a page that is not resident: runtime-internal `mem.fault` (§4.2). */
  | ({
      readonly t: 'fault';
      readonly pid: number;
      readonly sliceSeq: number;
      readonly id: number;
      readonly pageId: number;
    } & SliceAcct)
  | {
      readonly t: 'exit';
      readonly pid: number;
      readonly sliceSeq: number;
      readonly cpuMs: number;
      readonly code: number;
    }
  | { readonly t: 'killed'; readonly pid: number; readonly sliceSeq: number }
  | {
      readonly t: 'error';
      readonly pid: number;
      readonly sliceSeq: number;
      readonly message: string;
      readonly stack?: string;
    };

export type LoadedReport =
  | { readonly t: 'loaded'; readonly pid: number; readonly ok: true; readonly stateBytes?: number }
  | { readonly t: 'loaded'; readonly pid: number; readonly ok: false; readonly error: string };

export type MemReport =
  | ({
      readonly t: 'checkpointed';
      readonly reqId: number;
      readonly pid: number;
      readonly ok: true;
      readonly bytes: number;
    } & PageFile)
  | {
      readonly t: 'checkpointed';
      readonly reqId: number;
      readonly pid: number;
      readonly ok: false;
      readonly errno: 'EINVAL';
      readonly msg: string;
    }
  | {
      readonly t: 'pagedOut';
      readonly reqId: number;
      readonly pid: number;
      readonly pages: readonly (PageFile & { readonly pageId: number })[];
    }
  | { readonly t: 'pagedIn'; readonly reqId: number; readonly pid: number; readonly ok: boolean }
  | {
      readonly t: 'released';
      readonly reqId: number;
      readonly pid: number;
      readonly bytes: number;
    };

/** Executor → kernel (after the `hello` handshake, which the transport handles). */
export type ExecutorToKernel = SliceReport | LoadedReport | MemReport;

/**
 * How the kernel core reaches executor workers. The host implements it: `start` spawns a fresh
 * realm at `index` (a nested module worker in the browser, an in-process runtime in Node) and
 * resolves after its ABI `hello` matched; frames the executor sends are delivered to the handler
 * passed to `connect`.
 */
export interface ExecutorTransport {
  /** Register the kernel's frame handler (called once, by the process system). */
  connect(
    onFrame: (index: number, frame: ExecutorToKernel) => void,
    onCrash: (index: number, why: string) => void,
  ): void;
  start(index: number): Promise<void>;
  /** `worker.terminate()`; later frames from that realm are never delivered. */
  terminate(index: number): void;
  post(index: number, frame: KernelToExecutor, transfer?: Transferable[]): void;
  /** The SAB control block of the executor at `index`, or null (message fallback). */
  ctl(index: number): ControlBlock | null;
  /** Whether a realm is alive at `index`. */
  alive(index: number): boolean;
}
