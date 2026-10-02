/**
 * The Settings process (`/bin/settings.json` entry `apps/settings/proc`): owns the window and its
 * lifetime, and makes the executor-only calls its view asks for on the display channel
 * (apps/files/lib/relay.ts): kernel parameters (`sysctl.set`), the telemetry export into the home
 * directory (`writeFile`), Sync Now (`sync.flush`) and Restart to Update (`reboot`). The model
 * runs in the view (controller.ts).
 */
import type { CallName } from '@plotinium/protocol';

import { appProcess } from '../files/lib/relay.ts';

/** The calls the Settings view may have its process make. */
export const SETTINGS_RELAY: readonly CallName[] = [
  'sysctl.set',
  'writeFile',
  'sync.flush',
  'reboot',
];

const settings = appProcess({
  app: 'settings',
  title: 'Settings',
  icon: 'settings',
  minWidth: 880,
  minHeight: 620,
  relay: SETTINGS_RELAY,
});

export default settings;
