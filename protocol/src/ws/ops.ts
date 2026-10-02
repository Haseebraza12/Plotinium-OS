/**
 * WebSocket protocol v1: common definitions and the op model (offline-and-sync.md §3.3, §4.2 and
 * §4.7; C6). These are the ops the outbox holds and the server's `op_log` records.
 *
 * Every op carries `opId` (UUIDv7, the idempotency key), a per-OS-session `cseq`, a Lamport
 * counter (no HLC) and base versions or a subtree digest (SYN-03). `op.batch` (the frame) carries
 * up to 32 independent ops; `batch` (the op kind) is ONE op whose members commit or roll back
 * together.
 *
 * Wire names differ from syscall names on purpose: a wire `Name` must already be NFC (the kernel
 * normalised it at the syscall boundary), and the wire `ModeChange` is `{absolute}|{symbolic}`
 * (parsed by vfs/modeparse.ts on both sides), not the syscall's `{op:'set'|'delta'}`.
 */
import * as v from 'valibot';

import { AuditRecord } from '../audit.ts';
import { Errno, Reason } from '../errno.ts';

const noSlashOrNul = (s: string): boolean => !s.includes('/') && !s.includes('\u0000');

// ---------------------------------------------------------------------------------------------
// Common definitions (§4.2)
// ---------------------------------------------------------------------------------------------

export const Uuid = v.pipe(
  v.string(),
  v.regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
);
export const UuidV7 = v.pipe(
  v.string(),
  v.regex(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
);
/** Well-known ids are UUIDv7-shaped with timestamp 0 (C5). */
export const WsIno = UuidV7;
export const WsUid = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(2_147_483_647));
export const Seq = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
export const Version = Seq;
export const Fence = v.pipe(v.number(), v.safeInteger(), v.minValue(1));
export const Ms = Seq;
export const Sha256 = v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/));
export const WsMode = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(4095));
/** 1..255 characters and 1..255 UTF-8 bytes, no '/' or NUL, not '.' or '..', NFC-normalised. */
export const WsName = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(255),
  v.maxBytes(255),
  v.check(noSlashOrNul),
  v.check((s) => s !== '.' && s !== '..'),
  v.check((s) => s.isWellFormed() && s === s.normalize('NFC')),
);
/** RFC 3339 date-time. */
export const Timestamp = v.pipe(v.string(), v.maxLength(40), v.isoTimestamp());
export const WsErrno = Errno;
export const WsReason = Reason;

export const FeedCursor = v.strictObject({ ownerUid: WsUid, seq: Seq });
export const ResumeCursor = v.strictObject({ ownerUid: WsUid, fromSeq: Seq });
export const LeaseRef = v.strictObject({ leaseId: UuidV7, ino: WsIno, fence: Fence });

export const BuildIdentity = v.strictObject({
  name: v.literal('Plotinium'),
  version: v.pipe(v.string(), v.maxLength(32), v.regex(/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/)),
  build: v.pipe(v.string(), v.regex(/^[0-9a-f]{7,12}$/)),
  date: v.pipe(v.string(), v.isoDate()),
});

/** Expected versions (≤ 256 entries) or a subtree digest (vfs/digest.ts, PVFS-16). */
export const Base = v.variant('kind', [
  v.strictObject({
    kind: v.literal('versions'),
    entries: v.pipe(v.array(v.strictObject({ ino: WsIno, version: Version })), v.maxLength(256)),
  }),
  v.strictObject({ kind: v.literal('digest'), rootIno: WsIno, digest: Sha256 }),
]);

/** Wire mode change: parsed by the isomorphic vfs/modeparse.ts on both sides. */
export const WsModeChange = v.union([
  v.strictObject({ absolute: WsMode }),
  v.strictObject({ symbolic: v.pipe(v.string(), v.minLength(1), v.maxLength(64)) }),
]);

// ---------------------------------------------------------------------------------------------
// Ops (§4.2 and §4.7)
// ---------------------------------------------------------------------------------------------

export const OpCreate = v.strictObject({
  kind: v.literal('create'),
  parentIno: WsIno,
  name: WsName,
  /** Client-generated UUIDv7; the server keeps it. */
  ino: WsIno,
  type: v.picklist(['f', 'd', 'l']),
  mode: WsMode,
  blob: v.optional(Sha256),
  size: v.optional(Seq),
  symlinkTarget: v.optional(
    v.pipe(v.string(), v.minLength(1), v.maxLength(4096), v.maxBytes(4096)),
  ),
  mtime: Ms,
});
export const OpWrite = v.strictObject({
  kind: v.literal('write'),
  ino: WsIno,
  blob: Sha256,
  size: Seq,
  mtime: Ms,
});
export const OpUnlink = v.strictObject({
  kind: v.literal('unlink'),
  parentIno: WsIno,
  name: WsName,
  ino: WsIno,
  recursive: v.boolean(),
});
export const OpRename = v.strictObject({
  kind: v.literal('rename'),
  ino: WsIno,
  fromParentIno: WsIno,
  fromName: WsName,
  toParentIno: WsIno,
  toName: WsName,
  /** A replace is allowed only when it names the victim and its version. */
  replace: v.optional(v.strictObject({ ino: WsIno, version: Version })),
});
export const OpLink = v.strictObject({
  kind: v.literal('link'),
  ino: WsIno,
  parentIno: WsIno,
  name: WsName,
});
/** New ids are `deriveIno(opId, srcIno)` for every copied node (§3.3.2, ids.ts). */
export const OpCopy = v.strictObject({
  kind: v.literal('copy'),
  srcIno: WsIno,
  toParentIno: WsIno,
  toName: WsName,
  recursive: v.boolean(),
  preserve: v.optional(v.boolean()),
});
export const OpChmod = v.strictObject({
  kind: v.literal('chmod'),
  ino: WsIno,
  change: WsModeChange,
  recursive: v.boolean(),
});
export const OpChown = v.pipe(
  v.strictObject({
    kind: v.literal('chown'),
    ino: WsIno,
    uid: v.optional(WsUid),
    gid: v.optional(WsUid),
    recursive: v.boolean(),
    noFollow: v.optional(v.boolean()),
  }),
  /** anyOf: uid or gid is present. */
  v.check((op) => op.uid !== undefined || op.gid !== undefined),
);
export const OpUtimes = v.strictObject({ kind: v.literal('utimes'), ino: WsIno, mtime: Ms });

