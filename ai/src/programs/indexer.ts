/**
 * `ai.indexer`: the background indexing daemon (rag-semantic-search.md §3.1–§3.3; RAG-01, RAG-02,
 * RAG-03; AIN-A1..A3).
 *
 * An ordinary executor process running as the session uid at PRI 32 (priority 22 + nice 10, the
 * background band), visible in `ps`, killable, restarted by the service manager.
 *
 * - SEES through the kernel: `sys.subscribe` to `vfs.create|write|rename|unlink|chmod|chown`
 *   under $HOME (the bus delivers only events the uid may see), and file text only through
 *   `open`/`read` as the session uid (EACCES → skipped, no row written).
 * - ACTS through typed syscalls: `ai.index.lookup` (hash known?), `ai.index.embed` (ONE chunk per
 *   call, BLOCKING on `ai:embed`), `ai.index.put` (the file's whole chunk set), `ai.index.drop`.
 *   Nothing here touches IndexedDB (AIN-A2).
 * - SCHEDULED: one chunk embedding is one quantum; while the user is active
 *   (`ai.index.status` says `throttled`) it sleeps as long as the last embedding took — a 50 %
 *   duty cycle — unless the job is in the `deadline` class (pending > 15 s, RAG-02).
 * - Work queue: `dsa/heap` keyed by (class, enqueuedAt): deadline, hot (written in the last 60 s),
 *   hit, normal, backfill; a 1.5 s per-ino debounce coalesces autosave bursts.
 * - Reconciliation at start compares `ai.index.status({files:true})` with a scan of $HOME:
 *   stale or missing files are enqueued, vanished ones dropped. A model change re-indexes all
 *   (class `backfill`).
 * - Incremental: a rename re-embeds nothing (paths are read from the live tree at query time); a
 *   write re-embeds only chunks whose content hash is new.
 */
import { BinaryHeap } from '@plotinium/dsa/heap';
import type { KEvent } from '@plotinium/protocol';
import { IO_MAX_BYTES } from '@plotinium/protocol';

import {
  Debouncer,
  buildIndexPut,
  distinctHashes,
  hashChunksSync,
  planUpdate,
  reconcile,
} from '../indexer/bookkeeping.ts';
import { INDEX_MAX_BYTES, extractText, pathEligibility } from '../indexer/extract.ts';
import { IndexQueue, type JobClass, sleepAfterChunk } from '../indexer/queue.ts';
import { type AiProgram, type AiProgramContext, type SysGen, asKEvents, attempt } from './model.ts';

export const INDEXER_TOPICS = [
  'vfs.create',
  'vfs.write',
  'vfs.rename',
  'vfs.unlink',
  'vfs.chmod',
  'vfs.chown',
] as const;

/** Priority 22 + nice 10 = PRI 32 (§3.1). */
export const INDEXER_PRIORITY = 22;
export const INDEXER_NICE = 10;
export const HOT_WINDOW_MS = 60_000;
const IDLE_WAIT_MS = 5_000;
/** Back-off after the model was evicted (it re-loads on the next embed). */
export const RETRY_EVICTED_MS = 1_000;
/** Back-off while the model is failed (the kernel retries the load once after 30 s). */
export const RETRY_MODEL_MS = 60_000;
const LOOKUP_BATCH = 512;
const SCAN_PAGE = 1_000;

interface FileInfo {
  path: string;
  version: number;
}

export interface IndexerState {
  home: string;
  uid: number;
  modelKey: string;
  fd: number | null;
  files: Map<string, FileInfo>;
  dirs: Map<string, string>;
  /** Inos written but not located yet (a `vfs.write` carries no name). */
  unknown: Map<string, string>;
  lastWrite: Map<string, number>;
  debounce: Debouncer;
  queue: IndexQueue;
  lastEmbedMs: number;
  counters: { indexed: number; skipped: number; failed: number; embedded: number; reused: number };
}

function join(dir: string, name: string): string {
  return dir === '/' ? `/${name}` : `${dir}/${name}`;
}

