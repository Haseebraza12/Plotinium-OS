// Pilot: same q8 ONNX files on onnxruntime-web's WASM backend (what a browser worker uses without WebGPU).
import * as ort from 'onnxruntime-web';
import { env, AutoTokenizer } from '@huggingface/transformers';
import { readFileSync, existsSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

env.allowRemoteModels = false;
env.localModelPath = new URL('./models/', import.meta.url).pathname;
const threads = Number(process.argv[2] || 1);
const only = process.argv[3];
ort.env.wasm.numThreads = threads;

const MODELS = ['MongoDB/mdbr-leaf-ir', 'Snowflake/snowflake-arctic-embed-xs', 'Xenova/bge-small-en-v1.5'].filter(m => !only || m.includes(only));
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const text = readFileSync(new URL('./' + (process.env.DOC || 'prose50k.txt'), import.meta.url), 'utf8');

for (const id of MODELS) {
  const dir = new URL(`./models/${id}/onnx/`, import.meta.url).pathname;
  const t0 = performance.now();
  const tok = await AutoTokenizer.from_pretrained(id);
  const opts = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };
  if (existsSync(dir + 'model_quantized.onnx_data')) opts.externalData = [{ path: 'model_quantized.onnx_data', data: readFileSync(dir + 'model_quantized.onnx_data') }];
  const sess = await ort.InferenceSession.create(readFileSync(dir + 'model_quantized.onnx'), opts);
  const loadMs = performance.now() - t0;

  const ids = tok.encode(text, { add_special_tokens: false });
  const chunks = [];
  for (let s = 0; s < ids.length; s += 340) { chunks.push(ids.slice(s, s + 400)); if (s + 400 >= ids.length) break; }
  const texts = chunks.map(c => tok.decode(c));

  const embed = async (t) => {
    const enc = await tok([t], { truncation: true, max_length: 512 });
    const feeds = {};
    for (const name of sess.inputNames) {
      const src = enc[name];
      feeds[name] = new ort.Tensor('int64', BigInt64Array.from(src.data), src.dims);
    }
    const out = await sess.run(feeds);
    return out;
  };
  await embed('warm up');
  const per = []; const tIdx = performance.now();
  for (const t of texts) { const a = performance.now(); await embed(t); per.push(performance.now() - a); }
  const idxMs = performance.now() - tIdx;
  const q = 'Represent this sentence for searching relevant passages: where is the memory leak in the window compositor';
  const ql = []; for (let i = 0; i < 30; i++) { const a = performance.now(); await embed(q); ql.push(performance.now() - a); }
  console.log(JSON.stringify({ model: id, backend: 'ort-web wasm', threads, loadMs: Math.round(loadMs), doc: process.env.DOC, tokens: ids.length, chunks: chunks.length,
    chunkP50: Math.round(pct(per, .5)), chunkP95: Math.round(pct(per, .95)), index50kMs: Math.round(idxMs), queryP50: +pct(ql, .5).toFixed(1), queryP95: +pct(ql, .95).toFixed(1),
    rssMB: Math.round(process.memoryUsage().rss / 1e6) }));
  await sess.release();
}
