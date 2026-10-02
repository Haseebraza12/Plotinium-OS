/*
 * Builds the D15 font specimen: every candidate renders the same Plotinium surfaces with the real
 * tokens. The Terminal cells are real xterm.js 6 instances (DOM renderer, the one TerminalHost
 * uses) with the option values of ui/src/apps/terminal/theme.ts, so cell size, line height and
 * box-drawing joins are what the app would show. Served statically from the repository root:
 *   python3 -m http.server 4791 --bind 127.0.0.1   then open
 *   http://127.0.0.1:4791/docs/design/fonts/specimen/
 */
import { Terminal } from '../../../../ui/node_modules/@xterm/xterm/lib/xterm.mjs';

/** UI sans candidates; kb is the Latin woff2 the product would ship (du -b of the file). */
const UI = [
  { id: 'inter', name: 'Inter 4 · opsz + wght', family: "'S-Inter'", kb: 72.9 },
  { id: 'inter-wght', name: 'Inter · wght only (shipped today)', family: "'S-InterW'", kb: 48.3 },
  { id: 'inter-tight', name: 'Inter Tight · wght', family: "'S-InterTight'", kb: 44.9 },
  { id: 'geist', name: 'Geist · wght', family: "'S-Geist'", kb: 29.4 },
  { id: 'gsf', name: 'Google Sans Flex · opsz + wght', family: "'S-GSF'", kb: 119.9 },
  {
    id: 'system',
    name: 'System fallback (boot stack)',
    family: "system-ui, 'Segoe UI', Roboto, Ubuntu, 'Noto Sans', sans-serif",
    kb: 0,
  },
];

/** Monospace candidates; kb counts the Latin file plus the symbol subsets the face ships. */
const MONO = [
  { id: 'jbm', name: 'JetBrains Mono (shipped today)', family: "'S-JBM'", kb: 40.4 },
  { id: 'geist-mono', name: 'Geist Mono · + box drawing', family: "'S-GeistMono'", kb: 28.9 },
  { id: 'gsc', name: 'Google Sans Code · + symbols', family: "'S-GSC'", kb: 58.3 },
  { id: 'dejavu', name: 'System fallback (DejaVu Sans Mono)', family: "'DejaVu Sans Mono'", kb: 0 },
];

const params = new URLSearchParams(location.search);
const only = params.get('only');

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

function cell(c, inner) {
  return `<div class="cell" style="--f: ${c.family}; ${c.vars ?? ''}" data-cand="${c.id}"><span class="tag">${esc(c.name)}${c.kb > 0 ? ` · ${c.kb} KB` : ''}</span>${inner}</div>`;
}

function section(id, title, cols, cands, render) {
  return `<section class="spec" id="${id}"><h2>${esc(title)}</h2><div class="grid" style="--cols: ${cols}">${cands.map((c) => cell(c, render(c))).join('')}</div></section>`;
}

const chrome = () => `
  <div class="menubar"><b class="app">Files</b><span>File</span><span>Edit</span><span>View</span><span>Go</span><span>Window</span><span>Help</span><span class="end">Wed 27 Sep 14:32</span></div>
  <div class="titlebar"><span class="lights"><i></i><i></i><i></i></span><span class="title">Files — notes</span><span></span></div>`;

const windowPane = () => `
  <div class="window">
    <div class="side">
      <div class="head">Favourites</div>
      <div class="row on"><i></i>Home<span class="n">12</span></div>
      <div class="row"><i></i>Documents<span class="n">1,284</span></div>
      <div class="row"><i></i>Desktop</div>
      <div class="row"><i></i>Downloads<span class="n">7</span></div>
      <div class="head">Locations</div>
      <div class="row"><i></i>Shared with me</div>
      <div class="row"><i></i>Trash</div>
    </div>
    <div class="pane">
      <h3>Appearance</h3>
      <div class="group">
        <div class="item"><span>Theme</span><span class="val">Dark ›</span></div>
        <div class="item"><span>Accent colour<span class="sub">Used for selection, focus and the logo</span></span><span class="val">Violet</span></div>
        <div class="item"><span>Reduce motion</span><span class="toggle"></span></div>
        <div class="item"><span>Reduce transparency<span class="sub">Glass becomes solid surfaces</span></span></div>
      </div>
    </div>
  </div>`;

