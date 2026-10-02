/**
 * Shared types of the framework-free boot screens. Only protocol TYPES are imported (SYS-01);
 * the kernel and wm/boot-ui drive these screens and own every side effect.
 */
import type { BootLogEntry } from '@plotinium/protocol';

/** The build identity painted on every boot surface (BOOT-01; identity-and-branding.md §4.1). */
export interface BootIdentity {
  /** `0.3.0`, or `0.3.0-dev.14` for a development build. */
  readonly version: string;
  /** Short commit hash, e.g. `a1f93c2`. */
  readonly build: string;
}

/** Log levels of the protocol plus `ok`, the green `desktop: interactive` line. */
export type BootLogLevel = BootLogEntry['level'] | 'ok';

/**
 * One kernel-style boot log line: `[ssss.mmm] subsystem: message` (boot-and-services.md §3.7).
 * Structurally a protocol `BootLogEntry`; `level` may be left out and is then read from the
 * message's text prefix (`WARN`, `DEGRADED`, `FAIL`, `KERNEL PANIC`).
 */
export interface BootLogLine {
  /** Seconds since t0. */
  readonly t: number;
  readonly sub: string;
  readonly msg: string;
  readonly level?: BootLogLevel;
}

/** Options every screen accepts. */
export interface ScreenBase {
  /** Document to build in; defaults to the global one (tests and iframes pass their own). */
  readonly doc?: Document;
}

/** A mounted screen: the caller inserts `el` and calls `destroy()` when it hands over. */
export interface BootScreen {
  readonly el: HTMLElement;
  /** Moves focus to the screen's initial control. */
  focus(): void;
  /** Removes document listeners and the element. */
  destroy(): void;
}
