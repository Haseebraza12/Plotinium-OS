/**
 * About Plotinium (identity-and-branding.md §3.10 row 9; DSN-18): the atom mark, version and
 * codename, build hash and date, the kernel release, the browser and cores (`uname`), the memory
 * budget, storage, the signed-in user and the team from docs/identity/identity.json.
 *
 * Descriptor only; the view and the process load lazily.
 */
import type { AppDescriptor } from '../src/descriptor.ts';

export const descriptor: AppDescriptor = {
  id: 'about',
  title: 'About Plotinium',
  icon: 'atom',
  dock: false,
  keywords: ['about', 'version', 'build', 'uname', 'team', 'licences', 'system report'],
  window: {
    width: 780,
    height: 700,
    minWidth: 780,
    minHeight: 480,
    resizable: false,
    maximizable: false,
    chrome: 'titlebar',
    singleInstance: true,
  },
  menus: [],
  manifest: {
    name: 'about',
    kind: 'app',
    title: 'About Plotinium',
    icon: 'atom',
    entry: 'apps/about/proc',
    view: 'apps/about/view',
    requires: ['svc:wm'],
    checkpointable: true,
    caps: ['window', 'fs.read'],
  },
  load: () => import('./view.tsx').then((m) => m.mount),
  program: () => import('./proc.ts').then((m) => m.default),
};
