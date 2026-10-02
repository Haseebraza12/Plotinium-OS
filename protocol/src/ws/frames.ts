/**
 * WebSocket protocol v1 frames (offline-and-sync.md §4.1, §4.3 and §4.4; C6, SYN-01..SYN-18).
 *
 * Text frames only, UTF-8 JSON, at most MAX_PAYLOAD bytes (larger → close 1009). Every frame is
 * `{v: 1, t, id, body}`; client frames may piggy-back `ack`. Unknown `t`, a non-object body or a
 * schema failure → `error {code, refId}`; three protocol errors within 60 s → `bye` and 1008.
 * Two lanes per connection: the ordered op lane (`op.submit`, `op.batch`) and the control lane
 * (everything else), which never waits behind an op.
 */
import * as v from 'valibot';

import { MAX_BATCH } from './constants.ts';
import {
  BuildIdentity,
  Change,
  FeedCursor,
  Fence,
  LeaseRef,
  OpSubmit,
  ResumeCursor,
  Seq,
  Timestamp,
  UuidV7,
  Version,
  WsErrno,
  WsIno,
  WsName,
  WsReason,
  WsUid,
  Ms,
} from './ops.ts';

const FrameId = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(0xffff_ffff));
const LeaseMode = v.picklist(['S', 'X']);
const Username = v.pipe(v.string(), v.maxLength(32));

// ---------------------------------------------------------------------------------------------
// Client → server bodies (§4.3)
// ---------------------------------------------------------------------------------------------

export const Hello = v.strictObject({
  /** The protocol version the client speaks. */
  proto: v.pipe(v.number(), v.integer(), v.minValue(1)),
  build: BuildIdentity,
  osSessionId: UuidV7,
  /** From `meta.deviceId`, created at the first boot of the profile. */
  deviceId: UuidV7,
  /** Fencing epoch from `meta`. */
  kernelEpoch: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
  lamport: Seq,
  outbox: v.strictObject({ pending: Seq, held: Seq }),
  heldLeases: v.pipe(v.array(LeaseRef), v.maxLength(256)),
  /** `{ownerUid, fromSeq}` for every mirrored owner; 0 = never. */
  resume: v.pipe(v.array(ResumeCursor), v.maxLength(64)),
});
export const OpBatchFrame = v.strictObject({
  ops: v.pipe(v.array(OpSubmit), v.minLength(1), v.maxLength(MAX_BATCH)),
});
export const Ack = v.strictObject({
  cursors: v.pipe(v.array(FeedCursor), v.minLength(1), v.maxLength(64)),
});
export const LockAcquire = v.strictObject({
  /** Echoed in the replies. */
  reqId: UuidV7,
  ino: WsIno,
  mode: LeaseMode,
  /** Queue if busy. */
  wait: v.boolean(),
  /** Only with `wait`. */
  timeoutMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(600_000))),
  principal: WsUid,
});
/** Exactly one of `leaseId` (release a held lease) or `reqId` (cancel a queued request). */
export const LockRelease = v.pipe(
  v.strictObject({ leaseId: v.optional(UuidV7), reqId: v.optional(UuidV7) }),
  v.check((b) => (b.leaseId === undefined) !== (b.reqId === undefined)),
);
/** The heartbeat is the lease renewal; there is no separate `lock.renew` frame. */
export const Hb = v.strictObject({
  /** Client monotonic ms, echoed. */
  t: Ms,
  leases: v.pipe(v.array(LeaseRef), v.maxLength(256)),
  lamport: Seq,
});
export const Watch = v.strictObject({ ino: WsIno });
export const Resume = v.strictObject({
  cursors: v.pipe(v.array(ResumeCursor), v.minLength(1), v.maxLength(64)),
});
/** A process waiting for its op was killed (§3.13.3): all three signals cancel. */
export const ProcSignalUp = v.strictObject({
  target: v.strictObject({ kind: v.literal('op'), opId: UuidV7 }),
  sig: v.picklist(['SIGINT', 'SIGTERM', 'SIGKILL']),
});
export const ByeUp = v.strictObject({
  reason: v.picklist(['shutdown', 'reboot', 'logout', 'takeover', 'update']),
});

/** Bodies of the client → server frame types. */
export const C2S_BODIES = {
  hello: Hello,
  'op.submit': OpSubmit,
  'op.batch': OpBatchFrame,
  ack: Ack,
  'lock.acquire': LockAcquire,
  'lock.release': LockRelease,
  hb: Hb,
  watch: Watch,
  unwatch: Watch,
  resume: Resume,
  'proc.signal': ProcSignalUp,
  bye: ByeUp,
} as const;

export type C2SType = keyof typeof C2S_BODIES;
export const C2S_TYPES = Object.keys(C2S_BODIES) as C2SType[];

/** The lane each client frame type travels on (§3.6, SYN-02). */
export const C2S_LANE: Record<C2SType, 'op' | 'control'> = {
  hello: 'control',
  'op.submit': 'op',
  'op.batch': 'op',
  ack: 'control',
  'lock.acquire': 'control',
  'lock.release': 'control',
  hb: 'control',
  watch: 'control',
  unwatch: 'control',
  resume: 'control',
  'proc.signal': 'control',
  bye: 'control',
};

