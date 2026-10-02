import * as z from 'zod'; z.config({ jitless: true });
const { validate } = await import('./zod.js');
const good = [{ id: 1, call: 'stat', args: { path: '/home/ali/docs/report.md' } }, { id: 2, call: 'chmod', args: { path: '/home/ali/x', mode: 'o-w', recursive: true } }, { id: 3, call: 'spawn', args: { image: '/bin/grep', argv: ['-r', 'todo', '.'] } }, { id: 4, call: 'kill', args: { pid: 42, signal: 'KILL' } }];
const N = 300000; for (let i = 0; i < 50000; i++) validate(good[i & 3]);
const t = performance.now(); for (let i = 0; i < N; i++) validate(good[i & 3]); console.log('zod jitless valid_ns', ((performance.now() - t) * 1e6 / N).toFixed(0));