export function initIndexer(): IndexerState {
  return {
    home: '',
    uid: -1,
    modelKey: '',
    fd: null,
    files: new Map(),
    dirs: new Map(),
    unknown: new Map(),
    lastWrite: new Map(),
    debounce: new Debouncer(),
    queue: new IndexQueue(new BinaryHeap()),
    lastEmbedMs: 0,
    counters: { indexed: 0, skipped: 0, failed: 0, embedded: 0, reused: 0 },
  };
}

/** Rewrite every known path under `from` to live under `to` (a directory rename or move). */
function movePrefix(st: IndexerState, from: string, to: string): void {
  const re = (p: string): string | undefined =>
    p === from ? to : p.startsWith(`${from}/`) ? to + p.slice(from.length) : undefined;
  for (const [ino, p] of st.dirs) {
    const n = re(p);
    if (n !== undefined) st.dirs.set(ino, n);
  }
  for (const f of st.files.values()) {
    const n = re(f.path);
    if (n !== undefined) f.path = n;
  }
}

/**
 * Apply one VFS event to the indexer's view (pure bookkeeping, no syscalls). Returns the inos that
 * must be dropped from the index now.
 */
export function applyEvent(st: IndexerState, ev: KEvent, now: number): string[] {
  if (ev.topic === 'vfs.create') {
    const parent = st.dirs.get(ev.data.parent);
    if (parent === undefined) return [];
    const path = join(parent, ev.data.name);
    if (ev.data.type === 'd') st.dirs.set(ev.data.ino, path);
    else if (ev.data.type === 'f') {
      st.files.set(ev.data.ino, { path, version: ev.data.version });
      st.lastWrite.set(ev.data.ino, now);
      st.debounce.touch(ev.data.ino, now);
    }
    return [];
  }
  if (ev.topic === 'vfs.write') {
    const f = st.files.get(ev.data.ino);
    if (f !== undefined) f.version = ev.data.version;
    else {
      const parent = st.dirs.get(ev.data.parent);
      if (parent === undefined) return [];
      st.unknown.set(ev.data.ino, parent);
    }
    st.lastWrite.set(ev.data.ino, now);
    st.debounce.touch(ev.data.ino, now);
    return [];
  }
  if (ev.topic === 'vfs.rename') {
    const to = st.dirs.get(ev.data.toParent);
    const dir = st.dirs.get(ev.data.ino);
    const file = st.files.get(ev.data.ino);
    if (to === undefined) {
      // Moved out of $HOME: forget it (the kernel's readable set already hides it from others).
      if (dir !== undefined) {
        for (const [ino, f] of st.files) if (f.path.startsWith(`${dir}/`)) st.files.delete(ino);
        st.dirs.delete(ev.data.ino);
      }
      if (file !== undefined) st.files.delete(ev.data.ino);
      return [];
    }
    const newPath = join(to, ev.data.toName);
    if (dir !== undefined) movePrefix(st, dir, newPath);
    else if (file !== undefined) file.path = newPath;
    else {
      const from = st.dirs.get(ev.data.fromParent);
      if (from === undefined) st.unknown.set(ev.data.ino, to);
    }
    // Nothing is re-embedded: chunk hashes hold no file name (§3.3).
    return [];
  }
  if (ev.topic === 'vfs.unlink') {
    const dropped: string[] = [];
    for (const ino of ev.data.inos) {
      const dir = st.dirs.get(ino);
      if (dir !== undefined) {
        for (const [fino, f] of st.files)
          if (f.path.startsWith(`${dir}/`)) {
            st.files.delete(fino);
            st.queue.remove(fino);
            st.debounce.cancel(fino);
            dropped.push(fino);
          }
        st.dirs.delete(ino);
      }
      if (st.files.delete(ino)) dropped.push(ino);
      st.queue.remove(ino);
      st.debounce.cancel(ino);
      st.unknown.delete(ino);
    }
    return dropped;
  }
  // chmod / chown: nothing to re-index; the kernel filters at query time and drops the old owner's
  // text on chown (§3.3).
  return [];
}

