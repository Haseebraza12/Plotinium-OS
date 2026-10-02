import http from 'node:http';
import { WebSocketServer } from 'ws';
const H = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self' ws://127.0.0.1:4173; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
};
const files = {
  '/': ['text/html', `<!doctype html><title>proto</title><div id=s>booting</div><script src="/app.js"></script>`],
  '/app.js': ['text/javascript', `
    navigator.serviceWorker.register('/sw.js');
    window.state = { coi: self.crossOriginIsolated, sab: typeof SharedArrayBuffer, mem: typeof performance.measureUserAgentSpecificMemory, wsOpen:false, echo:null };
    document.getElementById('s').textContent = 'desktop-ready coi=' + self.crossOriginIsolated;
    try { const ws = new WebSocket('ws://127.0.0.1:4173/ws'); window.ws = ws;
      ws.onopen = () => state.wsOpen = true; ws.onclose = () => state.wsOpen = false; ws.onmessage = e => state.echo = e.data; } catch (e) { state.wsErr = String(e); }
    // frame meter
    window.frames_ = []; let last = performance.now();
    (function f(t){ frames_.push(t - last); last = t; requestAnimationFrame(f); })(performance.now());
  `],
  '/sw.js': ['text/javascript', `
    const C='shell-v1';
    self.addEventListener('install', e => e.waitUntil(caches.open(C).then(c => c.addAll(['/', '/app.js'])).then(() => self.skipWaiting())));
    self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
    self.addEventListener('fetch', e => { const u = new URL(e.request.url); if (u.pathname.startsWith('/api')) return;
      e.respondWith(caches.match(e.request, {ignoreSearch:true}).then(r => r || fetch(e.request))); });
  `],
};
const srv = http.createServer((req, res) => {
  if (req.url === '/api/ping') { res.writeHead(200, { ...H, 'content-type': 'application/json' }); return res.end('{"ok":true}'); }
  const f = files[req.url.split('?')[0]]; if (!f) { res.writeHead(404, H); return res.end(); }
  res.writeHead(200, { ...H, 'content-type': f[0], 'cache-control': 'no-cache' }); res.end(f[1]);
});
const wss = new WebSocketServer({ server: srv, path: '/ws' });
wss.on('connection', (s, req) => { s.on('message', m => s.send('echo:' + m)); });
srv.listen(4173, '127.0.0.1', () => console.log('listening'));
