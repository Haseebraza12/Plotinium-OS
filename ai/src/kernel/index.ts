/**
 * @plotinium/ai/kernel: the AI runtime that runs INSIDE the kernel worker, composed by web's
 * kernel-worker entry (the kernel itself may not import ai/, C12). See install.ts for the wiring
 * and ai/README.md "Kernel wiring" for the composer's checklist.
 */
export { installAi } from './install.ts';
export { agentFsFrom, createAiLink, lazyFsView, treeSnapshot } from './link.ts';
export type {
  AiLinkContextLike,
  AiLinkDeps,
  FsActorLike,
  KernelFsLike,
  KernelTreeLike,
  TreeEntryLike,
  TreeInodeLike,
} from './link.ts';
export type {
  AiDaemon,
  AiInstallation,
  AiInstallOptions,
  AiServiceContext,
  AiServiceImpl,
  AiServiceName,
  AiStartResult,
} from './install.ts';
export type {
  AiBus,
  AiCallImpl,
  AiCaller,
  AiKernel,
  AiLogLevel,
  AiPcb,
  AiProcCred,
  AiSubscription,
  HandlerTarget,
  HookTarget,
  HostFetch,
  MakeError,
} from './types.ts';
export { vfsTreeView, oracleFrom, resolveDir, resolvePathOf } from './fs-view.ts';
export type { AiFsView, InodeLike, LinkRef, MayFn, VfsTreeLike } from './fs-view.ts';
export { SemanticIndex } from './index-store.ts';
export {
  EMBED_PAGE_BYTES,
  EmbedService,
  JOB_TIMEOUT_MS,
  LOAD_TIMEOUT_MS,
  RETRY_AFTER_MS,
} from './embed-service.ts';
export type {
  EmbedServiceDeps,
  EmbedTimers,
  EmbedWorkerLike,
  ModelState,
} from './embed-service.ts';
export { SearchService, fitQuery } from './search-service.ts';
export type { SearchServiceDeps } from './search-service.ts';
export { PredictService, TelemetryService } from './predict-service.ts';
export type { MemoryFacts, PredictDeps, TelemetryDeps } from './predict-service.ts';
export { AgentService, renderDryRun } from './agent-service.ts';
export type { AgentFsDeps, AgentServiceDeps } from './agent-service.ts';
export { GatewayError, GatewayModelClient, gatewayHealthy, toModelResponse } from './gateway.ts';
export { ortThreads } from '../embed/config.ts';
export { registerAiHooks, createAiHooks } from '../hooks.ts';
export {
  AGENT_MANIFEST_PATH,
  AI_DAEMONS,
  AI_ENTRY,
  AI_MANIFESTS,
  PREFETCH_PRIORITY,
  prefetchArgv,
} from '../programs/index.ts';
export type { DaemonSpawn } from '../programs/index.ts';
