import WebSocket from 'ws'; import { io } from 'socket.io-client';
const kind = process.argv[2], N = +process.argv[3]; const socks = [];
for (let i = 0; i < N; i++) { if (kind === 'ws') socks.push(new WebSocket('ws://127.0.0.1:8766/', { perMessageDeflate: false })); else socks.push(io('http://127.0.0.1:8766', { transports: ['websocket'], forceNew: true })); if (i % 200 === 0) await new Promise(r => setTimeout(r, 50)); }
setTimeout(() => process.exit(0), 20000);
