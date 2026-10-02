// Latency server: pushes an event every ~200ms (randomised) to all transports; stamps with performance.timeOrigin+now
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { Server as SioServer } from 'socket.io';
const now = () => performance.timeOrigin + performance.now();
const sseClients = new Set(); const longPollers = new Set(); let lastEvent = null; let seq = 0;
const srv = http.createServer((req, res) => {
  if (req.url === '/sse') { res.writeHead(200, {'content-type':'text/event-stream','cache-control':'no-cache'}); res.write(':ok\n\n'); sseClients.add(res); req.on('close', () => sseClients.delete(res)); return; }
  if (req.url.startsWith('/lp')) { const since = +new URL(req.url,'http://x').searchParams.get('since'); if (lastEvent && lastEvent.seq > since) { res.end(JSON.stringify(lastEvent)); return; } longPollers.add(res); req.on('close', () => longPollers.delete(res)); return; }
  if (req.url.startsWith('/poll')) { res.end(JSON.stringify(lastEvent)); return; }
  res.end('ok');
});
const wss = new WebSocketServer({ noServer: true });
srv.on('upgrade', (req, sock, head) => { if (req.url === '/ws') wss.handleUpgrade(req, sock, head, ws => wss.emit('connection', ws)); });
const sio = new SioServer(srv, { transports: ['websocket'] });
function fire() {
  const ev = { t: 'lock.granted', seq: ++seq, ino: 4242, leaseId: 'l'+seq, fence: seq, ts: now() };
  lastEvent = ev; const s = JSON.stringify(ev);
  for (const c of wss.clients) c.send(s);
  sio.emit('m', ev);
  for (const r of sseClients) r.write(`id: ${ev.seq}\ndata: ${s}\n\n`);
  for (const r of longPollers) r.end(s); longPollers.clear();
  setTimeout(fire, 1300 + Math.random() * 1400);
}
srv.listen(8765, () => { console.log('ready'); setTimeout(fire, 500); });
