/**
 * The job table (shell-and-terminal.md §3.8 and §4.4; processes-and-scheduling.md §3.17.3).
 * Pure data and pure functions; the system calls that feed it live in exec.ts and builtins/jobs.ts.
 */
import type { SignalName, WaitStatus } from '@plotinium/protocol';
import { signalExitStatus } from '@plotinium/protocol';

export type JobState = 'running' | 'stopped' | 'done';
export type StopSignal = 'SIGTSTP' | 'SIGSTOP' | 'SIGTTIN' | 'SIGTTOU';

export interface TtyMode {
  canonical: boolean;
  echo: boolean;
  isig: boolean;
}

export interface EndStatus {
  code: number;
  signal: SignalName | null;
}

export interface Job {
  /** 0 while a foreground job has never been stopped. */
  id: number;
  pgid: number;
  pids: number[];
  text: string;
  state: JobState;
  /** Exit statuses by pid, filled as the processes end. */
  ended: Record<string, EndStatus>;
  /** The pipeline status when its last command could not be started (126, 127, 1). */
  fixed: number | null;
  stopReason?: StopSignal;
  /** The job's terminal mode, saved when it stopped and restored by `fg`. */
  mode?: TtyMode;
  notified: boolean;
}

export interface JobTable {
  list: Job[];
  /** Job ids, most recently used first: [0] is `%+`, [1] is `%-`. */
  order: number[];
}

export function newJobTable(): JobTable {
  return { list: [], order: [] };
}

export function newJob(pgid: number, pids: number[], text: string): Job {
  return { id: 0, pgid, pids, text, state: 'running', ended: {}, fixed: null, notified: false };
}

function smallestFreeId(t: JobTable): number {
  const used = new Set(t.list.map((j) => j.id));
  let id = 1;
  while (used.has(id)) id++;
  return id;
}

/** Adds a job (keeping its id when it already has one) and makes it the current job. */
export function addJob(t: JobTable, job: Job): Job {
  if (job.id === 0 || t.list.some((j) => j.id === job.id)) job.id = smallestFreeId(t);
  t.list.push(job);
  t.list.sort((a, b) => a.id - b.id);
  touchJob(t, job.id);
  return job;
}

export function touchJob(t: JobTable, id: number): void {
  t.order = [id, ...t.order.filter((x) => x !== id)];
}

export function removeJob(t: JobTable, id: number): void {
  t.list = t.list.filter((j) => j.id !== id);
  t.order = t.order.filter((x) => x !== id);
}

export function findJob(t: JobTable, id: number): Job | undefined {
  return t.list.find((j) => j.id === id);
}

export function jobOfPid(t: JobTable, pid: number): Job | undefined {
  return t.list.find((j) => j.pids.includes(pid));
}

/** `+` for the current job, `-` for the previous one, a space otherwise. */
export function jobMark(t: JobTable, id: number): string {
  if (t.order[0] === id) return '+';
  if (t.order[1] === id) return '-';
  return ' ';
}

export type SpecResult = { ok: true; job: Job } | { ok: false; message: string };

/**
 * Resolves a job spec: `%%`, `%+`, `%`, `%-`, `%n`, `%?text`, `%text`, or a bare job number.
 * `cmd` prefixes the error message (`fg: %5: no such job`).
 */
export function resolveJobSpec(t: JobTable, spec: string | undefined, cmd: string): SpecResult {
  const none = (s: string): SpecResult => ({ ok: false, message: `${cmd}: ${s}: no such job` });
  if (spec === undefined || spec === '%%' || spec === '%+' || spec === '%') {
    const job = findJob(t, t.order[0] ?? 0);
    return job ? { ok: true, job } : { ok: false, message: `${cmd}: no current job` };
  }
  if (spec === '%-') {
    const job = findJob(t, t.order[1] ?? 0);
    return job ? { ok: true, job } : none(spec);
  }
  const body = spec.startsWith('%') ? spec.slice(1) : spec;
  if (/^[0-9]+$/.test(body)) {
    const job = findJob(t, Number(body));
    return job ? { ok: true, job } : none(spec);
  }
  if (!spec.startsWith('%')) return none(spec);
  const match = body.startsWith('?')
    ? (j: Job): boolean => j.text.includes(body.slice(1))
    : (j: Job): boolean => j.text.startsWith(body);
  const hit = t.order.map((id) => findJob(t, id)).find((j) => j !== undefined && match(j));
  return hit ? { ok: true, job: hit } : none(spec);
}

