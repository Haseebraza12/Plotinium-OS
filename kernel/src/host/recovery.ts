/**
 * The kernel's side of the recovery console (boot-and-services.md §3.8, SVC-06, BOOT-06; UI-057).
 *
 * The console (web/src/boot/recovery-console.ts) posts `recovery.run {action}`; no process or uid
 * exists. The answer is klog lines whose subsystem is the action's name (`fsck: …`, `bootlog: …`),
 * which stream into the console's output and end its wait. Every action answers, also when it
 * cannot run (then with a WARN line saying why).
 *
 *   fsck               the VFS-11 check of the local store, read-only: counts and every failed
 *                      invariant with examples
 *   fsck-repair        the same, then the repairs in ONE local transaction (no outbox op; the next
 *                      online login re-converges from the server)
 *   bootlog            the last 20 boot records, newest first, and the critical path of the newest
 *                      completed one
 *   reset-session      every saved desktop layout of this device is kept as `<id>.recovery-<bootId>`,
 *                      so the next boot starts a clean session
 *   restore-manifests  answered truthfully: this build boots from its built-in manifests
 *                      (host/boot-volume.ts), so there is nothing on the volume to restore
 *   clear-cache        deletes the local database and reboots, but ONLY when the outbox holds no
 *                      unsynced change: the console cannot export the outbox yet, and deleting it
 *                      would lose work
 * `diagnostics` and the two reboots are the console's own (main thread).
 */
import type { ServiceName } from '@plotinium/services';
import { bootTargetName, criticalPath } from '@plotinium/services';
import type { OutboxRec } from '@plotinium/vfs';
import { applyRepair, fsck } from '@plotinium/vfs';
import type { FsckInput, InvariantResult } from '@plotinium/vfs';

import type { BootRecord } from '../core/io/bootlog.ts';
import type { FsStore } from '../core/fs/store.ts';
import { outcomeOf } from './boot-volume.ts';
import type { RouterToKernel } from './router-protocol.ts';

export type RecoveryAction = Extract<RouterToKernel, { t: 'recovery.run' }>['action'];

type Level = 'info' | 'warn' | 'fail';

export interface RecoveryDeps {
  /** The device store (the read-only `vfs` mount's), or null when it did not open. */
  readonly store: () => FsStore | null;
  /** A klog line; `sub` is the action's name so the console matches it to the action. */
  readonly log: (sub: string, level: Level, msg: string) => void;
  /** This boot's id (the recovery suffix of kept sessions). */
  readonly bootId: () => string;
  /** How many built-in service manifests this build boots from. */
  readonly builtinManifests: number;
  /** The service graph, for the critical path of a stored boot. */
  readonly requires: () => ReadonlyMap<ServiceName, readonly ServiceName[]> | null;
  /** Delete an IndexedDB database (the worker's `indexedDB.deleteDatabase`); absent: unsupported. */
  readonly deleteDatabase?: (name: string) => Promise<void>;
  /** Reboot into a normal boot (the BOOT-12 halt path). */
  readonly reboot: () => void;
  /** Epoch ms (the `fsck --repair` repair time). */
  readonly now: () => number;
}

/** Boot records the `bootlog` action lists (the whole ring). */
export const RECOVERY_BOOTLOG_MAX = 20;
/** Failed-invariant examples printed per invariant. */
const EXAMPLES_MAX = 3;

async function scanAll<T>(store: FsStore, name: Parameters<FsStore['scan']>[0]): Promise<T[]> {
  const out: T[] = [];
  await store.scan<T>(name, null, (r) => out.push(r));
  return out;
}

/** Every row fsck needs, read from the store. */
export async function fsckInputOf(store: FsStore): Promise<FsckInput> {
  const [inodes, dentries, users, blobs, outbox, undo] = await Promise.all([
    scanAll<FsckInput['inodes'][number]>(store, 'inodes'),
    scanAll<FsckInput['dentries'][number]>(store, 'dentries'),
    scanAll<NonNullable<FsckInput['users']>[number]>(store, 'users'),
    scanAll<NonNullable<FsckInput['blobs']>[number]>(store, 'blobs'),
    scanAll<OutboxRec>(store, 'outbox'),
    scanAll<NonNullable<FsckInput['undo']>[number]>(store, 'undo'),
  ]);
  return { inodes, dentries, users, blobs, outbox, undo };
}

