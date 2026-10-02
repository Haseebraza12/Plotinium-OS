import { Terminal } from '@xterm/xterm'; import '@xterm/xterm/css/xterm.css';
const t = new Terminal({ scrollback: 5000 }); t.open(document.getElementById('x'));
for (let i = 0; i < 5000; i++) t.write('line ' + i + ' lorem ipsum dolor sit amet consectetur\r\n');
t.write('', () => { window.__ready = true; });
