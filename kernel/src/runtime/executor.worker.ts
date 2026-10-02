/**
 * The default executor worker bundle: a kernel-only build with no program registry. Hosts that
 * ship programs (web) build their own executor entry that calls `startExecutor({ loaders })` with
 * the apps' program loaders and pass its Worker factory to the kernel worker
 * (`startKernelWorker({ executorFactory })`); see executor-entry.ts.
 */
import { startExecutor } from './executor-entry.ts';

startExecutor({ allowUrlImport: true });
