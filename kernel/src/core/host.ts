/**
 * What the thread-agnostic kernel core needs from its host (architecture.md §4.4).
 *
 * `kernel/src/core` never touches `self`, `navigator`, `Worker` or `indexedDB`: the host
 * (`host/worker.ts` in the browser, `host/loopback.ts` under Node) injects these values.
 *
 * TODO(R1): the rest of §4.4 `KernelHost` (`openDatabase`, `spawnExecutor`, `spawnBlkio`,
 * `spawnEmbed`, `socket`, `fetch`) lands with the storage, sched, mm and sync services.
 */

/** Kernel clocks. `now()` is monotonic (performance.now based); nothing else may read time. */
export interface KernelClock {
  /** Monotonic milliseconds on the kernel clock (t0 = worker start). */
  now(): number;
  /** Wall-clock epoch milliseconds. A test host returns a frozen fixture (C12). */
  epochMs(): number;
  /** IANA time zone of the device and its current offset from UTC in minutes (east positive). */
  timeZone(): { tz: string; offsetMin: number };
}

export type BrowserBrand = 'Chrome' | 'Edge' | 'Chromium' | 'Unknown browser';

/** Facts about the machine, read once by the host at boot (identity-and-branding.md §3.8). */
export interface PlatformInfo {
  readonly browser: { readonly brand: BrowserBrand; readonly major: number | null };
  /** `navigator.hardwareConcurrency`, at least 1. */
  readonly cores: number;
  readonly crossOriginIsolated: boolean;
}

/**
 * The build identity of identity-and-branding.md §4.1, injected by `web/vite.config.ts` as
 * `__PLT_IDENTITY__`. TODO(protocol): move to protocol/src/identity.ts (`BuildIdentitySchema`).
 */
export interface BuildIdentity {
  readonly name: 'Plotinium';
  readonly version: string;
  readonly build: string;
  readonly buildDate: string;
  readonly codename: string | null;
  readonly abi: number;
}

export interface KernelHost {
  readonly clock: KernelClock;
  readonly platform: PlatformInfo;
  readonly identity: BuildIdentity;
}

/** Identity used by tests and by a build without `__PLT_IDENTITY__` (never a release). */
export const DEV_IDENTITY: BuildIdentity = Object.freeze({
  name: 'Plotinium',
  version: '0.1.0-dev.0',
  build: '0000000',
  buildDate: '1970-01-01',
  codename: null,
  abi: 1,
});

/**
 * Browser brand and major version from `navigator.userAgentData.brands`, falling back to the UA
 * string (identity-and-branding.md §5 "Browser detection"). Pure, so the host passes the inputs.
 */
export function detectBrowser(
  brands: readonly { readonly brand: string; readonly version: string }[] | undefined,
  userAgent: string | undefined,
): PlatformInfo['browser'] {
  const known: readonly [string, BrowserBrand][] = [
    ['Google Chrome', 'Chrome'],
    ['Microsoft Edge', 'Edge'],
    ['Chromium', 'Chromium'],
  ];
  if (brands !== undefined) {
    for (const [name, brand] of known) {
      const hit = brands.find((b) => b.brand === name);
      if (hit) return { brand, major: parseMajor(hit.version) };
    }
  }
  // Edge's UA also contains "Chrome/", so the Edge token is checked first.
  const edge = userAgent === undefined ? null : /Edg\/(\d+)/.exec(userAgent);
  if (edge) return { brand: 'Edge', major: parseMajor(edge[1] ?? '') };
  const chrome = userAgent === undefined ? null : /Chrome\/(\d+)/.exec(userAgent);
  if (chrome) return { brand: 'Chrome', major: parseMajor(chrome[1] ?? '') };
  return { brand: 'Unknown browser', major: null };
}

function parseMajor(version: string): number | null {
  const n = Number.parseInt(version, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** `navigator.hardwareConcurrency` undefined or 0 counts as 1 core (identity §6). */
export function normaliseCores(hwc: number | undefined): number {
  return hwc !== undefined && Number.isInteger(hwc) && hwc >= 1 ? hwc : 1;
}
