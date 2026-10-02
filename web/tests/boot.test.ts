import { describe, expect, it } from 'vitest';

import { buildDiagnostics, diagnosticsFileName } from '../src/boot/diagnostics.ts';
import { createFeed } from '../src/boot/feed.ts';
import { platformLabel, probeCapabilities } from '../src/boot/probe.ts';
import { newBootRecord, UserWait } from '../src/boot/record.ts';
import { RECOVERY_RUN } from '../src/boot/recovery-console.ts';
import { BOOT_POLICY_NAME, sameOriginScriptUrl, scriptUrlFactory } from '../src/boot/trusted.ts';

const NAV = {
  userAgent:
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  hardwareConcurrency: 8,
} as unknown as Navigator;

describe('boot time accounting (boot §3.2 stage 5)', () => {
  it('BOOT-10 user wait at the boot menu and the login screen is excluded from boot time', () => {
    let now = 0;
    const w = new UserWait(() => now);
    now = 100;
    w.begin();
    now = 2_100;
    w.begin(); // nested begin keeps the first start
    expect(w.active).toBe(true);
    expect(w.ms()).toBe(2_000);
    w.end();
    now = 5_000;
    w.end(); // unmatched end is ignored
    expect(w.ms()).toBe(2_000);
    w.begin();
    now = 5_500;
    w.end();
    expect(w.ms()).toBe(2_500);
    expect(w.active).toBe(false);
  });

  it('BOOT-11 a new boot record starts incomplete, cold without a controlling worker, with the build', () => {
    const r = newBootRecord({ version: '0.1.0', build: 'abc1234' }, NAV, true, 1_700_000_000_000);
    expect(r).toMatchObject({
      outcome: 'incomplete',
      kind: 'cold',
      profile: 'normal',
      build: { version: '0.1.0', build: 'abc1234' },
      env: { chromeMajor: 140, hwc: 8, isolated: true, swActive: false },
    });
  });
});

describe('boot diagnostics (boot §3.6, §6.1)', () => {
  it('BOOT-08 the diagnostics file carries the record, capabilities, services, panic and the klog tail', () => {
    const record = newBootRecord({ version: '0.1.0', build: 'abc1234' }, NAV, false, 1_000);
    const klog = Array.from({ length: 600 }, (_, i) => ({
      t: i / 1_000,
      sub: 'svc',
      level: 'info' as const,
      msg: `line ${String(i)}`,
    }));
    const d = buildDiagnostics(
      {
        record,
        caps: null,
        services: [{ name: 'sched', state: 'failed', reason: 'executor 1 crashed' }],
        klog,
        userAgent: NAV.userAgent,
        at: '2026-09-26T12:00:00.000Z',
        panic: { kind: 'critical', text: 'sched failed' },
      },
      1_000,
    );
    expect(d.fileName).toBe('plotinium-boot-t0-1000.json');
    const doc = JSON.parse(d.json) as {
      kind: string;
      klog: unknown[];
      panic: { text: string };
      services: { name: string }[];
    };
    expect(doc.kind).toBe('plotinium-boot-diagnostics');
    expect(doc.klog).toHaveLength(512);
    expect(doc.panic.text).toBe('sched failed');
    expect(doc.services[0]?.name).toBe('sched');
  });

  it('BOOT-08 the diagnostics file name is safe for every boot id', () => {
    expect(diagnosticsFileName('7f3e-b12c', 0)).toBe('plotinium-boot-7f3e-b12c.json');
    expect(diagnosticsFileName('../../etc/passwd', 0)).toBe('plotinium-boot-.._.._etc_passwd.json');
  });
});

describe('POST (boot §3.2.1)', () => {
  function fakeWindow(over: Record<string, unknown> = {}): Window & typeof globalThis {
    class FakeWorker {
      terminate(): void {
        // nothing to stop
      }
    }
    const base: Record<string, unknown> = {
      isSecureContext: true,
      crossOriginIsolated: true,
      SharedArrayBuffer,
      Worker: FakeWorker,
      indexedDB: {},
      crypto: { subtle: { digest: () => undefined } },
      CompressionStream: class {},
      performance: {},
      location: { host: 'localhost:4717' },
      navigator: { locks: {}, serviceWorker: { controller: null } },
    };
    return { ...base, ...over } as unknown as Window & typeof globalThis;
  }

  it('SVC-14 a complete browser passes POST with no fatal row', () => {
    const r = probeCapabilities(fakeWindow());
    expect(r.fatal).toBe(false);
    expect(r.rows.every((row) => row.status === 'pass')).toBe(true);
    expect(r.summary).toBe('POST ok (workers, indexeddb, crypto, isolated)');
  });

  it('SVC-14 an insecure context is fatal and names the localhost fix', () => {
    const r = probeCapabilities(fakeWindow({ isSecureContext: false }));
    expect(r.fatal).toBe(true);
    const row = r.rows.find((x) => x.name === 'Secure context');
    expect(row).toMatchObject({ status: 'missing', required: true });
    expect(row?.fix).toContain('localhost:4717');
  });

  it('SVC-14 missing IndexedDB is fatal; missing isolation only degrades', () => {
    const noIdb = fakeWindow();
    delete (noIdb as unknown as Record<string, unknown>)['indexedDB'];
    expect(probeCapabilities(noIdb).fatal).toBe(true);
    const r = probeCapabilities(fakeWindow({ crossOriginIsolated: false }));
    expect(r.fatal).toBe(false);
    expect(r.rows.find((x) => x.name === 'Cross-origin isolation')?.status).toBe('degraded');
  });

  it('SVC-14 the unsupported screen names the browser and OS', () => {
    expect(platformLabel(NAV.userAgent)).toBe('Chrome 140 on Linux');
    expect(
      platformLabel(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15',
      ),
    ).toBe('Safari 18 on macOS');
    expect(
      platformLabel('Mozilla/5.0 (Windows NT 10.0; rv:131.0) Gecko/20100101 Firefox/131.0'),
    ).toBe('Firefox 131 on Windows');
  });
});

