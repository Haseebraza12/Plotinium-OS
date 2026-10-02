/**
 * Job-control builtins: `jobs` (§3.14.27), `fg` (§3.14.29), `bg` (§3.14.28), `wait` (§3.8).
 * Kernel calls as fixed by processes-and-scheduling.md §3.17.3.
 */
import type { SysGen } from '../../src/_sys.ts';
import { errnoOf } from '../../src/_sys.ts';
import type { Job } from '../jobs.ts';
import {
  jobDone,
  jobLine,
  jobOfPid,
  jobStatus,
  removeJob,
  resolveJobSpec,
  stoppedStatus,
  touchJob,
} from '../jobs.ts';
import type { Sh } from '../state.ts';
import { err, jobControl, out } from '../state.ts';
import { reap, toForeground, waitForeground, waitJob } from '../wait.ts';
import { shortOpts, usage } from './common.ts';

/** Whether fd is a terminal (§3.13 "TTY detection"). */
function* isTty(sh: Sh, fd: number): SysGen<boolean> {
  try {
    return (yield* sh.sys.call('isatty', { fd })).tty;
  } catch (e) {
    if (errnoOf(e) === undefined) throw e;
    return false;
  }
}

function* cont(sh: Sh, job: Job): SysGen<void> {
  try {
    yield* sh.sys.call('kill', { pid: -job.pgid, sig: 'SIGCONT' });
  } catch (e) {
    if (errnoOf(e) === undefined) throw e;
  }
}

/** Picks the jobs named by `specs` (all jobs when there are none), collecting error text. */
function select(sh: Sh, specs: readonly string[], cmd: string): { jobs: Job[]; errors: string } {
  const t = sh.st.jobs;
  if (specs.length === 0) return { jobs: [...t.list], errors: '' };
  const jobs: Job[] = [];
  let errors = '';
  for (const spec of specs) {
    const r = resolveJobSpec(t, spec, cmd);
    if (r.ok) jobs.push(r.job);
    else errors += `${r.message}\n`;
  }
  return { jobs, errors };
}

/** `jobs` lines; finished jobs are shown once and dropped (pure). */
export function listJobs(
  sh: Sh,
  jobs: readonly Job[],
  flags: ReadonlySet<string>,
  tty: boolean,
): string {
  const t = sh.st.jobs;
  const text = jobs
    .map((j) =>
      flags.has('p') ? `${j.pgid}\n` : `${jobLine(t, j, { pgid: flags.has('l'), tty })}\n`,
    )
    .join('');
  jobs.forEach((j) => {
    j.notified = true;
    if (j.state === 'done') removeJob(t, j.id);
  });
  return text;
}

export function* jobsBuiltin(sh: Sh, argv: readonly string[]): SysGen<number> {
  const { flags, rest, bad } = shortOpts(argv.slice(1), 'lp');
  if (bad !== null) return yield* usage(sh, 'jobs', bad, 'jobs [-l] [-p] [%JOB...]');
  yield* reap(sh);
  const { jobs, errors } = select(sh, rest, 'jobs');
  const tty = yield* isTty(sh, 1);
  yield* out(sh, listJobs(sh, jobs, flags, tty));
  if (errors.length > 0) yield* err(sh, errors);
  return errors.length > 0 ? 1 : 0;
}

export function* fgBuiltin(sh: Sh, argv: readonly string[]): SysGen<number> {
  const st = sh.st;
  if (!jobControl(st)) {
    yield* err(sh, 'fg: no job control\n');
    return 1;
  }
  yield* reap(sh);
  const r = resolveJobSpec(st.jobs, argv[1], 'fg');
  if (!r.ok) {
    yield* err(sh, `${r.message}\n`);
    return 1;
  }
  const job = r.job;
  removeJob(st.jobs, job.id);
  if (job.state === 'done') return jobStatus(job);
  yield* out(sh, `${job.text}\n`);
  st.fg = job;
  job.state = 'running';
  job.notified = false;
  yield* toForeground(sh, job);
  yield* cont(sh, job);
  return yield* waitForeground(sh);
}

export function* bgBuiltin(sh: Sh, argv: readonly string[]): SysGen<number> {
  const st = sh.st;
  if (!jobControl(st)) {
    yield* err(sh, 'bg: no job control\n');
    return 1;
  }
  const specs = argv.length > 1 ? argv.slice(1) : [undefined];
  let status = 0;
  for (const spec of specs) {
    const r = resolveJobSpec(st.jobs, spec, 'bg');
    if (!r.ok) {
      yield* err(sh, `${r.message}\n`);
      status = 1;
    } else if (r.job.state !== 'stopped') {
      yield* err(sh, `bg: job ${r.job.id} already in background\n`);
      status = 1;
    } else {
      const job = r.job;
      touchJob(st.jobs, job.id);
      job.state = 'running';
      yield* cont(sh, job);
      yield* out(sh, `[${job.id}]+ ${job.text} &\n`);
    }
  }
  return status;
}

/** `wait [%JOB | PID]...`: all background jobs by default; Ctrl-C interrupts it with 130. */
export function* waitBuiltin(sh: Sh, argv: readonly string[]): SysGen<number> {
  const st = sh.st;
  const specs = argv.slice(1);
  const targets: Job[] = [];
  let status = 0;
  for (const spec of specs) {
    const job = /^[0-9]+$/.test(spec) ? jobOfPid(st.jobs, Number(spec)) : undefined;
    const r = job ? { ok: true as const, job } : resolveJobSpec(st.jobs, spec, 'wait');
    if (r.ok) targets.push(r.job);
    else {
      yield* err(sh, `${r.message}\n`);
      status = 127;
    }
  }
  if (specs.length === 0) targets.push(...st.jobs.list.filter((j) => j.state === 'running'));
  for (const job of targets) {
    const done = yield* waitJob(sh, job);
    if (!done) return 130;
    status = job.state === 'stopped' ? stoppedStatus(job) : jobStatus(job);
    if (jobDone(job)) removeJob(st.jobs, job.id);
  }
  return specs.length === 0 ? 0 : status;
}
