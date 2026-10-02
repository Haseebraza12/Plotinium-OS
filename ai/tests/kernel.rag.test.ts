/**
 * Integration: subsystem A (RAG) end to end through the kernel link — the `ai.indexer` PROGRAM
 * running against simulated system calls, the kernel-side index, the `ai.embed` worker protocol and
 * `ai.semsearch` as the caller (rag-semantic-search.md §3.1–§3.5, §3.12).
 */
import type { SemsearchResult } from '@plotinium/protocol';
import { describe, expect, it } from 'vitest';

import { NOTICE_LOADING, NOTICE_UNAVAILABLE } from '../src/search/hybrid.ts';
import indexer, {
  INDEXER_NICE,
  INDEXER_PRIORITY,
  type IndexerState,
} from '../src/programs/indexer.ts';
import { AI_DAEMONS, AI_MANIFESTS } from '../src/programs/index.ts';
import type { HostFetch } from '../src/kernel/types.ts';
import { ProgramRunner, TestOs, posixMay, settle } from './harness/kernel.ts';

const LRU =
  '# Page replacement\n\nThe least recently used policy evicts the page whose last access is the oldest. ' +
  'An LRU cache keeps a doubly linked list and a hash map so eviction is constant time.\n';
const CHAI =
  '# Chai\n\nBoil water with cardamom, add black tea leaves, milk and sugar, then simmer.\n';
const SECRET =
  '# Private\n\nMy LRU eviction notes for the exam, do not share. Page replacement answers.\n';

async function search(
  os: TestOs,
  uid: number,
  q: string,
  extra: Record<string, unknown> = {},
): Promise<SemsearchResult> {
  return (await os.call(os.pcb(uid), 'ai.semsearch', { q, k: 5, ...extra })) as SemsearchResult;
}

function paths(r: SemsearchResult): string[] {
  return r.results.map((x) => x.path);
}

/** Run the indexer as `uid` until its queue and debounce are empty (or `maxCalls`). */
async function indexAs(os: TestOs, uid: number): Promise<ProgramRunner<IndexerState>> {
  const run = new ProgramRunner(
    os,
    indexer,
    ['ai.indexer'],
    os.pcb(uid, { name: 'ai.indexer', cls: 'system' }),
    {
      // One chunk embedding takes 20 ms of (virtual) time, as a quantum of real inference would.
      'ai.index.embed': async (proc, args) => {
        const v = await os.call(proc.pcb, 'ai.index.embed', args);
        os.clock.advance(20);
        return v;
      },
    },
  );
  await drain(run);
  return run;
}

/** Idle: the indexer is parked in `sys.events` with its long idle timeout and nothing queued. */
function idle(run: ProgramRunner<IndexerState>): boolean {
  const last = run.last;
  return (
    last?.call === 'sys.events' &&
    last.errno === 'ETIMEDOUT' &&
    (last.args as { timeoutMs?: number }).timeoutMs === 5_000 &&
    run.state.queue.size === 0 &&
    run.state.debounce.pending === 0
  );
}

async function drain(run: ProgramRunner<IndexerState>, maxCalls = 4_000): Promise<void> {
  await run.run({ maxCalls, until: () => idle(run) });
}

async function bootWithModel(): Promise<TestOs> {
  const os = new TestOs({ embed: true, sessionUid: 1000 });
  await os.startServices('ai.runtime');
  os.ai.embed?.ensureLoaded('test');
  await settle();
  return os;
}

