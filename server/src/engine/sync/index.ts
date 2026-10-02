/**
 * server/src/engine/sync: the sync engine as pure, tested modules that the `sync` Fastify plugin
 * wires (offline-and-sync.md; database.md §3.9, §3.15; backend-api.md §3.6.2, §3.7).
 */
export { systemClock, type Clock, type Timer } from './clock.ts';
export {
  BYE_CLOSE_CODE,
  backpressure,
  leaseActionOnClose,
  type LeaseAction,
  type SendClass,
  type ServerByeReason,
} from './close-policy.ts';
export {
  checkBase,
  subtreeDigest,
  withBaseCheck,
  baseOf,
  type StructuralKind,
  type Versioned,
} from './base-check.ts';
export {
  SyncConnection,
  CONNECTION_DEFAULTS,
  type ConnAuth,
  type HelloInfo,
  type Transport,
} from './connection.ts';
export {
  ContentWriteHandler,
  MTIME_CLAMP_MS,
  type ContentSql,
  type ContentWriteOptions,
  type Effects,
} from './content-write.ts';
export {
  callOf,
  ProtocolViolation,
  SyncEngine,
  type CommittedOp,
  type HandlerFor,
  type OpOrigin,
  type OsSessionCheck,
} from './engine.ts';
export {
  Broadcaster,
  withContext,
  type FeedEntry,
  type FeedReader,
  type FeedRow,
  type FeedSubscriber,
  type OwnerHead,
} from './feed.ts';
export { KyselyFeedReader, KyselyOsSessionStore, type OsSessionStore } from './feed-reader.ts';
export { capturingSteps, kyselyFeedSql, type FeedSql, type FeedWrite } from './feed-steps.ts';
export { SyncHub, type EngineApi, type HubConfig, type HubContext } from './hub.ts';
export { kyselyContentSql } from './kysely-content.ts';
export { OpLane, type EnqueueResult, type LaneDeps } from './lane.ts';
export { conflictName, isoDate, splitExtension } from './names.ts';
export {
  LamportClock,
  resultFromError,
  resultFromOutcome,
  retry,
  retryAfterFor,
  StoredResult,
} from './outcome.ts';
export {
  OwnerStream,
  resumeMode,
  snapshotUrl,
  type ResumeDecision,
  type StreamSink,
} from './resume.ts';
export {
  initialRouterState,
  noteProtocolError,
  routeFrame,
  type RouterAction,
  type RouterState,
} from './router.ts';
export { createSyncRuntime, type SyncRuntime, type SyncRuntimeOptions } from './runtime.ts';
export { FrameThrottle, type Admit } from './throttle.ts';
export { filterChanges, type DirContext, type DirContextSource } from './visibility.ts';
export { ConnectionWatchdog } from './watchdog.ts';
