import { render, screen } from '@solidjs/testing-library';
import { describe, expect, it } from 'vitest';

import { Badge, Pill } from './Badge.tsx';

describe('UI-Badge', () => {
  it('UI-Badge speaks its label and caps the visible number', () => {
    render(() => <Badge count={120} label="120 unread notifications" />);
    const badge = screen.getByRole('status', { name: '120 unread notifications' });
    expect(badge.textContent).toBe('99+');
  });

  it('UI-Badge renders nothing for a zero count', () => {
    const { container } = render(() => <Badge count={0} label="No updates" />);
    expect(container.textContent).toBe('');
  });

  it('DSN-08 UI-Pill always carries text next to its colour and dot', () => {
    render(() => (
      <Pill tone="success" dot>
        Connected
      </Pill>
    ));
    expect(screen.getByText('Connected')).toBeTruthy();
  });
});
