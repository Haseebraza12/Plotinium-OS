/**
 * The main thread's view of the current boot record (boot-and-services.md §4.6) and the
 * `window.__plt` test hooks of tests/e2e/SELECTORS.md §3, exposed only in `PLT_TEST_BUILD=1`
 * builds. TODO(R5): once `storage` writes the IndexedDB boot record, `bootlog()` returns the
 * `bootlog --json` syscall result instead of this main-thread draft.
 */
export interface BootRecordDraft {
  bootId: string;
  seq: number;
  profile: 'normal' | 'safe' | 'recovery';
  verbose: boolean;
  kind: 'warm' | 'cold' | 'cold-first';
  flags: string[];
  /** Epoch ms of the main thread's performance.timeOrigin; every other time is s since t0. */
  t0: number;
  userWaitMs: number;
  interactiveAt: number | null;
  bootMs: number | null;
  outcome: 'interactive' | 'panic' | 'recovery' | 'incomplete' | 'unsupported';
  panic?: { kind: string; text: string; cycle?: string[] };
  build: { version: string; build: string };
  env: {
    chromeMajor: number | null;
    hwc: number;
    isolated: boolean;
    swActive: boolean;
    persisted: boolean | null;
    quotaBytes: number;
    usageBytes: number;
  };
  assets: { bytesTotal: number; bytesDone: number };
}

export function newBootRecord(
  build: { version: string; build: string },
  nav: Navigator,
  isolated: boolean,
  t0: number,
): BootRecordDraft {
  const chrome = /Chrome\/(\d+)/.exec(nav.userAgent);
  const swActive = 'serviceWorker' in nav && nav.serviceWorker.controller !== null;
  return {
    bootId: '',
    seq: 0,
    profile: 'normal',
    verbose: false,
    kind: swActive ? 'warm' : 'cold',
    flags: [],
    t0,
    userWaitMs: 0,
    interactiveAt: null,
    bootMs: null,
    outcome: 'incomplete',
    build,
    env: {
      chromeMajor: chrome ? Number(chrome[1]) : null,
      hwc: nav.hardwareConcurrency || 1,
      isolated,
      swActive,
      persisted: null,
      quotaBytes: 0,
      usageBytes: 0,
    },
    assets: { bytesTotal: 0, bytesDone: 0 },
  };
}

/** Tracks user wait (login screen, boot menu) so boot time excludes it (§3.2 stage 5). */
export class UserWait {
  private since: number | null = null;
  private total = 0;
  private readonly now: () => number;

  constructor(now: () => number) {
    this.now = now;
  }

  begin(): void {
    if (this.since === null) this.since = this.now();
  }

  end(): void {
    if (this.since === null) return;
    this.total += this.now() - this.since;
    this.since = null;
  }

  get active(): boolean {
    return this.since !== null;
  }

  /** Milliseconds waited so far (including a wait still in progress). */
  ms(): number {
    return Math.round(this.total + (this.since === null ? 0 : this.now() - this.since));
  }
}

/**
 * The hook sources other owners fill in once their part is integrated (R3: sessionId, layout,
 * terminal; R2: oracle). Looked up at call time, so the assembler can set them after boot.
 */
export interface TestHookSources {
  readonly record: BootRecordDraft;
  sessionId?: () => string;
  layout?: () => unknown[];
  terminal?: { text(): string; idle(): boolean };
  oracle?: { snapshot(path: string): Promise<unknown> };
}

/** Install `window.__plt` (test builds only; the release job fails if a release build has it). */
export function installTestHooks(win: Window, src: TestHookSources): void {
  const hooks = {
    bootlog: () => Promise.resolve(structuredClone(src.record)),
    sessionId: () => src.sessionId?.() ?? '',
    layout: () => src.layout?.() ?? [],
    terminal: {
      text: () => src.terminal?.text() ?? '',
      idle: () => src.terminal?.idle() ?? false,
    },
    oracle: {
      snapshot: (path: string) =>
        src.oracle?.snapshot(path) ?? Promise.reject(new Error('oracle: not wired yet (R2)')),
    },
  };
  Object.defineProperty(win, '__plt', { value: Object.freeze(hooks), configurable: false });
}
