/**
 * WebSocket protocol v1: the inbound message router as a PURE function (offline-and-sync.md §4.1,
 * §4.3, §4.5, §3.16.3 rule 4, §6; SYN-01, SYN-02, SYN-03, SYN-13).
 *
 *   routeFrame(state, raw, now) -> { state, actions }
 *
 * No I/O, no clock of its own, no mutation: the connection executes the actions. Validation uses
 * the protocol package's Valibot schemas (C3), so client and server agree on every frame.
 *
 *   binary frame, bad JSON, not an object, v != 1, no t   -> error bad-frame      (a protocol error)
 *   unknown t                                           -> error unknown-type   (a protocol error)
 *   schema failure                                      -> error schema         (a protocol error)
 *     except op.submit / op.batch whose ops carry a valid opId and slot: those ops are REJECTED
 *     EINVAL (persisted, §3.10 step 0) and answered with op.result; the frame is not an error
 *   any frame before `hello`, or a second `hello`       -> error forbidden      (a protocol error)
 *   hello.proto older than N-1                          -> bye upgrade-required, close 1008
 *   three protocol errors within 60 s                   -> bye protocol-error, close 1008
 *   frame larger than MAX_PAYLOAD                       -> close 1009 (ws enforces it first)
 * A client frame's piggy-backed `ack` becomes an `ack` action before the frame's own action.
 */
import * as v from 'valibot';

import {
  C2S_BODIES,
  C2S_LANE,
  C2S_TYPES,
  C2SFrame,
  MAX_BATCH,
  MAX_PAYLOAD,
  PROTO,
  Seq,
  Timestamp,
  UuidV7,
  WsUid,
  type C2SType,
  type FeedCursor,
  type OpSubmit,
  type S2CFrame,
  type S2CType,
} from '@plotinium/protocol';

import { BYE_CLOSE_CODE, type ServerByeReason } from './close-policy.ts';

/** One outbound frame without its id (the connection numbers outbound frames). */
export type Outbound = {
  [K in S2CType]: { readonly t: K; readonly body: S2CFrame<K>['body'] };
}[S2CType];

type Body<T extends C2SType> = C2SFrame<T>['body'];

/** A valid op identity whose body failed the schema: persisted as rejected EINVAL (§3.10 step 0). */
export interface InvalidOp {
  readonly opId: string;
  readonly osSessionId: string;
  readonly cseq: number;
  readonly lamport: number;
  readonly principal: number;
  readonly clientTime: string | undefined;
  /** The op kind if it was a well-formed name (op_log.call), else undefined. */
  readonly kind: string | undefined;
  readonly issue: string;
}

export type RouterAction =
  | { readonly kind: 'send'; readonly frame: Outbound }
  | {
      readonly kind: 'close';
      readonly code: number;
      /** The close reason: the server's bye reason, or the client's own after its `bye` (UI-166). */
      readonly reason: ServerByeReason | Body<'bye'>['reason'] | 'message-too-big';
      /** The close that answers the client's own `bye` (not a server-initiated close). */
      readonly afterBye?: true;
    }
  | {
      readonly kind: 'hello';
      readonly frameId: number;
      readonly proto: number;
      readonly body: Body<'hello'>;
    }
  | { readonly kind: 'ops'; readonly frameId: number; readonly ops: readonly OpSubmit[] }
  | { readonly kind: 'invalid-ops'; readonly frameId: number; readonly ops: readonly InvalidOp[] }
  | { readonly kind: 'ack'; readonly cursors: readonly FeedCursor[] }
  | { readonly kind: 'lock.acquire'; readonly frameId: number; readonly body: Body<'lock.acquire'> }
  | { readonly kind: 'lock.release'; readonly frameId: number; readonly body: Body<'lock.release'> }
  | { readonly kind: 'hb'; readonly frameId: number; readonly body: Body<'hb'> }
  | { readonly kind: 'watch' | 'unwatch'; readonly frameId: number; readonly ino: string }
  | { readonly kind: 'resume'; readonly frameId: number; readonly body: Body<'resume'> }
  | { readonly kind: 'proc.signal'; readonly frameId: number; readonly body: Body<'proc.signal'> }
  | { readonly kind: 'bye'; readonly frameId: number; readonly reason: Body<'bye'>['reason'] };

export interface RouterState {
  readonly phase: 'awaiting-hello' | 'open' | 'closed';
  /** The protocol version negotiated in hello (null before). */
  readonly proto: number | null;
  /** Times of recent protocol errors (at most the last few, within PROTOCOL_ERROR_WINDOW_MS). */
  readonly protocolErrors: readonly number[];
}

export interface RouteResult {
  readonly state: RouterState;
  readonly actions: readonly RouterAction[];
}

