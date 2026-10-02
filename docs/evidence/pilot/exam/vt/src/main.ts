const k = new Worker(new URL('./kernel.worker.ts', import.meta.url), { type: 'module' });
k.onmessage = (e) => { (window as any).__R = e.data; (window as any).__done = true; };
