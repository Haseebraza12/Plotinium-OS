/**
 * The real implementations of the system services (boot-and-services.md §3.3) that the kernel
 * registers next to its own `kernel`, `sched`, `wm` and `desktop` (V9). The kernel's `installIo`
 * builds the ports; `createSystemServices(ports)` returns the registry fragment.
 */
import type { ServiceImpl, ServiceName } from '../types.ts';
import { loginService, mmService, sessionService, storageService, vfsService } from './core.ts';
import { aiService, completeService, updateService } from './extras.ts';
import { authService, lockdService, syncService } from './network.ts';
import type { SystemPorts } from './ports.ts';

/** The services this module implements (the other four are kernel-host services). */
export const SYSTEM_SERVICE_NAMES = [
  'storage',
  'mm',
  'vfs',
  'login',
  'session',
  'auth',
  'sync',
  'lockd',
  'ai.runtime',
  'ai.indexer',
  'ai.predictor',
  'ai.agent',
  'complete',
  'update',
] as const satisfies readonly ServiceName[];

export function createSystemServices(ports: SystemPorts): Map<ServiceName, ServiceImpl> {
  return new Map<ServiceName, ServiceImpl>([
    ['storage', storageService(ports.storage)],
    ['mm', mmService(ports.mm)],
    ['vfs', vfsService(ports.vfs)],
    ['login', loginService(ports.login)],
    ['session', sessionService(ports.session)],
    ['auth', authService(ports.auth)],
    ['sync', syncService(ports.sync)],
    ['lockd', lockdService(ports.lockd)],
    ['ai.runtime', aiService('ai.runtime', ports.ai)],
    ['ai.indexer', aiService('ai.indexer', ports.ai)],
    ['ai.predictor', aiService('ai.predictor', ports.ai)],
    ['ai.agent', aiService('ai.agent', ports.ai)],
    ['complete', completeService(ports.complete)],
    ['update', updateService(ports.update)],
  ]);
}

export { loginService, mmService, sessionService, storageService, vfsService } from './core.ts';
export { aiService, completeService, updateService } from './extras.ts';
export { authService, lockdService, syncService } from './network.ts';
export { CompletionIndex, PATH_ENTRIES_MAX } from './completion.ts';
export type { CompletionQuery, DirEntryLike, EntryType } from './completion.ts';
export { MM_PUBLISH_MS, MM_TICK_MS } from './core.ts';
export { SW_WAIT_MS } from './extras.ts';
export { selfHeal } from './heal.ts';
export type { Healer } from './heal.ts';
export { AUTH_REFRESH_MS, LOCAL_LOCKS_REASON } from './network.ts';
export type * from './ports.ts';
