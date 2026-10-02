import { createSignal } from 'solid-js';
export function Title({ title }: { title: string }) { return <h2>{title}</h2>; }
export function Early(p: { on: boolean }) { if (!p.on) return null; return <div>on</div>; }
export function Outside() { const [c] = createSignal(0); const v = c(); return <div>{v}</div>; }
