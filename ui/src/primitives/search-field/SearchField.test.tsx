import { fireEvent, render, screen } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import { describe, expect, it, vi } from 'vitest';

import { SearchField } from './SearchField.tsx';

describe('UI-SearchField', () => {
  it('UI-SearchField is a labelled searchbox inside a search landmark', () => {
    render(() => (
      <SearchField
        label="Search in notes"
        value=""
        onInput={() => undefined}
        placeholder="Search"
      />
    ));
    expect(screen.getByRole('search')).toBeTruthy();
    expect(screen.getByRole('searchbox', { name: 'Search in notes' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Clear search' })).toBeNull();
  });

  it('UI-SearchField reports input, submits on Enter and clears on Escape', () => {
    const [q, setQ] = createSignal('');
    const onInput = vi.fn((v: string) => setQ(v));
    const onSubmit = vi.fn();
    render(() => <SearchField label="Search" value={q()} onInput={onInput} onSubmit={onSubmit} />);
    const box = screen.getByRole<HTMLInputElement>('searchbox');
    fireEvent.input(box, { target: { value: 'paging' } });
    expect(onInput).toHaveBeenLastCalledWith('paging');
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledWith('paging');
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(onInput).toHaveBeenLastCalledWith('');
    expect(box.value).toBe('');
  });

  it('UI-SearchField clear button empties the query', () => {
    const onInput = vi.fn();
    render(() => <SearchField label="Search" value="vfs" onInput={onInput} />);
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(onInput).toHaveBeenCalledWith('');
  });
});
