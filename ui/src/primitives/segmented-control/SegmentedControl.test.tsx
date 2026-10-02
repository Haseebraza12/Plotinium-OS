import { fireEvent, render, screen } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import { describe, expect, it, vi } from 'vitest';

import { SegmentedControl } from './SegmentedControl.tsx';

type Mode = 'write' | 'split' | 'preview';
const options = [
  { value: 'write', label: 'Write' },
  { value: 'split', label: 'Split' },
  { value: 'preview', label: 'Preview' },
] as const;

describe('UI-SegmentedControl', () => {
  it('UI-SegmentedControl is a radio group with one checked radio and one tab stop', () => {
    render(() => (
      <SegmentedControl
        label="Editor mode"
        options={options}
        value="split"
        onChange={() => undefined}
      />
    ));
    expect(screen.getByRole('radiogroup', { name: 'Editor mode' })).toBeTruthy();
    const split = screen.getByRole('radio', { name: 'Split' });
    expect(split.getAttribute('aria-checked')).toBe('true');
    expect(split.getAttribute('tabindex')).toBe('0');
    expect(screen.getByRole('radio', { name: 'Write' }).getAttribute('tabindex')).toBe('-1');
  });

  it('UI-SegmentedControl arrow keys move and select, wrapping at the ends', () => {
    const [mode, setMode] = createSignal<Mode>('preview');
    const onChange = vi.fn((m: Mode) => setMode(m));
    render(() => (
      <SegmentedControl label="Editor mode" options={options} value={mode()} onChange={onChange} />
    ));
    fireEvent.keyDown(screen.getByRole('radio', { name: 'Preview' }), { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith('write');
    fireEvent.keyDown(screen.getByRole('radio', { name: 'Write' }), { key: 'End' });
    expect(onChange).toHaveBeenLastCalledWith('preview');
    expect(screen.getByRole('radio', { name: 'Preview' }).getAttribute('aria-checked')).toBe(
      'true',
    );
  });

  it('UI-SegmentedControl click selects and publishes the sliding index', () => {
    const onChange = vi.fn();
    render(() => (
      <SegmentedControl label="View" options={options} value="write" onChange={onChange} />
    ));
    fireEvent.click(screen.getByRole('radio', { name: 'Preview' }));
    expect(onChange).toHaveBeenCalledWith('preview');
    expect(screen.getByRole('radiogroup').style.getPropertyValue('--pl-seg-index')).toBe('0');
  });
});
