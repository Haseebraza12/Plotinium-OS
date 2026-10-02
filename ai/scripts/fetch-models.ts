/**
 * `node ai/scripts/fetch-models.ts`: self-host the embedding model and the ONNX runtime WASM
 * (rag-semantic-search.md §3.7; deployment-and-ci.md "bake /models and /ort into the web image").
 *
 *   node ai/scripts/fetch-models.ts [--all | --fallback] [--no-models] [--no-ort] [--check]
 *                                   [--out DIR] [--print-pins]
 *
 *   (default)     the primary model MongoDB/mdbr-leaf-ir @ 4262131b (q8 ONNX + tokenizer, ~24 MB)
 *                 and the onnxruntime-web asyncify WASM + MJS (~27 MB). If the primary cannot be
 *                 fetched or fails its SHA-256 pin, the fallback Xenova/bge-small-en-v1.5 @
 *                 ea104dac is fetched instead so the image always carries one model.
 *   --all         both models (the release image: switching to the fallback is then only a
 *                 configuration change plus a background re-index, §3.7)
 *   --fallback    only the fallback model
 *   --no-models   skip the models;  --no-ort  skip the runtime files
 *   --check       verify what is on disk against the pins; download nothing; exit 1 on a mismatch
 *   --out DIR     output root (default web/public, i.e. served as /models/* and /ort/*)
 *
 * Layout (versioned, so Caddy serves it `immutable`; security-model.md §3.9):
 *   <out>/models/<lock-id>/<model id>/<file>   lock-id = the revision's first 8 hex digits
 *   <out>/models/MANIFEST.json                 what was fetched, with every SHA-256
 *   <out>/ort/<onnxruntime-web version>/ort-wasm-simd-threaded.asyncify.{wasm,mjs}
 * The ai.embed worker computes the same paths from ai/src/embed/config.ts (`modelLockId`,
 * `ORT_VERSION`), which this script imports, so the two can never disagree.
 *   --print-pins  print the SHA-256 of every file on disk (maintenance: refreshing the pins)
 *
 * Every file is pinned by SHA-256; a present file with the right digest is never downloaded again,
 * so the script is idempotent and a Docker build whose context already holds the files needs no
 * network. Nothing is ever fetched from the Hugging Face Hub at run time: the browser loads only
 * these self-hosted copies (`env.allowRemoteModels = false`).
 *
 * The runtime WASM is copied from the onnxruntime-web package that @huggingface/transformers
 * resolves in node_modules (locked by pnpm-lock.yaml), so its version always matches the JS glue.
 *
 * Like ai/eval/rag/host.ts, this script reaches Node's built-ins through
 * `process.getBuiltinModule`, so ai/tsconfig.json keeps `types: []`.
 */

import { ORT_FILES, ORT_VERSION } from '../src/embed/config.ts';

interface NodeFs {
  existsSync(path: string): boolean;
  mkdirSync(path: string, options: { recursive: true }): unknown;
  readFileSync(path: string): Uint8Array;
  writeFileSync(path: string, data: Uint8Array | string): void;
  renameSync(from: string, to: string): void;
  rmSync(path: string, options: { force: true }): void;
  realpathSync(path: string): string;
  statSync(path: string): { size: number };
}

interface NodePath {
  join(...parts: string[]): string;
  dirname(path: string): string;
  resolve(...parts: string[]): string;
}

interface NodeUrl {
  fileURLToPath(url: string): string;
}

interface NodeHash {
  update(data: Uint8Array): NodeHash;
  digest(encoding: 'hex'): string;
}

interface NodeCrypto {
  createHash(algorithm: 'sha256'): NodeHash;
}

interface NodeProcess {
  argv: string[];
  exitCode?: number | undefined;
  getBuiltinModule(id: string): unknown;
}

function nodeProcess(): NodeProcess {
  const proc = (globalThis as { process?: Partial<NodeProcess> }).process;
  if (
    proc === undefined ||
    typeof proc.getBuiltinModule !== 'function' ||
    !Array.isArray(proc.argv)
  )
    throw new Error('fetch-models runs on Node >= 22.3 (process.getBuiltinModule)');
  return proc as NodeProcess;
}

function builtin<T>(id: string): T {
  const mod = nodeProcess().getBuiltinModule(id);
  if (mod === undefined || mod === null) throw new Error(`Node built-in ${id} is unavailable`);
  return mod as T;
}

/** One pinned file of a model repository. */
export interface PinnedFile {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}

export interface PinnedModel {
  readonly role: 'primary' | 'fallback';
  readonly id: string;
  readonly revision: string;
  readonly files: readonly PinnedFile[];
}

