/**
 * The kernel worker bundle: exactly one per origin (architecture.md §3.6). Vite builds it as a
 * separate ES-module chunk; main.ts streams it for truthful progress, then starts it.
 *
 * This is where the OS is composed on the kernel side (the kernel never imports apps or ai/):
 *  - the program registry: the `/bin/<name>.json` manifests of the shell, coreutils, the demo
 *    programs, the GUI apps and (AI build) the AI processes;
 *  - the executor bundle that carries their loaders (./executor.worker.ts);
 *  - the I/O extras: the AI link (./kernel/ai-link.ts) and the first-boot seed (the identity
 *    files, seeded into /system/branding: ./kernel/branding-seed.ts).
 */
import { AI_MANIFESTS } from '@plotinium/ai/programs';
import { programManifests } from '@plotinium/apps';
import type { Kernel } from '@plotinium/kernel';
import { startKernelWorker } from '@plotinium/kernel/host/worker';

import { aiLinkFactory } from './kernel/ai-link.ts';
import { brandingSeed } from './kernel/branding-seed.ts';

declare const __AI__: boolean;

let kernel: Kernel | null = null;
const scope = self as unknown as DedicatedWorkerGlobalScope;

startKernelWorker({
  programs: [...programManifests({ ai: __AI__ }), ...(__AI__ ? AI_MANIFESTS : [])],
  executorFactory: (index) =>
    new Worker(new URL('./executor.worker.ts', import.meta.url), {
      type: 'module',
      name: `executor-${String(index)}`,
    }),
  io: {
    aiEnabled: __AI__,
    ...(__AI__ ? { ai: aiLinkFactory({ current: () => kernel }, scope) } : {}),
    seed: () => brandingSeed((url) => fetch(url, { credentials: 'same-origin' })),
  },
  onKernel: (k) => {
    kernel = k;
  },
});
