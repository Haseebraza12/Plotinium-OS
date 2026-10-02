/**
 * `predict [-n N] [--why] [--json] [--latency [APP]] [--eval]` (predictive-prefetch.md §3.8):
 * exit 0 predictions shown, 1 cold start (MFU ranking), 2 error.
 * TODO(R4): `--why`, `--latency` and `--eval` need the per-component probabilities, the latency
 * ring and the evaluation call, which are not in syscall-abi.md yet; they report ENOSYS.
 */
import type { PredictModel } from '@plotinium/protocol';

import { aiUnavailable } from '../lib/ai.ts';
import { defineCommand, parseFor, UsageError } from '../lib/command.ts';
import { describe } from '../lib/errors.ts';
import { clock } from '../lib/format.ts';

export interface PredictOpts {
  readonly n: number;
  readonly why: boolean;
  readonly json: boolean;
  readonly latency: string | true | null;
  readonly evaluate: boolean;
}

/** Below this many launches the predictor ranks by use only (cold start). */
export const COLD_START_LAUNCHES = 50;

const MODEL_NAME: Readonly<Record<PredictModel, string>> = {
  markov2: 'markov-2 (witten-bell)',
  markov1: 'markov-1 (back-off)',
  'mfu-bucket': 'time-bucket MFU',
  mfu: 'MFU',
};

export function modelLine(
  model: PredictModel,
  launches: number,
  updatedAt: number,
  tz: number,
): string {
  if (launches < COLD_START_LAUNCHES)
    return `MODEL  MFU fallback (${launches} of ${COLD_START_LAUNCHES} launches)`;
  return `MODEL  ${MODEL_NAME[model]} · ${launches} launches · updated ${clock(updatedAt, tz).slice(0, 5)}`;
}

export default defineCommand<PredictOpts>({
  name: 'predict',
  parse(args) {
    const p = parseFor('predict', args);
    const text = p.value('n') ?? p.value('k') ?? '3';
    const n = Number(text);
    if (!Number.isInteger(n) || n < 1 || n > 10)
      throw new UsageError(`invalid count '${text}' (1 to 10)`);
    if (p.operands.length > 0 && !p.has('latency'))
      throw new UsageError(`extra operand '${p.operands[0] ?? ''}'`);
    return {
      n,
      why: p.has('why') || p.has('explain'),
      json: p.has('json'),
      latency: p.has('latency') ? (p.operands[0] ?? true) : null,
      evaluate: p.has('eval'),
    };
  },
  *run(io, opts) {
    if (opts.latency !== null || opts.evaluate || opts.why) {
      const flag = opts.latency !== null ? '--latency' : opts.evaluate ? '--eval' : '--why';
      yield* io.error(`${flag}: Function not implemented`);
      return 2;
    }
    try {
      const res = yield* io.sys.call('ai.predict', { k: opts.n });
      if (opts.json) {
        yield* io.line(JSON.stringify(res));
        return 0;
      }
      const tz = yield* io.tzOffset();
      const width = Math.max(3, ...res.predictions.map((p) => p.app.length));
      yield* io.line(modelLine(res.model, res.launches, res.updatedAt, tz));
      yield* io.lines(
        res.predictions.map(
          (p, i) => `  ${i + 1}  ${p.app.padEnd(width)}  ${p.confidence.toFixed(2)}  ${p.reason}`,
        ),
      );
      return res.launches < COLD_START_LAUNCHES ? 1 : 0;
    } catch (e) {
      yield* io.error(aiUnavailable(e) === null ? describe(e) : 'predictor not running');
      return 2;
    }
  },
});
