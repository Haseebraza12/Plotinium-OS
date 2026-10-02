/**
 * The loopback host: the whole kernel plus one in-process executor, for Node tests (architecture
 * §4.4 "worker.ts, main.ts (tests only) and loopback.ts implement it").
 *
 * `run(pid)` is a minimal, deterministic slice driver so tests can execute real programs through
 * the real dispatcher and executor runtime. It is NOT the scheduler (core/sched owns the ready
 * heap, aging and run tokens); it only exercises the lifecycle edges of Figure 9.1 and the F-call
 * fast path (`resume`), with the clock advanced by the test.
 */
import type { Cap, ProcClass, SysRes } from '@plotinium/protocol';

import type { BuildIdentity, PlatformInfo } from '../core/host.ts';
import { DEV_IDENTITY } from '../core/host.ts';
import type { AuditSink } from '../core/ipc/audit.ts';
import type { ExecPortRec, ViewCloseReason, ViewPortRec } from '../core/ipc/ports.ts';
import { execPort, viewPort } from '../core/ipc/ports.ts';
import type { Kernel } from '../core/kernel.ts';
import { createKernel } from '../core/kernel.ts';
import type { PCB } from '../core/proc/pcb.ts';
import { StaticUserDirectory } from '../core/proc/users.ts';
import type { SliceReport } from '../runtime/executor.ts';
import { ExecutorRuntime } from '../runtime/executor.ts';
import type { Program } from '../runtime/sys.ts';
import { ManualClock } from './clock.ts';

export const LOOPBACK_PLATFORM: PlatformInfo = Object.freeze({
  browser: Object.freeze({ brand: 'Chrome' as const, major: 154 }),
  cores: 8,
  crossOriginIsolated: false,
});

export interface LoopbackOptions {
  readonly clock?: ManualClock;
  readonly identity?: BuildIdentity;
  readonly platform?: PlatformInfo;
  readonly ai?: boolean;
  readonly users?: Iterable<readonly [number, string]>;
  readonly auditSink?: AuditSink;
  readonly quantumMs?: number;
}

export interface SpawnOptions {
  readonly name: string;
  readonly argv?: readonly string[];
  readonly uid?: number;
  readonly gid?: number;
  readonly cls?: ProcClass;
  readonly caps?: readonly Cap[];
  readonly fsScope?: readonly string[];
  readonly ppid?: number;
}

export interface RunResult {
  readonly pid: number;
  readonly code: number | null;
  readonly reason: string | null;
  readonly reports: SliceReport[];
  /** Every reply the process received, in order. */
  readonly replies: SysRes[];
}

export interface Loopback {
  readonly kernel: Kernel;
  readonly clock: ManualClock;
  readonly executor: ExecutorRuntime;
  readonly port: ExecPortRec;
  spawn(program: Program<unknown>, opts: SpawnOptions): PCB;
  run(pid: number, opts?: { maxSlices?: number; advanceMsPerSlice?: number }): Promise<RunResult>;
  openView(pid: number, wid: number): LoopbackView;
}

export interface LoopbackView {
  readonly port: ViewPortRec;
  readonly replies: SysRes[];
  closedWith: ViewCloseReason | null;
  send(msg: unknown): void;
}

