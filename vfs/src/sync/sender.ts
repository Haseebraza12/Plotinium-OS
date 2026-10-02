/**
 * The client send loop (offline-and-sync.md §5.2, §3.9; C6, SYN-06) as a pure planning function.
 *
 * Records are examined in commit order. A record whose principal the connection cannot authorise is
 * held (`principal-auth`) and skipped; a record whose blobs are not on the server yet starts their
 * upload and stops the scan (an op is never sent before its blobs, and order is kept); a record
 * larger than OP_ENVELOPE_MAX goes over `POST /api/ops/{opId}` only at the head of an empty window;
 * everything else is packed, in order, into one frame of at most `min(MAX_BATCH, credit)` ops and
 * MAX_PAYLOAD bytes.
 */
import { MAX_BATCH, MAX_PAYLOAD, OP_ENVELOPE_MAX } from '@plotinium/protocol';

import type { OutboxQueue } from './outbox.ts';
import type { QueueEntry } from './types.ts';

/** Bytes of the frame around the ops: `{"v":1,"t":"op.batch","id":…,"body":{"ops":[…]}}` and an ack. */
export const FRAME_OVERHEAD_BYTES = 1_024;

export type BlobReadiness = 'ready' | 'uploading' | 'unknown';

export interface SendContext {
  /** Credits left in the window (the advertised window minus ops in flight). */
  readonly credit: number;
  /** Ops sent on this connection without a result yet (including an HTTP op). */
  readonly inflight: number;
  /** An op is in flight over `POST /api/ops/{opId}`: nothing else is sent meanwhile. */
  readonly httpBusy: boolean;
  /** The connection may send ops of this principal (§3.8.6). */
  readonly allowed: (principal: number) => boolean;
  readonly blob: (sha: string) => BlobReadiness;
  readonly maxBatch?: number;
  readonly maxPayload?: number;
  readonly opEnvelopeMax?: number;
}

export interface SendPlan {
  /** Ops for one `op.submit` (1) or `op.batch` (2..32) frame, in commit order. */
  readonly frame: QueueEntry[];
  /** An oversized op to POST instead (only when `frame` is empty). */
  http: QueueEntry | null;
  /** Blobs to upload before the op at the head can go. */
  readonly upload: string[];
  /** Records that became held, and why. */
  readonly holds: {
    readonly entry: QueueEntry;
    readonly reason: 'principal-auth' | 'blob-upload';
  }[];
}

/** One send decision (§5.2). O(k) for the k records examined. */
export function planSend(queue: OutboxQueue, ctx: SendContext): SendPlan {
  const maxBatch = ctx.maxBatch ?? MAX_BATCH;
  const maxPayload = ctx.maxPayload ?? MAX_PAYLOAD;
  const envelopeMax = ctx.opEnvelopeMax ?? OP_ENVELOPE_MAX;
  const plan: SendPlan = { frame: [], http: null, upload: [], holds: [] };
  if (ctx.httpBusy) return plan;
  const limit = Math.min(maxBatch, Math.max(0, ctx.credit));
  let bytes = FRAME_OVERHEAD_BYTES;
  for (const e of queue.all()) {
    if (e.sent || e.rec.state === 'parked' || e.held === 'parked') continue;
    if (e.reserved || e.locked) break; // being rewritten (coalescing, cascade): keep commit order
    if (!ctx.allowed(e.rec.principal)) {
      if (e.held !== 'principal-auth') plan.holds.push({ entry: e, reason: 'principal-auth' });
      continue;
    }
    const missing = e.rec.blobs.filter((sha) => ctx.blob(sha) !== 'ready');
    if (missing.length > 0) {
      for (const sha of missing)
        if (ctx.blob(sha) === 'unknown' && !plan.upload.includes(sha)) plan.upload.push(sha);
      if (e.held !== 'blob-upload') plan.holds.push({ entry: e, reason: 'blob-upload' });
      break;
    }
    const size = queue.sizeOf(e);
    if (size > envelopeMax) {
      if (ctx.inflight === 0 && plan.frame.length === 0) plan.http = e;
      break;
    }
    if (plan.frame.length >= limit || bytes + size + 1 > maxPayload) break;
    plan.frame.push(e);
    bytes += size + 1;
  }
  return plan;
}
