/**
 * The boot record (boot-and-services.md §4.6, SVC-09; BOOT-11): created by `storage` with outcome
 * `incomplete`, updated at desktop-interactive, when services settle and at shutdown; the last 20
 * are kept in IndexedDB `bootlog` (durability relaxed: diagnostic data). `bootlog` and
 * `/system/log/boot.log` read it.
 */
import type { BootProfile, ServiceManager, ServiceName } from '@plotinium/services';
import { bootTargetName, criticalPath } from '@plotinium/services';
import { uuidv7 } from '@plotinium/protocol';

import type { BuildIdentity } from '../host.ts';
import type { FsStore } from '../fs/store.ts';
import { messageOf, subOf } from '../klog/format.ts';
import type { Klog } from '../klog/klog.ts';
import { levelOf } from '../klog/records.ts';
import type { KlogInput } from '../klog/records.ts';

export const BOOT_RECORDS_KEPT = 20;

/** Whether a klog record belongs on the boot timeline (see `BootRecorder.lines`). */
export function onTimeline(r: KlogInput): boolean {
  if (r.kind === 'line') return true;
  if (r.kind === 'proc') return r.from === null || r.to === null || r.to === 'TERMINATED';
  return false;
}
export const BOOT_LOG_LINES_MAX = 512;

export interface BootLogLine {
  readonly t: number;
  readonly sub: string;
  readonly level: 'info' | 'warn' | 'degraded' | 'fail' | 'panic';
  readonly msg: string;
}

export interface BootServiceRow {
  readonly name: string;
  readonly level: number;
  readonly critical: boolean;
  readonly start: number | null;
  readonly end: number | null;
  readonly status: string;
  readonly attempts: number;
  readonly reason?: string;
  readonly userWaitMs?: number;
}

/** The persisted record (the §4.6 fields this kernel knows; stages come from the router). */
export interface BootRecord {
  readonly bootId: string;
  seq: number;
  readonly build: { readonly version: string; readonly build: string };
  readonly profile: BootProfile;
  readonly verbose: boolean;
  readonly flags: readonly string[];
  readonly t0: number;
  services: BootServiceRow[];
  userWaitMs: number;
  interactiveAt: number | null;
  /**
   * Seconds since t0 when the login screen first waited for a user: every critical service was up.
   * The loader counts a boot that got this far as healthy (host/boot-volume.ts, UI-058).
   */
  loginAt?: number;
  bootMs: number | null;
  outcome: 'interactive' | 'panic' | 'recovery' | 'incomplete' | 'unsupported';
  log: BootLogLine[];
  shutdown?: { kind: 'reboot' | 'poweroff' | 'pagehide'; at: number; clean: boolean };
}

export interface CriticalRow {
  readonly name: ServiceName;
  readonly start: number;
  readonly end: number;
  readonly own: number;
  readonly gatedBy: ServiceName | null;
}

export interface BootRecorderDeps {
  readonly klog: Klog;
  readonly identity: BuildIdentity;
  /** Kernel clock ms → epoch ms. */
  readonly epochAtZero: number;
  /** Main-thread `performance.timeOrigin` (epoch ms); boot times are seconds since it. */
  readonly t0: () => number;
  readonly services: () => ServiceManager | null;
  readonly now: () => number;
}

export class BootRecorder {
  private readonly deps: BootRecorderDeps;
  private rec: BootRecord | null = null;
  private store: FsStore | null = null;

  constructor(deps: BootRecorderDeps) {
    this.deps = deps;
  }

  get current(): BootRecord | null {
    return this.rec;
  }

  /** Seconds since t0 of a kernel-clock time. */
  secs(kernelMs: number): number {
    return Math.max(0, (this.deps.epochAtZero + kernelMs - this.deps.t0()) / 1_000);
  }

  /**
   * The klog of this boot as boot-log lines (at most `max`, newest kept): subsystem lines and
   * process creation and exit. Syscall traces, memory records and scheduler transitions (READY,
   * RUNNING, BLOCKED) are dmesg's, not the boot timeline's (UI-135): a busy desktop writes hundreds
   * of them a second and would push the boot out of the ring's window.
   */
  lines(max = BOOT_LOG_LINES_MAX): BootLogLine[] {
    return this.deps.klog
      .read()
      .filter(onTimeline)
      .slice(-max)
      .map((r) => ({
        t: this.secs(r.t),
        sub: subOf(r).slice(0, 32),
        level: levelOf(r),
        msg: messageOf(r).slice(0, 1_024),
      }));
  }

  /** The `storage` service created the database: write the `incomplete` record (SVC-09). */
  async create(
    store: FsStore,
    o: { profile: BootProfile; flags: readonly string[]; verbose: boolean },
  ): Promise<string> {
    this.store = store;
    let seq = 1;
    await store.scan<{ seq?: unknown }>('bootlog', null, (r) => {
      if (typeof r.seq === 'number' && r.seq >= seq) seq = r.seq + 1;
    });
    this.rec = {
      bootId: uuidv7(),
      seq,
      build: { version: this.deps.identity.version, build: this.deps.identity.build },
      profile: o.profile,
      verbose: o.verbose,
      flags: [...o.flags],
      t0: this.deps.t0(),
      services: [],
      userWaitMs: 0,
      interactiveAt: null,
      bootMs: null,
      outcome: 'incomplete',
      log: [],
    };
    await this.write(true);
    return this.rec.bootId;
  }

