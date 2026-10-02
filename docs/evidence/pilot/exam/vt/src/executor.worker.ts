import { shared } from './shared';
(self as any).postMessage({ execCOI: (self as any).crossOriginIsolated, sab: typeof SharedArrayBuffer, shared: shared() });
