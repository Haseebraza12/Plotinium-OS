/**
 * AI subsystem C, prediction and telemetry (syscall-abi.md §4.4.10 C; owned by
 * predictive-prefetch.md). Telemetry events are written by the kernel from `proc.spawn` and `wm.*`
 * into the per-uid ring; that is not a syscall. Nothing leaves the device without the opt-in flag
 * (Spec: MUST, PRE-05). Events hold application ids only: no file names, paths, window titles or
 * document content.
 */
import * as v from 'valibot';

import { TELEMETRY_RING_SIZE } from '../limits.ts';
import { AppId, Count, EpochMs, Ino, Ratio } from '../sys/common.ts';

/** The predictor's back-off chain (C12): Markov-2, Markov-1, time-bucket MFU, global MFU. */
export const PredictModel = v.picklist(['markov2', 'markov1', 'mfu-bucket', 'mfu']);

export const Prediction = v.strictObject({
  app: AppId,
  confidence: Ratio,
  /** Short explanation shown by `predict` and the Task Manager (PRE-06). */
  reason: v.pipe(v.string(), v.maxLength(200)),
});

/** predictive-prefetch.md §3.2. */
export const TelemetryEvent = v.strictObject({
  v: v.literal(1),
  seq: Count,
  /** Epoch ms. */
  ts: EpochMs,
  /** Local offset when recorded. */
  tzOffsetMin: v.pipe(v.number(), v.integer(), v.minValue(-840), v.maxValue(840)),
  kind: v.picklist(['launch', 'focus', 'close']),
  app: AppId,
  /** Previous launched app in this OS session (launch only). */
  prev: v.nullable(AppId),
  /** floor(localHour / 4). */
  hourBucket: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(5)),
  /** Local day of week, 0 = Sunday. */
  dow: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(6)),
  weekend: v.boolean(),
  /** 1-based launch index within the OS session. */
  sessionPos: v.pipe(v.number(), v.integer(), v.minValue(1)),
  origin: v.picklist(['user', 'restore']),
  osSessionId: Ino,
});

export const PredictArgs = v.strictObject({
  k: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(10))),
});
export const PredictRet = v.strictObject({
  predictions: v.pipe(v.array(Prediction), v.maxLength(10)),
  model: PredictModel,
  launches: Count,
  updatedAt: EpochMs,
});

export const PredictPublishArgs = v.strictObject({
  predictions: v.pipe(v.array(Prediction), v.maxLength(10)),
  model: PredictModel,
  launches: Count,
});
export const PredictPublishRet = v.strictObject({});

export const TelemetryReadArgs = v.strictObject({
  /** Return events with `seq` greater than this. */
  since: v.optional(Count),
  limit: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(TELEMETRY_RING_SIZE)),
  ),
});
export const TelemetryReadRet = v.strictObject({
  events: v.pipe(v.array(TelemetryEvent), v.maxLength(TELEMETRY_RING_SIZE)),
  /** Pass as `since` to continue. */
  next: v.optional(Count),
});

export const TelemetryClearArgs = v.strictObject({});
export const TelemetryClearRet = v.strictObject({ cleared: Count });

export const TelemetryExportArgs = v.strictObject({});
/** JSON Lines, transferred. */
export const TelemetryExportRet = v.instance(ArrayBuffer);

export const TelemetryOptinArgs = v.strictObject({ on: v.boolean() });
/** `synced`: the server has the flag (sent when online). */
export const TelemetryOptinRet = v.strictObject({ on: v.boolean(), synced: v.boolean() });

export type TelemetryEvent = v.InferOutput<typeof TelemetryEvent>;
export type Prediction = v.InferOutput<typeof Prediction>;
export type PredictModel = v.InferOutput<typeof PredictModel>;
