import { describe, expect, it } from 'vitest';

import { EMBED_MAX_TOKENS, type FromEmbedWorker } from '../src/embed/protocol.ts';
import {
  type EmbedBackend,
  Embedder,
  checkInput,
  createEmbedHandler,
  embedInput,
} from '../src/embed/embedder.ts';
import { FALLBACK, PRIMARY, QUERY_PREFIX, modelKey } from '../src/embed/config.ts';
import { approxWordPiece } from '../src/indexer/tokens.ts';
import { isUnit } from '../src/search/vector-index.ts';

function fakeBackend(fail = false): EmbedBackend & { inputs: string[] } {
  const inputs: string[] = [];
  return {
    inputs,
    load: (_m, _t, progress) => {
      if (fail) return Promise.reject(new Error('no weights'));
      progress(50, 100);
      progress(100, 100);
      return Promise.resolve();
    },
    run: (input) => {
      inputs.push(input);
      if (input.includes('crash')) return Promise.reject(new Error('ort oom'));
      return Promise.resolve(new Float32Array(768).fill(0.5));
    },
  };
}

describe('ai.embed worker (MEM-06, I-A7)', () => {
  it('MEM-06 the Embedder rejects batches larger than 1 and inputs above 512 tokens', async () => {
    const e = new Embedder(fakeBackend(), approxWordPiece);
    const batch = await e.embed('doc', '', ['a', 'b']);
    expect(!batch.ok && batch.error.errno).toBe('EINVAL');
    const long = await e.embed('doc', '', 'word '.repeat(EMBED_MAX_TOKENS));
    expect(!long.ok && long.error.errno).toBe('EINVAL');
    expect(checkInput('word '.repeat(EMBED_MAX_TOKENS - 2), approxWordPiece).ok).toBe(true);
    expect(checkInput('word '.repeat(EMBED_MAX_TOKENS - 1), approxWordPiece).ok).toBe(false);
  });

  it('RAG-05 documents get no prefix, queries get the retrieval prefix, and output is 384-d unit length', async () => {
    const b = fakeBackend();
    const e = new Embedder(b, approxWordPiece);
    const doc = await e.embed('doc', 'LRU > Eviction', 'pages');
    const q = await e.embed('query', '', 'where is the lru');
    expect(doc.ok && isUnit(doc.value)).toBe(true);
    expect(q.ok && q.value.length).toBe(384);
    expect(b.inputs).toEqual(['LRU > Eviction\npages', `${QUERY_PREFIX}where is the lru`]);
    expect(embedInput('doc', '', 'x', FALLBACK)).toBe('x');
  });

  it('RAG-06 the worker reports load progress, readiness, vectors and failures as protocol messages', async () => {
    const posted: FromEmbedWorker[] = [];
    let clock = 0;
    const handler = createEmbedHandler(
      new Embedder(fakeBackend(), approxWordPiece),
      (m) => posted.push(m),
      () => (clock += 5),
    );
    await handler({ t: 'load', model: 'primary', threads: 2 });
    await handler({ t: 'embed', id: 1, kind: 'doc', header: '', text: 'hello' });
    await handler({ t: 'embed', id: 2, kind: 'doc', header: '', text: 'word '.repeat(600) });
    await handler({ t: 'embed', id: 3, kind: 'doc', header: '', text: 'crash' });
    expect(posted.map((m) => m.t)).toEqual([
      'progress',
      'progress',
      'ready',
      'vector',
      'error',
      'error',
    ]);
    expect(posted[2]).toEqual({ t: 'ready', modelKey: modelKey(PRIMARY), threads: 2 });
    expect(posted[4]).toMatchObject({ t: 'error', id: 2, errno: 'EINVAL' });
    expect(posted[5]).toMatchObject({ t: 'error', id: 3, errno: 'EIO' });
    const failed: FromEmbedWorker[] = [];
    await createEmbedHandler(
      new Embedder(fakeBackend(true), approxWordPiece),
      (m) => failed.push(m),
      () => 0,
    )({ t: 'load', model: 'fallback', threads: 1 });
    expect(failed).toEqual([{ t: 'error', errno: 'EIO', message: 'no weights' }]);
  });
});

describe('kernel seams', () => {
  it('AIN-C2 ai registers the scheduler, shell and search seams with the @plotinium/kernel/hooks shapes', async () => {
    const { createAiHooks, registerAiHooks } = await import('../src/hooks.ts');
    const { HookRegistry, NOOP_HOOKS } = await import('@plotinium/kernel/hooks');
    expect(createAiHooks({})).toEqual({});
    const idle: number[] = [];
    let semantic: 'semantic' | 'keyword' | 'none' = 'keyword';
    const hooks = createAiHooks({
      predict: {
        onIdle: (ms) => idle.push(ms),
        residencyHint: () => ({ app: 'editor', ttlMs: 60_000 }),
      },
      agentAvailable: () => true,
      searchAvailable: () => semantic,
    });
    hooks.scheduler?.onIdle(2_500);
    expect(idle).toEqual([2_500]);
    expect(hooks.scheduler?.residencyHint()).toEqual({ app: 'editor', ttlMs: 60_000 });
    expect(hooks.shell?.available()).toBe(true);
    expect(hooks.search?.available()).toBe('keyword');
    semantic = 'semantic';
    expect(hooks.search?.available()).toBe('semantic');

    // The kernel's own registry accepts them and goes back to the no-ops on unregister (C12).
    const registry = new HookRegistry();
    const off = registerAiHooks(registry, { searchAvailable: () => 'semantic' });
    expect(registry.hooks.search.available()).toBe('semantic');
    expect(registry.hooks.shell).toBe(NOOP_HOOKS.shell);
    off();
    expect(registry.hooks).toBe(NOOP_HOOKS);
  });
});
