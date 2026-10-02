import { fireEvent, render, screen, within } from '@solidjs/testing-library';
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
import type { SettingsSectionId, SettingsUser } from './models.ts';
import { searchSections, SECTIONS } from './sections.ts';
import { SettingsView, type SettingsViewProps } from './SettingsView.tsx';

function setup(
  options: { initial?: SettingsSectionId; user?: SettingsUser; aiAvailable?: boolean } = {},
) {
  const onChange = vi.fn<SettingsViewProps['onChange']>();
  const onAction = vi.fn<SettingsViewProps['onAction']>();
  const onCopy = vi.fn<NonNullable<SettingsViewProps['onCopy']>>();
  render(() => (
    <SettingsView
      initialSection={options.initial}
      user={options.user ?? SAMPLE_USER}
      values={DEFAULT_VALUES}
      about={SAMPLE_ABOUT}
      privacy={SAMPLE_PRIVACY}
      network={SAMPLE_NETWORK}
      users={SAMPLE_USERS}
      storage={SAMPLE_STORAGE}
      updates={SAMPLE_UPDATES}
      memory={SAMPLE_MEMORY_STATUS}
      bound={SAMPLE_BOUND}
      aiAvailable={options.aiAvailable}
      onChange={onChange}
      onAction={onAction}
      onCopy={onCopy}
    />
  ));
  return { onChange, onAction, onCopy };
}

const nav = (): HTMLElement => screen.getByRole('navigation', { name: 'Settings sections' });
const heading = (): string => screen.getByRole('heading', { level: 1 }).textContent ?? '';

describe('UI-Settings sections', () => {
  it('finds sections by label or keyword, case-insensitively', () => {
    expect(searchSections('')).toHaveLength(SECTIONS.length);
    expect(searchSections('telemetry').map((s) => s.id)).toEqual(['privacy']);
    expect(searchSections('THEME').map((s) => s.id)).toEqual(['appearance']);
    expect(searchSections('swap').map((s) => s.id)).toContain('memory');
    expect(searchSections('xyz')).toEqual([]);
  });
});

