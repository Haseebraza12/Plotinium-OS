/**
 * The build identity injected by vite.config.ts (identity-and-branding.md §4.1): one source for
 * every surface (I-1, PLT-ID-14), plus the build switches the boot driver reads.
 */
import type { BuildIdentity } from '@plotinium/kernel';

declare const __PLT_IDENTITY__: BuildIdentity;
declare const __TEST_FLAGS__: boolean;
declare const __PLT_TIMEOUT_SCALE__: number;

export const IDENTITY: BuildIdentity = __PLT_IDENTITY__;
/** Test builds only (`PLT_TEST_BUILD=1`): `window.__plt` hooks and `?bootflags=`. */
export const TEST_FLAGS: boolean = __TEST_FLAGS__;
/** Service timeouts and the stall watchdog are stretched on the dev server (1 in builds). */
export const TIMEOUT_SCALE: number = __PLT_TIMEOUT_SCALE__;
/** The Vite dev server: no Service Worker. */
export const DEV: boolean = import.meta.env.DEV;
