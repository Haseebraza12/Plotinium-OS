/**
 * Settings whose value nothing in Plotinium reads yet (UI-042). Their controls are shown disabled
 * with this note instead of saving a value that changes nothing. A setting leaves this list in
 * the change that makes something read it (apps/settings/tests lists every key with its consumer
 * or its note).
 */
import type { SettingKey } from './models.ts';

/** The short note under a control whose setting has no effect in this build. */
export const NOT_AVAILABLE = 'Not available in this build.';

export const UNAVAILABLE_SETTINGS: Readonly<Partial<Record<SettingKey, string>>> = {
  'general.deviceName': 'Not available in this build: nothing uses the device name yet.',
  'general.language': 'Not available in this build: Plotinium is in English (UK) only.',
  'dock.showSuggestions': NOT_AVAILABLE,
  // Files do sync (UI-006: syncd is linked); only switching it off has no consumer.
  'sync.files':
    'Files in your home folder always sync while you are online. Turning this off is not available in this build.',
  'sync.swapWriteBehind': NOT_AVAILABLE,
  'updates.auto': NOT_AVAILABLE,
  'updates.channel': NOT_AVAILABLE,
  // ai/src/agent/confirm.ts decides alone (AGT-03); no preference reaches it.
  'agent.requireConfirm':
    'The kernel always asks before deletes, overwrites, permission changes, system paths and plans that touch more than 20 files. A stricter setting is not available in this build.',
};

/** The note of a setting that has no effect in this build, if it is one. */
export function unavailableNote(key: SettingKey): string | undefined {
  return UNAVAILABLE_SETTINGS[key];
}
