/**
 * Waiting for jobs and handing the terminal back and forth (shell-and-terminal.md §3.7.3 steps
 * 5–6, §3.8; processes-and-scheduling.md §3.17.3). Invariant I-SH2: after a foreground job ends
 * or stops, the shell's group owns the TTY and the shell's saved mode is back.
 */
import type { WaitStatus } from '@plotinium/protocol';

import type { SysGen } from '../src/_sys.ts';
import { errnoOf } from '../src/_sys.ts';
import type { Job, JobTable, TtyMode } from './jobs.ts';
import {
  addJob,
  applyWait,
  jobDone,
  jobLine,
  jobOfPid,
  jobStatus,
  lastEnd,
  removeJob,
  signalText,
  stoppedStatus,
  touchJob,
} from './jobs.ts';
import type { Sh } from './state.ts';
import { err, jobControl } from './state.ts';

export const COOKED: TtyMode = { canonical: true, echo: true, isig: true };

/** Sets the terminal mode of fd 0; a shell without a terminal ignores the failure. */
export function* setMode(sh: Sh, mode: TtyMode): SysGen<void> {
  try {
    yield* sh.sys.call('tty.setattr', { fd: 0, ...mode });
  } catch (e) {
    if (errnoOf(e) === undefined) throw e;
  }
}

export function* getMode(sh: Sh): SysGen<TtyMode | null> {
  try {
    const a = yield* sh.sys.call('tty.getattr', { fd: 0 });
    return { canonical: a.canonical, echo: a.echo, isig: a.isig };
  } catch (e) {
    if (errnoOf(e) === undefined) throw e;
    return null;
  }
}

export function* giveTty(sh: Sh, pgid: number): SysGen<void> {
  try {
    yield* sh.sys.call('tcsetpgrp', { fd: 0, pgid });
  } catch (e) {
    if (errnoOf(e) === undefined) throw e;
  }
}

/** Gives the terminal to a job about to run in the foreground (§3.7.3 step 3). */
export function* toForeground(sh: Sh, job: Job): SysGen<void> {
  if (!jobControl(sh.st)) return;
  yield* giveTty(sh, job.pgid);
  yield* setMode(sh, job.mode ?? COOKED);
}

type WaitResult = { pid: number; status: WaitStatus } | 'none' | 'again';

function* waitOnce(
  sh: Sh,
  args: { pid: number; nohang?: boolean; untraced?: boolean; continued?: boolean },
): SysGen<WaitResult> {
  try {
    const r = yield* sh.sys.call('wait', args);
    return 'status' in r ? r : 'none';
  } catch (e) {
    const errno = errnoOf(e);
    if (errno === 'ESRCH') return 'none';
    if (errno === 'ECANCELED') return 'again';
    throw e;
  }
}

/** Records a wait result on the job that owns the pid (foreground job first). */
function route(sh: Sh, pid: number, status: WaitStatus): void {
  const fg = sh.st.fg;
  const job = fg?.pids.includes(pid) === true ? fg : jobOfPid(sh.st.jobs, pid);
  if (job) applyWait(job, pid, status);
}

function firstLive(job: Job): number | undefined {
  return job.pids.find((pid) => !Object.hasOwn(job.ended, String(pid)));
}

function markEnded(job: Job): void {
  job.pids.forEach((pid) => {
    if (!Object.hasOwn(job.ended, String(pid))) job.ended[String(pid)] = { code: 0, signal: null };
  });
  job.state = 'done';
}

/**
 * Waits until every process of the job ended or one stopped. With `interruptible`, a SIGINT to
 * the shell (Ctrl-C while the shell owns the terminal) ends the wait early and returns false.
 */
function* collect(sh: Sh, job: Job, interruptible: boolean): SysGen<boolean> {
  const st = sh.st;
  while (!jobDone(job) && job.state !== 'stopped') {
    const target = jobControl(st) ? -job.pgid : firstLive(job);
    if (target === undefined) break;
    const r = yield* waitOnce(sh, { pid: target, untraced: true });
    if (r === 'none') {
      // No such child any more (reaped elsewhere): treat the rest as ended.
      markEnded(job);
    } else if (r !== 'again') {
      route(sh, r.pid, r.status);
    } else if (interruptible && st.sig.intr) {
      st.sig.intr = false;
      return false;
    }
  }
  return true;
}

/** `wait` for one background job; false when Ctrl-C interrupted it (§3.8). */
export function* waitJob(sh: Sh, job: Job): SysGen<boolean> {
  return yield* collect(sh, job, true);
}

/**
 * Waits for `sh.st.fg` until every process ended or one stopped, then takes the terminal back.
 * Returns the pipeline status (`$?`). Re-entrant after a restore: all progress is in `st.fg`.
 */
export function* waitForeground(sh: Sh): SysGen<number> {
  const st = sh.st;
  const job = st.fg;
  if (job === null) return st.status;
  if (st.exec) st.exec.waiting = true;
  yield* collect(sh, job, false);
  if (st.exec) st.exec.waiting = false;
  st.fg = null;
  if (jobControl(st)) {
    if (job.state === 'stopped') job.mode = (yield* getMode(sh)) ?? COOKED;
    yield* giveTty(sh, st.pgid);
    if (st.ttyMode) yield* setMode(sh, st.ttyMode);
  }
  if (job.state === 'stopped') {
    addJob(st.jobs, job);
    job.notified = true;
    yield* err(sh, `${jobLine(st.jobs, job)}\n`);
    return stoppedStatus(job);
  }
  if (Object.values(job.ended).some((e) => e.signal === 'SIGINT')) st.sig.intr = true;
  const end = lastEnd(job);
  if (
    job.fixed === null &&
    end?.signal != null &&
    end.signal !== 'SIGINT' &&
    end.signal !== 'SIGPIPE'
  ) {
    yield* err(sh, `${signalText(end.signal)}\n`);
  }
  return jobStatus(job);
}

/** Collects background state changes without blocking (§3.8, before each prompt). */
export function* reap(sh: Sh): SysGen<void> {
  for (;;) {
    const r = yield* waitOnce(sh, { pid: -1, nohang: true, untraced: true, continued: true });
    if (r === 'none') return;
    if (r !== 'again') route(sh, r.pid, r.status);
  }
}

/** The pending `Done`, `Exit n` and `Stopped` notices; finished jobs are dropped (pure). */
export function takeNotices(t: JobTable): string {
  const pending = t.list.filter((j) => !j.notified && j.state !== 'running');
  pending.filter((j) => j.state === 'stopped').forEach((j) => touchJob(t, j.id));
  const text = pending.map((j) => `${jobLine(t, j)}\n`).join('');
  pending.forEach((j) => {
    j.notified = true;
    if (j.state === 'done') removeJob(t, j.id);
  });
  return text;
}

/** Prints the notices before the next prompt (§3.8). */
export function* notify(sh: Sh): SysGen<void> {
  const text = takeNotices(sh.st.jobs);
  if (text.length > 0) yield* err(sh, text);
}
