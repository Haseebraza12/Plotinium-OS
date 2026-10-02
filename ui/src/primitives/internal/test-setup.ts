// Vitest setup for @plotinium/ui (ui/vitest.config.ts): unmount every rendered tree after each
// test, since the suite runs without Vitest globals and so without auto-cleanup.
import { cleanup } from '@solidjs/testing-library';
import { afterEach } from 'vitest';

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute('data-motion');
});
