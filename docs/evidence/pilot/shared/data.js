// Identical workload for every framework prototype.
const q = new URLSearchParams(location.search);
export const N = Number(q.get('n') ?? 10);          // windows
export const ROWS = Array.from({ length: Number(q.get('rows') ?? 150) }, (_, i) => `row ${i} lorem ipsum dolor sit amet`);
export const DRAG_MODE = q.get('drag') ?? 'imperative'; // imperative | reactive
export function initialWindows() {
  return Array.from({ length: N }, (_, i) => ({
    id: i, title: `Window ${i}`, x: 30 + (i % 5) * 190, y: 30 + Math.floor(i / 5) * 230, w: 320, h: 240, z: i + 1, tick: 0,
  }));
}
// z renumbered 1..n, focused on top (WM-02 semantics), array order unchanged
export function zOrder(wins, id) {
  const order = [...wins].sort((a, b) => a.z - b.z).map(w => w.id).filter(x => x !== id);
  order.push(id);
  const z = new Map(order.map((wid, i) => [wid, i + 1]));
  return z;
}
window.__renders = { win: new Array(N).fill(0), desktop: 0, taskbar: 0 };
export function markReady() {
  // desktop considered interactive after first paint of all windows
  requestAnimationFrame(() => setTimeout(() => { performance.mark('desktop-interactive'); window.__ready = true; }, 0));
}
