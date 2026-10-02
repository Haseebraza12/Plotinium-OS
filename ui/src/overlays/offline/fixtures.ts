/**
 * Sample data for the connectivity popover and the lease banner (tests and the gallery), from
 * docs/design/stitch/offline-lock-states.
 */
import type { DegradedService, QueuedOp } from './OfflinePopover.tsx';

export const QUEUED_OPS: readonly QueuedOp[] = [
  { id: 'op-1', verb: 'write', path: '~/notes.md', time: '14:29' },
  { id: 'op-2', verb: 'mkdir', path: '~/drafts', time: '14:30' },
  { id: 'op-3', verb: 'mv', path: '~/a.txt', target: '~/archive/a.txt', time: '14:31' },
];

export const DEGRADED_SERVICES: readonly DegradedService[] = [
  { id: 'sync', name: 'sync', detail: 'offline', since: '14:28:51' },
  { id: 'lockd', name: 'lockd', detail: 'local advisory locks only', since: '14:28:51' },
];
