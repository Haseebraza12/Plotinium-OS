/**
 * The embedder guard and the worker's message handler (rag-semantic-search.md §3.2.5, I-A7).
 *
 * `Embedder.embed` takes exactly one input; an array (a batch) or more than 512 tokens is EINVAL
 * (test MEM-06). Documents get no prefix; queries get the retrieval prefix. The 768-d output is
 * MRL-truncated to 384 and renormalised.
 *
 * The backend is transformers-backend.ts (`@huggingface/transformers` 4.3.0, imported only inside
 * the `ai.embed` worker when the kernel sends `load`), configured exactly as in §3.7: no remote
 * models, `/models/<lock-id>/`, `wasmPaths` as an OBJECT under `/ort/<version>/`. While it is not
 * loaded the kernel answers from the keyword path (RAG-06).
 */
import type { TokenCounter } from '../indexer/tokens.ts';
import { type Result, fail, ok } from '../util/errors.ts';
import { FALLBACK, PRIMARY, type ModelConfig, modelKey, truncateRenormalise } from './config.ts';
import {
  EMBED_MAX_TOKENS,
  type EmbedKind,
  type FromEmbedWorker,
  type ToEmbedWorker,
} from './protocol.ts';

/** What the Transformers.js backend provides: one input in, one native vector out. */
export interface EmbedBackend {
  load(
    model: ModelConfig,
    threads: number,
    progress: (loaded: number, total: number) => void,
  ): Promise<void>;
  run(input: string): Promise<Float32Array>;
}

/** [CLS] and [SEP] around the input. */
const SPECIAL_TOKENS = 2;

export function embedInput(
  kind: EmbedKind,
  header: string,
  text: string,
  model: ModelConfig = PRIMARY,
): string {
  const body = header === '' ? text : `${header}\n${text}`;
  return kind === 'query' ? `${model.queryPrefix}${body}` : body;
}

/** I-A7: exactly one string of at most 512 tokens including the special tokens. */
export function checkInput(input: unknown, counter: TokenCounter): Result<string> {
  if (typeof input !== 'string')
    return fail(
      'EINVAL',
      undefined,
      undefined,
      'the embedder takes exactly one input (batch size 1)',
    );
  if (counter.count(input) + SPECIAL_TOKENS > EMBED_MAX_TOKENS) {
    return fail('EINVAL', undefined, undefined, 'input exceeds 512 tokens');
  }
  return ok(input);
}

export class Embedder {
  private model: ModelConfig = PRIMARY;
  private readonly backend: EmbedBackend;
  private readonly counter: TokenCounter;

  constructor(backend: EmbedBackend, counter: TokenCounter) {
    this.backend = backend;
    this.counter = counter;
  }

  async load(
    model: ModelConfig,
    threads: number,
    progress: (loaded: number, total: number) => void,
  ): Promise<string> {
    await this.backend.load(model, threads, progress);
    this.model = model;
    return modelKey(model);
  }

  /** Embed ONE input; `input` is typed `unknown` so a batch reaching it at run time fails closed. */
  async embed(kind: EmbedKind, header: string, input: unknown): Promise<Result<Float32Array>> {
    const checked = checkInput(
      typeof input === 'string' ? embedInput(kind, header, input, this.model) : input,
      this.counter,
    );
    if (!checked.ok) return checked;
    const native = await this.backend.run(checked.value);
    return ok(truncateRenormalise(native, this.model.storeDims));
  }
}

/** The worker's `onmessage` logic, independent of `self` so it can be tested. */
export function createEmbedHandler(
  embedder: Embedder,
  post: (msg: FromEmbedWorker) => void,
  now: () => number,
): (msg: ToEmbedWorker) => Promise<void> {
  return async (msg) => {
    if (msg.t === 'load') {
      try {
        const model = msg.model === 'primary' ? PRIMARY : FALLBACK;
        const key = await embedder.load(model, msg.threads, (loadedBytes, totalBytes) =>
          post({ t: 'progress', loadedBytes, totalBytes }),
        );
        post({ t: 'ready', modelKey: key, threads: msg.threads });
      } catch (e) {
        post({ t: 'error', errno: 'EIO', message: e instanceof Error ? e.message : 'load failed' });
      }
      return;
    }
    const t0 = now();
    try {
      const r = await embedder.embed(msg.kind, msg.header, msg.text);
      if (!r.ok) {
        post({
          t: 'error',
          id: msg.id,
          errno: 'EINVAL',
          message: r.error.message ?? 'invalid input',
        });
        return;
      }
      post({ t: 'vector', id: msg.id, vector: r.value, truncated: false, ms: now() - t0 });
    } catch (e) {
      post({
        t: 'error',
        id: msg.id,
        errno: 'EIO',
        message: e instanceof Error ? e.message : 'embed failed',
      });
    }
  };
}
