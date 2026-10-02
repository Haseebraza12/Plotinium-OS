/**
 * Kernel event bus: topics and payloads (syscall-abi.md §3.8 and §4.6, ABI-07).
 *
 * Delivery rules (owned by the kernel): VFS events only after IndexedDB `oncomplete`; at most once,
 * FIFO per topic per subscriber, with a strictly increasing per-topic `seq`; `vfs.*` events only to
 * subscribers with r on the parent and x on every ancestor at publish time; at most 1,024
 * undelivered events per subscription; views get at most one batch per animation frame.
 *
 * virtual-file-system.md §4.5 sketches richer `vfs.*` payloads (item arrays, extra topics); this
 * module follows syscall-abi.md §4.6, which is authoritative for names and shapes. See
 * protocol/README.md for the open reconciliation.
 */
import * as v from 'valibot';

import { Errno } from './errno.ts';
import { ProcClass } from './caps.ts';
import {
  AppId,
  Count,
  EpochMs,
  Ino,
  InodeType,
  Mode,
  Name,
  Path,
  Pid,
  PidOrZero,
  Priority,
  PState,
  Ratio,
  ShortText,
  Uid,
  WaitStatus,
  Wid,
} from './sys/common.ts';
import { NetStatus } from './sys/net.ts';

const Origin = v.picklist(['local', 'remote']);
const InoList = v.pipe(v.array(Ino), v.maxLength(1000));
const LockPayload = v.strictObject({
  ino: Ino,
  mode: v.picklist(['S', 'X']),
  holder: v.optional(v.pipe(v.string(), v.maxLength(128))),
  fence: v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(1))),
  expiresAt: v.optional(EpochMs),
});
const WmPayload = v.strictObject({ wid: Wid, pid: Pid, app: AppId });
const SvcPayload = v.strictObject({
  name: v.pipe(v.string(), v.maxLength(32)),
  critical: v.boolean(),
  error: v.optional(ShortText),
  retryInMs: v.optional(Count),
});

