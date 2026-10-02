/**
 * The desktop shell's dev harness: `mountDesktop` with the fake environment of
 * fixtures/dev-env.ts (demo apps, a fake kernel on the real compositor-port protocol, several
 * users plus Guest, a saved three-window layout). Served by dev/vite.config.mjs:
 *
 *   node_modules/.bin/vite --config wm/src/shell/dev/vite.config.mjs   → http://localhost:4720/dev/
 *
 * Query parameters: `login=0` signs `student` in at once, `windows=0` skips the saved layout,
 * `theme=light|dark`, `motion=reduce`, `offline=1`. The password of every demo user is
 * `plotinium`. `window.__pltShell` exposes the handle for Playwright (`window.__plt` is the test-build contract of
 * tests/support/hooks.ts, which the product host fills).
 */
import { createDevEnv } from './fixtures/dev-env.ts';
import { mountDesktop, type DesktopHandle } from './mount.tsx';

declare global {
  interface Window {
    __pltShell?: {
      readonly handle: DesktopHandle;
      readonly layout: () => ReturnType<DesktopHandle['layout']>;
      readonly sessionId: () => string | null;
      readonly calls: readonly string[];
    };
  }
}

const params = new URLSearchParams(window.location.search);
const theme = params.get('theme');
const dev = createDevEnv({
  login: params.get('login') !== '0',
  restore: params.get('windows') !== '0',
  ...(theme === 'light' || theme === 'dark' ? { theme } : {}),
  reducedMotion: params.get('motion') === 'reduce',
  offline: params.get('offline') === '1',
  launchDelayMs: 120,
  verifyDelayMs: 450,
  viewport: { w: window.innerWidth, h: window.innerHeight },
});

const root = document.getElementById('plt-desktop');
if (root !== null) {
  const handle = mountDesktop(root, {
    ...dev.env,
    onPhase: (phase) => {
      document.documentElement.dataset['shellPhase'] = phase;
      if (phase === 'desktop') dev.seedStatus();
    },
  });
  dev.bindPrefs((patch) => handle.setPrefs(patch));
  window.__pltShell = {
    handle,
    layout: () => handle.layout(),
    sessionId: () => handle.sessionId(),
    calls: dev.calls,
  };
}
