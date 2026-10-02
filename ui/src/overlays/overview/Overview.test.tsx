import { fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import { describe, expect, it, vi } from 'vitest';

import {
  flipFrom,
  Overview,
  overviewColumns,
  type OverviewProps,
  type OverviewWindow,
} from './Overview.tsx';

const WINDOWS: readonly OverviewWindow[] = [
  { id: 'files', title: 'Files — notes', app: 'files', appName: 'Files', aspect: 1.6 },
  { id: 'term', title: 'Terminal — ~', app: 'terminal', appName: 'Terminal', aspect: 1.5 },
  { id: 'editor', title: 'Editor — os-report.md', app: 'editor', appName: 'Editor', aspect: 1.5 },
  {
    id: 'tasks',
    title: 'Task Manager',
    app: 'task-manager',
    appName: 'Task Manager',
    aspect: 1.9,
    state: 'minimised',
  },
  { id: 'settings', title: 'Settings — About', app: 'settings', appName: 'Settings', aspect: 1.9 },
];

function Harness(props: { overrides?: Partial<OverviewProps> }) {
  const [selected, setSelected] = createSignal<string>('term');
  return (
    <Overview
      open
      windows={WINDOWS}
      selectedId={selected()}
      onSelect={setSelected}
      onPick={() => undefined}
      onCancel={() => undefined}
      onCloseWindow={() => undefined}
      {...props.overrides}
    />
  );
}

const selectedOption = (): HTMLElement => screen.getByRole('option', { selected: true });

describe('UI-Overview', () => {
  it('WM-07 Overview is a modal dialog with a listbox of windows; focus lands on the highlight', async () => {
    render(() => <Harness />);
    expect(screen.getByRole('dialog', { name: 'Overview' }).getAttribute('aria-modal')).toBe(
      'true',
    );
    const grid = screen.getByRole('listbox', { name: 'Open windows' });
    expect(grid.querySelectorAll('[role="option"]')).toHaveLength(5);
    await waitFor(() => expect(document.activeElement).toBe(selectedOption()));
    expect(selectedOption().getAttribute('aria-label')).toBe('Terminal — ~, Terminal, running');
    expect(
      screen.getByRole('option', { name: 'Task Manager, Task Manager, minimised' }),
    ).toBeTruthy();
  });

  it('WM-07 arrow keys move in two dimensions, Enter picks, Delete closes', async () => {
    const onPick = vi.fn();
    const onCloseWindow = vi.fn();
    render(() => <Harness overrides={{ onPick, onCloseWindow }} />);
    const grid = screen.getByRole('listbox');
    await waitFor(() => expect(document.activeElement).toBe(selectedOption()));
    fireEvent.keyDown(grid, { key: 'ArrowRight' });
    expect(selectedOption().getAttribute('aria-label')).toContain('Editor');
    fireEvent.keyDown(grid, { key: 'ArrowDown' });
    expect(selectedOption().getAttribute('aria-label')).toContain('Settings');
    fireEvent.keyDown(grid, { key: 'ArrowUp' });
    fireEvent.keyDown(grid, { key: 'Home' });
    expect(selectedOption().getAttribute('aria-label')).toContain('Files');
    fireEvent.keyDown(grid, { key: 'Enter' });
    expect(onPick).toHaveBeenCalledWith('files');
    fireEvent.keyDown(grid, { key: 'Delete' });
    expect(onCloseWindow).toHaveBeenCalledWith('files');
    fireEvent.keyDown(grid, { key: 'q', altKey: true });
    expect(onCloseWindow).toHaveBeenCalledTimes(2);
  });

  it('WM-07 Escape and a backdrop click cancel; a click picks a window', () => {
    const onCancel = vi.fn();
    const onPick = vi.fn();
    render(() => <Harness overrides={{ onCancel, onPick }} />);
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
    const backdrop = screen.getByRole('dialog').firstElementChild;
    fireEvent.click(backdrop as Element);
    expect(onCancel).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole('option', { name: /^Editor/u }));
    expect(onPick).toHaveBeenCalledWith('editor');
  });

  it('UI-Overview the empty state offers Terminal and Files', () => {
    const onLaunch = vi.fn();
    render(() => <Harness overrides={{ windows: [], onLaunch }} />);
    expect(screen.getByText('No open windows')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open Terminal' }));
    expect(onLaunch).toHaveBeenCalledWith('terminal');
  });

  it('UI-Overview the desktops strip is a tablist with an add button limited to four', () => {
    const onAddDesktop = vi.fn();
    render(() => (
      <Harness
        overrides={{
          desktops: [
            { id: 'd1', name: 'Desktop 1', active: true },
            { id: 'd2', name: 'Desktop 2' },
          ],
          onAddDesktop,
          maxDesktops: 2,
        }}
      />
    ));
    expect(screen.getByRole('tablist', { name: 'Desktops' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Desktop 1' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    const add = screen.getByRole('button', { name: 'Add desktop' });
    expect(add.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(add);
    expect(onAddDesktop).not.toHaveBeenCalled();
  });

  it('WM-03 the zoom is a FLIP computed once from the window and slot rectangles', () => {
    expect(
      flipFrom(
        { x: 100, y: 80, width: 800, height: 500 },
        { x: 500, y: 300, width: 400, height: 250 },
      ),
    ).toEqual({
      x: -400,
      y: -220,
      sx: 2,
      sy: 2,
    });
    expect([1, 3, 4, 5, 8, 10].map(overviewColumns)).toEqual([1, 3, 2, 3, 4, 4]);
  });
});
