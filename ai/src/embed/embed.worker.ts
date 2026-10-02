/**
 * The `ai.embed` special worker entry (rag-semantic-search.md §3.1, §3.2.5, §3.7, §3.8).
 *
 * Spawned by the kernel (never by the main thread) as a nested module worker, and only when the
 * model is first needed (BOOT-10). Its only port is the kernel's. It holds ONE model session and
 * answers one job at a time: `load` imports Transformers.js dynamically and configures it for the
 * self-hosted `/models/<lock-id>/` and `/ort/<version>/` files; `embed` runs batch size 1, at most
 * 512 tokens.
 * Eviction is `worker.terminate()` from the kernel: WebAssembly memory never shrinks.
 *
 * Composer (web's kernel worker, Vite): `import EmbedWorker from '@plotinium/ai/embed-worker?worker'`
 * and `spawn: () => new EmbedWorker({ name: 'ai.embed' })` in `installAi`.
 */
import { Embedder, createEmbedHandler } from './embedder.ts';
import type { FromEmbedWorker, ToEmbedWorker } from './protocol.ts';
import { TransformersBackend, type TransformersLike } from './transformers-backend.ts';

const scope = self as unknown as DedicatedWorkerGlobalScope;

const backend = new TransformersBackend(
  async () => (await import('@huggingface/transformers')) as unknown as TransformersLike,
);
const embedder = new Embedder(backend, backend.counter);

function post(msg: FromEmbedWorker): void {
  if (msg.t === 'vector') scope.postMessage(msg, [msg.vector.buffer]);
  else scope.postMessage(msg);
}

const handle = createEmbedHandler(embedder, post, () => performance.now());

// One job at a time, in arrival order (the kernel also keeps at most one in flight).
let chain: Promise<void> = Promise.resolve();
scope.onmessage = (ev: MessageEvent<ToEmbedWorker>) => {
  const msg = ev.data;
  chain = chain.then(() => handle(msg));
};
