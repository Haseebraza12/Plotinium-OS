import '../../../shared/style.css';
import { initialWindows, ROWS, DRAG_MODE, zOrder, markReady } from '../../../shared/data.js';
import { installCompositor } from '../../../shared/compositor.js';
const app = document.getElementById('app');
let wins = initialWindows();
const desk = document.createElement('div'); desk.className = 'desk';
const bar = document.createElement('div'); bar.className = 'taskbar';
const els = [], ticks = [], btns = [];
for (const w of wins) {
  const el = document.createElement('div'); el.className = 'win'; el.dataset.win = w.id;
  el.style.cssText = `transform:translate3d(${w.x}px,${w.y}px,0);width:${w.w}px;height:${w.h}px;z-index:${w.z}`;
  const t = document.createElement('div'); t.className = 'title'; t.dataset.drag = ''; t.append(w.title + ' ');
  const s = document.createElement('span'); s.className = 'tick'; s.textContent = w.tick; t.append(s);
  const ul = document.createElement('ul'); ul.className = 'body';
  for (const r of ROWS) { const li = document.createElement('li'); li.textContent = r; ul.append(li); }
  el.append(t, ul); desk.append(el); els.push(el); ticks.push(s);
  const b = document.createElement('button'); b.textContent = w.title; bar.append(b); btns.push(b);
}
app.append(desk, bar);
window.__app = {
  setPos(id, x, y) { wins[id].x = x; wins[id].y = y; els[id].style.transform = `translate3d(${x}px,${y}px,0)`; },
  tick(id) { ticks[id].textContent = ++wins[id].tick; },
  focus(id) { const z = zOrder(wins, id); for (const w of wins) { w.z = z.get(w.id); els[w.id].style.zIndex = w.z; btns[w.id].classList.toggle('focused', w.id === id); } },
};
installCompositor(DRAG_MODE); markReady();
