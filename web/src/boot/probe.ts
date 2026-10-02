/**
 * POST capability probe (boot-and-services.md §3.2.1, SVC-14): required capabilities are fatal
 * (the unsupported screen), degradable ones only add a WARN line and a bootlog note.
 */
import type { CapabilityMatrix } from '@plotinium/kernel/host/main';
import type { CapabilityRow } from '@plotinium/ui/boot';
import { localAddress } from '@plotinium/ui/boot';

export interface PostResult {
  readonly caps: CapabilityMatrix;
  readonly rows: CapabilityRow[];
  readonly fatal: boolean;
  /** `[firmware]` summary line for the verbose log. */
  readonly summary: string;
}

/**
 * Construct-and-terminate a module worker from an empty blob (CSP allows `worker-src blob:`).
 * `scriptUrl` is the boot Trusted Types policy (trusted.ts).
 */
function moduleWorkers(
  win: Window & typeof globalThis,
  scriptUrl: (url: string) => string,
): boolean {
  if (typeof win.Worker !== 'function') return false;
  try {
    const url = URL.createObjectURL(new Blob([''], { type: 'text/javascript' }));
    const w = new win.Worker(scriptUrl(url), { type: 'module', name: 'post-probe' });
    w.terminate();
    URL.revokeObjectURL(url);
    return true;
  } catch {
    return false;
  }
}

/**
 * Where this page would have a secure context (UI-069): read from the page's own location, so
 * the fix names the port the page is really served on. Tolerates a partial location object.
 */
function secureAddress(win: Window & typeof globalThis): string {
  const { host, protocol } = win.location as Partial<Pick<Location, 'host' | 'protocol'>>;
  try {
    const url = new URL(
      `${protocol ?? 'http:'}//${host === undefined || host === '' ? 'localhost' : host}`,
    );
    return localAddress(url);
  } catch {
    return 'http://localhost';
  }
}

export function probeCapabilities(
  win: Window & typeof globalThis,
  scriptUrl: (url: string) => string = (url) => url,
): PostResult {
  const nav = win.navigator;
  const secure = win.isSecureContext;
  const isolated = win.crossOriginIsolated;
  const caps: CapabilityMatrix = {
    secureContext: secure,
    crossOriginIsolated: isolated,
    sab: typeof win.SharedArrayBuffer === 'function',
    moduleWorkers: moduleWorkers(win, scriptUrl),
    indexedDB: 'indexedDB' in win,
    webLocks: 'locks' in nav,
    cryptoSubtle: typeof win.crypto?.subtle?.digest === 'function',
    serviceWorker: 'serviceWorker' in nav,
    serviceWorkerControlled: 'serviceWorker' in nav && nav.serviceWorker.controller !== null,
    compressionStream: typeof win.CompressionStream === 'function',
    measureMemory:
      typeof (win.performance as Performance & { measureUserAgentSpecificMemory?: unknown })
        .measureUserAgentSpecificMemory === 'function',
    estimate: { usage: 0, quota: 0 },
  };
  const row = (
    name: string,
    ok: boolean,
    required: boolean,
    probe: string,
    fix: string,
  ): CapabilityRow => ({
    name,
    probe,
    status: ok ? 'pass' : required ? 'missing' : 'degraded',
    required,
    ...(ok ? {} : { fix }),
  });
  const rows: CapabilityRow[] = [
    row(
      'Secure context',
      secure,
      true,
      win.location.host,
      `Open ${secureAddress(win)}, not a LAN IP`,
    ),
    row(
      'Module workers',
      caps.moduleWorkers,
      true,
      'new Worker({type:"module"})',
      'Use a current Chrome',
    ),
    row(
      'IndexedDB',
      caps.indexedDB,
      true,
      'indexedDB',
      'Storage is disabled or blocked by private mode',
    ),
    row(
      'Web Locks',
      caps.webLocks,
      true,
      'navigator.locks',
      'Use a current Chrome in a secure context',
    ),
    row(
      'Web Crypto',
      caps.cryptoSubtle,
      true,
      'crypto.subtle',
      'Use a current Chrome in a secure context',
    ),
    row(
      'Cross-origin isolation',
      isolated && caps.sab,
      false,
      'crossOriginIsolated',
      'Pre-emption falls back to messages',
    ),
    row('Service Worker', caps.serviceWorker, false, 'navigator.serviceWorker', 'No offline boot'),
    row(
      'CompressionStream',
      caps.compressionStream,
      false,
      'CompressionStream',
      'Remote swap pages are sent uncompressed',
    ),
  ];
  const fatal = rows.some((r) => r.required === true && r.status === 'missing');
  const flags = [
    caps.moduleWorkers && 'workers',
    caps.indexedDB && 'indexeddb',
    caps.cryptoSubtle && 'crypto',
    isolated && 'isolated',
  ]
    .filter(Boolean)
    .join(', ');
  return { caps, rows, fatal, summary: `POST ${fatal ? 'FAILED' : 'ok'} (${flags})` };
}

/** A short browser and OS label for the unsupported screen: `Chrome 128 on Linux`. */
export function platformLabel(userAgent: string): string {
  const pick = (re: RegExp): string | null => re.exec(userAgent)?.[1] ?? null;
  const edge = pick(/Edg\/(\d+)/);
  const firefox = pick(/Firefox\/(\d+)/);
  const chrome = pick(/(?:HeadlessChrome|Chrome|Chromium)\/(\d+)/);
  const safari = pick(/Version\/(\d+)[\d.]* (?:Mobile\/\S+ )?Safari\//);
  const browser =
    edge !== null
      ? `Edge ${edge}`
      : firefox !== null
        ? `Firefox ${firefox}`
        : chrome !== null
          ? `Chrome ${chrome}`
          : safari !== null
            ? `Safari ${safari}`
            : 'Unknown browser';
  const os = /CrOS/.test(userAgent)
    ? 'ChromeOS'
    : /Android/.test(userAgent)
      ? 'Android'
      : /iPhone|iPad/.test(userAgent)
        ? 'iOS'
        : /Windows/.test(userAgent)
          ? 'Windows'
          : /Mac OS X/.test(userAgent)
            ? 'macOS'
            : /Linux/.test(userAgent)
              ? 'Linux'
              : 'unknown OS';
  return `${browser} on ${os}`;
}
