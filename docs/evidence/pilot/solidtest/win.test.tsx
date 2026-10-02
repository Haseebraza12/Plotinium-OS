import { render, screen, fireEvent } from '@solidjs/testing-library';
import { createSignal, For } from 'solid-js';
import { createStore, reconcile } from 'solid-js/store';
import { expect, test } from 'vitest';
let runs = 0;
function Row(p: { name: string; cpu: number }) { runs++; return <tr><td>{p.name}</td><td data-testid={'cpu-' + p.name}>{p.cpu}</td></tr>; }
test('store reconcile updates only the changed cell, component runs once', async () => {
  const [procs, setProcs] = createStore<{ pid: number; name: string; cpu: number }[]>([{ pid: 1, name: 'init', cpu: 0 }, { pid: 2, name: 'sh', cpu: 1 }]);
  const [n, setN] = createSignal(0);
  render(() => <><button onClick={() => setN(n() + 1)}>b{n()}</button><table><tbody><For each={procs}>{(p) => <Row name={p.name} cpu={p.cpu} />}</For></tbody></table></>);
  expect(runs).toBe(2);
  setProcs(reconcile([{ pid: 1, name: 'init', cpu: 5 }, { pid: 2, name: 'sh', cpu: 1 }], { key: 'pid', merge: true }));
  expect(screen.getByTestId('cpu-init').textContent).toBe('5');
  fireEvent.click(screen.getByText('b0'));
  expect(screen.getByText('b1')).toBeTruthy();
  expect(runs).toBe(2);
});
