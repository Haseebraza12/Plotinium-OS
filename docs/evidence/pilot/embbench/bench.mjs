// Pilot benchmark: per-chunk embedding latency for candidate models (q8 ONNX),
// 50 KB file indexing time, query latency, and brute-force search cost.
import { env, AutoTokenizer, AutoModel } from '@huggingface/transformers';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

env.allowRemoteModels = false;
env.localModelPath = new URL('./models/', import.meta.url).pathname;

const device = process.argv[2] || 'cpu';        // 'cpu' (onnxruntime-node) or 'wasm' (onnxruntime-web)
const threads = Number(process.argv[3] || 1);
const onlyModel = process.argv[4];
if (device === 'wasm') {
  env.backends.onnx.wasm.numThreads = threads;
}

const MODELS = [
  { id: 'MongoDB/mdbr-leaf-ir', out: 'sentence_embedding' },
  { id: 'Snowflake/snowflake-arctic-embed-xs', out: 'cls' },
  { id: 'Xenova/bge-small-en-v1.5', out: 'cls' },
].filter(m => !onlyModel || m.id.includes(onlyModel));

const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

const text = readFileSync(new URL('./' + (process.env.DOC || 'doc50k.txt'), import.meta.url), 'utf8');

for (const m of MODELS) {
  const t0 = performance.now();
  const tok = await AutoTokenizer.from_pretrained(m.id);
  const opts = { dtype: 'q8', device };
  if (device === 'cpu') opts.session_options = { intraOpNumThreads: threads, interOpNumThreads: 1 };
  const model = await AutoModel.from_pretrained(m.id, opts);
  const loadMs = performance.now() - t0;

  // token-exact chunking: 400-token windows, 60 overlap (pilot; real chunker is heading-aware)
  const t1 = performance.now();
  const ids = tok.encode(text, { add_special_tokens: false });
  const tokMs = performance.now() - t1;
  const chunks = [];
  for (let s = 0; s < ids.length; s += 340) { chunks.push(ids.slice(s, s + 400)); if (s + 400 >= ids.length) break; }
  const chunkTexts = chunks.map(c => tok.decode(c));

  const embed = async (t) => {
    const inp = await tok([t], { padding: true, truncation: true, max_length: 512 });
    const o = await model(inp);
    if (m.out === 'sentence_embedding') return o.sentence_embedding.data;
    return o.last_hidden_state.data.slice(0, 384);
  };
  await embed('warm up run');
  const per = [];
  const tIdx = performance.now();
  for (const c of chunkTexts) { const a = performance.now(); await embed(c); per.push(performance.now() - a); }
  const idxMs = performance.now() - tIdx;

  const q = 'Represent this sentence for searching relevant passages: where is the memory leak in the window compositor';
  const ql = [];
  for (let i = 0; i < 30; i++) { const a = performance.now(); await embed(q); ql.push(performance.now() - a); }
  const mem = process.memoryUsage();
  console.log(JSON.stringify({
    model: m.id, device, threads, loadMs: Math.round(loadMs), docBytes: Buffer.byteLength(text), tokens: ids.length, tokenizeMs: Math.round(tokMs),
    chunks: chunks.length, chunkP50: Math.round(pct(per, 0.5)), chunkP95: Math.round(pct(per, 0.95)), index50kMs: Math.round(idxMs),
    queryP50: +pct(ql, 0.5).toFixed(1), queryP95: +pct(ql, 0.95).toFixed(1), rssMB: Math.round(mem.rss / 1e6),
  }));
  await model.dispose?.();
}
