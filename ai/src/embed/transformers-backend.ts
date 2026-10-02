/**
 * The Transformers.js implementation of `EmbedBackend` (rag-semantic-search.md §3.2.5, §3.7).
 *
 * The module is loaded ONLY inside the `ai.embed` worker, and only after the first of
 * desktop-interactive + 2 s idle, a search box gaining focus, or the first `semsearch` (BOOT-10,
 * I-A8): the kernel sends `load`, and only then is `@huggingface/transformers` imported
 * dynamically, so its chunk, `/models/*` and `/ort/*` never sit on the boot path.
 *
 * Environment, exactly as §3.7 fixes it:
 *   - `allowRemoteModels = false`, `allowLocalModels = true`, `localModelPath =
 *     '/models/<lock-id>/'` (the revision's first 8 hex digits): the browser loads only the
 *     self-hosted, SHA-256-pinned copies (ai/scripts/fetch-models.ts); nothing is ever fetched
 *     from the Hub at run time, and a new revision is a new, immutable URL;
 *   - `useBrowserCache` on: after the first load the weights come from the Cache API, so a page-in
 *     (re-spawn after eviction) does not re-download them;
 *   - `wasmPaths` is an OBJECT `{wasm, mjs}` under `/ort/<ort-version>/`;
 *   - the WASM binary also comes from the Cache API on a page-in, but through OUR cache
 *     (`cachedWasmBinary`, handed to ORT as `wasmBinary`), with Transformers.js' own
 *     `useWasmCache` OFF: inside a worker that option re-imports the ORT `.mjs` factory from a
 *     `blob:` URL, which the normative CSP (C10, `script-src 'self' 'wasm-unsafe-eval'`, no
 *     `blob:`) blocks — verified in Chrome under the production policy. The `.mjs` is imported
 *     from its same-origin, immutable `/ort/<version>/` URL instead (ai/README.md "CSP");
 *   - `numThreads` = 2 only when cross-origin isolated with ≥ 8 cores, else 1 (`ortThreads`).
 * Inference: batch size 1, at most 512 tokens (`truncation: true, max_length: 512`), leaf-ir's
 * `sentence_embedding` output (768-d, mean pooling + dense + normalise inside the graph) or the
 * fallback's CLS token of `last_hidden_state`; the Embedder then MRL-truncates to 384 and
 * renormalises.
 *
 * The library is described by the narrow structural types below instead of its published
 * declarations: those import `onnxruntime-common`, which the workspace does not hoist.
 */
import type { TokenCounter } from '../indexer/tokens.ts';
import { approxWordPiece } from '../indexer/tokens.ts';
import { type ModelConfig, ORT_FILES, ORT_VERSION, modelLockId } from './config.ts';
import { EMBED_MAX_TOKENS } from './protocol.ts';
import type { EmbedBackend } from './embedder.ts';

/** A tensor as Transformers.js returns it. */
export interface TensorLike {
  readonly dims: readonly number[];
  readonly data: ArrayLike<number>;
}

export interface EncodingLike {
  readonly input_ids: TensorLike;
  readonly [name: string]: TensorLike;
}

export interface TokenizerLike {
  (
    text: string,
    options: { truncation: boolean; max_length?: number; add_special_tokens?: boolean },
  ): EncodingLike;
}

export type ModelLike = (inputs: EncodingLike) => Promise<Record<string, TensorLike | undefined>>;

/** `progress_callback` payloads that carry byte counts. */
export interface ProgressInfoLike {
  readonly status: string;
  readonly file?: string;
  readonly loaded?: number;
  readonly total?: number;
}

export interface LoadOptions {
  revision: string;
  progress_callback: (info: ProgressInfoLike) => void;
}

export interface WasmEnvLike {
  wasmPaths?: unknown;
  numThreads?: number;
  proxy?: boolean;
  /** A pre-fetched runtime binary: ORT then skips its own fetch of `wasmPaths.wasm`. */
  wasmBinary?: ArrayBuffer;
}

export interface TransformersEnvLike {
  allowRemoteModels: boolean;
  allowLocalModels: boolean;
  localModelPath: string;
  useBrowserCache: boolean;
  useWasmCache: boolean;
  backends: { onnx: { wasm?: WasmEnvLike } };
}

