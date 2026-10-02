/**
 * The `window.__plt` test-hook contract. Only builds made with `PLT_TEST_BUILD=1`
 * (`__TEST_FLAGS__`, deployment-and-ci §3.4) expose it; release builds never do. Tests read state
 * through these hooks and never open IndexedDB directly (spec §3.3 `bootRecord`).
 *
 * Owners: boot/bootlog R5, terminal R3, oracle and debug R2. Documented in tests/e2e/SELECTORS.md.
 */
import type { Page } from '@playwright/test';

import type { OracleSnapshot } from './oracle.ts';

/** The subset of the boot record (boot-and-services §4.6) the harness reads. */
export interface BootRecordView {
  bootId: string;
  seq: number;
  profile: 'normal' | 'safe' | 'recovery';
  kind: 'warm' | 'cold' | 'cold-first';
  flags: string[];
  userWaitMs: number;
  interactiveAt: number | null;
  bootMs: number | null;
  outcome: 'interactive' | 'panic' | 'recovery' | 'incomplete' | 'unsupported';
  build: { version: string; build: string };
  env: { chromeMajor: number | null; hwc: number; isolated: boolean; swActive: boolean };
  assets: { bytesTotal: number; bytesDone: number };
}

export interface WindowLayoutView {
  wid: number;
  app: string;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  state: 'normal' | 'minimised' | 'maximised' | 'fullscreen';
}

export interface PltTestHooks {
  /** `bootlog --json` for the current boot (boot §8.3). */
  bootlog(): Promise<BootRecordView>;
  /** The OS session id restored by `session` (BOOT-12, WM-06). */
  sessionId(): string;
  /** Current compositor layout, bottom to top. */
  layout(): WindowLayoutView[];
  terminal: {
    /** Plain text of the focused Terminal's buffer, trailing blank lines trimmed. */
    text(): string;
    /** True when the focused Terminal shows a prompt and no foreground job runs. */
    idle(): boolean;
  };
  /** Client-side oracle snapshot of a subtree (spec §3.6.5), computed through syscalls. */
  oracle: { snapshot(path: string): Promise<OracleSnapshot> };
  perf?: { accumulators(): Record<string, number[]> };
}

declare global {
  interface Window {
    __plt?: PltTestHooks;
  }
}

export async function bootRecord(page: Page): Promise<BootRecordView> {
  return page.evaluate(() => {
    const h = window.__plt;
    if (h === undefined) throw new Error('window.__plt is missing: not a PLT_TEST_BUILD=1 build');
    return h.bootlog();
  });
}

export async function sessionId(page: Page): Promise<string> {
  return page.evaluate(() => {
    const h = window.__plt;
    if (h === undefined) throw new Error('window.__plt is missing: not a PLT_TEST_BUILD=1 build');
    return h.sessionId();
  });
}

export async function layout(page: Page): Promise<WindowLayoutView[]> {
  return page.evaluate(() => {
    const h = window.__plt;
    if (h === undefined) throw new Error('window.__plt is missing: not a PLT_TEST_BUILD=1 build');
    return h.layout();
  });
}

export async function clientSnapshot(page: Page, path: string): Promise<OracleSnapshot> {
  return page.evaluate((p) => {
    const h = window.__plt;
    if (h === undefined) throw new Error('window.__plt is missing: not a PLT_TEST_BUILD=1 build');
    return h.oracle.snapshot(p);
  }, path);
}
