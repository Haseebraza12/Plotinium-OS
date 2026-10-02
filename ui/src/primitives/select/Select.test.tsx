import { fireEvent, render, screen } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import { describe, expect, it, vi } from 'vitest';

import { Select } from './Select.tsx';

type Size = 'small' | 'medium' | 'large';
const options = [
  { value: 'small', label: 'Small' },
  { value: 'medium', label: 'Medium' },
  { value: 'large', label: 'Large', disabled: true },
] as const;

function Harness(props: { onChange?: (v: Size) => void }) {
  const [value, setValue] = createSignal<Size>('medium');
  return (
    <Select
      label="Sidebar icon size"
      value={value()}
      options={options}
      onChange={(v) => {
        props.onChange?.(v);
        setValue(v);
      }}
    />
  );
}

describe('UI-Select', () => {
  it('UI-Select is a combobox named by its label and current value', () => {
    render(() => <Harness />);
    const combo = screen.getByRole('combobox');
    expect(combo.getAttribute('aria-expanded')).toBe('false');
    expect(combo.getAttribute('aria-haspopup')).toBe('listbox');
    expect(combo.textContent).toContain('Medium');
    expect(screen.getByRole('combobox', { name: 'Sidebar icon size Medium' })).toBeTruthy();
  });

  it('UI-Select opens with ArrowDown, marks the selected option active and keeps focus on the button', () => {
    render(() => <Harness />);
    const combo = screen.getByRole('combobox');
    combo.focus();
    fireEvent.keyDown(combo, { key: 'ArrowDown' });
    expect(combo.getAttribute('aria-expanded')).toBe('true');
    const listbox = screen.getByRole('listbox');
    expect(listbox).toBeTruthy();
    const activeId = combo.getAttribute('aria-activedescendant') ?? '';
    expect(document.getElementById(activeId)?.textContent).toBe('Medium');
    expect(document.activeElement).toBe(combo);
  });

  it('UI-Select arrows skip disabled options; Enter chooses and closes', () => {
    const onChange = vi.fn();
    render(() => <Harness onChange={onChange} />);
    const combo = screen.getByRole('combobox');
    fireEvent.keyDown(combo, { key: 'Enter' });
    fireEvent.keyDown(combo, { key: 'ArrowDown' });
    fireEvent.keyDown(combo, { key: 'ArrowUp' });
    fireEvent.keyDown(combo, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('small');
    expect(combo.getAttribute('aria-expanded')).toBe('false');
  });

  it('UI-Select clicking an option chooses it; type-ahead works while closed', () => {
    const onChange = vi.fn();
    render(() => <Harness onChange={onChange} />);
    const combo = screen.getByRole('combobox');
    fireEvent.click(combo);
    fireEvent.click(screen.getByRole('option', { name: 'Small' }));
    expect(onChange).toHaveBeenLastCalledWith('small');
    fireEvent.keyDown(combo, { key: 'm' });
    expect(onChange).toHaveBeenLastCalledWith('medium');
  });
});
