/**
 * The kernel link (`createAiLink` → `installAi`) and the `ai.embed` backend configuration:
 * what the kernel's `installIo` sees (kernel/src/core/io/ai.ts), the lazy file-system view, the
 * service start results, the seams, and the Transformers.js environment of §3.7.
 */
import type { SemsearchResult } from '@plotinium/protocol';
import { describe, expect, it } from 'vitest';

import { EMBED_MAX_TOKENS } from '../src/embed/protocol.ts';
import { ORT_VERSION, PRIMARY } from '../src/embed/config.ts';
import {
  BROWSER_ENVIRONMENT,
  TransformersBackend,
  type TransformersEnvLike,
  type TransformersLike,
  configureEnv,
} from '../src/embed/transformers-backend.ts';
import { createAiLink } from '../src/kernel/link.ts';
import { HookRegistry } from '@plotinium/kernel/hooks';
import {
  FakeBus,
  Handlers,
  MemFs,
  TestOs,
  VirtualClock,
  makeError,
  posixMay,
  settle,
} from './harness/kernel.ts';

const svcCtx = {
  signal: new AbortController().signal,
  log: () => undefined,
  label: () => undefined,
};

describe('createAiLink as the kernel installs it (ARC-06, RAG-06, BOOT-10)', () => {
  it('ARC-06 the link is built lazily from the kernel context and works before the file system is mounted', async () => {
    const clock = new VirtualClock();
    const bus = new FakeBus(clock);
    const hooks = new HookRegistry();
    const handlers = new Handlers();
    let mounted: MemFs | null = null;
    const factory = createAiLink({
      kernel: {
        handlers,
        bus,
        makeError,
        now: () => clock.now(),
        epochMs: () => clock.epochMs(),
        log: () => undefined,
      },
      may: posixMay,
      timers: clock,
    });
    const ai = factory({
      hooks,
      fs: () => mounted,
      sessionUid: () => undefined,
      osSessionId: () => '01890000-0000-7000-8000-000000000001',
      online: () => false,
    });
    // Nothing is registered at link time (safe mode starts none of the services).
    expect(handlers.impls.size).toBe(0);
    expect(hooks.hooks.search.available()).toBe('none');

    const started = await ai.services['ai.runtime'].start(svcCtx);
    expect(started).toEqual({
      status: 'degraded',
      reason: 'no embedding model: keyword search only',
      selfHeals: false,
    });
    expect([...handlers.impls.keys()]).toContain('ai.semsearch');
    expect(hooks.hooks.search.available()).toBe('keyword');

    // Before `vfs` mounted, a query sees an empty tree: no results, no crash.
    const caller = {
      pcb: {
        pid: 9,
        pgid: 9,
        sid: 9,
        name: 'sh',
        cls: 'user' as const,
        tty: null,
        cwdPath: '/',
        cred: { uid: 1000, gid: 100, groups: [100], ruid: 1000 },
      },
      origin: 'E' as const,
      wid: null,
    };
    const empty = (await handlers.impls
      .get('ai.semsearch')
      ?.handle(caller, { q: 'anything', k: 5 })) as SemsearchResult;
    expect(empty.results).toEqual([]);
    mounted = new MemFs(bus, clock, [{ uid: 1000, name: 'alice' }]);
    mounted.write('/home/alice/todo.txt', 'buy cardamom for the chai\n', 1000);
    const later = (await handlers.impls
      .get('ai.semsearch')
      ?.handle(caller, { q: 'cardamom', k: 5 })) as SemsearchResult;
    expect(later.mode).toBe('keyword');

    // The daemons need the kernel's spawner; without it they report why.
    expect(await ai.services['ai.indexer'].start(svcCtx)).toMatchObject({ status: 'degraded' });
    // The agent without a gateway: degraded, and the shell seam says the NL command is absent.
    expect(await ai.services['ai.agent'].start(svcCtx)).toMatchObject({
      status: 'degraded',
      reason: 'no gateway fetch',
    });
    expect(hooks.hooks.shell.available()).toBe(false);
    // Uninstall puts the kernel's no-op seams back (C12).
    ai.uninstall();
    expect(hooks.hooks.search.available()).toBe('none');
  });

  it('RAG-01 the indexer and predictor services spawn their daemons through the kernel as processes', async () => {
    const spawned: string[] = [];
    const os = new TestOs({
      deps: {
        spawnDaemon: (name) => {
          spawned.push(name);
          return Promise.resolve({ pid: 40 + spawned.length });
        },
      },
    });
    await os.startServices('ai.runtime', 'ai.indexer', 'ai.predictor');
    expect(spawned).toEqual(['ai.indexer', 'ai.predictor']);
    expect(os.klog.join('\n')).toMatch(/ai\.indexer running as pid 41/);
  });

  it('BOOT-10 the model loads only after desktop-interactive plus 2 s of idle, never on the boot path', async () => {
    const os = new TestOs({ embed: true });
    await os.startServices('ai.runtime');
    expect(os.workers).toHaveLength(0);
    os.ai.desktopInteractive();
    os.clock.advance(1_999);
    expect(os.workers).toHaveLength(0);
    os.clock.advance(1);
    await settle();
    expect(os.workers).toHaveLength(1);
    expect(os.workers[0]?.received[0]).toMatchObject({ t: 'load', model: 'primary', threads: 1 });
    expect(os.ai.embed?.state).toBe('ready');
    expect(os.bus.topics('ai.model').map((e) => (e.data as { state: string }).state)).toEqual([
      'loading',
      'loading',
      'ready',
    ]);
    expect(os.ai.modelBytes()).toBeGreaterThan(0);
  });

  it('MEM-06 eviction terminates the ai.embed worker, and a search box focus pins the model against it', async () => {
    const os = new TestOs({ embed: true, sessionUid: 1000 });
    await os.startServices('ai.runtime');
    os.ai.embed?.ensureLoaded('test');
    await settle();
    await os.call(os.pcb(1000), 'ai.search.focus', { on: true });
    expect(os.ai.evictModel()).toBe(false);
    await os.call(os.pcb(1000), 'ai.search.focus', { on: false });
    expect(os.ai.evictModel()).toBe(true);
    expect(os.workers[0]?.terminated).toBe(true);
    expect(os.ai.modelBytes()).toBe(0);
  });

  it('AGT-03 without the agent runtime a batch carrying no plan token is refused', () => {
    const os = new TestOs();
    const caller = { pcb: os.pcb(1000), origin: 'E' as const, wid: null };
    expect(os.ai.verifyPlanToken(caller, { ops: [] })).toMatchObject({
      errno: 'EPERM',
      detail: { reason: 'no-token' },
    });
  });
});