function invariantLines(sub: string, results: readonly InvariantResult[]): [Level, string][] {
  const out: [Level, string][] = [];
  for (const r of results) {
    if (r.ok) continue;
    const ex = r.examples.slice(0, EXAMPLES_MAX).join('; ');
    out.push(['warn', `${sub}: ${r.id} failed ×${String(r.count)}${ex === '' ? '' : ` (${ex})`}`]);
  }
  for (const r of results)
    for (const w of r.warnings.slice(0, EXAMPLES_MAX)) out.push(['info', `${sub}: ${r.id} ${w}`]);
  return out;
}

async function runFsck(deps: RecoveryDeps, repair: boolean): Promise<void> {
  const sub = repair ? 'fsck-repair' : 'fsck';
  const store = deps.store();
  if (store === null) {
    deps.log(sub, 'warn', `${sub}: the local store is not open; nothing to check`);
    return;
  }
  const input = await fsckInputOf(store);
  const { report, diff } = fsck(input, { repair, now: deps.now() });
  const failed = report.invariants.filter((r) => !r.ok);
  deps.log(
    sub,
    'info',
    `${sub}: checked ${String(report.checked.inodes)} inodes, ${String(report.checked.dentries)} entries, ${String(report.checked.blobs)} blobs · ${String(report.invariants.length)} invariants`,
  );
  for (const [level, msg] of invariantLines(sub, report.invariants)) deps.log(sub, level, msg);
  if (repair && diff !== null && (report.repaired?.length ?? 0) > 0) {
    await applyRepair(store, diff);
    const n = (report.repaired ?? []).reduce((a, r) => a + r.count, 0);
    deps.log(
      sub,
      'info',
      `${sub}: repaired ${String(n)} problem${n === 1 ? '' : 's'} locally (${(report.repaired ?? []).map((r) => `${r.id}×${String(r.count)}`).join(', ')}); the next online login re-validates against the server`,
    );
  }
  deps.log(
    sub,
    failed.length === 0 || report.exitCode === 2 ? 'info' : 'warn',
    report.exitCode === 0
      ? `${sub}: clean`
      : report.exitCode === 2
        ? `${sub}: done, ${String(failed.length)} problem${failed.length === 1 ? '' : 's'} left`
        : `${sub}: ${String(failed.length)} problem${failed.length === 1 ? '' : 's'} found${repair ? '' : ' (Y repairs them)'}`,
  );
}

function when(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 16).replace('T', ' ');
}

async function runBootlog(deps: RecoveryDeps): Promise<void> {
  const store = deps.store();
  if (store === null) {
    deps.log('bootlog', 'warn', 'bootlog: the local store is not open; no boot records');
    return;
  }
  const recs = (await scanAll<BootRecord>(store, 'bootlog'))
    .filter((r) => typeof r.seq === 'number')
    .sort((a, b) => b.seq - a.seq)
    .slice(0, RECOVERY_BOOTLOG_MAX);
  deps.log('bootlog', 'info', `bootlog: ${String(recs.length)} boot records, newest first`);
  for (const r of recs) {
    const took = r.bootMs === null ? '' : ` · ${(r.bootMs / 1_000).toFixed(2)} s`;
    // As the loader counts it (boot-volume.ts): a recovery boot is `recovery`, a boot left at the
    // login screen is healthy.
    const counted = outcomeOf(r as unknown as Record<string, unknown>) ?? r.outcome;
    const login = r.outcome === 'incomplete' && r.loginAt !== undefined ? ' (reached login)' : '';
    deps.log(
      'bootlog',
      counted === 'interactive' || counted === 'recovery' ? 'info' : 'warn',
      `bootlog: #${String(r.seq)} ${when(r.t0)} · ${r.profile} · ${counted}${login}${took} · build ${r.build.build}`,
    );
  }
  const done = recs.find((r) => r.outcome === 'interactive');
  const requires = deps.requires();
  if (done === undefined || requires === null) return;
  const rows = criticalPath(
    done.services.map((s) => ({
      name: s.name,
      level: s.level,
      start: s.start,
      end: s.end,
      ...(s.userWaitMs === undefined ? {} : { userWaitMs: s.userWaitMs }),
    })),
    requires,
    bootTargetName(done.profile),
  );
  if (rows.length === 0) return;
  deps.log(
    'bootlog',
    'info',
    `bootlog: critical path of #${String(done.seq)}: ${rows
      .map((r) => `${r.name} ${r.own.toFixed(2)} s`)
      .join(' → ')}`,
  );
}

