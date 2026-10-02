/**
 * Settings and About fixes of the polish wave (docs/design/bug-hunt/BUGS.md,
 * fix-apps-settings-a11y): UI-042, UI-141, UI-142, UI-143, UI-144, UI-146, UI-163, UI-164.
 */
import { cleanup, fireEvent, render, screen, within } from '@solidjs/testing-library';
import { describe, expect, it, vi } from 'vitest';

import { NOT_AVAILABLE, UNAVAILABLE_SETTINGS } from './availability.ts';
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
import type { SettingsSectionId, SettingsViewProps } from './index.ts';
import aboutCss from './panes/AboutPane.module.css?raw';
import { SettingsView } from './SettingsView.tsx';

function setup(initial: SettingsSectionId, overrides: Partial<SettingsViewProps> = {}) {
  const onChange = vi.fn<SettingsViewProps['onChange']>();
  const onAction = vi.fn<SettingsViewProps['onAction']>();
  render(() => (
    <SettingsView
      initialSection={initial}
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
      onAction={onAction}
      {...overrides}
    />
  ));
  return { onChange, onAction };
}

/** The accessible description of an element (its aria-describedby targets, joined). */
function description(el: HTMLElement): string {
  return (el.getAttribute('aria-describedby') ?? '')
    .split(' ')
    .map((id) => document.getElementById(id)?.textContent ?? '')
    .join(' ')
    .trim();
}

describe('UI-Settings polish', () => {
  it('UI-144 Settings and its theme control carry the test ids of SELECTORS.md', () => {
    setup('appearance');
    expect(document.querySelector('[data-testid="settings"]')).not.toBeNull();
    const theme = document.querySelector('[data-testid="theme-toggle"]');
    expect(theme?.getAttribute('role')).toBe('radiogroup');
    expect(theme?.getAttribute('aria-label')).toBe('Theme');
  });

  it('UI-042 controls nothing reads are disabled and say so', () => {
    const { onChange } = setup('general');
    const language = screen.getByRole('combobox', { name: /Language/u });
    expect(language.getAttribute('aria-disabled')).toBe('true');
    expect(description(language)).toBe(UNAVAILABLE_SETTINGS['general.language']);
    const name = screen.getByRole('textbox', { name: 'Device name' });
    expect(name).toHaveProperty('disabled', true);
    expect(screen.getByText(UNAVAILABLE_SETTINGS['general.deviceName'] ?? '')).toBeTruthy();
    fireEvent.click(language);
    expect(screen.queryByRole('listbox')).toBeNull();
    // The 24-hour clock is applied by the shell (UI-040) and stays enabled.
    const clock = screen.getByRole('switch', { name: '24-hour time' });
    expect(clock.getAttribute('aria-disabled')).toBeNull();
    fireEvent.click(clock);
    expect(onChange).toHaveBeenCalledWith({ key: 'general.clock24h', value: false });
  });

  it('UI-042 Dock suggestions, sync and update switches are disabled with the note', () => {
    for (const [section, label, note] of [
      ['desktop', 'Show suggested apps in the Dock', NOT_AVAILABLE],
      // Files do sync since UI-006; the note says so and that only the off switch is missing.
      ['network', 'Sync files', UNAVAILABLE_SETTINGS['sync.files']],
      ['network', 'Write paged-out memory to the server', NOT_AVAILABLE],
    ] as const) {
      const { onChange } = setup(section);
      const control = screen.getByRole('switch', { name: label });
      expect(control.getAttribute('aria-disabled'), label).toBe('true');
      expect(description(control), label).toBe(note);
      fireEvent.click(control);
      expect(onChange, label).not.toHaveBeenCalled();
      cleanup();
    }
  });

  it('UI-163 the section description opens the pane in full, not cut off in the toolbar', () => {
    setup('memory');
    const lede = screen.getByText(/^How much memory processes may hold/u);
    expect(lede.textContent).toBe(
      'How much memory processes may hold, and where paged-out memory goes.',
    );
    expect(lede.closest('header')).toBeNull();
    expect(lede.closest('main')).not.toBeNull();
  });
});

