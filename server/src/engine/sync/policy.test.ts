/**
 * Close codes, backpressure, the watchdog timers and the frame throttle (offline-and-sync.md §3.7,
 * §3.9 step 5, §4.5, §4.6.1; backend-api.md §3.7), plus conflicted-copy names (§3.12.2) and the
 * SYN-18 visibility filter (§3.8.4 rule 5).
 */
import { describe, expect, it } from 'vitest';

import { CLOSE_AT, COALESCE_AT, type Change } from '@plotinium/protocol';
import { NAME_MAX, utf8Length } from '@plotinium/vfs/path';

import { systemClock } from './clock.ts';
import { backpressure, BYE_CLOSE_CODE, leaseActionOnClose } from './close-policy.ts';
import { conflictName, isoDate, splitExtension } from './names.ts';
import { ManualClock } from './tests/manual-clock.ts';
import { FrameThrottle } from './throttle.ts';
import { canSeeIn, contextInos, filterChanges, type DirContext } from './visibility.ts';
import { ConnectionWatchdog } from './watchdog.ts';

describe('VFS-09 close codes and leases (§4.5, §3.14.5)', () => {
  it('VFS-09 bye or a clean client close releases leases at once; abnormal and server-initiated closes keep them', () => {
    expect(leaseActionOnClose({ code: 1006, byeReceived: true, serverInitiated: false })).toBe(
      'release',
    );
    expect(leaseActionOnClose({ code: 1000, byeReceived: false, serverInitiated: false })).toBe(
      'release',
    );
    expect(leaseActionOnClose({ code: 1001, byeReceived: false, serverInitiated: false })).toBe(
      'release',
    );
    expect(leaseActionOnClose({ code: 1006, byeReceived: false, serverInitiated: false })).toBe(
      'keep',
    );
    expect(leaseActionOnClose({ code: 1000, byeReceived: false, serverInitiated: true })).toBe(
      'keep',
    );
    expect(leaseActionOnClose({ code: 1012, byeReceived: false, serverInitiated: true })).toBe(
      'keep',
    );
  });

  it('SYN-12 every server bye reason maps to its close code', () => {
    expect(BYE_CLOSE_CODE).toEqual({
      restart: 1012,
      shutdown: 1012,
      revoked: 4401,
      superseded: 4409,
      'upgrade-required': 1008,
      'idle-timeout': 4408,
      'protocol-error': 1008,
      'rate-limited': 4429,
      'slow-consumer': 4508,
      policy: 1008,
    });
  });

  it('SYN-12 backpressure coalesces live feed entries above 256 KiB and closes above 4 MiB; control replies still go', () => {
    expect(backpressure(0, 'feed')).toBe('send');
    expect(backpressure(COALESCE_AT + 1, 'feed')).toBe('coalesce');
    expect(backpressure(COALESCE_AT + 1, 'control')).toBe('send');
    expect(backpressure(CLOSE_AT + 1, 'control')).toBe('close');
  });
});

