import { fireEvent, render, screen } from '@solidjs/testing-library';
import { describe, expect, it, vi } from 'vitest';

import { Slider } from './Slider.tsx';

describe('UI-Slider', () => {
  it('UI-Slider is a labelled slider with a spoken value text', () => {
    render(() => (
      <Slider
        label="Memory budget"
        value={128}
        min={64}
        max={512}
        format={(v) => `${v} MB`}
        onInput={() => undefined}
      />
    ));
    const slider = screen.getByRole('slider', { name: 'Memory budget' });
    expect(slider.getAttribute('aria-valuetext')).toBe('128 MB');
    expect(slider.style.getPropertyValue('--pl-slider-pct')).toBe(
      `${((128 - 64) / (512 - 64)) * 100}%`,
    );
  });

  it('UI-Slider emits numeric input and commit values', () => {
    const onInput = vi.fn();
    const onCommit = vi.fn();
    render(() => <Slider label="Volume" value={40} onInput={onInput} onCommit={onCommit} />);
    const slider = screen.getByRole('slider', { name: 'Volume' });
    fireEvent.input(slider, { target: { value: '55' } });
    expect(onInput).toHaveBeenCalledWith(55);
    fireEvent.change(slider, { target: { value: '60' } });
    expect(onCommit).toHaveBeenCalledWith(60);
  });
});
