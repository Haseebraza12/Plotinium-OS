/**
 * UI-163: Settings › General accepted an empty device name. The field is disabled in this build
 * (UI-042: nothing reads the name yet), so this test turns the availability note off to reach the
 * commit path that a build with a consumer will use: an empty or blank name is refused, the saved
 * name comes back and the field says why, as an error tied to the input.
 */
import { fireEvent, render, screen } from '@solidjs/testing-library';
import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_VALUES,
  SAMPLE_ABOUT,
  SAMPLE_BOUND,
  SAMPLE_MEMORY_STATUS,
  SAMPLE_NETWORK,
  SAMPLE_PRIVACY,
  SAMPLE_STORAGE,
  SAMPLE_UPDATES,
  SAMPLE_USER,
  SAMPLE_USERS,
} from './fixtures.ts';
import type * as Availability from './availability.ts';
import type { SettingsViewProps } from './index.ts';
import { SettingsView } from './SettingsView.tsx';

vi.mock('./availability.ts', async (importOriginal) => {
  const real = await importOriginal<typeof Availability>();
  return {
    ...real,
    unavailableNote: (key: Parameters<typeof real.unavailableNote>[0]) =>
      key === 'general.deviceName' ? undefined : real.unavailableNote(key),
  };
});

function setup() {
  const onChange = vi.fn<SettingsViewProps['onChange']>();
  render(() => (
    <SettingsView
      initialSection="general"
      user={SAMPLE_USER}
      values={DEFAULT_VALUES}
      about={SAMPLE_ABOUT}
      privacy={SAMPLE_PRIVACY}
      network={SAMPLE_NETWORK}
      users={SAMPLE_USERS}
      storage={SAMPLE_STORAGE}
      updates={SAMPLE_UPDATES}
      memory={SAMPLE_MEMORY_STATUS}
      bound={SAMPLE_BOUND}
      onChange={onChange}
      onAction={vi.fn()}
    />
  ));
  return {
    onChange,
    field: screen.getByRole<HTMLInputElement>('textbox', { name: 'Device name' }),
  };
}

describe('UI-163 device name', () => {
  it('UI-163 a blank name is refused on blur: the saved name returns with a reason', () => {
    const { onChange, field } = setup();
    const saved = DEFAULT_VALUES['general.deviceName'];
    expect(field.disabled).toBe(false);
    fireEvent.input(field, { target: { value: '   ' } });
    fireEvent.blur(field);
    expect(onChange).not.toHaveBeenCalled();
    expect(field.value).toBe(saved);
    expect(field.getAttribute('aria-invalid')).toBe('true');
    const errorId = (field.getAttribute('aria-describedby') ?? '')
      .split(' ')
      .find((id) => id.endsWith('-error'));
    expect(document.getElementById(errorId ?? '')?.textContent).toMatch(
      /The device needs a name\. The previous name was kept\./u,
    );
  });

  it('UI-163 a real name is saved trimmed on Enter and clears the error', () => {
    const { onChange, field } = setup();
    fireEvent.input(field, { target: { value: '' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(field.getAttribute('aria-invalid')).toBe('true');
    fireEvent.input(field, { target: { value: '  Lab PC 3  ' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith({ key: 'general.deviceName', value: 'Lab PC 3' });
    expect(field.getAttribute('aria-invalid')).toBeNull();
  });
});
