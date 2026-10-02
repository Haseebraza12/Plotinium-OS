import '../../../shared/style.css';
import { LitElement, html } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import { styleMap } from 'lit/directives/style-map.js';
import { initialWindows, ROWS, DRAG_MODE, zOrder, markReady } from '../../../shared/data.js';
import { installCompositor } from '../../../shared/compositor.js';

class OsWin extends LitElement {
  static properties = { w: { attribute: false } };
  createRenderRoot() { return this; } // light DOM so the shared token CSS applies
  updated() { window.__renders.win[this.w.id]++; }
  render() {
    const w = this.w;
    return html`<div class="win" data-win=${w.id} style=${styleMap({ transform: `translate3d(${w.x}px,${w.y}px,0)`, width: `${w.w}px`, height: `${w.h}px`, zIndex: String(w.z) })}>
      <div class="title" data-drag="">${w.title} <span class="tick">${w.tick}</span></div>
      <ul class="body">${ROWS.map((r) => html`<li>${r}</li>`)}</ul></div>`;
  }
}
customElements.define('os-win', OsWin);
class OsDesktop extends LitElement {
  static properties = { wins: { state: true } };
  constructor() { super(); this.wins = initialWindows(); }
  createRenderRoot() { return this; }
  firstUpdated() {
    const upd = (id, f) => { this.wins = this.wins.map((w) => (w.id === id ? { ...w, ...f(w) } : w)); };
    window.__app = {
      setPos: (id, x, y) => upd(id, () => ({ x, y })),
      tick: (id) => upd(id, (w) => ({ tick: w.tick + 1 })),
      focus: (id) => { const z = zOrder(this.wins, id); this.wins = this.wins.map((w) => (w.z === z.get(w.id) ? w : { ...w, z: z.get(w.id) })); },
    };
    installCompositor(DRAG_MODE); markReady();
  }
  render() {
    const top = this.wins.length;
    return html`<div class="desk">${repeat(this.wins, (w) => w.id, (w) => html`<os-win .w=${w}></os-win>`)}</div>
      <div class="taskbar">${repeat(this.wins, (w) => w.id, (w) => html`<button class=${w.z === top ? 'focused' : ''}>${w.title}</button>`)}</div>`;
  }
}
customElements.define('os-desktop', OsDesktop);
document.getElementById('app').append(document.createElement('os-desktop'));
