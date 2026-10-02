import * as ort from 'onnxruntime-web';
import { env, AutoTokenizer } from '@huggingface/transformers';
import { readFileSync, existsSync } from 'node:fs';
env.allowRemoteModels = false;
env.localModelPath = new URL('./models/', import.meta.url).pathname;
ort.env.wasm.numThreads = Number(process.argv[2]||1);
const id = process.argv[3] || 'MongoDB/mdbr-leaf-ir';
const mb = () => { const m = process.memoryUsage(); return {rss: Math.round(m.rss/1e6), ab: Math.round(m.arrayBuffers/1e6), ext: Math.round(m.external/1e6), heap: Math.round(m.heapUsed/1e6)}; };
const log = (s) => console.log(s, JSON.stringify(mb()));
global.gc && gc(); log('baseline');
const tok = await AutoTokenizer.from_pretrained(id); log('tokenizer');
const dir = new URL(`./models/${id}/onnx/`, import.meta.url).pathname;
const opts = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };
if (existsSync(dir + 'model_quantized.onnx_data')) opts.externalData = [{ path: 'model_quantized.onnx_data', data: readFileSync(dir + 'model_quantized.onnx_data') }];
const sess = await ort.InferenceSession.create(readFileSync(dir + 'model_quantized.onnx'), opts);
global.gc && gc(); log('session');
const text = readFileSync('prose50k.txt','utf8');
for (const L of [128, 400, 512]) {
  const enc = await tok([text.slice(0, 20000)], { truncation: true, max_length: L });
  const feeds = {}; for (const n of sess.inputNames) feeds[n] = new ort.Tensor('int64', BigInt64Array.from(enc[n].data), enc[n].dims);
  await sess.run(feeds); global.gc && gc(); log('run len='+enc.input_ids.dims[1]);
}
// batch 8 x 512
const enc = await tok(Array(8).fill(text.slice(0,20000)), { truncation: true, max_length: 512, padding: true });
const feeds = {}; for (const n of sess.inputNames) feeds[n] = new ort.Tensor('int64', BigInt64Array.from(enc[n].data), enc[n].dims);
await sess.run(feeds); global.gc && gc(); log('run batch8x512');
await sess.release(); global.gc && gc(); log('after release');