export const PROTOCOL_ERROR_LIMIT = 3;
export const PROTOCOL_ERROR_WINDOW_MS = 60_000;

export const initialRouterState: RouterState = {
  phase: 'awaiting-hello',
  proto: null,
  protocolErrors: [],
};

type ErrorCode = S2CFrame<'error'>['body']['code'];

const OpIdentity = v.object({
  opId: UuidV7,
  osSessionId: UuidV7,
  cseq: Seq,
  lamport: Seq,
  principal: WsUid,
  clientTime: v.optional(Timestamp),
  op: v.optional(v.object({ kind: v.optional(v.string()) })),
});

const CALL_NAME = /^[a-z][a-z0-9_.]{0,63}$/;

function issueText(issues: readonly v.BaseIssue<unknown>[]): string {
  const first = issues[0];
  if (first === undefined) return 'schema';
  const path = v.getDotPath(first);
  return `${path === null ? '' : `${path}: `}${first.message}`.slice(0, 256);
}

function sendError(code: ErrorCode, msg: string, refId?: number): RouterAction {
  return {
    kind: 'send',
    frame: {
      t: 'error',
      body: { code, msg: msg.slice(0, 256), ...(refId === undefined ? {} : { refId }) },
    },
  };
}

export function bye(reason: ServerByeReason, retryAfterMs?: number): RouterAction[] {
  return [
    {
      kind: 'send',
      frame: {
        t: 'bye',
        body: { reason, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) },
      },
    },
    { kind: 'close', code: BYE_CLOSE_CODE[reason], reason },
  ];
}

/**
 * Records one protocol error at `now`; the third within 60 s closes the connection. Also used by
 * the connection for runtime protocol errors (for example exceeding the credit window).
 */
export function noteProtocolError(
  state: RouterState,
  now: number,
  reply: RouterAction,
): RouteResult {
  const recent = [...state.protocolErrors.filter((t) => now - t < PROTOCOL_ERROR_WINDOW_MS), now];
  if (recent.length >= PROTOCOL_ERROR_LIMIT) {
    return {
      state: { ...state, phase: 'closed', protocolErrors: recent },
      actions: [reply, ...bye('protocol-error')],
    };
  }
  return { state: { ...state, protocolErrors: recent }, actions: [reply] };
}

function frameIdOf(x: unknown): number | undefined {
  if (typeof x !== 'object' || x === null) return undefined;
  const id = (x as { id?: unknown }).id;
  return typeof id === 'number' && Number.isInteger(id) && id >= 1 && id <= 0xffff_ffff
    ? id
    : undefined;
}

/**
 * Splits a schema-failing op frame: ops that parse are queued normally; ops that fail their own
 * schema but carry a valid identity (opId, osSessionId, cseq, lamport, principal) are rejected
 * EINVAL and persisted (§3.10 step 0). Null when the frame itself is malformed (not an array, more
 * than MAX_BATCH ops, or an op without a valid identity): that is a protocol error.
 */
function splitOpFrame(
  t: 'op.submit' | 'op.batch',
  body: unknown,
): { valid: OpSubmit[]; invalid: InvalidOp[] } | null {
  let candidates: unknown[];
  if (t === 'op.submit') candidates = [body];
  else {
    const ops =
      typeof body === 'object' && body !== null ? (body as { ops?: unknown }).ops : undefined;
    if (!Array.isArray(ops) || ops.length < 1 || ops.length > MAX_BATCH) return null;
    candidates = ops;
  }
  const valid: OpSubmit[] = [];
  const invalid: InvalidOp[] = [];
  for (const c of candidates) {
    const full = v.safeParse(C2S_BODIES['op.submit'], c);
    if (full.success) {
      valid.push(full.output);
      continue;
    }
    const id = v.safeParse(OpIdentity, c);
    if (!id.success) return null;
    const kind = id.output.op?.kind;
    invalid.push({
      opId: id.output.opId,
      osSessionId: id.output.osSessionId,
      cseq: id.output.cseq,
      lamport: id.output.lamport,
      principal: id.output.principal,
      clientTime: id.output.clientTime,
      kind: kind !== undefined && CALL_NAME.test(kind) ? kind : undefined,
      issue: issueText(full.issues),
    });
  }
  return invalid.length === 0 ? null : { valid, invalid };
}

/** Protocol negotiation (SYN-13): the server speaks N and N-1; null means upgrade-required. */
export function negotiateProto(client: number, server: number = PROTO): number | null {
  if (client < server - 1) return null;
  return Math.min(client, server);
}