async function runResetSession(deps: RecoveryDeps): Promise<void> {
  const store = deps.store();
  if (store === null) {
    deps.log('reset-session', 'warn', 'reset-session: the local store is not open');
    return;
  }
  const rows = (await scanAll<Record<string, unknown>>(store, 'os_sessions')).filter(
    (r) => typeof r['osSessionId'] === 'string' && r['recoveryOf'] === undefined,
  );
  if (rows.length === 0) {
    deps.log('reset-session', 'info', 'reset-session: no saved session; the next boot is clean');
    return;
  }
  const bootId = deps.bootId();
  await store.tx(
    ['os_sessions'],
    'strict',
    (t) => {
      for (const r of rows) {
        const id = r['osSessionId'] as string;
        t.put('os_sessions', { ...r, osSessionId: `${id}.recovery-${bootId}`, recoveryOf: id });
        t.del('os_sessions', id);
      }
    },
    { label: 'recovery: reset session' },
  );
  deps.log(
    'reset-session',
    'info',
    `reset-session: ${String(rows.length)} saved layout${rows.length === 1 ? '' : 's'} kept as *.recovery-${bootId.slice(0, 8)}…; the next boot starts a clean session`,
  );
}

async function runClearCache(deps: RecoveryDeps): Promise<void> {
  const store = deps.store();
  if (store === null || deps.deleteDatabase === undefined) {
    deps.log('clear-cache', 'warn', 'clear-cache: the local database cannot be deleted from here');
    return;
  }
  const outbox = await scanAll<OutboxRec>(store, 'outbox');
  const unsynced = outbox.filter((r) => r.state === 'pending' || r.state === 'parked').length;
  if (unsynced > 0) {
    deps.log(
      'clear-cache',
      'warn',
      `clear-cache: refused: ${String(unsynced)} unsynced change${unsynced === 1 ? '' : 's'} would be lost. Reboot normally (N) and sign in online so they sync first`,
    );
    return;
  }
  deps.log('clear-cache', 'info', 'clear-cache: no unsynced changes; deleting the local database');
  // The store's connection closes itself on the delete's versionchange (vfs IdbStore).
  await deps.deleteDatabase('plotinium');
  deps.log('clear-cache', 'info', 'clear-cache: done; rebooting (the next boot is a first boot)');
  deps.reboot();
}

/** Run one console action; always answers with at least one klog line, never throws. */
export async function runRecovery(action: RecoveryAction, deps: RecoveryDeps): Promise<void> {
  try {
    switch (action) {
      case 'fsck':
        await runFsck(deps, false);
        return;
      case 'fsck-repair':
        await runFsck(deps, true);
        return;
      case 'bootlog':
        await runBootlog(deps);
        return;
      case 'reset-session':
        await runResetSession(deps);
        return;
      case 'restore-manifests':
        deps.log(
          'restore-manifests',
          'info',
          `restore-manifests: nothing to restore: this build boots from its ${String(deps.builtinManifests)} built-in service manifests, not from /system/services`,
        );
        return;
      case 'clear-cache':
        await runClearCache(deps);
        return;
      case 'diagnostics':
        deps.log('diagnostics', 'info', 'diagnostics: saved by the console (D), not the kernel');
        return;
    }
  } catch (e) {
    deps.log(action, 'fail', `${action}: failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