describe('ai.indexer as a process (RAG-01, RAG-02)', () => {
  it('RAG-01 the indexer is a scheduled background program at PRI 32, visible under its own name and throttled while the user is active', async () => {
    const manifest = AI_MANIFESTS.find((m) => m.name === 'ai-indexer');
    expect(manifest).toMatchObject({
      class: 'system',
      priority: 22,
      caps: ['fs.read', 'mem', 'ai.index'],
    });
    expect(AI_DAEMONS['ai.indexer']).toMatchObject({
      argv: ['ai.indexer'],
      priority: 22,
      nice: 10,
    });

    const os = await bootWithModel();
    os.fs.write('/home/alice/lru.md', LRU, 1000);
    os.fs.write('/home/alice/chai.md', CHAI, 1000);
    // The user is typing: every embedded chunk is followed by a duty-cycle sleep (§3.2.6).
    os.ai.noteInput();
    const run = await indexAs(os, 1000);

    expect(run.proc.priority).toEqual({ priority: INDEXER_PRIORITY, nice: INDEXER_NICE });
    expect(INDEXER_PRIORITY + INDEXER_NICE).toBe(32);
    expect(run.state.counters.indexed).toBe(2);
    expect(run.count('ai.index.embed')).toBeGreaterThanOrEqual(2);
    // It reads files ONLY through open/read as the session uid (AIN-A1).
    expect(run.count('open')).toBe(2);
    expect(run.count('sleep')).toBeGreaterThanOrEqual(1);
    const status = (await os.call(os.pcb(1000), 'ai.index.status', {})) as {
      indexedFiles: number;
      chunks: number;
    };
    expect(status.indexedFiles).toBe(2);
    expect(status.chunks).toBeGreaterThanOrEqual(2);
    expect(os.bus.topics('ai.index.progress').length).toBeGreaterThan(0);
  });

  it('RAG-02 create, modify, rename and delete of a 50 KB text file are reflected in results within 30 s', async () => {
    const os = await bootWithModel();
    const run = await indexAs(os, 1000);
    const t0 = os.clock.now();

    const body = `# Deadlock notes\n\n${'Banker algorithm avoids deadlock by checking safe states. '.repeat(900)}`;
    expect(body.length).toBeGreaterThan(50_000);
    os.fs.mkdir('/home/alice/notes', 1000, 100, 0o755);
    os.fs.write('/home/alice/notes/deadlock.md', body, 1000);
    await drain(run);
    expect(paths(await search(os, 1000, 'banker algorithm deadlock safe state'))).toContain(
      '/home/alice/notes/deadlock.md',
    );
    const embeddedAfterCreate = run.state.counters.embedded;

    // Modify: only the changed chunk's hash is new, so only it is embedded again.
    os.fs.write(
      '/home/alice/notes/deadlock.md',
      `${body}\n\nWound-wait and wait-die prevent starvation.\n`,
      1000,
    );
    await drain(run);
    const reembedded = run.state.counters.embedded - embeddedAfterCreate;
    expect(reembedded).toBeGreaterThanOrEqual(1);
    expect(reembedded).toBeLessThan(embeddedAfterCreate);
    expect(paths(await search(os, 1000, 'wound wait die starvation'))[0]).toBe(
      '/home/alice/notes/deadlock.md',
    );

    // Rename: nothing is re-embedded; the path is read from the live tree at query time.
    const before = run.state.counters.embedded;
    os.fs.rename('/home/alice/notes/deadlock.md', '/home/alice/notes/os-deadlock.md');
    await drain(run);
    expect(run.state.counters.embedded).toBe(before);
    expect(paths(await search(os, 1000, 'banker algorithm deadlock'))).toContain(
      '/home/alice/notes/os-deadlock.md',
    );

    // Delete: gone from the results (and dropped from the index).
    os.fs.unlink('/home/alice/notes/os-deadlock.md');
    await drain(run);
    expect(paths(await search(os, 1000, 'banker algorithm deadlock'))).not.toContain(
      '/home/alice/notes/os-deadlock.md',
    );
    expect(os.clock.now() - t0).toBeLessThan(4 * 30_000);
  });
});