/** The part of `@huggingface/transformers` the backend uses. */
export interface TransformersLike {
  readonly env: TransformersEnvLike;
  readonly AutoTokenizer: {
    from_pretrained(id: string, options: LoadOptions): Promise<TokenizerLike>;
  };
  readonly AutoModel: {
    from_pretrained(
      id: string,
      options: LoadOptions & { dtype: 'q8'; device?: 'wasm' | 'cpu' },
    ): Promise<ModelLike>;
  };
}

export interface BackendEnvironment {
  /**
   * The root the weights are served under ('/models/' in the browser; a directory in the Node
   * eval). Each model is read from `<modelsRoot><lock-id>/<model id>/`.
   */
  modelsRoot: string;
  /** The ORT runtime files; omitted in Node (onnxruntime-node needs none). */
  wasmPaths?: { wasm: string; mjs: string };
  /** 'wasm' in the browser, 'cpu' with onnxruntime-node. */
  device: 'wasm' | 'cpu';
  /** Fetch the runtime binary through a cache (browser); undefined: ORT fetches it itself. */
  wasmBinary?: (url: string) => Promise<ArrayBuffer | undefined>;
}

/** The Cache API bucket of the ORT binary (the URL is versioned, so an entry never goes stale). */
export const ORT_CACHE = 'plotinium-ort';

/** `wasmPaths.wasm` from the Cache API, fetched and stored on a miss; undefined on any failure. */
export async function cachedWasmBinary(url: string): Promise<ArrayBuffer | undefined> {
  try {
    const cache = typeof caches === 'undefined' ? undefined : await caches.open(ORT_CACHE);
    const hit = await cache?.match(url);
    if (hit !== undefined) return await hit.arrayBuffer();
    const res = await fetch(url, { credentials: 'same-origin' });
    if (!res.ok) return undefined;
    if (cache !== undefined) await cache.put(url, res.clone());
    return await res.arrayBuffer();
  } catch {
    return undefined;
  }
}

export const BROWSER_ENVIRONMENT: BackendEnvironment = {
  modelsRoot: '/models/',
  wasmPaths: {
    wasm: `/ort/${ORT_VERSION}/${ORT_FILES.wasm}`,
    mjs: `/ort/${ORT_VERSION}/${ORT_FILES.mjs}`,
  },
  device: 'wasm',
  wasmBinary: cachedWasmBinary,
};

/** `<modelsRoot><lock-id>/`: the `localModelPath` of one pinned model. */
export function modelPath(where: BackendEnvironment, model: ModelConfig): string {
  const root = where.modelsRoot.endsWith('/') ? where.modelsRoot : `${where.modelsRoot}/`;
  return `${root}${modelLockId(model)}/`;
}

/** Apply §3.7 to the library's `env` (exported for the test that pins it). */
export function configureEnv(
  env: TransformersEnvLike,
  where: BackendEnvironment,
  threads: number,
  model: ModelConfig,
): void {
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.localModelPath = modelPath(where, model);
  env.useBrowserCache = where.device === 'wasm';
  // OFF on purpose: in a worker it imports the ORT factory from a blob: URL, which the C10 CSP
  // blocks. The binary is cached by `cachedWasmBinary` instead (see the module comment).
  env.useWasmCache = false;
  const wasm = env.backends.onnx.wasm;
  if (wasm !== undefined && where.wasmPaths !== undefined) {
    // MUST be an object: a string prefix silently disables useWasmCache (§3.7).
    wasm.wasmPaths = { wasm: where.wasmPaths.wasm, mjs: where.wasmPaths.mjs };
    wasm.numThreads = Math.max(1, Math.floor(threads));
    wasm.proxy = false;
  }
}

function toFloat32(data: ArrayLike<number>, from: number, length: number): Float32Array {
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) out[i] = data[from + i] ?? 0;
  return out;
}

function l2Normalise(v: Float32Array): Float32Array {
  let s = 0;
  for (const x of v) s += x * x;
  const n = Math.sqrt(s);
  if (n > 0) for (let i = 0; i < v.length; i++) v[i] = (v[i] ?? 0) / n;
  return v;
}

