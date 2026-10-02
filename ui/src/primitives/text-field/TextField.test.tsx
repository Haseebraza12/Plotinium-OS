import { fireEvent, render, screen } from '@solidjs/testing-library';
import { describe, expect, it, vi } from 'vitest';

import { TextField } from './TextField.tsx';

describe('UI-TextField', () => {
  it('UI-TextField labels the input and links the hint', () => {
    render(() => (
      <TextField
        label="User name"
        value=""
        onInput={() => undefined}
        hint="Lower case, 3 to 32 characters."
      />
    ));
    const input = screen.getByRole('textbox', { name: 'User name' });
    const hintId = input.getAttribute('aria-describedby') ?? '';
    expect(document.getElementById(hintId)?.textContent).toContain('Lower case');
  });

  it('UI-TextField error sets aria-invalid and is described in text', () => {
    render(() => (
      <TextField
        label="Password"
        type="password"
        value="x"
        onInput={() => undefined}
        error="Incorrect password."
      />
    ));
    const input = screen.getByLabelText('Password');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    const ids = (input.getAttribute('aria-describedby') ?? '').split(' ');
    expect(
      ids.some(
        (i) => document.getElementById(i)?.textContent?.includes('Incorrect password.') === true,
      ),
    ).toBe(true);
  });

  it('UI-TextField emits each input value', () => {
    const onInput = vi.fn();
    render(() => <TextField label="Name" value="" onInput={onInput} />);
    fireEvent.input(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'lab3' } });
    expect(onInput).toHaveBeenCalledWith('lab3');
  });
});