describe('ai.semsearch through the kernel (RAG-03, RAG-06)', () => {
  it('RAG-03 no result ever includes content the querying user cannot read, under the CURRENT permissions', async () => {
    // The server's /api/index/verify, answering for the session user with the live permissions.
    const holder: { os?: TestOs } = {};
    const verify: HostFetch = (url, init) => {
      const os = holder.os;
      if (os === undefined || url !== '/api/index/verify')
        return Promise.reject(new Error('offline'));
      const body = JSON.parse(init.body ?? '{}') as {
        items: Array<{ ino: string; seq: number; inodeVersion: number }>;
      };
      const uid = os.sessionUid ?? -1;
      const cred = { uid, gid: 100, groups: [100] };
      const items = body.items.map((it) => {
        const node = os.fs.inode(it.ino);
        let readable = node !== undefined && posixMay(cred, node, 4);
        for (
          let p = node?.parent ?? null;
          readable && p !== null;
          p = os.fs.inode(p)?.parent ?? null
        ) {
          const dir = os.fs.inode(p);
          readable = dir !== undefined && posixMay(cred, dir, 1);
        }
        return readable && node !== undefined
          ? { ...it, readable, path: os.fs.pathOf(it.ino), snippet: 'shared' }
          : { ino: it.ino, seq: it.seq, readable: false };
      });
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ items }) });
    };
    const os = new TestOs({ embed: true, sessionUid: 1000, fetch: verify });
    holder.os = os;
    await os.startServices('ai.runtime');
    os.ai.embed?.ensureLoaded('test');
    await settle();
    os.fs.write('/home/alice/lru.md', LRU, 1000, 100, 0o644);
    os.fs.write('/home/bob/secret.md', SECRET, 1001, 100, 0o600);
    await indexAs(os, 1000);
    await indexAs(os, 1001);

    // alice's home is 0700: bob sees only his own file, alice never sees bob's 0600 file.
    os.sessionUid = 1001;
    const bob = await search(os, 1001, 'lru eviction page replacement');
    expect(paths(bob)).toEqual(['/home/bob/secret.md']);
    os.sessionUid = 1000;
    const alice = await search(os, 1000, 'lru eviction page replacement');
    expect(paths(alice)).toEqual(['/home/alice/lru.md']);
    for (const r of [...bob.results, ...alice.results]) expect(r.verified).toBe('own');
    os.sessionUid = 1001;

    // Opening alice's home makes her 0644 file visible to bob at once (permEpoch bump) …
    os.fs.chmod('/home/alice', 0o755);
    const shared = await search(os, 1001, 'lru eviction page replacement');
    expect(paths(shared)).toContain('/home/alice/lru.md');
    // A foreign result is shown only as the server verified it, with the server's snippet.
    expect(shared.results.find((r) => r.path === '/home/alice/lru.md')).toMatchObject({
      verified: 'server',
      snippet: 'shared',
    });
    // Offline, foreign results are hidden with a notice (never shown unverified).
    os.online = false;
    const offline = await search(os, 1001, 'lru eviction page replacement');
    expect(paths(offline)).not.toContain('/home/alice/lru.md');
    expect(offline.notices.join(' ')).toMatch(/hidden/);
    os.online = true;
    // … and closing the file again hides it on the very next query.
    os.fs.chmod('/home/alice/lru.md', 0o600);
    expect(paths(await search(os, 1001, 'lru eviction page replacement'))).not.toContain(
      '/home/alice/lru.md',
    );
    // Keyword mode obeys the same readable set.
    expect(paths(await search(os, 1001, 'lru', { mode: 'keyword' }))).not.toContain(
      '/home/alice/lru.md',
    );
  });

  it('RAG-06 semsearch falls back to keyword results with a clear notice while the model loads, fails or is evicted', async () => {
    const os = new TestOs({ embed: true, sessionUid: 1000 });
    await os.startServices('ai.runtime');
    os.fs.write('/home/alice/lru.md', LRU, 1000);
    os.fs.write('/home/alice/chai.md', CHAI, 1000);
    expect(os.hooks.hooks.search.available()).toBe('keyword');

    // First query: the model is not loaded yet — keyword results, the loading notice, and the
    // load starts (never on the boot path, BOOT-10).
    const first = await search(os, 1000, 'lru');
    expect(first.mode).toBe('keyword');
    expect(first.notices).toContain(NOTICE_LOADING);
    expect(os.workers).toHaveLength(1);
    await settle();
    expect(os.ai.embed?.state).toBe('ready');
    expect(os.hooks.hooks.search.available()).toBe('semantic');

    await indexAs(os, 1000);
    const semantic = await search(os, 1000, 'least recently used cache eviction');
    expect(semantic.mode).toBe('semantic');
    expect(paths(semantic)[0]).toBe('/home/alice/lru.md');

    // Memory pressure evicts the model (worker.terminate()): keyword again, with a notice.
    expect(os.ai.evictModel()).toBe(true);
    expect(os.workers[0]?.terminated).toBe(true);
    const evicted = await search(os, 1000, 'least recently used cache eviction');
    expect(evicted.mode).toBe('keyword');
    expect(evicted.notices.length).toBeGreaterThan(0);

    // A build without a model: keyword only, a notice, never an error.
    const bare = new TestOs({ sessionUid: 1000 });
    await bare.startServices('ai.runtime');
    bare.fs.write('/home/alice/chai.md', CHAI, 1000);
    const k = (await bare.call(bare.pcb(1000), 'ai.semsearch', {
      q: 'chai',
      k: 5,
    })) as SemsearchResult;
    expect(k.mode).toBe('keyword');
    expect(k.model.state).toBe('unavailable');
    expect(k.notices).toContain(NOTICE_UNAVAILABLE);
  });

  it('RAG-06 a failed model load degrades to keyword search and retries once after 30 s', async () => {
    const os = new TestOs({ embed: true, sessionUid: 1000 });
    await os.startServices('ai.runtime');
    const spawned = os.workers;
    os.ai.embed?.ensureLoaded('test');
    const w = spawned[0];
    if (w === undefined) throw new Error('no worker');
    w.onmessage?.({ data: { t: 'error', errno: 'EIO', message: 'no weights' } });
    expect(os.ai.embed?.state).toBe('failed');
    expect(os.hooks.hooks.search.available()).toBe('keyword');
    const r = await search(os, 1000, 'anything');
    expect(r.mode).toBe('keyword');
    expect(r.model.state).toBe('unavailable');
    os.clock.advance(30_000);
    await settle();
    expect(spawned).toHaveLength(2);
    expect(os.ai.embed?.state).toBe('ready');
  });

  it('RAG-06 an evicted model does not strand the indexer: its file is re-queued and indexed after the reload', async () => {
    const os = await bootWithModel();
    const run = await indexAs(os, 1000);
    const w = os.workers[0];
    if (w === undefined) throw new Error('no worker');
    // The next load is held, so the eviction lands while the indexer waits for the model.
    os.fs.write('/home/alice/lru.md', LRU, 1000);
    expect(os.ai.evictModel()).toBe(true);
    await drain(run, 400);
    expect(run.state.counters.indexed).toBe(1);
    expect(os.workers.length).toBeGreaterThanOrEqual(2);
    expect(paths(await search(os, 1000, 'least recently used eviction'))).toContain(
      '/home/alice/lru.md',
    );
  });
});