export function createLoopback(opts: LoopbackOptions = {}): Loopback {
  const clock = opts.clock ?? new ManualClock();
  const kernel = createKernel({
    host: {
      clock,
      identity: opts.identity ?? DEV_IDENTITY,
      platform: opts.platform ?? LOOPBACK_PLATFORM,
    },
    ai: opts.ai ?? true,
    users: new StaticUserDirectory(opts.users ?? [[1001, 'alice']]),
    ...(opts.auditSink === undefined ? {} : { auditSink: opts.auditSink }),
  });
  const executor = new ExecutorRuntime({ now: () => clock.now(), ctl: null });
  const inbox = new Map<number, SysRes[]>();
  const waiters = new Map<number, () => void>();
  const port = execPort(0, (pid, res) => {
    const q = inbox.get(pid) ?? [];
    q.push(res);
    inbox.set(pid, q);
    waiters.get(pid)?.();
  });
  const quantumMs = opts.quantumMs ?? 10;
  let sliceSeq = 0;

  const nextReply = (pid: number): Promise<SysRes> => {
    const take = (): SysRes | undefined => inbox.get(pid)?.shift();
    const now = take();
    if (now) return Promise.resolve(now);
    return new Promise<SysRes>((resolve) => {
      waiters.set(pid, () => {
        const res = take();
        if (!res) return;
        waiters.delete(pid);
        resolve(res);
      });
    });
  };

  const spawn = (program: Program<unknown>, s: SpawnOptions): PCB => {
    const uid = s.uid ?? 1001;
    const pcb = kernel.procs.create({
      ppid: s.ppid ?? 1,
      kind: 'user',
      cls: s.cls ?? 'user',
      name: s.name,
      argv: s.argv ?? [s.name],
      cred: { uid, gid: s.gid ?? uid, groups: [], ruid: uid },
      caps: s.caps ?? ['fs.read', 'fs.write', 'proc', 'window', 'tty', 'lock', 'mem'],
    });
    if (s.fsScope) pcb.fsScope = [...s.fsScope];
    pcb.worker = port.index;
    const loaded = executor.load(
      {
        pid: pcb.pid,
        ppid: pcb.ppid,
        pgid: pcb.pgid,
        sid: pcb.sid,
        uid,
        gid: pcb.cred.gid,
        argv: pcb.argv,
        env: [...pcb.env],
        cwd: pcb.cwdPath,
        tty: pcb.tty,
      },
      program,
    );
    if (!loaded.ok) {
      kernel.procs.terminate(pcb, 'spawn-failed', { code: 126, reason: 'spawn-failed' });
      return pcb;
    }
    kernel.lifecycle.transition(pcb, 'READY', 'admit');
    return pcb;
  };

  const run = async (
    pid: number,
    r: { maxSlices?: number; advanceMsPerSlice?: number } = {},
  ): Promise<RunResult> => {
    const pcb = kernel.procs.get(pid);
    if (!pcb) throw new Error(`no pid ${String(pid)}`);
    const reports: SliceReport[] = [];
    const replies: SysRes[] = [];
    let res: SysRes | undefined;
    let resume = false;
    for (let i = 0; i < (r.maxSlices ?? 1_000); i++) {
      if (pcb.state === 'TERMINATED') break;
      if (!resume) {
        sliceSeq++;
        kernel.lifecycle.transition(pcb, 'RUNNING', 'dispatch');
        pcb.slices++;
        pcb.sliceStartedAt = clock.now();
      }
      port.slice = { pid, sliceSeq };
      const report = executor.runSlice({
        t: resume ? 'resume' : 'dispatch',
        pid,
        sliceSeq,
        quantumMs,
        pendingSigs: 0,
        ...(res ? { res } : {}),
      });
      reports.push(report);
      clock.advance(r.advanceMsPerSlice ?? 1);
      res = undefined;
      resume = false;
      switch (report.t) {
        case 'syscall': {
          pcb.cpuTimeMs += report.cpuMs;
          kernel.execFrame(port, report);
          const sync = inbox.get(pid)?.shift();
          if (sync) {
            res = sync;
            resume = true;
          } else {
            kernel.lifecycle.transition(pcb, 'BLOCKED', 'block', {
              waitingOn: `io:${report.req.call}`,
            });
            res = await nextReply(pid);
            kernel.lifecycle.transition(pcb, 'READY', 'wake');
          }
          replies.push(res);
          break;
        }
        case 'yield':
          pcb.cpuTimeMs += report.cpuMs;
          kernel.lifecycle.transition(pcb, 'READY', 'quantum');
          break;
        case 'exit':
          pcb.cpuTimeMs += report.cpuMs;
          kernel.procs.terminate(pcb, 'exit', { code: report.code, reason: 'normal' });
          break;
        case 'killed':
          kernel.procs.terminate(pcb, 'signal:9', { code: 137, reason: 'signal', by: 0 });
          break;
        case 'error':
          kernel.log('proc', 'fail', `pid ${String(pid)} crashed: ${report.message}`, pid);
          kernel.procs.terminate(pcb, 'crash', { code: 1, reason: 'crash' });
          break;
        case 'fault':
          // This minimal driver has no pager (proc-loopback.ts does): a page fault is fatal here.
          kernel.log(
            'proc',
            'fail',
            `pid ${String(pid)} faulted on page ${String(report.pageId)} (no pager)`,
            pid,
          );
          kernel.procs.terminate(pcb, 'crash', { code: 1, reason: 'crash' });
          break;
      }
      port.slice = null;
    }
    return { pid, code: pcb.exitCode, reason: pcb.exitReason, reports, replies };
  };

  const openView = (pid: number, wid: number): LoopbackView => {
    const pcb = kernel.procs.get(pid);
    pcb?.windows.add(wid);
    const view: LoopbackView = {
      port: viewPort(
        pid,
        wid,
        (res) => {
          view.replies.push(res);
        },
        (reason) => {
          view.closedWith = reason;
        },
      ),
      replies: [],
      closedWith: null,
      send: (msg) => {
        kernel.viewMessage(view.port, msg);
      },
    };
    return view;
  };

  return { kernel, clock, executor, port, spawn, run, openView };
}