/** The native embedding of one encoded input: leaf's `sentence_embedding`, else the CLS token. */
export function pooledVector(
  outputs: Record<string, TensorLike | undefined>,
  model: ModelConfig,
): Float32Array {
  const sentence = outputs['sentence_embedding'];
  if (sentence !== undefined) {
    const dims = sentence.dims[sentence.dims.length - 1] ?? model.nativeDims;
    return toFloat32(sentence.data, 0, dims);
  }
  const hidden = outputs['last_hidden_state'];
  if (hidden === undefined)
    throw new Error('the model returned neither sentence_embedding nor last_hidden_state');
  const width = hidden.dims[hidden.dims.length - 1] ?? model.nativeDims;
  // CLS pooling (bge): the first token of the first (only) sequence, then L2 normalise.
  return l2Normalise(toFloat32(hidden.data, 0, width));
}

/**
 * The real WordPiece counter: the loaded tokenizer's own count without special tokens (the
 * Embedder adds [CLS] and [SEP] itself). Before the tokenizer loads it answers with the
 * approximation, which over-estimates, so the 512-token guard stays safe.
 */
export class LoadedTokenCounter implements TokenCounter {
  private tokenizer: TokenizerLike | null = null;

  set(tokenizer: TokenizerLike): void {
    this.tokenizer = tokenizer;
  }

  count(text: string): number {
    if (this.tokenizer === null) return approxWordPiece.count(text);
    const enc = this.tokenizer(text, { truncation: false, add_special_tokens: false });
    return enc.input_ids.dims[enc.input_ids.dims.length - 1] ?? 0;
  }
}

/** Byte progress summed over the files of one load (for `ai.model` and the Task Manager). */
export class LoadProgress {
  private readonly files = new Map<string, { loaded: number; total: number }>();

  update(info: ProgressInfoLike): { loaded: number; total: number } | undefined {
    if (info.file === undefined || info.total === undefined || info.total <= 0) return undefined;
    this.files.set(info.file, {
      loaded: Math.min(info.loaded ?? 0, info.total),
      total: info.total,
    });
    let loaded = 0;
    let total = 0;
    for (const f of this.files.values()) {
      loaded += f.loaded;
      total += f.total;
    }
    return { loaded, total };
  }
}

export class TransformersBackend implements EmbedBackend {
  readonly counter = new LoadedTokenCounter();
  private readonly importLib: () => Promise<TransformersLike>;
  private readonly where: BackendEnvironment;
  private tokenizer: TokenizerLike | null = null;
  private model: ModelLike | null = null;
  private config: ModelConfig | null = null;

  constructor(
    importLib: () => Promise<TransformersLike>,
    where: BackendEnvironment = BROWSER_ENVIRONMENT,
  ) {
    this.importLib = importLib;
    this.where = where;
  }

  async load(
    model: ModelConfig,
    threads: number,
    progress: (loaded: number, total: number) => void,
  ): Promise<void> {
    const lib = await this.importLib();
    configureEnv(lib.env, this.where, threads, model);
    const wasm = lib.env.backends.onnx.wasm;
    if (
      wasm !== undefined &&
      this.where.wasmBinary !== undefined &&
      this.where.wasmPaths !== undefined
    ) {
      const binary = await this.where.wasmBinary(this.where.wasmPaths.wasm);
      if (binary !== undefined) wasm.wasmBinary = binary;
    }
    const bytes = new LoadProgress();
    const options: LoadOptions = {
      revision: model.revision,
      progress_callback: (info) => {
        const p = bytes.update(info);
        if (p !== undefined) progress(p.loaded, p.total);
      },
    };
    const tokenizer = await lib.AutoTokenizer.from_pretrained(model.id, options);
    const net = await lib.AutoModel.from_pretrained(model.id, {
      ...options,
      dtype: model.dtype,
      device: this.where.device,
    });
    this.tokenizer = tokenizer;
    this.model = net;
    this.config = model;
    this.counter.set(tokenizer);
  }

  /** ONE input (batch size 1), at most 512 tokens including [CLS] and [SEP] (I-A7). */
  async run(input: string): Promise<Float32Array> {
    if (this.tokenizer === null || this.model === null || this.config === null)
      throw new Error('the embedding model is not loaded');
    const enc = this.tokenizer(input, { truncation: true, max_length: EMBED_MAX_TOKENS });
    const outputs = await this.model(enc);
    return pooledVector(outputs, this.config);
  }
}