/**
 * The pins. Large files carry the Git LFS oid published by the Hub (which IS the SHA-256 of the
 * content); small JSON files were hashed on the first verified download (2026-09-26).
 * `onnx/model_quantized.onnx` is the q8 graph Transformers.js loads for `dtype: 'q8'`; leaf-ir
 * keeps its weights in the external-data file next to it (`use_external_data_format` in
 * config.json).
 */
export const MODELS: readonly PinnedModel[] = [
  {
    role: 'primary',
    id: 'MongoDB/mdbr-leaf-ir',
    revision: '4262131b32c3182bd06e67e92ae69d7bd66e0c5c',
    files: [
      {
        path: 'config.json',
        sha256: '258407cfa27c7e1e502a9c312abebb4f5241bf226972ffc366287f370a3567f1',
        bytes: 829,
      },
      {
        path: 'tokenizer.json',
        sha256: 'da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0',
        bytes: 711_661,
      },
      {
        path: 'tokenizer_config.json',
        sha256: '46ac231e9b955a8af80fc7f23a0ecc65b524f1df84a02c2c82cbca354fb207b4',
        bytes: 1_529,
      },
      {
        path: 'special_tokens_map.json',
        sha256: '5aa43c2f985a25296d5a5ce621c2f77376ca8091a47993c492fd5460b895b140',
        bytes: 732,
      },
      {
        path: 'onnx/model_quantized.onnx',
        sha256: '8c08cb4ecc00bad721b117a85738c537ceb9b85b3eedc52d9c6906fddaa55718',
        bytes: 220_597,
      },
      {
        path: 'onnx/model_quantized.onnx_data',
        sha256: 'e77ea96a124230e23e5bac8e26c3ffe5410154973d8635673fa0220b06c13f8b',
        bytes: 22_954_752,
      },
    ],
  },
  {
    role: 'fallback',
    id: 'Xenova/bge-small-en-v1.5',
    revision: 'ea104dacec62c0de699686887e3f920caeb4f3e3',
    files: [
      {
        path: 'config.json',
        sha256: 'fa73f90bf92c8cace1fbcb709626306f2bdbc9ea3e5b5f94b440df9b6aa56350',
        bytes: 683,
      },
      {
        path: 'tokenizer.json',
        sha256: 'd241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66',
        bytes: 711_396,
      },
      {
        path: 'tokenizer_config.json',
        sha256: '9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3',
        bytes: 366,
      },
      {
        path: 'special_tokens_map.json',
        sha256: 'b6d346be366a7d1d48332dbc9fdf3bf8960b5d879522b7799ddba59e76237ee3',
        bytes: 125,
      },
      {
        path: 'onnx/model_quantized.onnx',
        sha256: '6c9c6101a956d62dfb5e7190c538226c0c5bb9cb27b651234b6df063ee7dbfe4',
        bytes: 34_014_426,
      },
    ],
  },
];

/** The ORT files the ai.embed worker names in `env.backends.onnx.wasm.wasmPaths` (§3.7). */
export const ORT_FILE_NAMES = [ORT_FILES.wasm, ORT_FILES.mjs] as const;

/** Where a model's files go: `<modelsDir>/<lock-id>/<model id>/`. */
export function modelDir(
  modelsDir: string,
  model: PinnedModel,
  join: (...p: string[]) => string,
): string {
  return join(modelsDir, model.revision.slice(0, 8), model.id);
}

const HUB = 'https://huggingface.co';

export function resolveUrl(model: PinnedModel, file: string): string {
  return `${HUB}/${model.id}/resolve/${model.revision}/${file}`;
}

interface Args {
  models: 'primary' | 'fallback' | 'all' | 'none';
  ort: boolean;
  check: boolean;
  out: string;
  printPins: boolean;
}

const USAGE =
  'usage: node ai/scripts/fetch-models.ts [--all | --fallback] [--no-models] [--no-ort] [--check] [--out DIR] [--print-pins]';

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { models: 'primary', ort: true, check: false, out: '', printPins: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    switch (a) {
      case '--all':
        args.models = 'all';
        break;
      case '--fallback':
        args.models = 'fallback';
        break;
      case '--no-models':
        args.models = 'none';
        break;
      case '--no-ort':
        args.ort = false;
        break;
      case '--check':
        args.check = true;
        break;
      case '--print-pins':
        args.printPins = true;
        break;
      case '--out': {
        const v = argv[++i];
        if (v === undefined) throw new Error(`--out needs a directory\n${USAGE}`);
        args.out = v;
        break;
      }
      default:
        throw new Error(`unknown option ${a}\n${USAGE}`);
    }
  }
  return args;
}

