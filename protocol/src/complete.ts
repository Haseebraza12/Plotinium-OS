/**
 * Completion service shapes (shell-and-terminal.md §4.5; SYS-03, SHL-10).
 *
 * The `complete.*` calls are REQUESTED (marked † in shell-and-terminal.md §3.14 and §4.8): they are
 * not in the syscall-abi.md §4.4 catalogue yet, so they are deliberately absent from CALLS and the
 * dispatcher answers them ENOSYS. These schemas fix their argument and result shapes now, so the
 * shell, the `complete` service and the kernel agree on them; registering them in sys/registry.ts
 * waits for syscall-abi.md to accept the request (R1).
 *
 * For `path` the kernel resolves `dir` with the caller's credentials and checks `x` on every
 * ancestor and `r` on `dir`; for `hist` it stamps the caller's uid from the port. The service never
 * sees credentials (SHL-10).
 */
import * as v from 'valibot';

import { PATH_MAX } from './limits.ts';
import { Count, Path } from './sys/common.ts';

/** The four trie namespaces of data-structures.md §3.5 S2. */
export const COMPLETE_NAMESPACES = ['cmd', 'path', 'flag', 'hist'] as const;
export const CompleteNamespace = v.picklist(COMPLETE_NAMESPACES);
export type CompleteNamespace = v.InferOutput<typeof CompleteNamespace>;

/** The requested calls, in the order of shell-and-terminal.md §4.5 (not registered: see above). */
export const COMPLETE_CALLS = [
  'complete.query',
  'complete.hist.load',
  'complete.hist.add',
  'complete.hist.clear',
  'complete.stats',
  'complete.bench',
] as const;

export const COMPLETE_LIMIT_MAX = 100;
export const COMPLETE_LIMIT_DEFAULT = 100;
/** Plotinium bound on one history line (the history file holds at most 1,200 lines). */
export const HISTORY_LINE_MAX = 4_096;
export const HISTORY_LOAD_MAX = 1_200;

const Prefix = v.pipe(v.string(), v.maxLength(PATH_MAX));
const CommandName = v.pipe(v.string(), v.minLength(1), v.maxLength(64));
const HistoryLine = v.pipe(v.string(), v.maxLength(HISTORY_LINE_MAX));

/** `dir` is used by the `path` namespace (the caller's cwd when absent); `flag` needs `cmd`. */
export const CompleteQuery = v.pipe(
  v.strictObject({
    ns: CompleteNamespace,
    prefix: Prefix,
    limit: v.optional(
      v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(COMPLETE_LIMIT_MAX)),
      COMPLETE_LIMIT_DEFAULT,
    ),
    dir: v.optional(Path),
    cmd: v.optional(CommandName),
  }),
  v.check((q) => q.ns !== 'flag' || q.cmd !== undefined, 'the flag namespace needs cmd'),
  v.check((q) => q.dir === undefined || q.ns === 'path', 'dir applies to the path namespace only'),
);
export type CompleteQueryInput = v.InferInput<typeof CompleteQuery>;
export type CompleteQuery = v.InferOutput<typeof CompleteQuery>;

export const CompleteItem = v.strictObject({
  text: Prefix,
  kind: v.picklist(['builtin', 'program', 'd', 'f', 'l', 'flag', 'hist']),
  /** Flag description from the man page front matter. */
  desc: v.optional(v.pipe(v.string(), v.maxLength(80))),
  /** History sequence number. */
  seq: v.optional(Count),
});
export type CompleteItem = v.InferOutput<typeof CompleteItem>;

export const CompleteResult = v.strictObject({
  items: v.pipe(v.array(CompleteItem), v.maxLength(COMPLETE_LIMIT_MAX)),
  /** More candidates exist than `limit`. */
  truncated: v.boolean(),
  /** false while the directory is still being indexed (the shell may retry). */
  indexed: v.boolean(),
});
export type CompleteResult = v.InferOutput<typeof CompleteResult>;

export const CompleteHistLoadArgs = v.strictObject({
  lines: v.pipe(v.array(HistoryLine), v.maxLength(HISTORY_LOAD_MAX)),
});
export const CompleteHistAddArgs = v.strictObject({ line: HistoryLine });
export const CompleteHistClearArgs = v.strictObject({});

const NamespaceStats = v.strictObject({ entries: Count, bytes: Count });
export const CompleteStatsRet = v.strictObject({
  ns: v.strictObject({
    cmd: NamespaceStats,
    path: NamespaceStats,
    flag: NamespaceStats,
    hist: NamespaceStats,
  }),
});
export type CompleteStatsRet = v.InferOutput<typeof CompleteStatsRet>;

/** `complete --bench`: over an indexed directory OR N synthetic names, never both. */
export const CompleteBenchArgs = v.pipe(
  v.strictObject({
    ns: v.optional(CompleteNamespace, 'path'),
    dir: v.optional(Path),
    synthetic: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(1_000_000))),
    queries: v.optional(
      v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(1_000_000)),
      10_000,
    ),
    k: v.optional(
      v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(COMPLETE_LIMIT_MAX)),
      20,
    ),
    seed: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(0xffff_ffff)), 42),
  }),
  v.check(
    (a) => a.dir === undefined || a.synthetic === undefined,
    'dir and synthetic are exclusive',
  ),
);
export type CompleteBenchArgs = v.InferOutput<typeof CompleteBenchArgs>;

const Ms = v.pipe(v.number(), v.finite(), v.minValue(0));
/** Latencies in milliseconds (SYS-03 budget: p95 ≤ 1 ms at ≥ 10,000 entries). */
export const CompleteBenchRet = v.strictObject({
  p50: Ms,
  p95: Ms,
  p99: Ms,
  max: Ms,
  bytesPerEntry: v.pipe(v.number(), v.finite(), v.minValue(0)),
  entries: Count,
});
export type CompleteBenchRet = v.InferOutput<typeof CompleteBenchRet>;
