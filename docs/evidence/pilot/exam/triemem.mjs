import { Trie, rng } from './dsa.mjs';
const words = ['home','docs','src','kernel','report','draft','notes','img','photo','music','video','lib','bin','tmp','proj','test','data','old','new','final'];
for (const n of [1000, 10000, 100000]) {
  global.gc(); const before = process.memoryUsage().heapUsed;
  const rnd = rng(7); const t = new Trie(); let chars = 0; let nodes = 0;
  while (t.count < n) { const d = 1 + ((rnd() * 5) | 0); let p = '/'; for (let j = 0; j < d; j++) p += words[(rnd() * 20) | 0] + ((rnd() * 50) | 0) + '/'; p += 'file' + ((rnd() * 1e6) | 0) + '.md'; t.insert(p); chars += p.length; }
  const cnt = (nd) => { let c = 1; for (const x of nd.c.values()) c += cnt(x); return c; }; nodes = cnt(t.root);
  global.gc(); const after = process.memoryUsage().heapUsed;
  console.log(n, 'entries', 'nodes', nodes, 'rawChars', chars, 'heapMB', ((after - before) / 1048576).toFixed(1), 'bytes/node', ((after-before)/nodes).toFixed(0));
  globalThis.keep = t;
}
