import { render, screen } from '@solidjs/testing-library';
import { describe, expect, it } from 'vitest';

import { Avatar, colourSlotOf, initialsOf } from './Avatar.tsx';

describe('UI-Avatar', () => {
  it('UI-Avatar derives initials and a stable colour slot', () => {
    expect(initialsOf('student')).toBe('S');
    expect(initialsOf('Ada Lovelace')).toBe('AL');
    expect(initialsOf('  ')).toBe('?');
    expect(colourSlotOf('alice')).toBe(colourSlotOf('alice'));
  });

  it('DSN-08 UI-Avatar puts the presence status in the accessible name', () => {
    render(() => <Avatar name="alice" status="online" />);
    expect(screen.getByRole('img', { name: 'alice, online' }).textContent).toBe('A');
  });

  it('UI-Avatar decorative avatars are hidden from assistive tech', () => {
    const { container } = render(() => <Avatar name="bob" decorative />);
    expect(container.firstElementChild?.getAttribute('aria-hidden')).toBe('true');
  });
});