const table = () => `
  <table class="tm">
    <thead><tr><th>Name</th><th class="r">PID</th><th class="r">% CPU</th><th class="r">Memory</th><th class="r">Threads</th><th>State</th></tr></thead>
    <tbody>
      <tr><td>kernel</td><td class="r">1</td><td class="r">0.4</td><td class="r">18.2 MB</td><td class="r">4</td><td>running</td></tr>
      <tr><td>ai.agent</td><td class="r">212</td><td class="r">12.7</td><td class="r">118.4 MB</td><td class="r">11</td><td>waiting</td></tr>
      <tr class="sel"><td>indexer</td><td class="r">23</td><td class="r">100.0</td><td class="r">1,024.0 MB</td><td class="r">1</td><td>running</td></tr>
      <tr><td>sh</td><td class="r">1041</td><td class="r">0.0</td><td class="r">3.9 MB</td><td class="r">1</td><td>sleeping</td></tr>
      <tr><td>Editor</td><td class="r">887</td><td class="r">1.1</td><td class="r">64.0 MB</td><td class="r">3</td><td>running</td></tr>
      <tr><td>Files</td><td class="r">716</td><td class="r">8.8</td><td class="r">41.6 MB</td><td class="r">2</td><td>running</td></tr>
    </tbody>
  </table>`;

const legible = () => `
  <div class="legible">
    <p class="s13">Il1 | O0o | rn m | 5,450 ms · 0.25 GB · 99.9%</p>
    <p class="s12">Il1 | O0o | rn m | 5,450 ms · 0.25 GB · 99.9%</p>
    <p class="s11">Il1 | O0o | rn m | 5,450 ms · 0.25 GB · 99.9%</p>
    <p class="s11 muted">Plotinium pages its own memory; the agent acts only through the kernel, and every change waits for your confirmation.</p>
    <p class="s12 muted">Signed in as alice · last login 26 Sep 2026, 09:41 · quota 1.2 of 5 GB</p>
  </div>`;

const clock = () => `
  <div class="clock"><div class="date">Wednesday 27 September</div><div class="time">14:32</div><div class="time" style="font-size: 120px">09:41</div></div>`;

const heads = () => `
  <div class="heads">
    <h4 class="wordmark">Plotinium</h4>
    <h4 class="h34">Plotinium 0.2 Monoclinic</h4>
    <h4 class="h28">Task Manager · Memory</h4>
    <h4 class="h22">Restart to update Plotinium?</h4>
  </div>`;

const withTracking0 = (c) => ({
  ...c,
  id: `${c.id}-t0`,
  name: `${c.name} · tracking 0`,
  vars: '--ls-11: 0; --ls-20: 0; --ls-22: 0; --ls-28: 0; --ls-34: 0; --ls-display: 0',
});

/** Inter's full dynamic-metrics tracking (rsms.me/inter/dynmetrics), before halving for opsz. */
const withTrackingFull = (c) => ({
  ...c,
  id: `${c.id}-tf`,
  name: `${c.name} · full dynamic tracking`,
  vars: '--ls-20: -0.017em; --ls-22: -0.018em; --ls-28: -0.021em; --ls-34: -0.022em; --ls-display: -0.022em',
});

const body = [
  section('chrome', 'Menu bar row (13 px) and window title (13 px semibold)', 3, UI, chrome),
  section(
    'window',
    'Sidebar rows (13 px) and a settings list (13 px, 11 px sub-labels)',
    3,
    UI,
    windowPane,
  ),
  section(
    'table',
    'Task Manager table: dense, tabular numbers (13 px, 12 px header)',
    3,
    UI,
    table,
  ),
  section('legible', 'Legibility at 13, 12 and 11 px (l / I / 1, 0 / O, rn / m)', 3, UI, legible),
  section(
    'clock',
    'Login clock (96 px and the real 120 px, weight 200, tabular, -0.02em)',
    3,
    [...UI, withTracking0(UI[0]), withTrackingFull(UI[0])],
    clock,
  ),
  section(
    'heads',
    'Headlines 22–36 px bold; default cells use the shipped --pl-tracking-* scale',
    3,
    [...UI, withTracking0(UI[0]), withTrackingFull(UI[0]), withTracking0(UI[3])],
    heads,
  ),
  `<section class="spec" id="mono"><h2>Terminal (real xterm.js, 13 px, line height 1.2) and Editor (13 px / 1.6)</h2><div class="grid" style="--cols: 2">${MONO.map((m) => cell(m, `<div class="term" id="term-${m.id}"></div>${code()}`)).join('')}</div></section>`,
].filter((s) => only === null || s.includes(`id="${only}"`));

