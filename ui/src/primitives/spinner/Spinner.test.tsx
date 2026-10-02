import { render, screen } from '@solidjs/testing-library';
import { describe, expect, it } from 'vitest';

import { Spinner } from './Spinner.tsx';

describe('UI-Spinner', () => {
  it('UI-Spinner is a polite status carrying its label as text', () => {
    render(() => <Spinner label="Asking the agent" />);
    const status = screen.getByRole('status');
    expect(status.textContent).toBe('Asking the agent');
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(status.querySelectorAll('rect')).toHaveLength(12);
  });
});
