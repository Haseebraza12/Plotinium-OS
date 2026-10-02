/**
 * kernel/core/programs: the kernel side of the program registry (`/bin/<name>.json` manifests)
 * and the application start-up closure (KPS-07). See catalog.ts for the injection contract: the
 * kernel never imports apps; the host passes a `ProgramCatalog` to `createKernel({ programs })`
 * and the matching `ProgramLoaders` to `startExecutor({ loaders })` in its executor bundle.
 */
export {
  BIN_DIR,
  EMPTY_CATALOG,
  manifestNameOf,
  manifestPath,
  StaticProgramCatalog,
} from './catalog.ts';
export type { ManifestProblem, ProgramCatalog } from './catalog.ts';
export { ClosureCache, startupClosure } from './closure.ts';
export type { StartupPlan } from './closure.ts';
