/**
 * @plotinium/services: the 18 service manifests (C17) and the service manager
 * (specs/02-boot/boot-and-services.md). Runs inside the kernel worker; the kernel imports it,
 * never the other way round. Primary owner: R5 QA/DevOps (R3 reviews boot UI coupling).
 */
export const PACKAGE_NAME = '@plotinium/services';

export {
  BACKOFF_BASE_MS,
  BACKOFF_CAP_MS,
  backoffCeiling,
  backoffDelay,
  seededRandom,
} from './backoff.ts';
export { criticalPath } from './critical-path.ts';
export type { CriticalPathRow, ServiceTiming } from './critical-path.ts';
export {
  ancestorClosure,
  DependencyCycle,
  fallbackPlan,
  FALLBACK_WARNING,
  planLevels,
} from './levels.ts';
export type { DagPlan } from './levels.ts';
export { BUILTIN_MANIFEST_FILES } from './manifests.ts';
export { alphaFor, BootProgress, targetClosure, W_ASSETS } from './progress.ts';
export type { BootTarget, ProgressEvent, ProgressSnapshot } from './progress.ts';
export { bootTargetName, CODE_WAIT_MAX_MS, ServiceManager } from './svcmgr.ts';
export type {
  BootLogLine,
  BuildOk,
  BuildResult,
  ServiceManagerOptions,
  SvcEvent,
  SvcPanic,
} from './svcmgr.ts';
export type {
  BootProfile,
  KernelTimers,
  LogLevel,
  ManifestFile,
  ServiceContext,
  ServiceImpl,
  ServiceManifest,
  ServiceName,
  ServiceRegistry,
  ServiceState,
  ServiceStatus,
  StartResult,
} from './types.ts';
export { validateManifests } from './validate.ts';
export type { Rule, ValidationError, ValidationResult } from './validate.ts';

// The real system services (storage, mm, vfs, login, session, auth, sync, lockd, ai.*, complete,
// update) over the ports the kernel implements (kernel/src/core/io).
export * from './system/index.ts';