describe('the recovery console actions (boot §3.8)', () => {
  it('BOOT-06 file-system check, clear cache and reset session are kernel recovery actions', () => {
    expect(RECOVERY_RUN.fsck).toBe('fsck');
    expect(RECOVERY_RUN.repair).toBe('fsck-repair');
    expect(RECOVERY_RUN['clear-cache']).toBe('clear-cache');
    expect(RECOVERY_RUN['reset-session']).toBe('reset-session');
    // Diagnostics and the two reboots work on the main thread even if the kernel never answers.
    expect(RECOVERY_RUN.diagnostics).toBeNull();
    expect(RECOVERY_RUN.reboot).toBeNull();
    expect(RECOVERY_RUN.safe).toBeNull();
  });
});

describe('boot feeds', () => {
  it('BOOT-07 a feed delivers every change to its subscribers until they unsubscribe', () => {
    const f = createFeed<readonly string[]>([]);
    const seen: (readonly string[])[] = [];
    const stop = f.subscribe((v) => seen.push(v));
    f.set(['auth degraded']);
    stop();
    f.set(['auth running']);
    expect(seen).toEqual([['auth degraded']]);
    expect(f.current()).toEqual(['auth running']);
  });
});

describe('Trusted Types on the boot path (security-model §3.9)', () => {
  const loc = { origin: 'http://localhost:4717', href: 'http://localhost:4717/?boot=menu' };

  it('SEC-22 the boot policy passes same-origin and same-origin blob: worker URLs only', () => {
    expect(sameOriginScriptUrl('/assets/kernel.worker-1.js', loc.origin, loc.href)).toBe(
      '/assets/kernel.worker-1.js',
    );
    expect(sameOriginScriptUrl('blob:http://localhost:4717/0b8f', loc.origin, loc.href)).toBe(
      'blob:http://localhost:4717/0b8f',
    );
    expect(() => sameOriginScriptUrl('https://evil.example/k.js', loc.origin, loc.href)).toThrow(
      /cross-origin/,
    );
    expect(() => sameOriginScriptUrl('blob:https://evil.example/1', loc.origin, loc.href)).toThrow(
      /cross-origin/,
    );
    expect(() => sameOriginScriptUrl('//evil.example/k.js', loc.origin, loc.href)).toThrow();
  });

  it('SEC-22 with Trusted Types the router creates one named policy and uses its script URLs', () => {
    const created: string[] = [];
    const factory = scriptUrlFactory({
      location: loc,
      trustedTypes: {
        createPolicy: (name: string, rules: { createScriptURL: (s: string) => string }) => {
          created.push(name);
          return { createScriptURL: (s: string) => ({ trusted: rules.createScriptURL(s) }) };
        },
      },
    } as unknown as { location: typeof loc });
    expect(created).toEqual([BOOT_POLICY_NAME]);
    expect(factory('/assets/kernel.worker-1.js')).toEqual({
      trusted: '/assets/kernel.worker-1.js',
    });
    expect(() => factory('https://evil.example/k.js')).toThrow(/cross-origin/);
  });

  it('SEC-22 without Trusted Types (or with the name refused) the check still applies', () => {
    expect(scriptUrlFactory({ location: loc })('/sw.js')).toBe('/sw.js');
    const refused = scriptUrlFactory({
      location: loc,
      trustedTypes: {
        createPolicy: () => {
          throw new TypeError('policy name not allowed');
        },
      },
    } as unknown as { location: typeof loc });
    expect(refused('/assets/a.js')).toBe('/assets/a.js');
    expect(() => refused('https://evil.example/a.js')).toThrow();
  });
});
