import { render, screen } from '@solidjs/testing-library';
import { describe, expect, it } from 'vitest';

import { ProgressBar } from './ProgressBar.tsx';
import { ProgressRing } from './ProgressRing.tsx';

describe('UI-ProgressBar', () => {
  it('BOOT-13 UI-ProgressBar exposes role=progressbar with live values and a text value', () => {
    render(() => (
      <ProgressBar
        label="Index status"
        value={3118}
        max={3530}
        valueText="3,118 of 3,530 chunks"
        showValue
      />
    ));
    const bar = screen.getByRole('progressbar', { name: 'Index status' });
    expect(bar.getAttribute('aria-valuenow')).toBe('3118');
    expect(bar.getAttribute('aria-valuemax')).toBe('3530');
    expect(bar.getAttribute('aria-valuetext')).toBe('3,118 of 3,530 chunks');
  });

  it('UI-ProgressBar scales the fill with transform, clamped to 0..1', () => {
    const { container } = render(() => <ProgressBar label="Restore" value={150} />);
    const fill = container.querySelector<HTMLElement>('[role="progressbar"] > div');
    expect(fill?.style.getPropertyValue('--pl-progress-ratio')).toBe('1');
    expect(screen.getByRole('progressbar').getAttribute('aria-valuetext')).toBe('100%');
  });

  it('UI-ProgressBar sweep adds the bounded sheen animation class', () => {
    const { container } = render(() => <ProgressBar label="Boot" value={40} sweep hideLabel />);
    expect(container.querySelector('.pl-anim-progress-sweep')).not.toBeNull();
  });
});

describe('UI-ProgressRing', () => {
  it('UI-ProgressRing is a progressbar whose arc offset tracks the value', () => {
    const { container } = render(() => (
      <ProgressRing label="Memory" value={50} size={40} thickness={4} showValue />
    ));
    const ring = screen.getByRole('progressbar', { name: 'Memory' });
    expect(ring.getAttribute('aria-valuetext')).toBe('50%');
    const arc = container.querySelectorAll('circle')[1];
    const c = 2 * Math.PI * 18;
    expect(Number(arc?.getAttribute('stroke-dashoffset'))).toBeCloseTo(c / 2, 5);
  });
});
