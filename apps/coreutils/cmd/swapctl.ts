/**
 * `swapctl [status] | tier auto|local|remote | --tier MODE | drop-local [PID] | checkpoint PID |
 * bench [--size SIZE] [--tier local|remote] [-n N]` (memory-and-paging.md §3.17.4,
 * shell-and-terminal.md §3.14.51). `bench` checks MEM-05: local p95 ≤ 300 ms, remote p95 ≤ 2 s.
 */
import { defineCommand, parseFor, UsageError } from '../lib/command.ts';
import { describe, mustErrno } from '../lib/errors.ts';
import { binSize } from '../lib/format.ts';
import type { Io } from '../lib/io.ts';
import { extCall } from '../lib/sys.ts';
import type { CoreExtraCalls, SysGen } from '../lib/sys.ts';

type Tier = 'auto' | 'local' | 'remote';

export type SwapctlOpts =
  | { readonly sub: 'status' }
  | { readonly sub: 'tier'; readonly tier: Tier }
  | { readonly sub: 'drop-local'; readonly pid: number | null }
  | { readonly sub: 'checkpoint'; readonly pid: number }
  | {
      readonly sub: 'bench';
      readonly size: number;
      readonly tier: 'local' | 'remote';
      readonly n: number;
    };

const UNITS: Readonly<Record<string, number>> = { '': 1, K: 1024, M: 1_048_576, G: 1_073_741_824 };

export function parseSize(text: string): number | null {
  const m = /^(\d+(?:\.\d+)?)([KMG]?)i?B?$/i.exec(text);
  if (m === null) return null;
  const bytes = Number(m[1]) * (UNITS[(m[2] ?? '').toUpperCase()] ?? 1);
  return bytes >= 1 ? Math.round(bytes) : null;
}

function tierOf(text: string | undefined): Tier {
  if (text === 'auto' || text === 'local' || text === 'remote') return text;
  throw new UsageError(`invalid tier '${text ?? ''}' (auto, local or remote)`);
}

function pidOf(text: string | undefined): number {
  const pid = Number(text);
  if (text === undefined || !Number.isInteger(pid) || pid < 1)
    throw new UsageError(`invalid PID '${text ?? ''}'`);
  return pid;
}

export function parseSwapctl(args: readonly string[]): SwapctlOpts {
  const p = parseFor('swapctl', args);
  const [sub, arg, extra] = p.operands;
  if (extra !== undefined) throw new UsageError(`extra operand '${extra}'`);
  if (sub === 'bench') {
    const size = parseSize(p.value('size') ?? '5M');
    const n = Number(p.value('n') ?? '20');
    const tier = p.value('tier') ?? 'local';
    if (size === null) throw new UsageError(`invalid size '${p.value('size') ?? ''}'`);
    if (!Number.isInteger(n) || n < 1)
      throw new UsageError(`invalid count '${p.value('n') ?? ''}'`);
    if (tier !== 'local' && tier !== 'remote')
      throw new UsageError(`invalid bench tier '${tier}' (local or remote)`);
    return { sub: 'bench', size, tier, n };
  }
  if (sub === undefined && p.has('tier')) return { sub: 'tier', tier: tierOf(p.value('tier')) };
  if (sub === undefined || sub === 'status') return { sub: 'status' };
  if (sub === 'tier') return { sub: 'tier', tier: tierOf(arg) };
  if (sub === 'drop-local')
    return { sub: 'drop-local', pid: arg === undefined ? null : pidOf(arg) };
  if (sub === 'checkpoint') return { sub: 'checkpoint', pid: pidOf(arg) };
  throw new UsageError(`unknown command '${sub}'`);
}

type SwapStat = CoreExtraCalls['swap.stat']['ret'];

export function statusLines(s: SwapStat, uid: number): string[] {
  return [
    `tier: ${s.policy}   device: ${s.device}   fallback: ${s.fallback}   uid: ${uid}`,
    `local:  ${binSize(s.local.bytes)} (${s.local.pages} pages)`,
    `remote: ${binSize(s.remote.bytes)} (${s.remote.pages} pages acked, ${s.queue.pages} pending)`,
  ];
}

export function benchLine(
  tier: 'local' | 'remote',
  p95Ms: number,
): { line: string; pass: boolean } {
  const budget = tier === 'local' ? 300 : 2000;
  const pass = p95Ms <= budget;
  const limit = tier === 'local' ? '≤ 300 ms' : '≤ 2 s';
  return {
    line: `MEM-05 ${tier} p95 ${Math.round(p95Ms)} ms (${limit}) ${pass ? 'PASS' : 'FAIL'}`,
    pass,
  };
}

function* status(io: Io): SysGen<void> {
  try {
    yield* io.lines(statusLines(yield* extCall(io.sys, 'swap.stat', {}), io.ctx.uid));
  } catch (e) {
    if (mustErrno(e) !== 'ENOSYS') throw e;
    // Until swap.stat lands, the byte counts come from statfs.
    const fs = yield* io.sys.call('statfs', {});
    yield* io.lines([
      `local:  ${binSize(fs.swapBytes.local)}`,
      `remote: ${binSize(fs.swapBytes.remote)}`,
      'tier and device: unavailable (swap.stat not implemented)',
    ]);
  }
}

export default defineCommand<SwapctlOpts>({
  name: 'swapctl',
  parse: parseSwapctl,
  *run(io, opts) {
    try {
      switch (opts.sub) {
        case 'status':
          yield* status(io);
          return 0;
        case 'tier':
          yield* extCall(io.sys, 'swap.ctl', { tier: opts.tier });
          yield* io.line(`swapctl: tier policy is now ${opts.tier}`);
          return 0;
        case 'drop-local': {
          const res = yield* extCall(io.sys, 'swap.ctl', {
            dropLocal: true,
            ...(opts.pid === null ? {} : { pid: opts.pid }),
          });
          yield* io.line(`swapctl: dropped ${res.dropped ?? 0} local copies`);
          return 0;
        }
        case 'checkpoint': {
          const res = yield* extCall(io.sys, 'swap.checkpoint', { pid: opts.pid });
          yield* io.line(`swapctl: checkpointed ${opts.pid} (${binSize(res.bytes)})`);
          return 0;
        }
        case 'bench': {
          const res = yield* extCall(io.sys, 'swap.bench', {
            size: opts.size,
            tier: opts.tier,
            n: opts.n,
          });
          const out = benchLine(opts.tier, res.p95Ms);
          yield* io.line(out.line);
          return out.pass ? 0 : 1;
        }
      }
    } catch (e) {
      const errno = mustErrno(e);
      if (errno === 'EAGAIN' && (opts.sub === 'tier' || opts.sub === 'bench'))
        yield* io.error('remote tier needs a connection');
      else yield* io.error(describe(e));
      return 1;
    }
  },
});
