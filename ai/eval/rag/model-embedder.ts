/**
 * The REAL embedding model for the RAG evaluation, run in Node (rag-semantic-search.md §3.7;
 * ai-safety-and-evaluation.md §3.6).
 *
 * It is the same `TransformersBackend` the `ai.embed` worker uses, with the same self-hosted,
 * SHA-256-pinned files (web/public/models, fetched by ai/scripts/fetch-models.ts) and the same
 * environment rules (`allowRemoteModels = false`, batch size 1, at most 512 tokens), except that
 * Node runs ONNX Runtime natively (`device: 'cpu'`, onnxruntime-node) instead of the WASM build.
 * Vectors are MRL-truncated to 384 dimensions and renormalised exactly like `Embedder`.
 *
 * pnpm's strict layout does not expose `onnxruntime-common` to @huggingface/transformers' Node
 * build (it imports it without declaring it), so the loader resolves that one specifier to the
 * copy next to onnxruntime-node with a `module.registerHooks` resolve hook. Nothing is installed
 * and nothing is fetched at run time.
 *
 * `recordingEmbedder` wraps any embedder and keeps every (sha256(model input) → vector) pair, so a
 * run can be written to vectors.jsonl and replayed deterministically in CI with
 * `--embedder recorded` (no model needed there).
 */
import {
  FALLBACK,
  PRIMARY,
  type ModelConfig,
  modelKey,
  truncateRenormalise,
} from '../../src/embed/config.ts';
import {
  TransformersBackend,
  type TransformersLike,
} from '../../src/embed/transformers-backend.ts';
import { utf8 } from '../../src/util/bytes.ts';
import { sha256Hex } from './corpus.ts';
import type { EvalEmbedder } from './embedders.ts';
import { nodeProcess } from './host.ts';

interface NodeModule {
  registerHooks(hooks: {
    resolve(
      specifier: string,
      context: unknown,
      next: (specifier: string, context: unknown) => unknown,
    ): unknown;
  }): unknown;
  createRequire(path: string): { resolve(id: string): string };
}

interface NodeFs {
  realpathSync(path: string): string;
  existsSync(path: string): boolean;
}

interface NodePath {
  join(...parts: string[]): string;
  dirname(path: string): string;
}

interface NodeUrl {
  fileURLToPath(url: string): string;
  pathToFileURL(path: string): { href: string };
}

function builtin<T>(id: string): T {
  const mod = nodeProcess().getBuiltinModule(id);
  if (mod === undefined || mod === null) throw new Error(`Node built-in ${id} is unavailable`);
  return mod as T;
}

let hooked = false;

/** Resolve `onnxruntime-common` to onnxruntime-node's own copy (one Tensor class for both). */
function hookOnnxCommon(): void {
  if (hooked) return;
  const fs = builtin<NodeFs>('node:fs');
  const path = builtin<NodePath>('node:path');
  const url = builtin<NodeUrl>('node:url');
  const mod = builtin<NodeModule>('node:module');
  const entry = fs.realpathSync(
    url.fileURLToPath(import.meta.resolve('@huggingface/transformers')),
  );
  const marker = '/node_modules/@huggingface/transformers/';
  const at = entry.lastIndexOf(marker);
  if (at < 0) throw new Error(`unexpected @huggingface/transformers location ${entry}`);
  const siblings = `${entry.slice(0, at)}/node_modules`;
  const ortNode = fs.realpathSync(path.join(siblings, 'onnxruntime-node'));
  const common = path.join(path.dirname(ortNode), 'onnxruntime-common');
  if (!fs.existsSync(common)) throw new Error(`onnxruntime-common not found next to ${ortNode}`);
  const commonUrl = url.pathToFileURL(
    mod.createRequire(path.join(common, 'package.json')).resolve('onnxruntime-common'),
  ).href;
  mod.registerHooks({
    resolve: (specifier, context, next) =>
      specifier === 'onnxruntime-common'
        ? { url: commonUrl, shortCircuit: true }
        : next(specifier, context),
  });
  hooked = true;
}

/** web/public/models of this checkout (where fetch-models.ts put the pinned files). */
export function defaultModelsDir(): string {
  const path = builtin<NodePath>('node:path');
  const url = builtin<NodeUrl>('node:url');
  return `${path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '..', '..', 'web', 'public', 'models')}/`;
}

/** The pinned model (`primary` = MongoDB/mdbr-leaf-ir, `fallback` = Xenova/bge-small-en-v1.5). */
export async function transformersEmbedder(
  which: 'primary' | 'fallback' = 'primary',
  opts: { modelsDir?: string; threads?: number } = {},
): Promise<EvalEmbedder & { readonly config: ModelConfig; readonly loadMs: number }> {
  hookOnnxCommon();
  const config = which === 'fallback' ? FALLBACK : PRIMARY;
  const backend = new TransformersBackend(
    async () => (await import('@huggingface/transformers')) as unknown as TransformersLike,
    { modelsRoot: opts.modelsDir ?? defaultModelsDir(), device: 'cpu' },
  );
  const t0 = performance.now();
  await backend.load(config, opts.threads ?? 1, () => undefined);
  const loadMs = performance.now() - t0;
  return {
    name: `${config.id}@${config.revision.slice(0, 8)} q8 (onnxruntime-node, cpu)`,
    modelKey: modelKey(config),
    config,
    loadMs,
    async embed(input: string): Promise<Float32Array> {
      return truncateRenormalise(await backend.run(input), config.storeDims);
    },
  };
}

/** Wrap an embedder and keep every vector it returns, keyed by sha256(model input). */
export function recordingEmbedder(inner: EvalEmbedder): EvalEmbedder & { lines(): string[] } {
  const seen = new Map<string, Float32Array>();
  return {
    name: inner.name,
    modelKey: inner.modelKey,
    async embed(input: string): Promise<Float32Array> {
      const v = await inner.embed(input);
      seen.set(await sha256Hex(utf8(input)), v);
      return v;
    },
    lines: () =>
      [...seen].map(([sha256, v]) =>
        JSON.stringify({ sha256, vector: Array.from(v, (x) => Number(x.toFixed(7))) }),
      ),
  };
}
