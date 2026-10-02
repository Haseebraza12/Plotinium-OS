import { fireEvent, render, screen } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import { describe, expect, it, vi } from 'vitest';

import { Toggle } from './Toggle.tsx';

describe('UI-Toggle', () => {
  it('UI-Toggle is a named switch with aria-checked and a description', () => {
    render(() => (
      <Toggle
        checked={false}
        onChange={() => undefined}
        label="Reduce motion"
        description="Also stops the dock bounce."
      />
    ));
    const sw = screen.getByRole('switch', { name: 'Reduce motion' });
    expect(sw.getAttribute('aria-checked')).toBe('false');
    expect(sw.getAttribute('aria-describedby')).toBeTruthy();
  });

  it('UI-Toggle toggles once per click and reflects the new state', () => {
    const [on, setOn] = createSignal(false);
    const onChange = vi.fn((next: boolean) => setOn(next));
    render(() => <Toggle checked={on()} onChange={onChange} label="Sync telemetry" />);
    const sw = screen.getByRole('switch', { name: 'Sync telemetry' });
    fireEvent.click(sw);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(true);
    expect(sw.getAttribute('aria-checked')).toBe('true');
  });

  it('UI-Toggle disabled ignores activation', () => {
    const onChange = vi.fn();
    render(() => <Toggle checked onChange={onChange} label="Keep telemetry" disabled />);
    fireEvent.click(screen.getByRole('switch', { name: 'Keep telemetry' }));
    expect(onChange).not.toHaveBeenCalled();
  });
});