/** Every process of the job has ended. */
export function jobDone(job: Job): boolean {
  return job.pids.every((pid) => Object.hasOwn(job.ended, String(pid)));
}

/** Records one wait result on the job. */
export function applyWait(job: Job, pid: number, status: WaitStatus): void {
  switch (status.kind) {
    case 'exited':
      job.ended[String(pid)] = { code: status.code, signal: null };
      break;
    case 'signaled':
      job.ended[String(pid)] = { code: status.code, signal: status.signal };
      break;
    case 'stopped':
      job.state = 'stopped';
      job.stopReason = asStopSignal(status.signal);
      job.notified = false;
      break;
    case 'continued':
      job.state = 'running';
      break;
  }
  if (jobDone(job) && job.state !== 'done') {
    job.state = 'done';
    job.notified = false;
  }
}

function asStopSignal(sig: SignalName): StopSignal {
  return sig === 'SIGTTIN' || sig === 'SIGTTOU' || sig === 'SIGSTOP' ? sig : 'SIGTSTP';
}

/** The status of the last process of the pipeline (§3.7.3). */
export function lastEnd(job: Job): EndStatus | undefined {
  const last = job.pids.at(-1);
  return last === undefined ? undefined : job.ended[String(last)];
}

export function jobStatus(job: Job): number {
  if (job.fixed !== null) return job.fixed;
  return lastEnd(job)?.code ?? 0;
}

/** Status `$?` gets when a foreground job stops: 128 + the stop signal. */
export function stoppedStatus(job: Job): number {
  return signalExitStatus(job.stopReason ?? 'SIGTSTP');
}

const SIGNAL_TEXT: Partial<Record<SignalName, string>> = {
  SIGHUP: 'Hangup',
  SIGINT: 'Interrupt',
  SIGQUIT: 'Quit',
  SIGKILL: 'Killed',
  SIGPIPE: 'Broken pipe',
  SIGTERM: 'Terminated',
  SIGUSR1: 'User defined signal 1',
  SIGUSR2: 'User defined signal 2',
};

export function signalText(sig: SignalName): string {
  return SIGNAL_TEXT[sig] ?? sig;
}

/** The state column of `jobs` and of the notices (§3.8). */
export function stateText(job: Job): string {
  if (job.state === 'running') return 'Running';
  if (job.state === 'stopped') {
    if (job.stopReason === 'SIGTTIN') return 'Stopped (tty input)';
    if (job.stopReason === 'SIGTTOU') return 'Stopped (tty output)';
    return 'Stopped';
  }
  if (job.fixed === null) {
    const end = lastEnd(job);
    if (end?.signal != null) return signalText(end.signal);
  }
  const code = jobStatus(job);
  return code === 0 ? 'Done' : `Exit ${code}`;
}

/** `[1]+  Stopped                 top` (the state padded to 24 columns). */
export function jobLine(
  t: JobTable,
  job: Job,
  opts: { pgid?: boolean; tty?: boolean } = {},
): string {
  const state = stateText(job);
  const pad = state.length >= 24 ? `${state} ` : state.padEnd(24);
  const amp = job.state === 'running' ? ' &' : '';
  const pg = opts.pgid === true ? ` ${String(job.pgid).padStart(5)}` : ' ';
  const text = opts.tty === false ? job.text : safeText(job.text);
  return `[${job.id}]${jobMark(t, job.id)}${pg} ${pad}${text}${amp}`;
}

// eslint-disable-next-line no-control-regex -- C0 and C1 controls are what gets replaced
const UNSAFE = /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g;

/**
 * Command lines shown on a terminal have control and bidirectional-override characters replaced
 * with `?` (SHL-13), so a pasted escape sequence cannot restyle the terminal from `jobs`.
 */
export function safeText(text: string): string {
  return text.replace(UNSAFE, '?');
}

/** Stopped jobs block the first `exit` (§3.8). */
export function hasStoppedJobs(t: JobTable): boolean {
  return t.list.some((j) => j.state === 'stopped');
}