export const MemberOp = v.variant('kind', [
  OpCreate,
  OpWrite,
  OpUnlink,
  OpRename,
  OpLink,
  OpCopy,
  OpChmod,
  OpChown,
  OpUtimes,
]);

/** All members commit in one vfsTxn or none; `fingerprint` = the dry-run hash re-checked by the server. */
export const OpBatch = v.strictObject({
  kind: v.literal('batch'),
  ops: v.pipe(v.array(MemberOp), v.minLength(1), v.maxLength(2000)),
  fingerprint: v.optional(Sha256),
});
export const OpAuditAppend = v.strictObject({
  kind: v.literal('audit.append'),
  records: v.pipe(v.array(AuditRecord), v.minLength(1), v.maxLength(64)),
});

/** A session layout serialises to at most 32 KiB (window-manager.md, memory-and-paging.md). */
export const SESSION_LAYOUT_MAX_BYTES = 32_768;
const encoder = new TextEncoder();
export const OpSessionLayout = v.strictObject({
  kind: v.literal('session.layout'),
  /** `WindowLayout` (window-manager.md and memory-and-paging.md own its shape). */
  layout: v.pipe(
    v.record(v.string(), v.unknown()),
    v.check((layout) => encoder.encode(JSON.stringify(layout)).length <= SESSION_LAYOUT_MAX_BYTES),
  ),
  /** Last writer wins per osSessionId (`layout_rev`). */
  rev: Seq,
});

export const VfsOp = v.variant('kind', [
  OpCreate,
  OpWrite,
  OpUnlink,
  OpRename,
  OpLink,
  OpCopy,
  OpChmod,
  OpChown,
  OpUtimes,
  OpBatch,
  OpAuditAppend,
  OpSessionLayout,
]);

/** Actor, pid, prompt id, plan hash and audit rows inserted in the same vfsTxn (AGT-08). */
export const OpAudit = v.strictObject({
  actor: v.picklist(['user', 'agent', 'system']),
  pid: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
  promptId: v.optional(UuidV7),
  planHash: v.optional(Sha256),
  records: v.optional(v.pipe(v.array(AuditRecord), v.maxLength(2000))),
});

/** The body of `op.submit`, one element of `op.batch`, and the body of `POST /api/ops/{opId}`. */
export const OpSubmit = v.strictObject({
  /** Idempotency key; `op_log.op_id`. */
  opId: UuidV7,
  osSessionId: UuidV7,
  /** Outbox order within that OS session. */
  cseq: Seq,
  lamport: Seq,
  /** Effective uid of the issuing process; the server authorises it (§3.8.6). */
  principal: WsUid,
  /** Local wall clock at commit; diagnostics only. */
  clientTime: Timestamp,
  op: VfsOp,
  base: Base,
  fences: v.optional(
    v.pipe(v.array(v.strictObject({ ino: WsIno, fence: Fence })), v.maxLength(256)),
  ),
  /** Content that must exist on the server first. */
  blobs: v.optional(v.pipe(v.array(Sha256), v.maxLength(1024))),
  audit: v.optional(OpAudit),
});

/** One change of a feed entry (`vfs.changed`). */
export const Change = v.strictObject({
  kind: v.picklist(['upsert', 'unlink', 'move']),
  ino: WsIno,
  version: Version,
  parentIno: v.optional(WsIno),
  name: v.optional(WsName),
  fromParentIno: v.optional(WsIno),
  fromName: v.optional(WsName),
  type: v.optional(v.picklist(['f', 'd', 'l'])),
  mode: v.optional(WsMode),
  uid: v.optional(WsUid),
  gid: v.optional(WsUid),
  size: v.optional(Seq),
  nlink: v.optional(Seq),
  blob: v.optional(Sha256),
  symlinkTarget: v.optional(v.pipe(v.string(), v.maxLength(4096))),
  mtime: v.optional(Ms),
  ctime: v.optional(Ms),
  /** Unlink of a directory: the whole subtree is gone. */
  subtree: v.optional(v.boolean()),
});

export type Base = v.InferOutput<typeof Base>;
export type WsModeChange = v.InferOutput<typeof WsModeChange>;
export type MemberOp = v.InferOutput<typeof MemberOp>;
export type VfsOp = v.InferOutput<typeof VfsOp>;
export type OpAudit = v.InferOutput<typeof OpAudit>;
export type OpSubmit = v.InferOutput<typeof OpSubmit>;
export type Change = v.InferOutput<typeof Change>;
export type FeedCursor = v.InferOutput<typeof FeedCursor>;
export type ResumeCursor = v.InferOutput<typeof ResumeCursor>;
export type LeaseRef = v.InferOutput<typeof LeaseRef>;
export type BuildIdentity = v.InferOutput<typeof BuildIdentity>;
