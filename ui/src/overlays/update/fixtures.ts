/**
 * Sample data for Restart to update and the shutdown progress (tests and the gallery), from
 * docs/design/stitch/update-restart. The step order is the real BOOT-12 order.
 */
import type { UpdateNote } from './RestartToUpdateDialog.tsx';
import type { ShutdownStep } from './ShutdownProgress.tsx';

export const UPDATE_CURRENT = { version: '0.3.0', build: 'a1f93c2' };
export const UPDATE_NEXT = { version: '0.3.1', build: 'c47e0b9', size: '18.4 MB' };

export const UPDATE_NOTES: readonly UpdateNote[] = [
  { lead: 'Faster boot', text: 'independent services start in parallel' },
  { lead: 'Search', text: 'semantic search now indexes PDFs' },
  { lead: 'Terminal', text: '`ai explain` for failed commands' },
  { lead: 'lockd', text: 'fixes a lease-renewal race' },
];

export const SHUTDOWN_STEPS: readonly ShutdownStep[] = [
  { id: 'checkpoint', label: 'Checkpointed 4 window processes', state: 'done', detail: '4 / 4' },
  { id: 'flush', label: 'Flushed dirty pages', state: 'done', detail: '3 / 3' },
  { id: 'session', label: 'Saved session · 4 windows', state: 'done', detail: 'strict' },
  {
    id: 'services',
    label: 'Stopping sync · outbox flushed',
    state: 'active',
    detail: '11 / 18',
    segments: { done: 10, total: 18 },
  },
  { id: 'activate', label: 'Activate 0.3.1 and reload', state: 'pending', detail: 'next' },
];
