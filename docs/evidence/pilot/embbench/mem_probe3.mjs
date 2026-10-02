const mems = [];
const OrigMem = WebAssembly.Memory;
WebAssembly.Memory = function(d){ const m = new OrigMem(d); mems.push(m); return m; };
WebAssembly.Memory.prototype = OrigMem.prototype;
const origInst = WebAssembly.instantiate;
WebAssembly.instantiate = async function(...a){ const r = await origInst.apply(this,a); const inst = r.instance || r; for (const v of Object.values(inst.exports)) if (v instanceof OrigMem) mems.push(v); return r; };
const origIS = WebAssembly.instantiateStreaming;
const { default: ort } = await import('onnxruntime-web').then(m=>({default:m}));
const { env, AutoTokenizer } = await import('@huggingface/transformers');
const { readFileSync, existsSync } = await import('node:fs');
env.allowRemoteModels = false; env.localModelPath = new URL('./models/', import.meta.url).pathname;
ort.env.wasm.numThreads = Number(process.argv[2]||1);
const id = process.argv[3] || 'MongoDB/mdbr-leaf-ir';
const wm = () => mems.map(m=>Math.round(m.buffer.byteLength/1048576)+'MiB').join(',');
const log = (s) => console.log(s, 'rss', Math.round(process.memoryUsage().rss/1e6), 'wasmMem', wm());
const tok = await AutoTokenizer.from_pretrained(id);
const dir = new URL(`./models/${id}/onnx/`, import.meta.url).pathname;
const opts = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };
if (existsSync(dir + 'model_quantized.onnx_data')) opts.externalData = [{ path: 'model_quantized.onnx_data', data: readFileSync(dir + 'model_quantized.onnx_data') }];
const sess = await ort.InferenceSession.create(readFileSync(dir + 'model_quantized.onnx'), opts);
log('session');
const text = readFileSync('prose50k.txt','utf8');
for (const B of [1, 8]) {
  const enc = await tok(Array(B).fill(text.slice(0,20000)), { truncation: true, max_length: 512, padding: true });
  const feeds = {}; for (const n of sess.inputNames) feeds[n] = new ort.Tensor('int64', BigInt64Array.from(enc[n].data), enc[n].dims);
  await sess.run(feeds); log('run B='+B+'x512');
}
await sess.release(); log('released');