describe('UI-Settings view', () => {
  it('DSN-18 opens on About: sidebar sections, the wordmark, system facts and the team', () => {
    setup();
    const items = within(nav()).getAllByRole('button');
    expect(items.map((b) => b.textContent)).toEqual([
      'General',
      'Appearance',
      'Desktop & Dock',
      'Memory',
      'Scheduler',
      'Network & Sync',
      'Privacy & AI',
      'Users & Groups',
      'Storage',
      'Updates1',
      'About',
    ]);
    expect(within(nav()).getByRole('button', { name: 'About' }).getAttribute('aria-current')).toBe(
      'page',
    );
    expect(heading()).toBe('About');
    expect(screen.getByRole('heading', { level: 2, name: 'Plotinium' })).toBeTruthy();
    const kernel = screen.getAllByText('Kernel').find((el) => el.tagName === 'DT');
    expect(kernel?.parentElement?.textContent).toContain('plotinium 0.3.0-a1f93c2');
    expect(screen.getAllByText('Member to be announced')).toHaveLength(5);
    expect(screen.getByRole('status', { name: '1 update available' })).toBeTruthy();
  });

  it('DSN-18 copying a fact goes through the intent and is announced', () => {
    const { onCopy } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Copy version' }));
    expect(onCopy).toHaveBeenCalledWith('Version', '0.3.0 (build a1f93c2)');
    expect(screen.getByText('Copied')).toBeTruthy();
    expect(screen.getByText('Copied version to clipboard')).toBeTruthy();
  });

  it('UI-Settings navigates sections with back and forward history', () => {
    setup();
    const back = screen.getByRole('button', { name: 'Back' });
    expect(back.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(within(nav()).getByRole('button', { name: 'Memory' }));
    expect(heading()).toBe('Memory');
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(heading()).toBe('About');
    fireEvent.click(screen.getByRole('button', { name: 'Forward' }));
    expect(heading()).toBe('Memory');
  });

  it('UI-Settings arrow keys move through the sidebar; Ctrl+F focuses search', () => {
    setup({ initial: 'general' });
    const general = within(nav()).getByRole('button', { name: 'General' });
    general.focus();
    fireEvent.keyDown(general, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(within(nav()).getByRole('button', { name: 'Appearance' }));
    fireEvent.keyDown(document.activeElement as Element, { key: 'End' });
    expect(document.activeElement).toBe(within(nav()).getByRole('button', { name: 'About' }));
    fireEvent.keyDown(document.activeElement as Element, { key: 'f', ctrlKey: true });
    expect(document.activeElement).toBe(screen.getByRole('searchbox', { name: 'Search settings' }));
  });

  it('UI-Settings sidebar search filters sections and reports the count', () => {
    setup();
    const box = screen.getByRole('searchbox', { name: 'Search settings' });
    fireEvent.input(box, { target: { value: 'telemetry' } });
    expect(
      within(nav())
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Privacy & AI']);
    expect(screen.getByText('1 setting matches')).toBeTruthy();
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(heading()).toBe('Privacy & AI');
    fireEvent.input(box, { target: { value: 'foo' } });
    expect(screen.getByText('No settings match “foo”')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show all settings' }));
    expect(within(nav()).getAllByRole('button')).toHaveLength(SECTIONS.length);
  });
});

describe('UI-Settings privacy', () => {
  it('PRE-05 keeping telemetry on the device is locked on with its reason', () => {
    setup({ initial: 'privacy' });
    const locked = screen.getByRole('switch', { name: 'Keep telemetry on this device' });
    expect(locked.getAttribute('aria-checked')).toBe('true');
    expect(locked.getAttribute('aria-disabled')).toBe('true');
    const table = screen.getByRole('table', { name: 'Recent telemetry events' });
    expect(within(table).getAllByRole('row')).toHaveLength(5);
    expect(table.textContent).not.toContain('/home');
  });

  it('PRE-05 turning sync on asks for consent in a sheet first', () => {
    const { onChange } = setup({ initial: 'privacy' });
    fireEvent.click(screen.getByRole('switch', { name: 'Sync telemetry to server' }));
    expect(onChange).not.toHaveBeenCalled();
    const sheet = screen.getByRole('dialog', { name: 'Sync telemetry to your account?' });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Turn on sync' }));
    expect(onChange).toHaveBeenCalledWith({ key: 'telemetry.sync', value: true });
  });

  it('DSN-17 Clear telemetry asks in an alertdialog before the action', () => {
    const { onAction } = setup({ initial: 'privacy' });
    fireEvent.click(screen.getByRole('button', { name: 'Clear telemetry' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Clear 1,284 events?' });
    expect(onAction).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Clear telemetry' }));
    expect(onAction).toHaveBeenCalledWith('telemetry.clear');
  });

  it('AGT-03 the agent budget is a meter in words; the kernel owns confirmation (UI-042)', () => {
    const { onChange, onAction } = setup({ initial: 'privacy' });
    expect(
      screen.getByRole('meter', { name: 'Monthly agent budget' }).getAttribute('aria-valuetext'),
    ).toBe('$3.20 of $50 used this month');
    // Nothing reads agent.requireConfirm (ai/src/agent/confirm.ts decides), so the switch is
    // disabled and says why instead of saving a value that changes nothing.
    const confirm = screen.getByRole('switch', { name: 'Require confirmation for all changes' });
    expect(confirm.getAttribute('aria-disabled')).toBe('true');
    expect(
      document.getElementById(confirm.getAttribute('aria-describedby') ?? '')?.textContent,
    ).toContain('The kernel always asks');
    fireEvent.click(confirm);
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Open ai log…' }));
    expect(onAction).toHaveBeenCalledWith('ai.openLog');
  });

  it('RAG-01 the index row shows the indexer progress; Rebuild index is confirmed in a popover', () => {
    const { onAction } = setup({ initial: 'privacy' });
    expect(
      screen.getByRole('progressbar', { name: 'Chunks indexed' }).getAttribute('aria-valuetext'),
    ).toBe('3,118 of 3,530 chunks indexed');
    fireEvent.click(screen.getByRole('button', { name: 'Rebuild index' }));
    const popover = screen.getByRole('dialog', { name: 'Rebuild the index' });
    fireEvent.click(within(popover).getByRole('button', { name: 'Rebuild' }));
    expect(onAction).toHaveBeenCalledWith('index.rebuild');
  });

  it('UI-Settings the AI-off build shows Privacy without the AI groups', () => {
    setup({ initial: 'privacy', aiAvailable: false });
    expect(heading()).toBe('Privacy');
    expect(screen.queryByText('Semantic search')).toBeNull();
    expect(within(nav()).getByRole('button', { name: 'Privacy' })).toBeTruthy();
  });
});

describe('UI-Settings panes', () => {
  it('UI-Settings appearance: theme and accent are radio groups with arrow keys', () => {
    const { onChange } = setup({ initial: 'appearance' });
    const themes = screen.getByRole('radiogroup', { name: 'Theme' });
    const system = within(themes).getByRole('radio', { name: 'Follow system' });
    expect(system.getAttribute('aria-checked')).toBe('true');
    fireEvent.keyDown(system, { key: 'ArrowRight' });
    expect(onChange).toHaveBeenCalledWith({ key: 'appearance.theme', value: 'light' });
    fireEvent.click(screen.getByRole('radio', { name: 'Blue' }));
    expect(onChange).toHaveBeenCalledWith({ key: 'appearance.accent', value: 'blue' });
  });

  it('MEM-01 the memory budget commits on release and guests cannot change it', () => {
    const { onChange } = setup({ initial: 'memory' });
    const slider = screen.getByRole('slider', { name: 'Global budget' });
    fireEvent.input(slider, { target: { value: '384' } });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(slider, { target: { value: '384' } });
    expect(onChange).toHaveBeenCalledWith({ key: 'mm.budgetMB', value: 384 });
  });

  it('MEM-01 guests see why device settings are read-only', () => {
    setup({ initial: 'memory', user: { name: 'guest', uid: 65534, guest: true } });
    expect(screen.getByText('Guests cannot change device settings.')).toBeTruthy();
    const slider = screen.getByRole<HTMLInputElement>('slider', { name: 'Global budget' });
    expect(slider.disabled).toBe(true);
  });

  it('PROC-04 the scheduler pane recomputes the declared bound as T_age moves', () => {
    setup({ initial: 'scheduler' });
    expect(screen.getByText('5,450 ms')).toBeTruthy();
    fireEvent.input(screen.getByRole('slider', { name: 'Aging interval (T_age)' }), {
      target: { value: '250' },
    });
    expect(screen.getByText('11,450 ms')).toBeTruthy();
  });

  it('UI-Settings updates: restart to update is the primary action', () => {
    const { onAction } = setup({ initial: 'updates' });
    expect(screen.getByRole('heading', { name: 'Plotinium 0.3.1 is available' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Restart to update' }));
    expect(onAction).toHaveBeenCalledWith('updates.install');
  });
});