describe('ai.embed Transformers.js backend (RAG-05, MEM-06)', () => {
  function fakeEnv(): TransformersEnvLike {
    return {
      allowRemoteModels: true,
      allowLocalModels: false,
      localModelPath: '/somewhere/',
      useBrowserCache: false,
      useWasmCache: false,
      backends: { onnx: { wasm: {} } },
    };
  }

  it('RAG-05 the environment is self-hosted: no remote models, versioned /models/<lock-id>/, and wasmPaths as an OBJECT under /ort/<version>/', () => {
    const env = fakeEnv();
    configureEnv(env, BROWSER_ENVIRONMENT, 2, PRIMARY);
    expect(env).toMatchObject({
      allowRemoteModels: false,
      allowLocalModels: true,
      localModelPath: '/models/4262131b/',
      useBrowserCache: true,
      // Off: in a worker it imports the ORT factory from a blob: URL, which the C10 CSP blocks.
      useWasmCache: false,
    });
    expect(env.backends.onnx.wasm).toEqual({
      wasmPaths: {
        wasm: `/ort/${ORT_VERSION}/ort-wasm-simd-threaded.asyncify.wasm`,
        mjs: `/ort/${ORT_VERSION}/ort-wasm-simd-threaded.asyncify.mjs`,
      },
      numThreads: 2,
      proxy: false,
    });
  });

  it('MEM-06 inference is batch size 1 with at most 512 tokens, using the q8 model on the wasm device', async () => {
    const env = fakeEnv();
    const seen: Array<{ input: string; opts: unknown }> = [];
    const loads: unknown[] = [];
    const tokenizer = Object.assign(
      (input: string, opts: { truncation: boolean; max_length?: number }) => {
        seen.push({ input, opts });
        return {
          input_ids: {
            dims: [1, Math.min(input.split(' ').length, opts.max_length ?? 1e9)],
            data: [],
          },
        };
      },
      {},
    );
    const lib: TransformersLike = {
      env,
      AutoTokenizer: {
        from_pretrained: (id, o) => {
          loads.push({ id, revision: o.revision });
          o.progress_callback({ status: 'progress', file: 'tokenizer.json', loaded: 5, total: 10 });
          return Promise.resolve(tokenizer);
        },
      },
      AutoModel: {
        from_pretrained: (id, o) => {
          loads.push({ id, dtype: o.dtype, device: o.device });
          return Promise.resolve(() =>
            Promise.resolve({
              sentence_embedding: { dims: [1, 768], data: new Float32Array(768).fill(0.1) },
            }),
          );
        },
      },
    };
    const backend = new TransformersBackend(() => Promise.resolve(lib));
    const progress: number[] = [];
    await backend.load(PRIMARY, 1, (loaded) => progress.push(loaded));
    expect(loads).toEqual([
      { id: 'MongoDB/mdbr-leaf-ir', revision: PRIMARY.revision },
      { id: 'MongoDB/mdbr-leaf-ir', dtype: 'q8', device: 'wasm' },
    ]);
    expect(progress).toEqual([5]);
    const v = await backend.run('one two three');
    expect(v).toHaveLength(768);
    expect(seen.at(-1)).toEqual({
      input: 'one two three',
      opts: { truncation: true, max_length: EMBED_MAX_TOKENS },
    });
    // The loaded tokenizer is the token counter now (no special tokens counted).
    expect(backend.counter.count('a b c d')).toBe(4);
  });
});
