/**
 * `prefetch:<app>`: one speculative warm-up job (predictive-prefetch.md §3.5; PRE-04, PRE-06;
 * AIN-C2, AIN-C3; I-C3, I-C5).
 *
 * Spawned by the kernel's pre-fetch policy (the `SchedulerHints` seam) at priority 39 — the lowest
 * — with capabilities `mm.speculative` and `fs.read` only, as the login uid, and visible in `ps`.
 * Each step is one quantum and the job yields between them:
 *   1. `mem.prefetch({app})`: the app's code chunks (its dependency closure, resolved by the kernel
 *      with dsa/dag) and its last saved state as SPECULATIVE pages (evicted first, discarded
 *      after 5 min unless the app is launched). EAGAIN means the reservation would need reclaim
 *      of non-speculative pages: the job ends at once (never blocking, I-C5).
 *   2. `mem.prefetch({ino})` for up to 8 recent files the kernel passed as `--ino=<id>`
 *      (inode + first chunk); EACCES or ENOENT skips the file.
 *   3. exit 0.
 * The job never writes anything: no call it makes can mutate the VFS, swap or a store (I-C3).
 */
import { type AiProgram, type AiProgramContext, type SysGen, attempt, errnoOf } from './model.ts';

export const PREFETCH_FILES_MAX = 8;

export interface PrefetchState {
  app: string;
  inos: string[];
  bytes: number;
  pages: number;
}

/** argv: `prefetch:<app>` [--ino=<uuid>]… (argv[0] names the app, as `ps` shows it). */
export function initPrefetch(argv: readonly string[]): PrefetchState {
  const name = argv[0] ?? '';
  const app = name.startsWith('prefetch:') ? name.slice('prefetch:'.length) : (argv[1] ?? '');
  const inos = argv
    .filter((a) => a.startsWith('--ino='))
    .map((a) => a.slice('--ino='.length))
    .slice(0, PREFETCH_FILES_MAX);
  return { app, inos, bytes: 0, pages: 0 };
}

export function* runPrefetch(ctx: AiProgramContext, st: PrefetchState): SysGen<number> {
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(st.app)) return 2;
  const code = yield* attempt(ctx.sys, 'mem.prefetch', { app: st.app });
  if (!code.ok) return code.errno === 'EAGAIN' ? 0 : 1;
  st.bytes += code.value.bytes;
  st.pages += code.value.pages;
  yield ctx.tick;
  for (const ino of st.inos) {
    try {
      const r = yield* ctx.sys.call('mem.prefetch', { ino });
      st.bytes += r.bytes;
      st.pages += r.pages;
    } catch (e) {
      const errno = errnoOf(e);
      if (errno === 'EAGAIN') return 0;
      if (errno !== 'EACCES' && errno !== 'ENOENT') throw e;
    }
    yield ctx.tick;
  }
  return 0;
}

const program: AiProgram<PrefetchState> = {
  checkpointable: true,
  init: initPrefetch,
  run: runPrefetch,
};

export default program;
