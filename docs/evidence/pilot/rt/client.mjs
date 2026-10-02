import WebSocket from 'ws';
import { io } from 'socket.io-client';
const now = () => performance.timeOrigin + performance.now();
const N = 200; const res = { ws: [], sio: [], sse: [], longpoll: [], poll1s: [] };
const pct = (a, p) => { const s = [...a].sort((x,y)=>x-y); return s[Math.min(s.length-1, Math.floor(p/100*s.length))]; };
const ws = new WebSocket('ws://127.0.0.1:8765/ws'); ws.on('message', d => { const e = JSON.parse(d); if (res.ws.length < N) res.ws.push(now()-e.ts); });
const s = io('http://127.0.0.1:8765', { transports: ['websocket'] }); s.on('m', e => { if (res.sio.length < N) res.sio.push(now()-e.ts); });
(async () => { const r = await fetch('http://127.0.0.1:8765/sse'); const rd = r.body.getReader(); const dec = new TextDecoder(); let buf='';
  while (res.sse.length < N) { const {value, done} = await rd.read(); if (done) break; buf += dec.decode(value); let i; while ((i = buf.indexOf('\n\n')) >= 0) { const blk = buf.slice(0,i); buf = buf.slice(i+2); const m = blk.match(/^data: (.*)$/m); if (m) res.sse.push(now()-JSON.parse(m[1]).ts); } } })();
(async () => { let since = 0; while (res.longpoll.length < N) { const r = await fetch('http://127.0.0.1:8765/lp?since='+since); const e = await r.json(); res.longpoll.push(now()-e.ts); since = e.seq; } })();
// 1s short polling: latency = time from event creation until a poll observes it
(async () => { let seen = 0; while (res.poll1s.length < 60) { const r = await fetch('http://127.0.0.1:8765/poll'); const e = await r.json(); if (e && e.seq > seen) { res.poll1s.push(now()-e.ts); seen = e.seq; } await new Promise(r => setTimeout(r, 1000)); } })();
const iv = setInterval(() => { if (Object.entries(res).every(([k,v]) => v.length >= (k==='poll1s'?60:N))) { clearInterval(iv);
  for (const [k,v] of Object.entries(res)) console.log(k.padEnd(9), 'n='+v.length, 'p50='+pct(v,50).toFixed(2)+'ms', 'p95='+pct(v,95).toFixed(2)+'ms');
  process.exit(0); } }, 500);
