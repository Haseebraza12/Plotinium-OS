import { fireEvent, render, screen, within } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import { describe, expect, it, vi } from 'vitest';

import { sortRows, Table, type SortState, type TableColumn } from './Table.tsx';

interface Proc {
  pid: number;
  name: string;
  cpu: number;
}
const rows: readonly Proc[] = [
  { pid: 1, name: 'init', cpu: 0.1 },
  { pid: 23, name: 'ai.indexer', cpu: 9.6 },
  { pid: 7, name: 'vfs', cpu: 2.4 },
  { pid: 12, name: 'synced', cpu: 0.9 },
];
const columns: readonly TableColumn<Proc>[] = [
  {
    id: 'pid',
    header: 'PID',
    cell: (r) => r.pid,
    sortValue: (r) => r.pid,
    width: '56px',
    align: 'end',
  },
  { id: 'name', header: 'Name', cell: (r) => r.name, sortValue: (r) => r.name, mono: true },
  { id: 'cpu', header: 'CPU', cell: (r) => `${r.cpu}%`, sortValue: (r) => r.cpu, align: 'end' },
];

function Harness(props: {
  onActivate?: (p: Proc) => void;
  onSelection?: (s: ReadonlySet<string>) => void;
}) {
  const [sort, setSort] = createSignal<SortState>({ column: 'pid', direction: 'ascending' });
  const [selected, setSelected] = createSignal<ReadonlySet<string>>(new Set());
  return (
    <Table
      label="Processes"
      columns={columns}
      rows={rows}
      rowId={(r) => String(r.pid)}
      sort={sort()}
      onSortChange={setSort}
      selectionMode="multiple"
      selected={selected()}
      onSelectionChange={(s) => {
        props.onSelection?.(s);
        setSelected(s);
      }}
      onActivate={(r) => props.onActivate?.(r)}
    />
  );
}

const bodyNames = (): string[] =>
  screen
    .getAllByRole('row')
    .slice(1)
    .map((r) => within(r).getAllByRole('gridcell')[1]?.textContent ?? '');

describe('UI-Table', () => {
  it('UI-Table sortRows is stable and numeric-aware', () => {
    const byName = sortRows(rows, columns[1], 'ascending').map((r) => r.name);
    expect(byName).toEqual(['ai.indexer', 'init', 'synced', 'vfs']);
    expect(sortRows(rows, columns[2], 'descending')[0]?.name).toBe('ai.indexer');
  });

  it('UI-Table renders a grid with sortable column headers and aria-sort', () => {
    render(() => <Harness />);
    const grid = screen.getByRole('grid', { name: 'Processes' });
    expect(grid.getAttribute('aria-multiselectable')).toBe('true');
    expect(screen.getByRole('columnheader', { name: /PID/ }).getAttribute('aria-sort')).toBe(
      'ascending',
    );
    expect(bodyNames()).toEqual(['init', 'vfs', 'synced', 'ai.indexer']);
    fireEvent.click(screen.getByRole('button', { name: 'CPU' }));
    expect(screen.getByRole('columnheader', { name: /CPU/ }).getAttribute('aria-sort')).toBe(
      'ascending',
    );
    fireEvent.click(screen.getByRole('button', { name: 'CPU' }));
    expect(screen.getByRole('columnheader', { name: /CPU/ }).getAttribute('aria-sort')).toBe(
      'descending',
    );
    expect(bodyNames()[0]).toBe('ai.indexer');
  });

  it('UI-Table click, Ctrl-click and Shift-click select rows', () => {
    const onSelection = vi.fn();
    render(() => <Harness onSelection={onSelection} />);
    const body = screen.getAllByRole('row').slice(1);
    fireEvent.click(body[0] as HTMLElement);
    expect([...(onSelection.mock.lastCall?.[0] as Set<string>)]).toEqual(['1']);
    fireEvent.click(body[2] as HTMLElement, { ctrlKey: true });
    expect([...(onSelection.mock.lastCall?.[0] as Set<string>)].sort()).toEqual(['1', '12']);
    fireEvent.click(body[3] as HTMLElement, { shiftKey: true });
    expect([...(onSelection.mock.lastCall?.[0] as Set<string>)].sort()).toEqual(['12', '23']);
    expect(body[3]?.getAttribute('aria-selected')).toBe('true');
  });

  it('UI-Table arrows move selection, Shift extends, Ctrl+A selects all, Enter activates', () => {
    const onActivate = vi.fn();
    const onSelection = vi.fn();
    render(() => <Harness onActivate={onActivate} onSelection={onSelection} />);
    const first = screen.getAllByRole('row')[1] as HTMLElement;
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowDown' });
    expect([...(onSelection.mock.lastCall?.[0] as Set<string>)]).toEqual(['7']);
    expect(document.activeElement?.getAttribute('data-row-id')).toBe('7');
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowDown', shiftKey: true });
    expect([...(onSelection.mock.lastCall?.[0] as Set<string>)].sort()).toEqual(['12', '7']);
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'a', ctrlKey: true });
    expect((onSelection.mock.lastCall?.[0] as Set<string>).size).toBe(4);
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Enter' });
    expect(onActivate).toHaveBeenCalledWith(rows[3]);
  });
});