describe('SYN-10 server-side timers on an injectable clock (§3.7, §4.5)', () => {
  it('SYN-10 the process clock fires once, can be cancelled and never keeps the process alive', async () => {
    const before = systemClock.now();
    expect(Math.abs(before - Date.now())).toBeLessThan(1_000);
    const fired: string[] = [];
    systemClock.setTimer(1, () => fired.push('a'));
    systemClock.setTimer(1, () => fired.push('b')).cancel();
    systemClock.setTimer(-5, () => fired.push('c')); // a negative delay is clamped to 0
    await new Promise((r) => setTimeout(r, 20));
    expect(fired.sort()).toEqual(['a', 'c']);
  });

  function watchdog(idleTimeoutMs = 15_000) {
    const clock = new ManualClock();
    const events: string[] = [];
    const w = new ConnectionWatchdog({
      clock,
      idleTimeoutMs,
      onTimeout: (k) => events.push(`timeout:${k}`),
      ping: () => events.push('ping'),
      terminate: () => events.push('terminate'),
    });
    return { clock, events, w };
  }

  it('SYN-10 no hello within 5 s closes with 4408', async () => {
    const { clock, events, w } = watchdog();
    w.start();
    await clock.advance(4_999);
    expect(events).toEqual([]);
    await clock.advance(1);
    expect(events).toEqual(['timeout:hello']);
  });

  it('SYN-10 no application frame for leaseTtlMs closes with 4408; frames push the deadline back', async () => {
    const { clock, events, w } = watchdog();
    w.start();
    w.helloReceived();
    await clock.advance(10_000);
    w.appFrame();
    await clock.advance(10_000);
    expect(events.filter((e) => e.startsWith('timeout'))).toEqual([]);
    await clock.advance(5_001);
    expect(events.filter((e) => e.startsWith('timeout'))).toEqual(['timeout:idle']);
  });

  it('SYN-10 a ping every 20 s; a missed pong terminates the socket, and pongs never count as app frames', async () => {
    const { clock, events, w } = watchdog(120_000);
    w.start();
    w.helloReceived();
    await clock.advance(20_000);
    expect(events).toEqual(['ping']);
    w.pong();
    w.appFrame();
    await clock.advance(20_000);
    expect(events).toEqual(['ping', 'ping']);
    await clock.advance(20_000);
    expect(events).toEqual(['ping', 'ping', 'terminate']);
    w.stop();
    await clock.advance(60_000);
    expect(events).toHaveLength(3);
  });
});

describe('SYN-06 frame throttle: throttle replay, never disconnect it (§3.9 step 5)', () => {
  it('SYN-06 an empty bucket answers throttle once per window and a replaying op lane is never closed', () => {
    const clock = new ManualClock();
    const t = new FrameThrottle({ clock, ratePerSecond: 50, burst: 200 });
    for (let i = 0; i < 200; i++) expect(t.admit('op').kind).toBe('ok');
    const first = t.admit('op');
    expect(first).toMatchObject({ kind: 'throttle', notify: true });
    for (let i = 0; i < 100; i++) expect(t.admit('op').kind).toBe('throttle');
    expect(t.admit('op')).toMatchObject({ notify: false });
  });

  it('SYN-06 control frames that ignore a throttle three times within 10 s are closed 4429 (non-replay abuse)', () => {
    const clock = new ManualClock();
    const t = new FrameThrottle({ clock, ratePerSecond: 1, burst: 1 });
    expect(t.admit('control').kind).toBe('ok');
    expect(t.admit('control')).toMatchObject({ kind: 'throttle', notify: true });
    expect(t.admit('control').kind).toBe('throttle');
    expect(t.admit('control').kind).toBe('throttle');
    expect(t.admit('control').kind).toBe('close');
  });
});

describe('VFS-10 conflicted-copy names (§3.12.2)', () => {
  it('VFS-10 the name keeps the extension after the last dot, dotfiles have none, and n >= 2 is appended inside', () => {
    expect(conflictName('report.md', 'alice', '2026-11-14', () => false)).toBe(
      'report (conflict from alice, 2026-11-14).md',
    );
    expect(conflictName('archive.tar.gz', 'bob', '2026-11-14', () => false)).toBe(
      'archive.tar (conflict from bob, 2026-11-14).gz',
    );
    expect(conflictName('.bashrc', 'alice', '2026-11-14', () => false)).toBe(
      '.bashrc (conflict from alice, 2026-11-14)',
    );
    const taken = new Set(['notes (conflict from bob, 2026-11-14).md']);
    expect(conflictName('notes.md', 'bob', '2026-11-14', (c) => taken.has(c))).toBe(
      'notes (conflict from bob, 2026-11-14) 2.md',
    );
    expect(splitExtension('Makefile')).toEqual({ stem: 'Makefile', ext: '' });
  });

  it('VFS-10 long names are shortened at a code-point boundary to stay within 255 bytes', () => {
    const long = `${'é'.repeat(140)}.txt`;
    const name = conflictName(long, 'alice', '2026-11-14', () => false);
    expect(utf8Length(name)).toBeLessThanOrEqual(NAME_MAX);
    expect(name.endsWith(' (conflict from alice, 2026-11-14).txt')).toBe(true);
    expect(name.isWellFormed()).toBe(true);
    const hugeExt = `a.${'x'.repeat(260)}`;
    expect(
      utf8Length(conflictName(hugeExt, 'alice', '2026-11-14', () => false)),
    ).toBeLessThanOrEqual(NAME_MAX);
  });

  it('VFS-10 the date is the commit date in PLOTINIUM_TZ (Asia/Karachi by default)', () => {
    const lateUtc = Date.UTC(2026, 10, 13, 20, 30); // 01:30 on the 14th in Karachi (UTC+5)
    expect(isoDate(lateUtc)).toBe('2026-11-14');
    expect(isoDate(lateUtc, 'UTC')).toBe('2026-11-13');
  });
});

