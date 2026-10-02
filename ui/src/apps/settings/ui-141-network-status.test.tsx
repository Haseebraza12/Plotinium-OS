/**
 * Verifier regression (Wave 3, verify-c) for UI-141 on the Docker build: with sync LIVE but no op
 * acknowledged yet, Network & Sync showed "Online · Last synced never" and Sync now answered
 * "Everything is synced." The description now says what is true in each state.
 */
import { render, screen } from '@solidjs/testing-library';
import { describe, expect, it, vi } from 'vitest';

import { UNAVAILABLE_SETTINGS } from './availability.ts';
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
import type { NetworkModel } from './index.ts';
import { networkDescription } from './panes/GeneralPanes.tsx';
import { SettingsView } from './SettingsView.tsx';

function renderNetwork(network: NetworkModel): void {
  render(() => (
    <SettingsView
      initialSection="network"
      user={SAMPLE_USER}
      values={DEFAULT_VALUES}
      about={SAMPLE_ABOUT}
      privacy={SAMPLE_PRIVACY}
      network={network}
      users={SAMPLE_USERS}
      storage={SAMPLE_STORAGE}
      updates={SAMPLE_UPDATES}
      memory={SAMPLE_MEMORY_STATUS}
      bound={SAMPLE_BOUND}
      onChange={vi.fn()}
      onAction={vi.fn()}
    />
  ));
}

describe('UI-141 Network & Sync status text', () => {
  it('UI-141 online with nothing acknowledged yet never says "Last synced never"', () => {
    renderNetwork({ ...SAMPLE_NETWORK, status: 'online', lastSync: 'never', queued: 0 });
    expect(screen.getByText('Online')).toBeTruthy();
    expect(screen.queryByText(/Last synced never/u)).toBeNull();
    expect(
      screen.getByText('Connected. Nothing from this device has needed syncing yet.'),
    ).toBeTruthy();
  });

  it('UI-141 every state with no acknowledgement has its own honest line', () => {
    const base: NetworkModel = { ...SAMPLE_NETWORK, lastSync: 'never' };
    expect(networkDescription({ ...base, status: 'syncing', queued: 2 })).toBe(
      'Sending the first changes from this device.',
    );
    expect(networkDescription({ ...base, status: 'degraded' })).toBe(
      'Nothing has synced: the sync service is not running.',
    );
    expect(networkDescription({ ...base, status: 'auth' })).toBe(
      'Sign in again to sync changes from this device.',
    );
    expect(networkDescription({ ...base, status: 'offline', queued: 3 })).toBe(
      'Changes are queued and replay when the connection returns.',
    );
    for (const status of ['online', 'syncing', 'degraded', 'auth'] as const) {
      expect(networkDescription({ ...base, status })).not.toMatch(/never/u);
    }
  });

  it('UI-141 once something was acknowledged it shows the time and latency', () => {
    const { latencyMs: _unused, ...noLatency } = SAMPLE_NETWORK;
    expect(networkDescription({ ...noLatency, status: 'online', lastSync: '14:31' })).toBe(
      'Last synced 14:31',
    );
    expect(
      networkDescription({ ...SAMPLE_NETWORK, status: 'online', lastSync: '14:31', latencyMs: 18 }),
    ).toBe('Last synced 14:31 · 18 ms');
  });

  it('UI-042 the Sync files note no longer claims file sync is unavailable', () => {
    const note = UNAVAILABLE_SETTINGS['sync.files'] ?? '';
    expect(note).toMatch(/always sync while you are online/u);
    expect(note).not.toBe('Not available in this build.');
  });
});
