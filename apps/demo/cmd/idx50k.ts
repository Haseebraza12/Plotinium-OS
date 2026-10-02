/**
 * idx50k: writes the 50 KB text file of the RAG-02 freshness demonstration ("create, modify,
 * rename and delete of a 50 KB text file are reflected within 30 s", rag-semantic-search.md §3.2.7)
 * in one `writeFile`, and with `--wait` times how long `semsearch` takes to find it.
 */
import type { ProgramContext, SysGen } from '@plotinium/kernel/sys';
import { errnoOf } from '@plotinium/kernel/sys';

import type { DemoState, Out } from '../lib/cli.ts';
import {
  clockMs,
  defineDemo,
  epochNow,
  errText,
  homeOf,
  intOption,
  nap,
  parseFor,
  seconds,
  sizeOption,
  statusFor,
  takeSignal,
  thousands,
  UsageError,
} from '../lib/cli.ts';
import { idxText, markerOf } from '../lib/prose.ts';

/** 50 KB as the kernel commands count it (K = 1,024 bytes). */
export const DEFAULT_SIZE = 51_200;
/** Spec RAG-02: a change is reflected within 30 s. */
export const RAG02_BUDGET_MS = 30_000;
export const DEFAULT_TIMEOUT_S = 60;
const POLL_MS = 1000;

export interface IdxOpts {
  readonly path: string | null;
  readonly size: number;
  readonly seed: number;
  readonly wait: boolean;
  readonly timeout: number;
  readonly query: string | null;
}

export interface IdxWork {
  path: string | null;
  ino: string | null;
  writtenAt: number | null;
  attempts: number;
}

export function parseIdx(args: readonly string[]): IdxOpts {
  const p = parseFor('idx50k', args);
  if (p.operands.length > 1) throw new UsageError(`idx50k: extra operand '${p.operands[1] ?? ''}'`);
  const rawSize = p.value('s');
  const rawSeed = p.value('seed');
  const rawTimeout = p.value('t');
  const query = p.value('q') ?? null;
  if (query !== null && (query.trim() === '' || query.length > 1000))
    throw new UsageError('idx50k: --query needs 1 to 1000 characters');
  if ((rawTimeout !== undefined || query !== null) && !p.has('w'))
    throw new UsageError('idx50k: --timeout and --query need --wait');
  const path = p.operands[0] ?? null;
  if (path === '') throw new UsageError("idx50k: invalid path ''");
  return {
    path,
    size:
      rawSize === undefined
        ? DEFAULT_SIZE
        : sizeOption('idx50k', '--size', rawSize, 1024, 16 * 1_048_576),
    seed: rawSeed === undefined ? 1 : intOption('idx50k', '--seed', rawSeed, 0, 0xffff_ffff),
    wait: p.has('w'),
    timeout:
      rawTimeout === undefined
        ? DEFAULT_TIMEOUT_S
        : intOption('idx50k', '--timeout', rawTimeout, 1, 3_600),
    query,
  };
}

function bytesOf(text: string): ArrayBuffer {
  const b = new TextEncoder().encode(text);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

export function verdict(ms: number): string {
  return `RAG-02 budget 30 s: ${ms <= RAG02_BUDGET_MS ? 'met' : 'missed'}`;
}

function* waitFound(
  ctx: ProgramContext,
  out: Out,
  o: IdxOpts,
  w: IdxWork,
  st: DemoState<IdxOpts, IdxWork>,
): SysGen<number> {
  const q = o.query ?? markerOf(o.seed);
  const writtenAt = w.writtenAt ?? (yield* epochNow(ctx)).epochMs;
  for (;;) {
    const sig = takeSignal(st);
    if (sig !== null) {
      yield* out.error(`stopped by ${sig} after ${String(w.attempts)} searches`);
      return statusFor(sig);
    }
    w.attempts++;
    try {
      const r = yield* ctx.sys.call('ai.semsearch', { q, k: 10 });
      const now = (yield* epochNow(ctx)).epochMs;
      const hit = r.results.find((res) => res.ino === w.ino);
      if (hit !== undefined) {
        const ms = now - writtenAt;
        yield* out.line(
          `idx50k: found by semsearch after ${seconds(ms)} (mode ${r.mode}, score ${hit.score.toFixed(2)}; ${verdict(ms)})`,
        );
        return 0;
      }
      if (now - writtenAt >= o.timeout * 1000) {
        yield* out.error(
          `not found by semsearch after ${String(o.timeout)} s (${verdict(now - writtenAt)})`,
        );
        return 1;
      }
    } catch (e) {
      const errno = errnoOf(e);
      if (errno === 'ECANCELED') continue;
      if (errno === undefined) throw e;
      yield* out.error(`semsearch unavailable: ${errText(e)}`);
      return 1;
    }
    yield* nap(ctx, POLL_MS);
  }
}

function* run(
  ctx: ProgramContext,
  out: Out,
  o: IdxOpts,
  w: IdxWork,
  st: DemoState<IdxOpts, IdxWork>,
): SysGen<number> {
  const path = (w.path ??= o.path ?? `${homeOf(ctx)}/idx50k.md`);
  if (w.ino === null) {
    const text = idxText(o.size, o.seed);
    try {
      const r = yield* ctx.sys.writeFile({ path, data: bytesOf(text), create: true, mode: 0o644 });
      const t = yield* epochNow(ctx);
      w.ino = r.ino;
      w.writtenAt = t.epochMs;
      yield* out.line(
        `idx50k: wrote ${thousands(r.bytes)} bytes to ${path} (version ${String(r.version)}) at ${clockMs(t.epochMs, t.tzOffsetMin)}; marker ${markerOf(o.seed)}`,
      );
    } catch (e) {
      yield* out.error(`cannot write '${path}': ${errText(e)}`);
      return 1;
    }
  }
  if (!o.wait) return 0;
  return yield* waitFound(ctx, out, o, w, st);
}

const idx50k = defineDemo<IdxOpts, IdxWork>({
  name: 'idx50k',
  catches: ['SIGINT', 'SIGTERM', 'SIGHUP'],
  parse: parseIdx,
  start: () => ({ path: null, ino: null, writtenAt: null, attempts: 0 }),
  run,
});

export default idx50k;