describe('SYN-18 feed entries filtered by the receiver current permissions (§3.8.4)', () => {
  const ROOT = 'root';
  const HOME = 'home';
  const PRIV = 'priv';
  const PUB = 'pub';
  const ctx: DirContext = new Map([
    [ROOT, { row: { type: 'd', mode: 0o755, uid: 0, gid: 0 }, parent: null }],
    [HOME, { row: { type: 'd', mode: 0o755, uid: 0, gid: 0 }, parent: ROOT }],
    [PRIV, { row: { type: 'd', mode: 0o700, uid: 1002, gid: 1002 }, parent: HOME }],
    [PUB, { row: { type: 'd', mode: 0o755, uid: 1002, gid: 1002 }, parent: HOME }],
    ['secret-file', { row: { type: 'f', mode: 0o600, uid: 1002, gid: 1002 }, parent: PUB }],
  ]);
  const alice = { uid: 1001, gid: 1001, groups: [1001] };
  const blob = 'a'.repeat(64);

  it('SYN-18 an entry about a file the receiver cannot read arrives redacted and still advances the cursor', () => {
    const changes: Change[] = [
      { kind: 'upsert', ino: 'x', version: 2, parentIno: PRIV, name: 'plan.md' },
    ];
    expect(filterChanges(alice, 1002, changes, ctx)).toEqual({ changes: [], redacted: true });
    expect(filterChanges({ uid: 1002, gid: 1002, groups: [1002] }, 1002, changes, ctx)).toEqual({
      changes,
      redacted: false,
    });
    expect(filterChanges(alice, 1002, [], ctx)).toEqual({ changes: [], redacted: false });
  });

  it('SYN-18 a visible entry loses its blob unless the receiver may read the inode', () => {
    const visible: Change[] = [
      {
        kind: 'upsert',
        ino: 'secret-file',
        version: 2,
        parentIno: PUB,
        name: 's',
        blob,
        type: 'f',
        mode: 0o600,
        uid: 1002,
        gid: 1002,
      },
      {
        kind: 'upsert',
        ino: 'open-file',
        version: 2,
        parentIno: PUB,
        name: 'o',
        blob,
        type: 'f',
        mode: 0o644,
        uid: 1002,
        gid: 1002,
      },
      { kind: 'upsert', ino: 'secret-file', version: 3, blob },
    ];
    const out = filterChanges(alice, 1002, visible, ctx);
    expect(out.redacted).toBe(false);
    expect(out.changes.map((c) => c.blob)).toEqual([undefined, blob, undefined]);
  });

  it('SYN-18 a move into a hidden directory is seen as an unlink from the visible one; missing rows hide a change', () => {
    const move: Change = {
      kind: 'move',
      ino: 'f1',
      version: 3,
      parentIno: PRIV,
      name: 'n',
      fromParentIno: PUB,
      fromName: 'old',
    };
    expect(filterChanges(alice, 1002, [move], ctx).changes).toEqual([
      { kind: 'unlink', ino: 'f1', version: 3, parentIno: PUB, name: 'old' },
    ]);
    expect(canSeeIn(alice, 'nowhere', ctx)).toBe(false);
    expect(canSeeIn(alice, null, ctx)).toBe(false);
    const orphan: DirContext = new Map([
      ['d', { row: { type: 'd', mode: 0o755, uid: 0, gid: 0 }, parent: 'missing' }],
    ]);
    expect(canSeeIn(alice, 'd', orphan)).toBe(false);
    expect(contextInos([move]).sort()).toEqual(['f1', PRIV, PUB].sort());
  });
});
