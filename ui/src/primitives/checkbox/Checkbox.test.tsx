import { fireEvent, render, screen } from '@solidjs/testing-library';
import { describe, expect, it, vi } from 'vitest';

import { Checkbox } from './Checkbox.tsx';

describe('UI-Checkbox', () => {
  it('UI-Checkbox is a labelled native checkbox', () => {
    render(() => <Checkbox checked onChange={() => undefined} label="Show hidden files" />);
    const box = screen.getByRole<HTMLInputElement>('checkbox', { name: 'Show hidden files' });
    expect(box.checked).toBe(true);
  });

  it('UI-Checkbox reports the next state on change', () => {
    const onChange = vi.fn();
    render(() => <Checkbox checked={false} onChange={onChange} label="Include .trash" />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Include .trash' }));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('UI-Checkbox sets the indeterminate DOM property for a mixed state', () => {
    render(() => (
      <Checkbox checked={false} indeterminate onChange={() => undefined} label="Select all" />
    ));
    const box = screen.getByRole<HTMLInputElement>('checkbox', { name: 'Select all' });
    expect(box.indeterminate).toBe(true);
  });
});