/** Apply a batch of at most 64 events (`sys.events` max); returns the inos to drop. */
export function applyEvents(st: IndexerState, events: readonly KEvent[], now: number): string[] {
  const drop: string[] = [];
  for (const ev of events) drop.push(...applyEvent(st, ev, now));
  return drop;
}

/** Move the inos whose 1.5 s debounce elapsed into the work queue. */
export function drainDebounce(st: IndexerState, now: number): void {
  for (const ino of st.debounce.take(now)) st.queue.enqueue(ino, classFor(st, ino, now), now);
}

function enqueueAll(st: IndexerState, inos: readonly string[], cls: JobClass, now: number): void {
  for (const ino of inos) st.queue.enqueue(ino, cls, now);
}

/** The class of a job leaving the debouncer: `hot` if the user wrote it in the last 60 s. */
export function classFor(st: IndexerState, ino: string, now: number): JobClass {
  const w = st.lastWrite.get(ino);
  return w !== undefined && now - w < HOT_WINDOW_MS ? 'hot' : 'normal';
}

interface ScanEntry {
  readonly name: string;
  readonly ino: string;
  readonly type: string;
  readonly stat?: { readonly version: number } | undefined;
}

/** Record one `readdir` page (at most SCAN_PAGE entries, pure bookkeeping). */
function absorbPage(
  st: IndexerState,
  dir: string,
  entries: readonly ScanEntry[],
  todo: string[],
): void {
  for (const e of entries) {
    const path = join(dir, e.name);
    if (e.type === 'd') {
      if (!e.name.startsWith('.')) {
        st.dirs.set(e.ino, path);
        todo.push(path);
      }
    } else if (e.type === 'f') {
      st.files.set(e.ino, { path, version: e.stat?.version ?? 0 });
    }
  }
}

/** Group the unlocated inos by directory and forget them (they are re-found by `readdir`). */
function takeUnknown(st: IndexerState): Map<string, string[]> {
  const byDir = new Map<string, string[]>();
  for (const [ino, dir] of st.unknown) byDir.set(dir, [...(byDir.get(dir) ?? []), ino]);
  st.unknown.clear();
  return byDir;
}

function locateIn(
  st: IndexerState,
  dir: string,
  inos: readonly string[],
  entries: readonly ScanEntry[],
): void {
  for (const e of entries)
    if (inos.includes(e.ino) && e.type === 'f')
      st.files.set(e.ino, { path: join(dir, e.name), version: e.stat?.version ?? 0 });
}

/** Scan a directory tree breadth-first with `readdir` (plus) as the session uid. */
function* scan(ctx: AiProgramContext, st: IndexerState, root: string): SysGen<void> {
  const rootStat = yield* attempt(ctx.sys, 'stat', { path: root });
  if (!rootStat.ok) return;
  st.dirs.set(rootStat.value.ino, root);
  const todo = [root];
  while (todo.length > 0) {
    const dir = todo.shift() ?? root;
    let cursor: string | undefined;
    do {
      const page = yield* attempt(ctx.sys, 'readdir', {
        path: dir,
        plus: true,
        limit: SCAN_PAGE,
        ...(cursor === undefined ? {} : { cursor }),
      });
      if (!page.ok) break;
      absorbPage(st, dir, page.value.entries, todo);
      cursor = page.value.next;
      yield ctx.tick;
    } while (cursor !== undefined);
  }
}

/** Locate inos written before their name was known (`vfs.write` has no name). */
function* locateUnknown(ctx: AiProgramContext, st: IndexerState): SysGen<void> {
  if (st.unknown.size === 0) return;
  for (const [dir, inos] of takeUnknown(st)) {
    const page = yield* attempt(ctx.sys, 'readdir', { path: dir, plus: true, limit: SCAN_PAGE });
    if (page.ok) locateIn(st, dir, inos, page.value.entries);
  }
}