/** Payload schema of every topic, in the order of syscall-abi.md §4.6. */
export const EVENT_PAYLOADS = {
  'vfs.create': v.strictObject({
    ino: Ino,
    parent: Ino,
    name: Name,
    type: InodeType,
    uid: Uid,
    version: Count,
    origin: Origin,
    opId: v.optional(Ino),
  }),
  'vfs.write': v.strictObject({
    ino: Ino,
    parent: Ino,
    version: Count,
    size: Count,
    origin: Origin,
    opId: v.optional(Ino),
  }),
  'vfs.rename': v.strictObject({
    ino: Ino,
    fromParent: Ino,
    fromName: Name,
    toParent: Ino,
    toName: Name,
    origin: Origin,
    opId: v.optional(Ino),
  }),
  'vfs.unlink': v.strictObject({
    inos: InoList,
    truncated: v.optional(v.boolean()),
    parent: Ino,
    name: Name,
    origin: Origin,
    opId: v.optional(Ino),
  }),
  'vfs.chmod': v.strictObject({
    root: Ino,
    inos: InoList,
    truncated: v.optional(v.boolean()),
    mode: v.optional(Mode),
    uid: v.optional(Uid),
    gid: v.optional(Uid),
    recursive: v.boolean(),
    origin: Origin,
  }),
  'vfs.chown': v.strictObject({
    root: Ino,
    inos: InoList,
    truncated: v.optional(v.boolean()),
    mode: v.optional(Mode),
    uid: v.optional(Uid),
    gid: v.optional(Uid),
    recursive: v.boolean(),
    origin: Origin,
  }),
  'vfs.conflict': v.strictObject({
    ino: Ino,
    keptAs: v.strictObject({ ino: Ino, path: Path }),
    /** Who made the other change, for example `bob`. */
    by: v.pipe(v.string(), v.maxLength(64)),
  }),
  'vfs.rejected': v.strictObject({ opId: Ino, errno: Errno, path: Path, restored: v.boolean() }),
  'proc.spawn': v.strictObject({
    pid: Pid,
    ppid: PidOrZero,
    pgid: Pid,
    uid: Uid,
    argv0: v.pipe(v.string(), v.maxLength(256)),
    priority: Priority,
    class: ProcClass,
  }),
  'proc.state': v.strictObject({
    pid: Pid,
    from: PState,
    to: PState,
    reason: v.pipe(v.string(), v.maxLength(64)),
  }),
  'proc.exit': v.strictObject({
    pid: Pid,
    status: WaitStatus,
    reason: v.picklist(['normal', 'signal', 'watchdog', 'collateral', 'abi-violation']),
  }),
  'wm.create': WmPayload,
  'wm.focus': WmPayload,
  'wm.minimise': WmPayload,
  'wm.restore': WmPayload,
  'wm.close': WmPayload,
  'mem.fault': v.strictObject({
    pid: Pid,
    pageId: Count,
    tier: v.picklist(['local', 'remote']),
    bytes: Count,
    ms: v.pipe(v.number(), v.minValue(0)),
  }),
  'mem.evict': v.strictObject({
    pid: Pid,
    pageId: Count,
    bytes: Count,
    to: v.picklist(['local', 'remote', 'drop']),
  }),
  'mem.pressure': v.strictObject({
    accounted: Count,
    budget: Count,
    level: v.picklist(['ok', 'reclaim', 'blocked']),
  }),
  'net.state': NetStatus,
  'lock.granted': LockPayload,
  'lock.queued': LockPayload,
  'lock.lost': LockPayload,
  'lock.released': LockPayload,
  'svc.started': SvcPayload,
  'svc.degraded': SvcPayload,
  'svc.failed': SvcPayload,
  'svc.stopped': SvcPayload,
  'update.available': v.strictObject({
    version: v.pipe(v.string(), v.maxLength(32)),
    build: v.pipe(v.string(), v.maxLength(32)),
  }),
  'ai.index.progress': v.strictObject({
    pending: Count,
    indexedFiles: Count,
    chunks: Count,
    state: v.picklist(['idle', 'indexing', 'paused', 'throttled', 'degraded']),
  }),
  'ai.model': v.strictObject({
    state: v.picklist(['absent', 'loading', 'ready', 'evicted', 'failed']),
    bytes: v.optional(Count),
    loadedBytes: v.optional(Count),
    totalBytes: v.optional(Count),
  }),
  'ai.predict': v.strictObject({
    uid: Uid,
    predictions: v.pipe(
      v.array(v.strictObject({ app: AppId, confidence: Ratio })),
      v.maxLength(10),
    ),
  }),
  notify: v.strictObject({
    nid: Count,
    title: v.pipe(v.string(), v.maxLength(128)),
    body: v.pipe(v.string(), v.maxLength(1024)),
    level: v.picklist(['info', 'warn', 'error']),
    pid: Pid,
  }),
  'bus.overflow': v.strictObject({
    topic: v.pipe(v.string(), v.maxLength(64)),
    dropped: Count,
  }),
} as const;

export type Topic = keyof typeof EVENT_PAYLOADS;

export const TOPICS = Object.keys(EVENT_PAYLOADS) as Topic[];

export const TopicSchema = v.picklist(TOPICS);

export type EventData = { [T in Topic]: v.InferOutput<(typeof EVENT_PAYLOADS)[T]> };

/** A topic group: the part of a topic name before its first dot (`vfs`, `proc`, `notify`, …). */
export const TOPIC_GROUPS = [...new Set(TOPICS.map((t) => t.split('.')[0] ?? t))];

/** Whether `pattern` (an exact topic or `group.*`) selects `topic` (§4.4.9 `sys.subscribe`). */
export function topicMatches(pattern: string, topic: Topic): boolean {
  if (pattern.endsWith('.*')) {
    const group = pattern.slice(0, -2);
    return topic === group || topic.startsWith(`${group}.`);
  }
  return pattern === topic;
}

/** An exact topic name or `group.*` for one of TOPIC_GROUPS. */
export const TopicPattern = v.pipe(
  v.string(),
  v.maxLength(64),
  v.check(
    (p) =>
      (TOPICS as readonly string[]).includes(p) ||
      (p.endsWith('.*') && TOPIC_GROUPS.includes(p.slice(0, -2))),
  ),
);

/** One delivered event: `{topic, seq, t, data}` where `seq` is per topic and strictly increasing. */
export const KEvent = v.variant(
  'topic',
  TOPICS.map((topic) =>
    v.strictObject({
      topic: v.literal(topic),
      seq: Count,
      t: EpochMs,
      data: EVENT_PAYLOADS[topic],
    }),
  ),
);

export type KEvent<T extends Topic = Topic> = {
  [K in T]: { topic: K; seq: number; t: number; data: EventData[K] };
}[T];