interface Ctx {
  fs: NodeFs;
  path: NodePath;
  crypto: NodeCrypto;
  log(line: string): void;
}

function sha256(ctx: Ctx, bytes: Uint8Array): string {
  return ctx.crypto.createHash('sha256').update(bytes).digest('hex');
}

function fileSha(ctx: Ctx, path: string): string | null {
  return ctx.fs.existsSync(path) ? sha256(ctx, ctx.fs.readFileSync(path)) : null;
}

async function download(ctx: Ctx, url: string, dest: string, pin: PinnedFile): Promise<void> {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`GET ${url}: HTTP ${String(res.status)}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const got = sha256(ctx, bytes);
  if (got !== pin.sha256)
    throw new Error(`${url}: SHA-256 ${got} does not match the pin ${pin.sha256}`);
  ctx.fs.mkdirSync(ctx.path.dirname(dest), { recursive: true });
  const tmp = `${dest}.part`;
  ctx.fs.writeFileSync(tmp, bytes);
  ctx.fs.renameSync(tmp, dest);
}

export interface ModelOutcome {
  readonly id: string;
  readonly ok: boolean;
  readonly downloaded: number;
  readonly present: number;
  readonly bytes: number;
  readonly error?: string;
}

async function fetchModel(
  ctx: Ctx,
  modelsDir: string,
  model: PinnedModel,
  check: boolean,
): Promise<ModelOutcome> {
  let downloaded = 0;
  let present = 0;
  let bytes = 0;
  try {
    for (const f of model.files) {
      const dest = ctx.path.join(
        modelDir(modelsDir, model, (...p) => ctx.path.join(...p)),
        f.path,
      );
      const have = fileSha(ctx, dest);
      bytes += f.bytes;
      if (have === f.sha256) {
        present++;
        continue;
      }
      if (check)
        throw new Error(
          have === null ? `${dest} is missing` : `${dest}: SHA-256 ${have} is not the pin`,
        );
      ctx.log(`  GET ${model.id}/${f.path} (${(f.bytes / 1_048_576).toFixed(1)} MiB)`);
      await download(ctx, resolveUrl(model, f.path), dest, f);
      downloaded++;
    }
    return { id: model.id, ok: true, downloaded, present, bytes };
  } catch (e) {
    return {
      id: model.id,
      ok: false,
      downloaded,
      present,
      bytes,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/** The dist/ folder of the onnxruntime-web that @huggingface/transformers resolves. */
function ortDist(ctx: Ctx): { dir: string; version: string } {
  const url = builtin<NodeUrl>('node:url');
  const entry = url.fileURLToPath(import.meta.resolve('@huggingface/transformers'));
  // pnpm: <store>/@huggingface+transformers@x/node_modules/@huggingface/transformers/dist/…;
  // the package's own dependencies are siblings in that node_modules folder.
  let dir = ctx.path.dirname(ctx.fs.realpathSync(entry));
  for (let i = 0; i < 6; i++) {
    const candidate = ctx.path.join(dir, 'node_modules', 'onnxruntime-web');
    const sibling = ctx.path.join(dir, 'onnxruntime-web');
    for (const c of [candidate, sibling]) {
      if (ctx.fs.existsSync(ctx.path.join(c, 'package.json'))) {
        const pkg = JSON.parse(
          new TextDecoder().decode(ctx.fs.readFileSync(ctx.path.join(c, 'package.json'))),
        ) as { version?: unknown };
        return {
          dir: ctx.path.join(ctx.fs.realpathSync(c), 'dist'),
          version: typeof pkg.version === 'string' ? pkg.version : 'unknown',
        };
      }
    }
    dir = ctx.path.dirname(dir);
  }
  throw new Error('onnxruntime-web (a dependency of @huggingface/transformers) was not found');
}

function copyOrt(
  ctx: Ctx,
  ortRoot: string,
  check: boolean,
): { version: string; files: PinnedFile[] } {
  const src = ortDist(ctx);
  if (src.version !== ORT_VERSION)
    throw new Error(
      `onnxruntime-web in node_modules is ${src.version}, but ai/src/embed/config.ts ORT_VERSION is ${ORT_VERSION}: update ORT_VERSION with the lockfile`,
    );
  const ortDir = ctx.path.join(ortRoot, src.version);
  const files: PinnedFile[] = [];
  for (const name of ORT_FILE_NAMES) {
    const from = ctx.path.join(src.dir, name);
    const to = ctx.path.join(ortDir, name);
    const bytes = ctx.fs.readFileSync(from);
    const want = sha256(ctx, bytes);
    const have = fileSha(ctx, to);
    if (have !== want) {
      if (check) throw new Error(`${to} does not match onnxruntime-web ${src.version}/${name}`);
      ctx.fs.mkdirSync(ortDir, { recursive: true });
      ctx.fs.writeFileSync(to, bytes);
      ctx.log(`  copied ${name} (onnxruntime-web ${src.version})`);
    }
    files.push({ path: `${src.version}/${name}`, sha256: want, bytes: bytes.byteLength });
  }
  return { version: src.version, files };
}

async function main(): Promise<number> {
  const proc = nodeProcess();
  const argv = proc.argv.slice(2);
  if (argv.includes('--help')) {
    console.log(USAGE);
    return 0;
  }
  const args = parseArgs(argv);
  const path = builtin<NodePath>('node:path');
  const url = builtin<NodeUrl>('node:url');
  const ctx: Ctx = {
    fs: builtin<NodeFs>('node:fs'),
    path,
    crypto: builtin<NodeCrypto>('node:crypto'),
    log: (line) => console.log(line),
  };
  const repo = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', '..');
  const out = args.out === '' ? path.join(repo, 'web', 'public') : path.resolve(args.out);
  const modelsDir = path.join(out, 'models');
  const ortDir = path.join(out, 'ort');

  if (args.printPins) {
    for (const m of MODELS)
      for (const f of m.files) {
        const p = path.join(
          modelDir(modelsDir, m, (...p) => path.join(...p)),
          f.path,
        );
        console.log(`${m.id}/${f.path} ${fileSha(ctx, p) ?? 'missing'}`);
      }
    return 0;
  }

  const manifest: {
    generatedBy: string;
    models: Array<{ role: string; id: string; revision: string; files: readonly PinnedFile[] }>;
    ort?: { version: string; files: PinnedFile[] };
  } = { generatedBy: 'ai/scripts/fetch-models.ts', models: [] };
  let failed = false;

  if (args.models !== 'none') {
    const wanted = MODELS.filter((m) =>
      args.models === 'all'
        ? true
        : args.models === 'fallback'
          ? m.role === 'fallback'
          : m.role === 'primary',
    );
    for (const m of wanted) {
      console.log(
        `${args.check ? 'check' : 'fetch'} ${m.role} ${m.id} @ ${m.revision.slice(0, 8)}`,
      );
      const r = await fetchModel(ctx, modelsDir, m, args.check);
      if (r.ok) {
        console.log(
          `  ok: ${String(r.present)} present, ${String(r.downloaded)} downloaded, ${(r.bytes / 1_048_576).toFixed(1)} MiB`,
        );
        manifest.models.push({ role: m.role, id: m.id, revision: m.revision, files: m.files });
        continue;
      }
      console.error(`  FAILED: ${r.error ?? 'unknown error'}`);
      const fallback = MODELS.find((x) => x.role === 'fallback');
      if (
        m.role === 'primary' &&
        args.models === 'primary' &&
        fallback !== undefined &&
        !args.check
      ) {
        console.log(`falling back to ${fallback.id} @ ${fallback.revision.slice(0, 8)}`);
        const f = await fetchModel(ctx, modelsDir, fallback, false);
        if (f.ok) {
          manifest.models.push({
            role: fallback.role,
            id: fallback.id,
            revision: fallback.revision,
            files: fallback.files,
          });
          console.log(`  ok: ${String(f.downloaded)} downloaded`);
          continue;
        }
        console.error(`  FAILED: ${f.error ?? 'unknown error'}`);
      }
      failed = true;
    }
  }

  if (args.ort) {
    try {
      console.log(`${args.check ? 'check' : 'copy'} onnxruntime-web WASM → ${ortDir}`);
      manifest.ort = copyOrt(ctx, ortDir, args.check);
      console.log(`  ok: onnxruntime-web ${manifest.ort.version}`);
    } catch (e) {
      console.error(`  FAILED: ${e instanceof Error ? e.message : String(e)}`);
      failed = true;
    }
  }

  if (!args.check && (manifest.models.length > 0 || manifest.ort !== undefined)) {
    ctx.fs.mkdirSync(modelsDir, { recursive: true });
    ctx.fs.writeFileSync(
      path.join(modelsDir, 'MANIFEST.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
  }
  return failed ? 1 : 0;
}

try {
  nodeProcess().exitCode = await main();
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  nodeProcess().exitCode = 2;
}
