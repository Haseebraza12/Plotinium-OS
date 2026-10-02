import { shared } from './shared';
const ex = new Worker(new URL('./executor.worker.ts', import.meta.url), { type: 'module' });
ex.onmessage = (e) => { (self as any).postMessage({ fromExecutor: e.data, kernelCOI: (self as any).crossOriginIsolated, sab: typeof SharedArrayBuffer, shared: shared() }); };