/** Read a whole file (≤ 2 MiB) as the session uid. */
function* readFile(
  ctx: AiProgramContext,
  path: string,
  size: number,
): SysGen<Uint8Array | undefined> {
  const opened = yield* attempt(ctx.sys, 'open', { path, flags: 'r' });
  if (!opened.ok) return undefined;
  const fd = opened.value.fd;
  const out = new Uint8Array(Math.min(size, INDEX_MAX_BYTES + 1));
  let off = 0;
  try {
    while (off < out.length) {
      const r = yield* attempt(ctx.sys, 'read', {
        fd,
        len: Math.min(IO_MAX_BYTES, out.length - off),
      });
      if (!r.ok || r.value.byteLength === 0) break;
      out.set(new Uint8Array(r.value).subarray(0, out.length - off), off);
      off += r.value.byteLength;
    }
  } finally {
    yield* attempt(ctx.sys, 'close', { fd });
  }
  return out.subarray(0, off);
}

export type IndexOutcome = 'indexed' | 'skipped' | 'gone' | 'failed' | 'stale' | 'retry';

/** Index one file (§3.2): read, extract, chunk, look up, embed new chunks, put. */
export function* indexFile(
  ctx: AiProgramContext,
  st: IndexerState,
  ino: string,
  cls: JobClass,
): SysGen<IndexOutcome> {
  const info = st.files.get(ino);
  if (info === undefined) return 'gone';
  if (!pathEligibility(info.path, 'f').ok) {
    st.counters.skipped++;
    return 'skipped';
  }
  const stat = yield* attempt(ctx.sys, 'stat', { path: info.path });
  if (!stat.ok || stat.value.ino !== ino) return 'gone';
  if (stat.value.type !== 'f' || stat.value.size > INDEX_MAX_BYTES) {
    st.counters.skipped++;
    return 'skipped';
  }
  const version = stat.value.version;
  const bytes = yield* readFile(ctx, info.path, stat.value.size);
  if (bytes === undefined) {
    st.counters.skipped++;
    return 'skipped';
  }
  const extracted = extractText(info.path, 'f', bytes);
  if (!extracted.ok) {
    st.counters.skipped++;
    return 'skipped';
  }
  yield ctx.tick;
  const chunks = hashChunksSync(extracted.text, extracted.kind, st.modelKey);
  yield ctx.tick;
  const hashes = distinctHashes(chunks);
  const known = new Set<string>();
  for (let i = 0; i < hashes.length; i += LOOKUP_BATCH) {
    const batch = hashes.slice(i, i + LOOKUP_BATCH);
    const r = yield* attempt(ctx.sys, 'ai.index.lookup', { hashes: batch });
    if (!r.ok) return 'failed';
    r.value.known.forEach((k, j) => {
      const h = batch[j];
      if (k && h !== undefined) known.add(h);
    });
  }
  const plan = planUpdate({
    ino,
    inodeVersion: version,
    modelKey: st.modelKey,
    own: stat.value.uid === st.uid,
    chunks,
    known,
  });
  const vectors = new Map<string, Float32Array<ArrayBuffer>>();
  for (const c of plan.toEmbed) {
    const t0 = ctx.now();
    const v = yield* attempt(ctx.sys, 'ai.index.embed', {
      text: c.text,
      header: c.header,
      kind: 'doc',
    });
    if (!v.ok) {
      if (v.errno === 'ECANCELED' || (v.errno === 'EIO' && v.reason === 'model')) {
        // The model was evicted (it re-loads on the next embed) or failed to load: keep the file
        // queued and back off (a failed model answers at once, so without the pause this spins).
        st.queue.enqueue(ino, cls, ctx.now());
        yield* ctx.sleep(v.reason === 'evicted' ? RETRY_EVICTED_MS : RETRY_MODEL_MS);
        return 'retry';
      }
      st.counters.failed++;
      return 'failed';
    }
    st.lastEmbedMs = ctx.now() - t0;
    st.counters.embedded++;
    vectors.set(c.contentHash, new Float32Array(v.value));
    // The 50 % duty cycle while the user is active (§3.2.6).
    const status = yield* attempt(ctx.sys, 'ai.index.status', {});
    const active = status.ok && status.value.state === 'throttled';
    const pause = sleepAfterChunk({
      lastEmbedMs: st.lastEmbedMs,
      lastInputAt: active ? ctx.now() : Number.NEGATIVE_INFINITY,
      now: ctx.now(),
      cls,
    });
    if (pause > 0) yield* ctx.sleep(pause);
    else yield ctx.tick;
  }
  st.counters.reused += plan.reused;
  const put = buildIndexPut(plan, vectors);
  if (put === undefined) return 'failed';
  const r = yield* attempt(ctx.sys, 'ai.index.put', put);
  if (!r.ok) {
    if (r.errno === 'EAGAIN') {
      // Changed since it was read: index the new version.
      st.queue.enqueue(ino, cls, ctx.now());
      return 'stale';
    }
    st.counters.failed++;
    return 'failed';
  }
  info.version = version;
  st.counters.indexed++;
  return 'indexed';
}

