import { fireEvent, render, screen } from '@solidjs/testing-library';
import { describe, expect, it, vi } from 'vitest';

import { Button } from './Button.tsx';

describe('UI-Button', () => {
  it('UI-Button renders a native button with type=button and its label', () => {
    render(() => <Button>Save</Button>);
    const button = screen.getByRole('button', { name: 'Save' });
    expect(button.getAttribute('type')).toBe('button');
  });

  it('UI-Button calls onClick when pressed', () => {
    const onClick = vi.fn();
    render(() => (
      <Button variant="primary" onClick={onClick}>
        Run plan
      </Button>
    ));
    fireEvent.click(screen.getByRole('button', { name: 'Run plan' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('UI-Button disabled stays focusable, is aria-disabled and swallows clicks', () => {
    const onClick = vi.fn();
    render(() => (
      <Button disabled onClick={onClick}>
        Clear
      </Button>
    ));
    const button = screen.getByRole('button', { name: 'Clear' });
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.hasAttribute('disabled')).toBe(false);
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('UI-Button keeps icons out of the accessible name', () => {
    render(() => <Button icon={<svg data-testid="icon" />}>Export</Button>);
    expect(screen.getByTestId('icon').parentElement?.getAttribute('aria-hidden')).toBe('true');
    expect(screen.getByRole('button', { name: 'Export' })).toBeTruthy();
  });
});
