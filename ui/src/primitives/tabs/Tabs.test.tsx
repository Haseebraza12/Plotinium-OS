import { fireEvent, render, screen } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import { describe, expect, it } from 'vitest';

import { Tabs } from './Tabs.tsx';

type Tab = 'processes' | 'memory' | 'predictions';
const tabs = [
  { id: 'processes', label: 'Processes', count: 42 },
  { id: 'memory', label: 'Memory' },
  { id: 'predictions', label: 'Predictions' },
] as const;

function Harness(props: { variant?: 'segmented' | 'underline' }) {
  const [tab, setTab] = createSignal<Tab>('processes');
  return (
    <Tabs
      label="Task Manager views"
      tabs={tabs}
      selected={tab()}
      onChange={setTab}
      variant={props.variant}
    >
      {(id) => <p>Panel {id}</p>}
    </Tabs>
  );
}

describe('UI-Tabs', () => {
  it('UI-Tabs exposes tablist, tabs and a panel labelled by the selected tab', () => {
    render(() => <Harness />);
    expect(screen.getByRole('tablist', { name: 'Task Manager views' })).toBeTruthy();
    const selected = screen.getByRole('tab', { selected: true });
    expect(selected.textContent).toContain('Processes');
    const panel = screen.getByRole('tabpanel');
    expect(panel.getAttribute('aria-labelledby')).toBe(selected.id);
    expect(panel.textContent).toBe('Panel processes');
  });

  it('UI-Tabs arrow keys activate the next tab and wrap; Home/End jump', () => {
    render(() => <Harness variant="underline" />);
    const first = screen.getByRole('tab', { name: /Processes/ });
    fireEvent.keyDown(first, { key: 'ArrowRight' });
    expect(screen.getByRole('tabpanel').textContent).toBe('Panel memory');
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'End' });
    expect(screen.getByRole('tab', { selected: true }).textContent).toContain('Predictions');
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowRight' });
    expect(screen.getByRole('tabpanel').textContent).toBe('Panel processes');
    expect(document.activeElement?.textContent).toContain('Processes');
  });
});
