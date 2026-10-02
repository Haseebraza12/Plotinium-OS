import { Terminal } from '@xterm/xterm'; import { FitAddon } from '@xterm/addon-fit'; import { WebglAddon } from '@xterm/addon-webgl'; import '@xterm/xterm/css/xterm.css';
const t = new Terminal(); const f = new FitAddon(); t.loadAddon(f); t.open(document.getElementById('x')); t.loadAddon(new WebglAddon()); f.fit(); t.write('hello');