/** Routes one inbound WebSocket message. */
export function routeFrame(
  state: RouterState,
  raw: string,
  now: number,
  isBinary = false,
): RouteResult {
  if (state.phase === 'closed') return { state, actions: [] };
  if (Buffer.byteLength(raw, 'utf8') > MAX_PAYLOAD) {
    return {
      state: { ...state, phase: 'closed' },
      actions: [{ kind: 'close', code: 1009, reason: 'message-too-big' }],
    };
  }
  if (isBinary) return noteProtocolError(state, now, sendError('bad-frame', 'text frames only'));

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return noteProtocolError(state, now, sendError('bad-frame', 'invalid JSON'));
  }
  const refId = frameIdOf(parsed);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return noteProtocolError(state, now, sendError('bad-frame', 'a frame is a JSON object'));
  }
  const envelope = parsed as { v?: unknown; t?: unknown; body?: unknown };
  if (envelope.v !== 1 || typeof envelope.t !== 'string') {
    return noteProtocolError(
      state,
      now,
      sendError('bad-frame', 'expected {v: 1, t, id, body}', refId),
    );
  }
  const t = envelope.t;
  if (!(C2S_TYPES as readonly string[]).includes(t)) {
    return noteProtocolError(
      state,
      now,
      sendError('unknown-type', `unknown type ${t.slice(0, 40)}`, refId),
    );
  }
  const type = t as C2SType;

  const result = v.safeParse(C2SFrame, parsed);
  if (!result.success) {
    const issue = issueText(result.issues);
    if (
      (type === 'op.submit' || type === 'op.batch') &&
      state.phase === 'open' &&
      refId !== undefined
    ) {
      const split = splitOpFrame(type, envelope.body);
      if (split !== null) {
        const actions: RouterAction[] = [
          { kind: 'invalid-ops', frameId: refId, ops: split.invalid },
        ];
        if (split.valid.length > 0) actions.push({ kind: 'ops', frameId: refId, ops: split.valid });
        return { state, actions };
      }
    }
    return noteProtocolError(state, now, sendError('schema', issue, refId));
  }
  // The schema is a variant over a mapped list, so its inferred output is not discriminated on
  // `t`; the protocol's C2SFrame TYPE is the discriminated view of the same, now validated, value.
  const frame = result.output as C2SFrame;

  if (state.phase === 'awaiting-hello') {
    if (frame.t !== 'hello')
      return noteProtocolError(
        state,
        now,
        sendError('forbidden', 'hello must be the first frame', frame.id),
      );
    const negotiated = negotiateProto(frame.body.proto);
    if (negotiated === null) {
      return { state: { ...state, phase: 'closed' }, actions: bye('upgrade-required') };
    }
    return {
      state: { ...state, phase: 'open', proto: negotiated },
      actions: [{ kind: 'hello', frameId: frame.id, proto: negotiated, body: frame.body }],
    };
  }

  const actions: RouterAction[] = [];
  if (frame.ack !== undefined && frame.ack.length > 0)
    actions.push({ kind: 'ack', cursors: frame.ack });

  switch (frame.t) {
    case 'hello':
      return noteProtocolError(
        state,
        now,
        sendError('forbidden', 'hello was already received', frame.id),
      );
    case 'op.submit':
      actions.push({ kind: 'ops', frameId: frame.id, ops: [frame.body] });
      break;
    case 'op.batch':
      actions.push({ kind: 'ops', frameId: frame.id, ops: frame.body.ops });
      break;
    case 'ack':
      actions.push({ kind: 'ack', cursors: frame.body.cursors });
      break;
    case 'lock.acquire':
      actions.push({ kind: 'lock.acquire', frameId: frame.id, body: frame.body });
      break;
    case 'lock.release':
      actions.push({ kind: 'lock.release', frameId: frame.id, body: frame.body });
      break;
    case 'hb':
      actions.push({ kind: 'hb', frameId: frame.id, body: frame.body });
      break;
    case 'watch':
    case 'unwatch':
      actions.push({ kind: frame.t, frameId: frame.id, ino: frame.body.ino });
      break;
    case 'resume':
      actions.push({ kind: 'resume', frameId: frame.id, body: frame.body });
      break;
    case 'proc.signal':
      actions.push({ kind: 'proc.signal', frameId: frame.id, body: frame.body });
      break;
    case 'bye':
      actions.push({ kind: 'bye', frameId: frame.id, reason: frame.body.reason });
      return {
        state: { ...state, phase: 'closed' },
        // The close echoes the client's own reason (`logout`, `reboot`, …; UI-166).
        actions: [
          ...actions,
          { kind: 'close', code: 1000, reason: frame.body.reason, afterBye: true },
        ],
      };
  }
  return { state, actions };
}

/** The lane a routed action travels on (SYN-02): only ops wait in the per-connection queue. */
export function laneOf(action: RouterAction): 'op' | 'control' {
  return action.kind === 'ops' || action.kind === 'invalid-ops' ? C2S_LANE['op.submit'] : 'control';
}
