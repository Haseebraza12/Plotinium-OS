import http from 'node:http'; import { WebSocketServer } from 'ws'; import { Server as SioServer } from 'socket.io';
const kind = process.argv[2]; const srv = http.createServer((q,s)=>s.end('ok'));
let count = 0;
if (kind === 'ws') { const wss = new WebSocketServer({ server: srv, perMessageDeflate: false }); wss.on('connection', ws => { count++; ws.on('message', ()=>{}); }); }
else { const io = new SioServer(srv, { transports: ['websocket'], perMessageDeflate: false }); io.on('connection', s => { count++; s.on('m', ()=>{}); }); }
const snap = () => { global.gc(); global.gc(); const m = process.memoryUsage(); return { rss: m.rss, heap: m.heapUsed, ext: m.external + m.arrayBuffers }; };
srv.listen(8766, () => { setTimeout(() => { const base = snap(); process.send ? 0 : 0; console.log('BASE', JSON.stringify(base));
  const iv = setInterval(() => { if (count >= +process.argv[3]) { clearInterval(iv); setTimeout(() => { const a = snap(); const n = count;
    console.log(kind, 'conns='+n, 'rss/conn='+((a.rss-base.rss)/n/1024).toFixed(1)+'KB', 'heap/conn='+((a.heap-base.heap)/n/1024).toFixed(1)+'KB', 'ext/conn='+((a.ext-base.ext)/n/1024).toFixed(2)+'KB'); process.exit(0); }, 3000); } }, 200); }, 500); });