function code() {
  return `<pre class="code"><span class="ln">1</span><span class="com">// kernel/src/core/mm/lru.ts — 0O Il1 {}[]() =&gt; != &lt;=</span>
<span class="ln">2</span><span class="kw">export function</span> evict(pages: Page[], budget = <span class="num">0x4000</span>): number {
<span class="ln">3</span>  <span class="kw">let</span> freed = <span class="num">0</span>;
<span class="ln">4</span>  <span class="kw">for</span> (<span class="kw">const</span> p <span class="kw">of</span> pages) <span class="kw">if</span> (p.pinned === <span class="kw">false</span>) freed += p.size;
<span class="ln">5</span>  <span class="kw">return</span> freed &gt;= budget ? freed : <span class="num">-1</span>; <span class="str">'ok'</span>
<span class="ln">6</span>}</pre>`;
}

document.getElementById('root').innerHTML = body.join('');

/** Token colour → opaque hex, the way ui/src/apps/terminal/theme.ts flattens it. */
function tokenColour(el, token, bg) {
  const probe = document.createElement('span');
  probe.style.color = `var(${token})`;
  el.append(probe);
  const value = getComputedStyle(probe).color;
  probe.remove();
  const m = /rgba?\(([^)]+)\)/.exec(value);
  if (m === null) return '#888888';
  const parts = m[1]
    .split(/[\s,/]+/)
    .filter(Boolean)
    .map(Number);
  const [r, g, b, a = 1] = parts;
  const mix = (c, i) => Math.round(c * a + (bg?.[i] ?? 255) * (1 - a));
  return `#${[mix(r, 0), mix(g, 1), mix(b, 2)].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
}

const E = '\x1b[';
const prompt = `${E}1;32mstudent@plotinium${E}0m:${E}1;34m~${E}0m$ `;
const transcript = [
  `${prompt}tree notes`,
  'notes',
  '├── os-report.md',
  '├── lab3-vfs.pdf',
  '└── drafts',
  '    └── sched-notes.md',
  '1 directory, 3 files',
  `${prompt}ps -o pid,ni,pcpu,rss,comm`,
  '  PID  NI  %CPU     RSS COMMAND',
  '    1   0   0.4   18636 kernel',
  '   23  10 100.0 1048576 indexer',
  '  212   0  12.7  121242 ai.agent',
  `${E}1;94m── Kernel confirmation · ai.agent (pid 212) ──────────────${E}0m`,
  `${E}1mPlan · 4 steps · 1 transaction${E}0m`,
  '  2  find   ~ -type f -name "*.pdf"      → 12 files',
  `${E}32m✓ committed in 41 ms · txn 8f2c${E}0m   ${E}31m✗ denied${E}0m   ↑↓ · …`,
  'Il1| O0o | {}[]() <= >= != => -> ~/  `\'" %CPU 0.25',
  `${prompt}${E}7m ${E}0m`,
].join('\r\n');

await document.fonts.ready;
for (const m of MONO) {
  const host = document.getElementById(`term-${m.id}`);
  if (host === null) continue;
  await document.fonts.load(`13px ${m.family}`, 'Il1O0─→');
  await document.fonts.load(`bold 13px ${m.family}`, 'Il1O0─→');
  const bgHex = tokenColour(host, '--pl-surface');
  const bg = [1, 3, 5].map((i) => Number.parseInt(bgHex.slice(i, i + 2), 16));
  const t = new Terminal({
    fontFamily: `${m.family}, monospace`,
    fontSize: 13,
    lineHeight: 1.2,
    cols: 64,
    rows: 18,
    cursorBlink: false,
    minimumContrastRatio: 4.5,
    drawBoldTextInBrightColors: false,
    theme: {
      background: bgHex,
      foreground: tokenColour(host, '--pl-text', bg),
      green: tokenColour(host, '--pl-success', bg),
      blue: tokenColour(host, '--pl-info', bg),
      red: tokenColour(host, '--pl-danger', bg),
      brightBlue: tokenColour(host, '--pl-tint-blue', bg),
    },
  });
  t.open(host);
  t.write(transcript);
}
document.documentElement.dataset.ready = 'true';
