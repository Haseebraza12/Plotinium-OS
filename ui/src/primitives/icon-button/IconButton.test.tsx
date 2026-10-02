import { fireEvent, render, screen } from '@solidjs/testing-library';
import { describe, expect, it, vi } from 'vitest';

import { IconButton } from './IconButton.tsx';

describe('UI-IconButton', () => {
  it('UI-IconButton is named by its label, not its glyph', () => {
    render(() => <IconButton label="Back" icon={<svg />} />);
    expect(screen.getByRole('button', { name: 'Back' })).toBeTruthy();
  });

  it('UI-IconButton exposes aria-pressed when used as a toggle', () => {
    const onClick = vi.fn();
    render(() => <IconButton label="Ask AI" icon={<svg />} pressed onClick={onClick} />);
    const button = screen.getByRole('button', { name: 'Ask AI' });
    expect(button.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('UI-IconButton disabled does not fire', () => {
    const onClick = vi.fn();
    render(() => <IconButton label="Forward" icon={<svg />} disabled onClick={onClick} />);
    fireEvent.click(screen.getByRole('button', { name: 'Forward' }));
    expect(onClick).not.toHaveBeenCalled();
  });
});