describe('UI-142 and UI-141 Privacy & AI', () => {
  it('UI-142 telemetry times are local, like the clock and the "oldest" date', () => {
    setup('privacy');
    const at = SAMPLE_PRIVACY.telemetry.rows[0]?.at ?? 0;
    const local = new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(at);
    const time = document.querySelector(`time[datetime="${new Date(at).toISOString()}"]`);
    expect(time?.textContent).toBe(local);
  });

  it('UI-141 no invented numbers: an unreported budget, a degraded agent, nothing pending', () => {
    setup('privacy', {
      privacy: {
        ...SAMPLE_PRIVACY,
        index: { ...SAMPLE_PRIVACY.index, indexed: 40, total: 40 },
        agent: { ...SAMPLE_PRIVACY.agent, usedCents: 0, capCents: 0, status: 'degraded' },
      },
    });
    expect(screen.queryByRole('meter', { name: 'Monthly agent budget' })).toBeNull();
    expect(screen.getByText('Not reported')).toBeTruthy();
    expect(screen.getByText('Degraded')).toBeTruthy();
    expect(screen.queryByText('0 chunks pending')).toBeNull();
    expect(screen.getByText('Checking for changes')).toBeTruthy();
  });

  it('UI-146 View all, Rebuild index and the server copy say when they cannot do more', () => {
    const { onAction } = setup('privacy', {
      values: { ...DEFAULT_VALUES, 'telemetry.sync': true },
      privacy: {
        ...SAMPLE_PRIVACY,
        telemetry: {
          ...SAMPLE_PRIVACY.telemetry,
          count: SAMPLE_PRIVACY.telemetry.rows.length,
          serverDeleteUnavailable: 'The copy on the server is kept.',
        },
        index: { ...SAMPLE_PRIVACY.index, rebuildUnavailable: 'Rebuilding is not available.' },
      },
    });
    const all = screen.getByRole('button', { name: 'All events shown' });
    expect(all.getAttribute('aria-disabled')).toBe('true');
    const rebuild = screen.getByRole('button', { name: 'Rebuild index' });
    expect(rebuild.getAttribute('aria-disabled')).toBe('true');
    expect(description(rebuild)).toBe('Rebuilding is not available.');
    fireEvent.click(rebuild);
    expect(screen.queryByRole('dialog', { name: 'Rebuild the index' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Clear telemetry' }));
    const dialog = screen.getByRole('alertdialog');
    expect(within(dialog).queryByRole('checkbox')).toBeNull();
    expect(within(dialog).getByText('The copy on the server is kept.')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Clear telemetry' }));
    expect(onAction).toHaveBeenCalledWith('telemetry.clear');
  });
});

describe('UI-141 and UI-146 Network, Updates and Users', () => {
  it('UI-141 online with sync degraded is "Sync unavailable", not a green Online', () => {
    setup('network', { network: { ...SAMPLE_NETWORK, status: 'degraded', lastSync: 'never' } });
    expect(screen.getByText('Sync unavailable')).toBeTruthy();
    expect(screen.queryByText('Online')).toBeNull();
  });

  it('UI-141 a failed update check never claims "up to date"', () => {
    setup('updates', {
      updates: { current: '0.3.0', lastChecked: 'at startup', state: 'error', error: 'Down.' },
    });
    expect(screen.queryByText(/is up to date/u)).toBeNull();
    expect(screen.getByText('Updates cannot be checked right now')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('Down.');
  });

  it('UI-146 account buttons are disabled and described by why', () => {
    const { onAction } = setup('users');
    for (const name of ['Change password…', 'Forget this device', 'Add user…']) {
      const button = screen.getByRole('button', { name });
      expect(button.getAttribute('aria-disabled'), name).toBe('true');
      expect(description(button), name).toContain('This build cannot change them');
      fireEvent.click(button);
    }
    expect(onAction).not.toHaveBeenCalled();
  });
});

describe('UI-143, UI-146 and UI-164 About', () => {
  it('UI-146 Licences lists the shipped software when the model carries it', () => {
    const { onAction } = setup('about', {
      about: {
        ...SAMPLE_ABOUT,
        licences: [{ name: 'SolidJS (solid-js)', licence: 'MIT', use: 'UI framework' }],
      },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Licences' }));
    const dialog = screen.getByRole('dialog', { name: 'Third-party software' });
    const rows = within(dialog).getAllByRole('row');
    expect(rows.map((r) => r.textContent)).toEqual([
      'ComponentLicenceUsed for',
      'SolidJS (solid-js)MITUI framework',
    ]);
    expect(onAction).not.toHaveBeenCalled();
  });

  it('UI-143 placeholder members get a neutral disc, not initials taken from the role', () => {
    setup('about');
    expect(screen.getAllByText('Member to be announced')).toHaveLength(5);
    expect(screen.queryByText('R', { selector: 'span' })).toBeNull();
  });

  it('UI-143 and UI-164 the About layout follows its own width; the old orbit CSS is gone', () => {
    expect(aboutCss).toMatch(/container: pl-about \/ inline-size;/u);
    expect(aboutCss).toMatch(/@container pl-about \(width < 720px\)/u);
    expect(aboutCss).not.toMatch(/@media \(width < 860px\)/u);
    expect(aboutCss).not.toMatch(/ellipse|stroke-width|rotate\(/u);
    expect(aboutCss).toMatch(/\.factText \{[^}]*overflow-wrap: anywhere;/u);
  });
});
