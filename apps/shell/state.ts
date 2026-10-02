/**
 * The shell's serialisable state and its run-time handle.
 *
 * Everything the shell must keep across a page-out lives in `ShellState` (plain data, no
 * functions or class instances; processes-and-scheduling.md §3.5.1 rule 1). `Sh` bundles that
 * state with the per-dispatch `sys` client and `tick`, which are never stored.
 */
import type { Sys, SysGen } from '../src/_sys.ts';
import { errnoOf, writeText } from '../src/_sys.ts';
import type { List } from './ast.ts';
import type { EditorState } from './editor.ts';
import type { HistoryState } from './history.ts';
import { newHistory } from './history.ts';
import type { Job, JobTable, TtyMode } from './jobs.ts';
import { newJobTable } from './jobs.ts';
import type { VarTable } from './vars.ts';
import { getVar, newVars } from './vars.ts';

export type ShellMode = 'interactive' | 'command' | 'script' | 'stdin';

/** A command line being executed; `item` and `step` say how far it got. */
export interface ExecCursor {
  source: string;
  list: List;
  item: number;
  /** 0 = the first pipeline of the and-or list, i = its i-th `&&`/`||` right side. */
  step: number;
  /** A foreground job is being waited for: the only point where a checkpoint can land. */
  waiting: boolean;
  /** The line to add to history once it has run (interactive shells only). */
  histLine: string | null;
}

export interface ShellState {
  v: 1;
  argv: string[];
  mode: ShellMode;
  /** `-i` was given: interactive even if the checks at start-up say otherwise. */
  forceInteractive: boolean;
  phase: 'start' | 'loop';
  login: boolean;
  /** The `-c` command text. */
  command: string | null;
  /** The script operand of `sh FILE`. */
  scriptPath: string | null;
  /** `$0`. */
  name: string;
  positional: string[];
  vars: VarTable;
  status: number;
  lastBg: number | null;
  pid: number;
  pgid: number;
  uid: number;
  version: string;
  jobs: JobTable;
  /** The foreground job while the shell waits for it. */
  fg: Job | null;
  hist: HistoryState;
  ed: EditorState | null;
  /** Keyboard input not yet consumed: an incomplete UTF-8 tail and decoded text. */
  input: { bytes: number[]; text: string };
  exec: ExecCursor | null;
  /** `name → manifest path` (§3.7.2); cleared when PATH changes. */
  cmdCache: Record<string, string>;
  /** The shell's own terminal mode, restored after every foreground job (I-SH2). */
  ttyMode: TtyMode | null;
  lineNo: number;
  /** Line number of the "There are stopped jobs." warning, or -1. */
  exitWarnedLine: number;
  exitCode: number | null;
  sig: { intr: boolean; winch: boolean };
  /** The degraded-completion notice has been printed (SHL-17). */
  completeNotice: boolean;
}

export interface Sh {
  readonly sys: Sys;
  readonly st: ShellState;
  readonly tick: symbol;
}

export const DEFAULT_VERSION = '0.3.0';

export function newState(argv: readonly string[]): ShellState {
  return {
    v: 1,
    argv: [...argv],
    mode: 'stdin',
    forceInteractive: false,
    phase: 'start',
    login: false,
    command: null,
    scriptPath: null,
    name: 'sh',
    positional: [],
    vars: newVars(),
    status: 0,
    lastBg: null,
    pid: 0,
    pgid: 0,
    uid: 0,
    version: DEFAULT_VERSION,
    jobs: newJobTable(),
    fg: null,
    hist: newHistory(),
    ed: null,
    input: { bytes: [], text: '' },
    exec: null,
    cmdCache: {},
    ttyMode: null,
    lineNo: 0,
    exitWarnedLine: -1,
    exitCode: null,
    sig: { intr: false, winch: false },
    completeNotice: false,
  };
}

export function jobControl(st: ShellState): boolean {
  return st.mode === 'interactive';
}

export function varOr(st: ShellState, name: string, fallback: string): string {
  return getVar(st.vars, name) ?? fallback;
}

/** Writes to a descriptor, ignoring failures: the shell cannot report a broken stdout or stderr. */
export function* put(sh: Sh, fd: number, text: string): SysGen<void> {
  try {
    yield* writeText(sh.sys, fd, text);
  } catch (e) {
    // Nothing to report to: this is the channel diagnostics would go to.
    if (errnoOf(e) === undefined) throw e;
  }
}

export function* out(sh: Sh, text: string): SysGen<void> {
  yield* put(sh, 1, text);
}

export function* err(sh: Sh, text: string): SysGen<void> {
  yield* put(sh, 2, text);
}
