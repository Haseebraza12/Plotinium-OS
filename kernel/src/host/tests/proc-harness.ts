/**
 * Test support for the process-system tests: a program registry of small programs driven through
 * the real kernel on the process loopback host (`host/proc-loopback.ts`).
 *
 * `script` runs a named generator from `SCRIPTS` (argv[1]), so one manifest covers every
 * scenario; each script writes what it observed into `rec`, which the test reads back through
 * `recordOf(pid)` after the process exited. `burn` is a CPU loop with a yield point per step.
 */
import type { AppManifestInput, SignalName } from '@plotinium/protocol';

import type { LoopbackProgram, ProcLoopback, ProcLoopbackOptions } from '../proc-loopback.ts';
import { createProcLoopback } from '../proc-loopback.ts';
import type { Program, ProgramContext, SysGen } from '../../runtime/sys.ts';
import { errnoOf } from '../../runtime/sys.ts';
import type { KlogProc } from '../../core/klog/records.ts';

export type Rec = Record<string, unknown>;
export type Script = (ctx: ProgramContext, rec: Rec) => SysGen<number | undefined>;
export type SigHook = (ctx: ProgramContext, rec: Rec, sig: SignalName) => void;

const SCRIPTS = new Map<string, Script>();
const SIGNAL_HOOKS = new Map<string, SigHook>();
const RECORDS = new Map<number, Rec>();

export function defineScript(name: string, s: Script, onSignal?: SigHook): void {
  SCRIPTS.set(name, s);
  if (onSignal !== undefined) SIGNAL_HOOKS.set(name, onSignal);
}

export function recordOf(pid: number): Rec {
  return RECORDS.get(pid) ?? {};
}

interface ScriptState {
  readonly name: string;
}

const scriptProgram: Program<ScriptState> = {
  init: (argv) => ({ name: argv[1] ?? '' }),
  *run(ctx, st) {
    const s = SCRIPTS.get(st.name);
    if (s === undefined) throw new Error(`no script ${st.name}`);
    const rec: Rec = {};
    RECORDS.set(ctx.pid, rec);
    return yield* s(ctx, rec);
  },
  signal(ctx, st, sig) {
    const rec = RECORDS.get(ctx.pid) ?? {};
    const signals = (rec['signals'] as SignalName[] | undefined) ?? [];
    signals.push(sig);
    rec['signals'] = signals;
    RECORDS.set(ctx.pid, rec);
    SIGNAL_HOOKS.get(st.name)?.(ctx, rec, sig);
  },
};

/** `script forever`: sleeps in a loop until it is killed (a mostly-sleeping process). */
defineScript('forever', function* (ctx) {
  for (;;) yield* ctx.sleep(1_000);
});

export interface BurnState {
  n: number;
  max: number;
}

/** CPU-bound: argv[1] steps (default: forever), one yield point per step. */
export const burnProgram: Program<BurnState> = {
  checkpointable: true,
  init: (argv) => ({ n: 0, max: argv[1] === undefined ? -1 : Number(argv[1]) }),
  *run(ctx, st) {
    while (st.max < 0 || st.n < st.max) {
      st.n++;
      yield ctx.tick;
    }
    return 0;
  },
};

export const TEST_CAPS = ['proc', 'tty', 'mem', 'fs.read', 'fs.write', 'lock', 'window'] as const;

export function manifest(name: string, over: Partial<AppManifestInput> = {}): AppManifestInput {
  return {
    name,
    kind: 'command',
    title: name,
    entry: `test/${name}`,
    requires: [],
    caps: [...TEST_CAPS],
    ...over,
  };
}

export const BASE_PROGRAMS: readonly LoopbackProgram[] = [
  { manifest: manifest('script'), program: scriptProgram },
  { manifest: manifest('burn', { checkpointable: true }), program: burnProgram },
];

/**
 * A fresh process loopback with the base programs. Pids restart at every boot, so the records of
 * an earlier loopback are forgotten here.
 */
export function loopback(
  opts: ProcLoopbackOptions & { readonly extra?: readonly LoopbackProgram[] } = {},
): ProcLoopback {
  RECORDS.clear();
  const { extra, ...rest } = opts;
  return createProcLoopback({ ...rest, programs: [...BASE_PROGRAMS, ...(extra ?? [])] });
}

/** Spawn `script <name>` as the session user and run until it exits. */
export async function runScript(
  lb: ProcLoopback,
  name: string,
  opts: { maxMs?: number; setsid?: boolean; tty?: number | null; args?: readonly string[] } = {},
): Promise<{ pid: number; code: number | null; rec: Rec }> {
  const p = await lb.spawn('script', {
    argv: ['script', name, ...(opts.args ?? [])],
    ...(opts.setsid === undefined ? {} : { setsid: opts.setsid }),
    ...(opts.tty === undefined ? {} : { tty: opts.tty }),
  });
  const done = await lb.until(() => exited(p), opts.maxMs ?? 30_000);
  if (!done)
    throw new Error(
      `script ${name} (pid ${String(p.pid)}) did not exit: ${p.state} ${String(p.waitingOn)}`,
    );
  return { pid: p.pid, code: p.exitCode, rec: recordOf(p.pid) };
}

/**
 * The process has finished dying: TERMINATED with its exit status recorded. (A kill of a RUNNING
 * process marks it TERMINATED at once and completes when its slice ends, §3.16 step 4.)
 */
export function exited(p: { readonly state: string; readonly exitCode: number | null }): boolean {
  return p.state === 'TERMINATED' && p.exitCode !== null;
}

/** The errno of a failed call inside a script (for `rec`). */
export function* attempt<T>(g: SysGen<T>): SysGen<T | { errno: string }> {
  try {
    return yield* g;
  } catch (e) {
    return { errno: errnoOf(e) ?? String(e) };
  }
}

/** `from>to:reason` per transition of `pid`, in klog order. */
export function trace(lb: ProcLoopback, pid: number): string[] {
  return lb.kernel.klog.read({ filter: (r) => r.kind === 'proc' && r.pid === pid }).map((r) => {
    const p = r as KlogProc;
    return `${p.from ?? '-'}>${p.to ?? '-'}:${p.reason}`;
  });
}

/** Every proc record of the klog. */
export function procRecords(lb: ProcLoopback): KlogProc[] {
  return lb.kernel.klog.read({ filter: (r) => r.kind === 'proc' }).map((r) => r as KlogProc);
}
