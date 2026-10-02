import { fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import { describe, expect, it, vi } from 'vitest';

import { AppSwitcher, spokenSwitcherItem, type SwitcherItem } from './AppSwitcher.tsx';

const ITEMS: readonly SwitcherItem[] = [
  { id: 'w1', title: 'Files — notes', app: 'files', appName: 'Files' },
  { id: 'w2', title: 'Terminal — ~', app: 'terminal', appName: 'Terminal' },
  { id: 'w3', title: 'Editor — os-report.md', app: 'editor', appName: 'Editor' },
  {
    id: 'w4',
    title: 'Task Manager',
    app: 'task-manager',
    appName: 'Task Manager',
    state: 'minimised',
  },
  { id: 'w5', title: 'Settings — About', app: 'settings', appName: 'Settings' },
];

function Harness(props: { onCommit?: (id: string) => void; onCancel?: () => void }) {
  const [selected, setSelected] = createSignal<string>('w2');
  return (
    <AppSwitcher
      open
      items={ITEMS}
      selectedId={selected()}
      onHighlight={setSelected}
      onCommit={(id) => props.onCommit?.(id)}
      onCancel={() => props.onCancel?.()}
    />
  );
}

describe('UI-AppSwitcher', () => {
  it('WM-07 the switcher is a listbox announced on open with the highlighted window', async () => {
    render(() => <Harness />);
    const listbox = screen.getByRole('listbox', { name: 'Switch window' });
    await waitFor(() => expect(document.activeElement).toBe(listbox));
    const active = document.getElementById(listbox.getAttribute('aria-activedescendant') ?? '');
    expect(active?.getAttribute('aria-label')).toBe('Terminal — ~, Terminal, 2 of 5');
    expect(screen.getByRole('status').textContent).toBe('Switch window: Terminal — ~, 2 of 5');
    expect(screen.getAllByRole('option')).toHaveLength(5);
  });

  it('WM-07 Alt+` and Alt+Shift+` cycle; arrows move; releasing Alt commits', () => {
    const onCommit = vi.fn();
    render(() => <Harness onCommit={onCommit} />);
    const listbox = screen.getByRole('listbox');
    fireEvent.keyDown(listbox, { key: '`', altKey: true });
    expect(screen.getByRole('option', { selected: true }).getAttribute('aria-label')).toContain(
      'Editor — os-report.md',
    );
    fireEvent.keyDown(listbox, { key: '`', altKey: true, shiftKey: true });
    fireEvent.keyDown(listbox, { key: 'ArrowLeft' });
    expect(screen.getByRole('option', { selected: true }).getAttribute('aria-label')).toContain(
      'Files — notes',
    );
    fireEvent.keyDown(listbox, { key: 'ArrowLeft' });
    expect(screen.getByRole('option', { selected: true }).getAttribute('aria-label')).toContain(
      'Settings — About',
    );
    fireEvent.keyUp(listbox, { key: 'Alt' });
    expect(onCommit).toHaveBeenCalledWith('w5');
  });

  it('WM-07 Escape cancels and a click commits a window', () => {
    const onCommit = vi.fn();
    const onCancel = vi.fn();
    render(() => <Harness onCommit={onCommit} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole('option', { name: /^Task Manager/u }));
    expect(onCommit).toHaveBeenCalledWith('w4');
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' });
    expect(onCancel).toHaveBeenCalled();
  });

  it('UI-AppSwitcher options carry their state in words', () => {
    expect(spokenSwitcherItem(ITEMS[3] as SwitcherItem, 3, 5)).toBe(
      'Task Manager, Task Manager, 4 of 5, minimised',
    );
  });
});
