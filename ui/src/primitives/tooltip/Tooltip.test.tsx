import { fireEvent, render, screen } from '@solidjs/testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Tooltip } from './Tooltip.tsx';

describe('UI-Tooltip', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('UI-Tooltip describes its trigger with the tooltip text', () => {
    render(() => (
      <Tooltip content="Search in notes (Ctrl F)">
        <button>Search</button>
      </Tooltip>
    ));
    const button = screen.getByRole('button', { name: 'Search' });
    const id = button.getAttribute('aria-describedby') ?? '';
    expect(document.getElementById(id)?.textContent).toBe('Search in notes (Ctrl F)');
  });

  it('UI-Tooltip appears after the hover delay and Escape dismisses it', () => {
    render(() => (
      <Tooltip content="Files" delay={400} describe={false} prominent>
        <button>Files</button>
      </Tooltip>
    ));
    const wrapper = screen.getByRole('button', { name: 'Files' }).parentElement as HTMLElement;
    fireEvent.pointerEnter(wrapper);
    expect(screen.queryByRole('tooltip', { hidden: true })).toBeNull();
    vi.advanceTimersByTime(450);
    expect(screen.getByRole('tooltip', { hidden: true }).textContent).toBe('Files');
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByRole('tooltip', { hidden: true })).toBeNull();
  });

  it('UI-Tooltip stays while the pointer moves onto it (WCAG 1.4.13 hoverable)', () => {
    render(() => (
      <Tooltip content="Kernel confirmation" delay={0}>
        <button>Lock</button>
      </Tooltip>
    ));
    const wrapper = screen.getByRole('button', { name: 'Lock' }).parentElement as HTMLElement;
    fireEvent.pointerEnter(wrapper);
    vi.advanceTimersByTime(10);
    const tip = screen.getByRole('tooltip', { hidden: true });
    fireEvent.pointerLeave(wrapper);
    fireEvent.pointerEnter(tip);
    vi.advanceTimersByTime(500);
    expect(screen.queryByRole('tooltip', { hidden: true })).not.toBeNull();
  });
});
