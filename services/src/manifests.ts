/**
 * The built-in manifest set: `services/manifests/*.json` compiled into the kernel bundle
 * (boot-and-services.md §3.3). Normal boots read the seeded copies under `/system/services`; Safe
 * and Recovery boots use this set (§3.7, INV-B7).
 */
import aiAgent from '../manifests/ai.agent.json';
import aiIndexer from '../manifests/ai.indexer.json';
import aiPredictor from '../manifests/ai.predictor.json';
import aiRuntime from '../manifests/ai.runtime.json';
import auth from '../manifests/auth.json';
import complete from '../manifests/complete.json';
import desktop from '../manifests/desktop.json';
import kernel from '../manifests/kernel.json';
import lockd from '../manifests/lockd.json';
import login from '../manifests/login.json';
import mm from '../manifests/mm.json';
import sched from '../manifests/sched.json';
import session from '../manifests/session.json';
import storage from '../manifests/storage.json';
import sync from '../manifests/sync.json';
import update from '../manifests/update.json';
import vfs from '../manifests/vfs.json';
import wm from '../manifests/wm.json';
import type { ManifestFile } from './types.ts';

/** In boot-level order, as in the §3.3 table. */
export const BUILTIN_MANIFEST_FILES: readonly ManifestFile[] = Object.freeze(
  [
    kernel,
    sched,
    storage,
    wm,
    mm,
    vfs,
    login,
    session,
    desktop,
    auth,
    sync,
    lockd,
    aiRuntime,
    aiIndexer,
    aiPredictor,
    aiAgent,
    complete,
    update,
  ].map((json) => Object.freeze({ file: `${json.name}.json`, json })),
);