/** Reconciliation at start (§3.2.1). */
function* reconcileAtStart(ctx: AiProgramContext, st: IndexerState): SysGen<void> {
  const status = yield* attempt(ctx.sys, 'ai.index.status', { files: true });
  if (!status.ok) return;
  const previous = st.modelKey === '' ? status.value.modelKey : st.modelKey;
  st.modelKey = status.value.modelKey;
  yield* scan(ctx, st, st.home);
  const live = [...st.files].map(([ino, f]) => ({
    ino,
    version: f.version,
    eligible: pathEligibility(f.path, 'f').ok,
  }));
  const indexed = (status.value.files ?? []).map((f) => ({
    ino: f.ino,
    inodeVersion: f.inodeVersion,
  }));
  const rec = reconcile(indexed, live, previous, st.modelKey);
  const now = ctx.now();
  // Only files under this session's $HOME are ours to drop; other users' rows stay (a vanished
  // inode is never scored anyway: the readable set is built from the live tree, I-A9).
  const mine = rec.drop.filter((ino) => st.files.has(ino));
  if (mine.length > 0) yield* attempt(ctx.sys, 'ai.index.drop', { inos: mine.slice(0, 1_000) });
  enqueueAll(st, rec.enqueue, rec.backfill ? 'backfill' : 'normal', now);
}

export function* runIndexer(ctx: AiProgramContext, st: IndexerState): SysGen<number> {
  const cred = yield* ctx.sys.call('proc.cred', {});
  st.home = cred.home;
  st.uid = cred.uid;
  // PRI 32 NI 10 even when spawned without the manifest priority (§3.1).
  yield* attempt(ctx.sys, 'setpriority', {
    pid: 0,
    priority: INDEXER_PRIORITY,
    nice: INDEXER_NICE,
  });
  const sub = yield* ctx.sys.call('sys.subscribe', { topics: [...INDEXER_TOPICS], path: st.home });
  st.fd = sub.fd;
  yield* reconcileAtStart(ctx, st);

  for (;;) {
    const busy = st.queue.size > 0 || st.debounce.pending > 0;
    const got = yield* attempt(ctx.sys, 'sys.events', {
      fd: st.fd,
      max: 64,
      timeoutMs: st.queue.size > 0 ? 0 : busy ? 500 : IDLE_WAIT_MS,
    });
    const now = ctx.now();
    if (got.ok) {
      const drop = applyEvents(st, asKEvents(got.value.events), now);
      if (drop.length > 0) yield* attempt(ctx.sys, 'ai.index.drop', { inos: drop.slice(0, 1_000) });
      if (got.value.dropped > 0) yield* reconcileAtStart(ctx, st);
    } else if (got.errno !== 'ETIMEDOUT' && got.errno !== 'EAGAIN') {
      // The subscription is gone (EBADF): subscribe again and reconcile.
      const again = yield* ctx.sys.call('sys.subscribe', {
        topics: [...INDEXER_TOPICS],
        path: st.home,
      });
      st.fd = again.fd;
      yield* reconcileAtStart(ctx, st);
    }
    yield* locateUnknown(ctx, st);
    drainDebounce(st, ctx.now());
    st.queue.age(ctx.now());
    const job = st.queue.pop();
    if (job !== undefined) yield* indexFile(ctx, st, job.ino, job.cls);
    yield ctx.tick;
  }
}

const program: AiProgram<IndexerState> = {
  checkpointable: false,
  init: () => initIndexer(),
  run: runIndexer,
};

export default program;
