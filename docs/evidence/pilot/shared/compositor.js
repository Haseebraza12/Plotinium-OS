// Framework-agnostic compositor: sole writer of geometry in 'imperative' mode.
// pointer capture + translate3d batched per requestAnimationFrame.
export function installCompositor(mode) {
  let drag = null, pending = false;
  window.__moves = 0;
  document.addEventListener('pointerdown', (e) => {
    const handle = e.target.closest('[data-drag]'); if (!handle) return;
    const el = handle.closest('[data-win]'); const id = Number(el.dataset.win);
    const m = /translate3d\(([-\d.]+)px,\s*([-\d.]+)px/.exec(el.style.transform);
    const x0 = Number(m[1]), y0 = Number(m[2]);
    drag = { id, el, ox: e.clientX - x0, oy: e.clientY - y0, x: x0, y: y0 };
    handle.setPointerCapture(e.pointerId);
    window.__app.focus(id);
  });
  document.addEventListener('pointermove', (e) => {
    if (!drag) return;
    drag.x = e.clientX - drag.ox; drag.y = e.clientY - drag.oy; window.__moves++;
    if (!pending) { pending = true; requestAnimationFrame(flush); }
  });
  function flush() {
    pending = false; if (!drag) return;
    if (mode === 'imperative') drag.el.style.transform = `translate3d(${drag.x}px,${drag.y}px,0)`;
    else window.__app.setPos(drag.id, drag.x, drag.y);
  }
  document.addEventListener('pointerup', () => { drag = null; });
}