// ---------------------------------------------------------------------------------------------
// Server → client bodies (§4.4)
// ---------------------------------------------------------------------------------------------

const LeaseTtlMs = v.pipe(v.number(), v.integer(), v.minValue(15_000), v.maxValue(120_000));

export const WsLeaseInfo = v.strictObject({
  leaseId: UuidV7,
  ino: WsIno,
  fence: Fence,
  mode: LeaseMode,
  expiresAt: Timestamp,
});

export const HelloOk = v.strictObject({
  proto: v.pipe(v.number(), v.integer(), v.minValue(1)),
  osSessionId: UuidV7,
  server: BuildIdentity,
  serverTime: Timestamp,
  lamport: Seq,
  /** From the cookie session, plus live `su` grants (§3.8.6). */
  auth: v.strictObject({
    uid: WsUid,
    username: Username,
    gids: v.pipe(v.array(WsUid), v.maxLength(64)),
    kind: v.picklist(['user', 'guest', 'demo', 'examiner']),
    suGrants: v.pipe(v.array(v.strictObject({ uid: WsUid, expiresAt: Timestamp })), v.maxLength(4)),
  }),
  limits: v.strictObject({
    maxPayload: v.literal(65_536),
    opEnvelopeMax: v.literal(61_440),
    maxBatch: v.literal(32),
    creditWindow: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(32)),
    feedWindow: v.pipe(v.number(), v.integer(), v.minValue(16), v.maxValue(1024)),
    maxLeases: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(256)),
    maxWatches: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(256)),
  }),
  timers: v.strictObject({
    leaseTtlMs: LeaseTtlMs,
    hbMs: v.pipe(v.number(), v.integer(), v.minValue(5_000), v.maxValue(40_000)),
    deadManMs: v.pipe(v.number(), v.integer(), v.minValue(10_000), v.maxValue(120_000)),
  }),
  owners: v.pipe(
    v.array(
      v.strictObject({
        ownerUid: WsUid,
        fromSeq: Seq,
        headSeq: Seq,
        horizonSeq: Seq,
        mode: v.picklist(['stream', 'snapshot']),
      }),
    ),
    v.maxLength(64),
  ),
  keptLeases: v.pipe(v.array(WsLeaseInfo), v.maxLength(256)),
  lostLeases: v.pipe(v.array(LeaseRef), v.maxLength(256)),
});

export const OpResult = v.pipe(
  v.strictObject({
    opId: UuidV7,
    /** `applied`, `conflict`, `rejected` (final) or `retry` (send again later). */
    status: v.picklist(['applied', 'conflict', 'rejected', 'retry']),
    /** The stored outcome of an earlier attempt is returned. */
    duplicate: v.boolean(),
    /** A tombstone without details (§3.10). */
    pruned: v.optional(v.boolean()),
    errno: v.optional(WsErrno),
    reason: v.optional(WsReason),
    retryAfterMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(600_000))),
    versions: v.optional(
      v.pipe(
        v.array(
          v.strictObject({
            ino: WsIno,
            version: Version,
            mtime: v.optional(Ms),
            ctime: v.optional(Ms),
          }),
        ),
        v.maxLength(256),
      ),
    ),
    keptAs: v.optional(v.strictObject({ ino: WsIno, parentIno: WsIno, name: WsName })),
    ownerSeqs: v.optional(v.pipe(v.array(FeedCursor), v.maxLength(64))),
    commitTime: v.optional(Timestamp),
    lamport: Seq,
    quota: v.optional(
      v.strictObject({
        uid: WsUid,
        usedBytes: Seq,
        usedInodes: Seq,
        quotaBytes: Seq,
        quotaInodes: Seq,
      }),
    ),
  }),
  /** rejected and retry need errno; retry needs retryAfterMs; conflict needs keptAs (allOf). */
  v.check((r) => (r.status !== 'rejected' && r.status !== 'retry') || r.errno !== undefined),
  v.check((r) => r.status !== 'retry' || r.retryAfterMs !== undefined),
  v.check((r) => r.status !== 'conflict' || r.keptAs !== undefined),
);