  private snapshotServices(): void {
    const rec = this.rec;
    const mgr = this.deps.services();
    if (rec === null || mgr === null) return;
    rec.services = mgr.timings().map((s) => ({
      name: s.name,
      level: s.level,
      critical: s.critical,
      start: s.start === null ? null : this.secs(s.start),
      end: s.end === null ? null : this.secs(s.end),
      status: s.status,
      attempts: s.attempts,
      ...(s.reason === undefined ? {} : { reason: s.reason }),
      ...(s.userWaitMs === undefined ? {} : { userWaitMs: s.userWaitMs }),
    }));
    rec.userWaitMs = rec.services.reduce((n, s) => n + (s.userWaitMs ?? 0), 0);
  }

  /** The login screen waits for a user (once per boot): the boot itself succeeded (UI-058). */
  async loginReady(): Promise<void> {
    const rec = this.rec;
    if (rec === null || rec.loginAt !== undefined) return;
    rec.loginAt = this.secs(this.deps.now());
    await this.write(false);
  }

  /**
   * The current boot's timeline for `bootlog` and /system/log/boot.log: frozen in the record from
   * desktop-interactive on (refreshed while late services settle), so later activity never
   * replaces it; live from klog before that (UI-135).
   */
  timeline(max = BOOT_LOG_LINES_MAX): BootLogLine[] {
    const rec = this.rec;
    if (rec === null || rec.interactiveAt === null || rec.log.length === 0) return this.lines(max);
    return rec.log.slice(-max);
  }

  /** Stored boot records, newest first (`bootlog --list`). */
  async records(): Promise<BootRecord[]> {
    const store = this.store;
    if (store === null) return this.rec === null ? [] : [this.rec];
    const out: BootRecord[] = [];
    await store.scan<BootRecord>('bootlog', null, (r) => {
      if (typeof r.seq === 'number' && typeof r.bootId === 'string') out.push(r);
    });
    const cur = this.rec;
    if (cur !== null) {
      const i = out.findIndex((r) => r.bootId === cur.bootId);
      if (i === -1) out.push(cur);
      else out[i] = cur;
    }
    return out.sort((a, b) => b.seq - a.seq);
  }

  /** `desktop-interactive` (§3.2.4): boot time = interactiveAt − user wait. */
  async interactive(): Promise<void> {
    const rec = this.rec;
    if (rec === null) return;
    this.snapshotServices();
    rec.interactiveAt = this.secs(this.deps.now());
    rec.bootMs = Math.max(0, Math.round(rec.interactiveAt * 1_000 - rec.userWaitMs));
    rec.outcome = 'interactive';
    rec.log = this.lines();
    await this.write(false);
  }

  /** Non-critical services settled, or a later refresh: late service lines join the timeline. */
  async refresh(): Promise<void> {
    if (this.rec === null) return;
    this.snapshotServices();
    this.rec.log = this.lines();
    await this.write(false);
  }

  /**
   * Shutdown: the services' final states and how the boot ended. A boot that reached the desktop
   * keeps its frozen timeline (hours of later activity are not the boot log, UI-135); one that did
   * not stores what it has.
   */
  async shutdown(kind: 'reboot' | 'poweroff' | 'pagehide'): Promise<void> {
    if (this.rec === null) return;
    this.snapshotServices();
    this.rec.shutdown = { kind, at: this.secs(this.deps.now()), clean: kind !== 'pagehide' };
    if (this.rec.interactiveAt === null) this.rec.log = this.lines();
    await this.write(false);
  }

  private async write(prune: boolean): Promise<void> {
    const store = this.store;
    const rec = this.rec;
    if (store === null || rec === null) return;
    const old: string[] = [];
    if (prune) {
      const all: { bootId: string; seq: number }[] = [];
      await store.scan<{ bootId?: unknown; seq?: unknown }>('bootlog', null, (r) => {
        if (typeof r.bootId === 'string')
          all.push({ bootId: r.bootId, seq: typeof r.seq === 'number' ? r.seq : 0 });
      });
      all.sort((a, b) => b.seq - a.seq);
      for (const r of all.slice(BOOT_RECORDS_KEPT - 1)) old.push(r.bootId);
    }
    const copy = structuredClone(rec);
    await store.tx(
      ['bootlog'],
      'relaxed',
      (t) => {
        t.put('bootlog', copy);
        for (const id of old) t.del('bootlog', id);
      },
      { label: 'bootlog' },
    );
  }

  /** The previous boot's record (`bootlog --boot previous`). */
  async previous(): Promise<BootRecord | null> {
    const store = this.store;
    const cur = this.rec;
    if (store === null) return null;
    let best: BootRecord | null = null;
    await store.scan<BootRecord>('bootlog', null, (r) => {
      if (r.bootId === cur?.bootId || typeof r.seq !== 'number') return;
      if (best === null || r.seq > best.seq) best = r;
    });
    return best;
  }

  /** BOOT-11: the chain of services that determined the boot time (§5.8), kernel-clock ms. */
  criticalPath(): CriticalRow[] {
    const mgr = this.deps.services();
    if (mgr === null) return [];
    const target = bootTargetName(this.rec?.profile ?? 'normal');
    return criticalPath(mgr.timings(), mgr.requiresMap(), target).map((r) => ({
      name: r.name,
      start: r.start,
      end: r.end,
      own: r.own,
      gatedBy: r.gatedBy,
    }));
  }
}
