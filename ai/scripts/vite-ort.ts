/**
 * The Vite alias the `ai.embed` worker bundle needs (web/vite.config.ts).
 *
 * @huggingface/transformers 4.3.0's browser build imports `onnxruntime-common` without declaring
 * it (it arrives through onnxruntime-web). pnpm's strict layout does not expose undeclared
 * packages, so without this alias Vite fails with `Failed to resolve import "onnxruntime-common"`
 * as soon as the worker is bundled (verified: ai/README.md "Browser check"). The alias points the
 * specifier at the copy next to the onnxruntime-web that transformers resolves, so the Tensor
 * class of transformers and of the WASM backend is one and the same.
 *
 *   // web/vite.config.ts
 *   import { defaultClientConditions } from 'vite';
 *   import { ORT_EXTERN_WASM_CONDITION, onnxruntimeCommonAlias } from '../ai/scripts/vite-ort.ts';
 *   export default defineConfig({
 *     resolve: {
 *       alias: [onnxruntimeCommonAlias()],
 *       conditions: [ORT_EXTERN_WASM_CONDITION, ...defaultClientConditions],
 *     },
 *     …
 *   });
 *
 * The condition selects onnxruntime-web's "extern wasm" builds: without it Vite follows the
 * bundle build's `new URL('ort-wasm-simd-threaded.jsep.wasm', import.meta.url)` and emits a second
 * 27 MB copy of the runtime into /assets (never used: the worker names `/ort/<version>/` in
 * `wasmPaths`), which would also bloat any precache of /assets.
 *
 * The durable fix is a pnpm `packageExtensions` entry (`@huggingface/transformers` depends on
 * `onnxruntime-common`) followed by `pnpm install`; this helper needs no install.
 */

interface NodeFs {
  realpathSync(path: string): string;
  existsSync(path: string): boolean;
  readFileSync(path: string): Uint8Array;
}

interface NodePath {
  join(...parts: string[]): string;
  dirname(path: string): string;
}

interface NodeModule {
  createRequire(from: string): { resolve(id: string): string };
}

function builtin<T>(id: string): T {
  const proc = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process;
  const mod = proc?.getBuiltinModule?.(id);
  if (mod === undefined || mod === null) throw new Error(`Node built-in ${id} is unavailable`);
  return mod as T;
}

/** onnxruntime-web's export condition for builds that load the WASM from `wasmPaths` only. */
export const ORT_EXTERN_WASM_CONDITION = 'onnxruntime-web-use-extern-wasm';

/** Absolute path of the ESM entry of the onnxruntime-common that onnxruntime-web uses. */
export function onnxruntimeCommonEntry(): string {
  const fs = builtin<NodeFs>('node:fs');
  const path = builtin<NodePath>('node:path');
  // createRequire anchored at this file: robust when Vite bundles the config (import.meta.url is
  // rewritten to the original file there, import.meta.resolve is not).
  const req = builtin<NodeModule>('node:module').createRequire(import.meta.url);
  const entry = fs.realpathSync(req.resolve('@huggingface/transformers'));
  const marker = '/node_modules/@huggingface/transformers/';
  const at = entry.lastIndexOf(marker);
  if (at < 0) throw new Error(`unexpected @huggingface/transformers location ${entry}`);
  const ortWeb = fs.realpathSync(
    path.join(`${entry.slice(0, at)}/node_modules`, 'onnxruntime-web'),
  );
  const common = path.join(path.dirname(ortWeb), 'onnxruntime-common');
  const pkg = JSON.parse(
    new TextDecoder().decode(fs.readFileSync(path.join(common, 'package.json'))),
  ) as {
    exports?: { import?: unknown };
    module?: unknown;
  };
  const rel =
    typeof pkg.exports?.import === 'string'
      ? pkg.exports.import
      : typeof pkg.module === 'string'
        ? pkg.module
        : 'dist/esm/index.js';
  const file = path.join(common, rel);
  if (!fs.existsSync(file)) throw new Error(`onnxruntime-common entry ${file} does not exist`);
  return file;
}

/** `{ find, replacement }` for Vite's `resolve.alias` array. */
export function onnxruntimeCommonAlias(): { find: RegExp; replacement: string } {
  return { find: /^onnxruntime-common$/, replacement: onnxruntimeCommonEntry() };
}