export const VfsChanged = v.strictObject({
  ownerUid: WsUid,
  seq: Seq,
  opId: UuidV7,
  commitTime: Timestamp,
  lamport: Seq,
  /** Every change was filtered for this receiver; the cursor still advances (SYN-18). */
  redacted: v.boolean(),
  changes: v.pipe(v.array(Change), v.maxLength(200)),
  /** Instead of `changes` for an op that changed more than 200 inodes. */
  refetch: v.optional(
    v.strictObject({ dirs: v.pipe(v.array(WsIno), v.minLength(1), v.maxLength(64)) }),
  ),
});
export const ResumeDone = v.strictObject({ ownerUid: WsUid, headSeq: Seq });
export const SnapshotRequired = v.strictObject({
  ownerUid: WsUid,
  reason: v.picklist(['horizon', 'reset', 'gap-unrecoverable']),
  headSeq: Seq,
  url: v.pipe(v.string(), v.maxLength(512), v.regex(/^\/api\/sync\/snapshot\?/)),
});
export const LockGranted = v.strictObject({
  reqId: UuidV7,
  leaseId: UuidV7,
  ino: WsIno,
  mode: LeaseMode,
  fence: Fence,
  expiresAt: Timestamp,
  ttlMs: LeaseTtlMs,
});
export const LockQueued = v.strictObject({
  reqId: UuidV7,
  /** 1 = next. */
  position: v.pipe(v.number(), v.integer(), v.minValue(1)),
});
export const LockDenied = v.strictObject({
  reqId: UuidV7,
  errno: v.picklist(['EBUSY', 'EACCES', 'ENOENT', 'EISDIR', 'EAGAIN', 'ETIMEDOUT', 'ECANCELED']),
  reason: v.optional(WsReason),
  holder: v.optional(v.strictObject({ username: Username, mode: LeaseMode, expiresAt: Timestamp })),
});
export const LockEnded = v.strictObject({
  ino: WsIno,
  leaseId: UuidV7,
  reason: v.picklist(['released', 'expired', 'revoked', 'session-closed', 'process-killed']),
});
export const HbAck = v.strictObject({
  t: Ms,
  serverTime: Timestamp,
  renewed: v.pipe(v.array(UuidV7), v.maxLength(256)),
  lost: v.pipe(v.array(LeaseRef), v.maxLength(256)),
});
/** A `su` grant ended: SIGHUP to the elevated processes. */
export const ProcSignalDown = v.strictObject({
  target: v.strictObject({ kind: v.literal('principal'), uid: WsUid }),
  sig: v.literal('SIGHUP'),
  reason: v.picklist(['su-expired', 'su-revoked']),
});
export const Throttle = v.strictObject({
  retryAfterMs: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(60_000)),
  scope: v.picklist(['frames', 'ops', 'locks']),
});
export const WsError = v.strictObject({
  code: v.picklist(['bad-frame', 'unknown-type', 'schema', 'forbidden', 'limit']),
  /** The offending frame id. */
  refId: v.optional(FrameId),
  errno: v.optional(WsErrno),
  msg: v.pipe(v.string(), v.maxLength(256)),
});
export const ByeDown = v.strictObject({
  reason: v.picklist([
    'restart',
    'shutdown',
    'revoked',
    'superseded',
    'upgrade-required',
    'idle-timeout',
    'protocol-error',
    'rate-limited',
    'slow-consumer',
    'policy',
  ]),
  retryAfterMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(600_000))),
});

/** Bodies of the server → client frame types. */
export const S2C_BODIES = {
  'hello.ok': HelloOk,
  'op.result': OpResult,
  'vfs.changed': VfsChanged,
  'resume.done': ResumeDone,
  'snapshot.required': SnapshotRequired,
  'lock.granted': LockGranted,
  'lock.queued': LockQueued,
  'lock.denied': LockDenied,
  'lock.released': LockEnded,
  'lock.expired': LockEnded,
  'hb.ack': HbAck,
  'proc.signal': ProcSignalDown,
  throttle: Throttle,
  error: WsError,
  bye: ByeDown,
} as const;

export type S2CType = keyof typeof S2C_BODIES;
export const S2C_TYPES = Object.keys(S2C_BODIES) as S2CType[];

// ---------------------------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------------------------

/** A client → server frame: `{v: 1, t, id, ack?, body}`, discriminated on `t`. */
export const C2SFrame = v.variant(
  't',
  C2S_TYPES.map((t) =>
    v.strictObject({
      v: v.literal(1),
      t: v.literal(t),
      id: FrameId,
      /** Piggy-backed feed acknowledgement (same meaning as the `ack` frame). */
      ack: v.optional(v.pipe(v.array(FeedCursor), v.maxLength(64))),
      body: C2S_BODIES[t],
    }),
  ),
);

/** A server → client frame: `{v: 1, t, id, body}`, discriminated on `t`. */
export const S2CFrame = v.variant(
  't',
  S2C_TYPES.map((t) =>
    v.strictObject({ v: v.literal(1), t: v.literal(t), id: FrameId, body: S2C_BODIES[t] }),
  ),
);

export type C2SFrame<T extends C2SType = C2SType> = {
  [K in T]: {
    v: 1;
    t: K;
    id: number;
    ack?: v.InferOutput<typeof FeedCursor>[];
    body: v.InferOutput<(typeof C2S_BODIES)[K]>;
  };
}[T];
export type S2CFrame<T extends S2CType = S2CType> = {
  [K in T]: { v: 1; t: K; id: number; body: v.InferOutput<(typeof S2C_BODIES)[K]> };
}[T];

export type OpResult = v.InferOutput<typeof OpResult>;
export type HelloOk = v.InferOutput<typeof HelloOk>;
export type Hello = v.InferOutput<typeof Hello>;
