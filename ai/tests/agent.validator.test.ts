import type { PlanStep } from '@plotinium/protocol';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { FROZEN_NOW, QUOTAS, TZ, USERS, at, buildFxAgt } from '../eval/fixtures/fx-agt.ts';
import { type FixtureEntry, buildTree } from '../eval/fixtures/tree.ts';
import { Overlay, normalizePath } from '../src/agent/fsview.ts';
import { globMatch } from '../src/agent/glob.ts';
import {
  bindIntent,
  isGrounded,
  licensed,
  normalizeText,
  opClassOf,
  wordMatch,
} from '../src/agent/intent.ts';
import { describeRelTime, matchesRelTime, resolveSpan } from '../src/agent/reltime.ts';
import { runFind } from '../src/agent/select.ts';
import { type ValidateInput, modeDisplay, validatePlan } from '../src/agent/validator.ts';
import { posixOracle } from './doubles.ts';

const A = USERS.alice;
const HOME = A.home;
const TXN = '0192f0c1-0000-7000-8000-000000000001';

function input(
  steps: PlanStep[],
  request: string,
  over: Partial<ValidateInput> = {},
): ValidateInput {
  return {
    requestId: '0192f0c1-0000-7000-8000-0000000000aa',
    steps,
    request,
    clarifications: [],
    cred: { uid: A.uid, gid: A.gid, groups: [...A.groups] },
    home: HOME,
    cwd: HOME,
    umask: 0o022,
    now: FROZEN_NOW,
    tz: TZ,
    txnId: TXN,
    snapshot: buildFxAgt().tree.snapshot,
    oracle: posixOracle,
    quota: {
      quota: (uid) =>
        QUOTAS[uid] ?? { usedBytes: 0, quotaBytes: null, usedInodes: 0, quotaInodes: null },
    },
    ...over,
  };
}

const step = (
  id: string,
  op: PlanStep['op'],
  args: unknown,
  span: string,
  sources?: PlanStep['sources'],
): PlanStep => (sources === undefined ? { id, op, args, span } : { id, op, args, span, sources });

describe('validator (AGT-02)', () => {
  it('AGT-02 a plan with an unknown call is rejected with EINVAL and nothing runs', () => {
    const r = validatePlan(
      input(
        [{ id: 's1', op: 'exec' as PlanStep['op'], args: { cmd: 'rm -rf ~' }, span: 'x' }],
        'x',
      ),
    );
    expect(!r.ok && r.error).toMatchObject({ errno: 'EINVAL' });
  });

  it('AGT-02 bad arguments, step order and bad references are rejected with EINVAL', () => {
    const bad = validatePlan(
      input([step('s1', 'mkdir', { path: '~/x', uid: 0 }, 'make x')], 'make x'),
    );
    expect(!bad.ok && bad.error).toMatchObject({
      errno: 'EINVAL',
      reason: 'bad-arguments',
      step: 's1',
    });
    const order = validatePlan(
      input(
        [
          step('s2', 'mkdir', { path: '~/a' }, 'make a'),
          step('s1', 'mkdir', { path: '~/b' }, 'make a'),
        ],
        'make a',
      ),
    );
    expect(!order.ok && order.error.reason).toBe('step-order');
    const ref = validatePlan(
      input(
        [
          step('s1', 'mkdir', { path: '~/a' }, 'make a'),
          step('s2', 'unlink', { path: '~' }, 'make a', { ref: 's1' }),
        ],
        'make a',
      ),
    );
    expect(!ref.ok && ref.error.reason).toBe('bad-ref');
    const src = validatePlan(
      input([step('s1', 'mkdir', { path: '~/a' }, 'make a', ['/home/alice/x'])], 'make a'),
    );
    expect(!src.ok && src.error.reason).toBe('sources-not-allowed');
  });

  it('AGT-02 a plan with a missing source path is rejected with ENOENT and nothing runs', () => {
    const r = validatePlan(
      input(
        [step('s1', 'rename', { from: '~/nope.txt', to: '~/x.txt' }, 'move nope.txt to x.txt')],
        'move nope.txt to x.txt',
      ),
    );
    expect(!r.ok && r.error).toMatchObject({ errno: 'ENOENT', step: 's1' });
  });

  it('AGT-02 a plan that needs write permission the user lacks is rejected with EACCES', () => {
    const r = validatePlan(
      input(
        [step('s1', 'mkdir', { path: '~/frozen/sub' }, 'create sub in frozen')],
        'create sub in frozen',
      ),
    );
    expect(!r.ok && r.error.errno).toBe('EACCES');
  });

  it('AGT-02 a plan that exceeds quota is rejected with EDQUOT', () => {
    const r = validatePlan(
      input(
        [
          step(
            's1',
            'copy',
            { from: '~/photos', to: '~/photos-2', recursive: true },
            'copy photos to photos-2',
          ),
        ],
        'copy photos to photos-2',
      ),
    );
    expect(!r.ok && r.error.errno).toBe('EDQUOT');
  });

  it('AGT-02 a plan whose step 3 fails leaves steps 1 and 2 unapplied', () => {
    const snapshot = buildFxAgt().tree.snapshot;
    const r = validatePlan(
      input(
        [
          step('s1', 'mkdir', { path: '~/newdir' }, 'make newdir'),
          step('s2', 'write', { path: '~/newdir/a.txt', text: 'hi' }, 'write a.txt'),
          step('s3', 'rename', { from: '~/missing', to: '~/newdir/m' }, 'move missing'),
        ],
        'make newdir, write a.txt, move missing',
        { snapshot },
      ),
    );
    expect(!r.ok && r.error.step).toBe('s3');
    // The snapshot is untouched: validation works on a copy-on-write overlay.
    const home = snapshot.node(buildFxAgt().tree.inoOf(HOME) ?? '');
    expect(home?.children?.has('newdir')).toBe(false);
  });

  it('AGT-02 overwrite detection: a type mismatch or a non-empty directory target is rejected', () => {
    const isdir = validatePlan(
      input(
        [step('s1', 'write', { path: '~/Documents', text: 'x' }, 'write over Documents')],
        'write over Documents',
      ),
    );
    expect(!isdir.ok && isdir.error.errno).toBe('EISDIR');
    const notEmpty = validatePlan(
      input(
        [
          step(
            's1',
            'rename',
            { from: '~/projects/beta', to: '~/projects/alpha' },
            'replace alpha with beta',
          ),
        ],
        'replace alpha with beta',
      ),
    );
    expect(!notEmpty.ok && notEmpty.error.errno).toBe('ENOTEMPTY');
    const notDir = validatePlan(
      input(
        [step('s1', 'rename', { from: '~/tmp', to: '~/todo.txt' }, 'replace todo.txt with tmp')],
        'replace todo.txt with tmp',
      ),
    );
    expect(!notDir.ok && notDir.error.errno).toBe('ENOTDIR');
    const exists = validatePlan(
      input([step('s1', 'mkdir', { path: '~/Documents' }, 'make Documents')], 'make Documents'),
    );
    expect(!exists.ok && exists.error.errno).toBe('EEXIST');
    const noReplace = validatePlan(
      input(
        [
          step(
            's1',
            'rename',
            { from: '~/todo.txt', to: '~/kill_list.txt', noReplace: true },
            'rename todo.txt to kill_list.txt',
          ),
        ],
        'rename todo.txt to kill_list.txt',
      ),
    );
    expect(!noReplace.ok && noReplace.error.errno).toBe('EEXIST');
    const into = validatePlan(
      input(
        [
          step(
            's1',
            'rename',
            { from: '~/projects', to: '~/projects/alpha/p' },
            'move projects into alpha',
          ),
        ],
        'move projects into alpha',
      ),
    );
    expect(!into.ok && into.error.reason).toBe('into-itself');
  });

  it('AGT-02 an overwrite moves the old file to the trash and is recorded as OVERWRITE', () => {
    const r = validatePlan(
      input(
        [
          step(
            's1',
            'rename',
            { from: '~/todo.txt', to: '~/kill_list.txt' },
            'rename todo.txt to kill_list.txt and replace it',
          ),
        ],
        'rename todo.txt to kill_list.txt and replace it',
      ),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.counts.overwrite).toBe(1);
    expect(r.value.ops[0]?.overwrites).toBeDefined();
    expect(r.value.batch.map((b) => b.op)).toEqual(['mkdir', 'mkdir', 'rename', 'rename']);
    expect(r.value.batch[2]).toMatchObject({
      op: 'rename',
      from: `${HOME}/kill_list.txt`,
      to: `${HOME}/.trash/${TXN}/1-kill_list.txt`,
    });
  });

  it('AGT-02 plans larger than 10,000 affected inodes are rejected with plan-too-large', () => {
    const entries: FixtureEntry[] = [
      { path: HOME, type: 'd', uid: A.uid, gid: A.gid, mode: 0o755 },
      { path: `${HOME}/big`, type: 'd', uid: A.uid, gid: A.gid, mode: 0o755 },
    ];
    for (let i = 0; i < 10_001; i++)
      entries.push({ path: `${HOME}/big/f${i}`, type: 'f', uid: A.uid, gid: A.gid, mode: 0o644 });
    const r = validatePlan(
      input(
        [
          step(
            's1',
            'chmod',
            { path: '~/big', mode: { op: 'set', bits: 0o600 }, recursive: true },
            'make big private',
          ),
        ],
        'make big private',
        { snapshot: buildTree(entries).snapshot },
      ),
    );
    expect(!r.ok && r.error.reason).toBe('plan-too-large');
  });

  it('AGT-02 a valid plan yields hashes, expected versions, digests, grant pairs and inverse actions', () => {
    const r = validatePlan(
      input(
        [
          step(
            's1',
            'chmod',
            { path: '~/projects', mode: { op: 'set', bits: 0o700 }, recursive: true },
            'make projects private',
          ),
        ],
        'make projects private',
      ),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value;
    expect(d.planHash).toMatch(/^[0-9a-f]{64}$/);
    expect(d.dryRunHash).toMatch(/^[0-9a-f]{64}$/);
    expect(d.expectedVersions.length).toBe(6);
    expect(Object.keys(d.subtreeDigests)).toHaveLength(1);
    expect(d.grant.every(([op]) => op === 'chmod')).toBe(true);
    expect(d.inverse.filter((i) => i.kind === 'chmod')).toHaveLength(6);
    expect(d.affectedInodes).toBe(6);
    expect(modeDisplay({ op: 'set', bits: 0o700 })).toBe('0700');
    const again = validatePlan(
      input(
        [
          step(
            's1',
            'chmod',
            { path: '~/projects', mode: { op: 'set', bits: 0o700 }, recursive: true },
            'make projects private',
          ),
        ],
        'make projects private',
      ),
    );
    expect(again.ok && again.value.planHash).toBe(d.planHash);
  });

  it('AGT-02 write, symlink, utimes and hard delete produce the documented batch ops', () => {
    const r = validatePlan(
      input(
        [
          step('s1', 'write', { path: '~/hello.txt', text: 'hello' }, 'write hello.txt'),
          step('s2', 'symlink', { target: 'hello.txt', path: '~/hi' }, 'link hi to hello.txt'),
          step('s3', 'utimes', { path: '~/todo.txt', mtime: 'now' }, 'touch todo.txt'),
          step('s4', 'unlink', { path: '~/tmp/cache.tmp' }, 'delete cache.tmp'),
        ],
        'write hello.txt, link hi to hello.txt, touch todo.txt, delete cache.tmp',
        { trash: false },
      ),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.batch.map((b) => b.op)).toEqual(['write', 'symlink', 'utimes', 'unlink']);
    expect(r.value.undoAvailable).toBe(false);
    expect(r.value.bytes).toBe(5);
  });
});

describe('capability roots and root drop (AGT-04)', () => {
  it('AGT-04 a plan touching /system is refused with EPERM system-path without an elevation grant', () => {
    const r = validatePlan(
      input(
        [step('s1', 'unlink', { path: '/system/config.json' }, 'delete /system/config.json')],
        'delete /system/config.json',
      ),
    );
    expect(!r.ok && r.error).toMatchObject({ errno: 'EPERM', reason: 'system-path' });
  });

  it('AGT-04 with an elevation grant the ops run as uid 0 and the plan is flagged for confirmation', () => {
    const r = validatePlan(
      input(
        [step('s1', 'unlink', { path: '/system/config.json' }, 'delete /system/config.json')],
        'delete /system/config.json',
        { elevation: true },
      ),
    );
    expect(r.ok && r.value.systemPath).toBe(true);
    expect(r.ok && r.value.flags.elevation).toBe(true);
  });

  it('AGT-04 paths outside the cwd and home are refused with EPERM scope', () => {
    const r = validatePlan(
      input(
        [
          step(
            's1',
            'copy',
            { from: '~/todo.txt', to: '/home/carol/inbox/t.txt' },
            'copy todo.txt to carol',
          ),
        ],
        'copy todo.txt to carol',
      ),
    );
    expect(!r.ok && r.error).toMatchObject({ errno: 'EPERM', reason: 'scope' });
  });

  it('AGT-04 chown needs root: EPERM root-only for the agent', () => {
    const r = validatePlan(
      input(
        [step('s1', 'chown', { path: '~/todo.txt', uid: 1002 }, 'give todo.txt to bob')],
        'give todo.txt to bob',
      ),
    );
    expect(!r.ok && r.error.reason).toBe('root-only');
    const el = validatePlan(
      input(
        [step('s1', 'chown', { path: '~/todo.txt', uid: 1002 }, 'give todo.txt to bob')],
        'give todo.txt to bob',
        { elevation: true },
      ),
    );
    expect(el.ok && el.value.ops[0]?.call).toBe('chown');
  });

  it('AGT-04 chmod on a file the user does not own is EPERM owner', () => {
    const r = validatePlan(
      input(
        [
          step(
            's1',
            'chmod',
            { path: '/home/team/shared-plan.md', mode: { op: 'set', bits: 0o600 } },
            'make shared-plan.md private',
          ),
        ],
        'make shared-plan.md private',
        { cwd: '/home/team' },
      ),
    );
    expect(r.ok).toBe(true);
    const bobs = validatePlan(
      input(
        [
          step(
            's1',
            'chmod',
            { path: '/home/team/shared-plan.md', mode: { op: 'set', bits: 0o600 } },
            'make shared-plan.md private',
          ),
        ],
        'make shared-plan.md private',
        {
          cwd: '/home/team',
          cred: { uid: USERS.bob.uid, gid: USERS.bob.gid, groups: [...USERS.bob.groups] },
          home: USERS.bob.home,
        },
      ),
    );
    expect(!bobs.ok && bobs.error.reason).toBe('owner');
  });

  it('AGT-04 a sticky directory only lets owners remove entries, and a foreign lease is EBUSY', () => {
    const entries: FixtureEntry[] = [
      { path: '/home/alice', type: 'd', uid: A.uid, gid: A.gid, mode: 0o755 },
      { path: '/home/alice/drop', type: 'd', uid: 0, gid: 0, mode: 0o1777 },
      { path: '/home/alice/drop/bobs.txt', type: 'f', uid: 1002, gid: 100, mode: 0o666 },
      { path: '/home/alice/drop/mine.txt', type: 'f', uid: A.uid, gid: 100, mode: 0o644 },
    ];
    const t = buildTree(entries);
    const sticky = validatePlan(
      input(
        [step('s1', 'unlink', { path: '~/drop/bobs.txt' }, 'delete bobs.txt')],
        'delete bobs.txt',
        { snapshot: t.snapshot },
      ),
    );
    expect(!sticky.ok && sticky.error.reason).toBe('sticky');
    const mine = t.inoOf('/home/alice/drop/mine.txt');
    const busy = validatePlan(
      input(
        [step('s1', 'unlink', { path: '~/drop/mine.txt' }, 'delete mine.txt')],
        'delete mine.txt',
        { snapshot: t.snapshot, leases: (ino) => ino === mine },
      ),
    );
    expect(!busy.ok && busy.error.errno).toBe('EBUSY');
  });

  it('AGT-04 path resolution reports ELOOP, ENOTDIR and ENAMETOOLONG', () => {
    const t = buildTree([
      { path: '/home/alice', type: 'd', uid: A.uid, gid: A.gid, mode: 0o755 },
      {
        path: '/home/alice/loop',
        type: 'l',
        uid: A.uid,
        gid: A.gid,
        mode: 0o777,
        target: '/home/alice/loop',
      },
      { path: '/home/alice/file', type: 'f', uid: A.uid, gid: A.gid, mode: 0o644 },
    ]);
    const cred = { uid: A.uid, gid: A.gid, groups: [] };
    const ov = new Overlay(t.snapshot);
    const loop = ov.resolve('/home/alice/loop', cred, posixOracle, true);
    expect(!loop.ok && loop.error.errno).toBe('ELOOP');
    const nd = ov.resolve('/home/alice/file/x', cred, posixOracle, true);
    expect(!nd.ok && nd.error.errno).toBe('ENOTDIR');
    const long = ov.resolve(`/home/alice/${'n'.repeat(256)}`, cred, posixOracle, true);
    expect(!long.ok && long.error.errno).toBe('ENAMETOOLONG');
    expect(normalizePath('../x/./y', '/home/alice/a', '/home/alice')).toBe('/home/alice/x/y');
    expect(normalizePath('~', '/', '/home/alice')).toBe('/home/alice');
    expect(normalizePath('', '/', '/')).toBeUndefined();
  });
});

describe('intent binding (AGT-06)', () => {
  it('AGT-06 a destructive step whose span lacks a licensing verb is rejected with EPERM not-requested', () => {
    const r = validatePlan(
      input(
        [step('s1', 'unlink', { path: '~/Downloads/setup.exe' }, 'tidy my Downloads folder')],
        'tidy my Downloads folder',
      ),
    );
    expect(!r.ok && r.error).toMatchObject({ errno: 'EPERM', reason: 'not-requested', step: 's1' });
  });

  it('AGT-06 a span that is not a verbatim quote of the request is rejected with EINVAL', () => {
    const r = bindIntent({
      steps: [step('s1', 'mkdir', {}, 'Make A Folder')],
      request: 'make a folder',
      clarifications: [],
      userEdited: false,
      overwrites: new Set(),
    });
    expect(!r.ok && r.error.reason).toBe('span-not-in-request');
    const ok = bindIntent({
      steps: [step('s1', 'mkdir', {}, 'make   a\nfolder')],
      request: 'please make a folder',
      clarifications: [],
      userEdited: false,
      overwrites: new Set(),
    });
    expect(ok.ok).toBe(true);
    const clar = bindIntent({
      steps: [step('s1', 'mkdir', {}, 'the reports one')],
      request: 'make it',
      clarifications: ['the reports one'],
      userEdited: false,
      overwrites: new Set(),
    });
    expect(clar.ok).toBe(true);
    const edited = bindIntent({
      steps: [step('s1', 'unlink', {}, 'anything')],
      request: 'x',
      clarifications: [],
      userEdited: true,
      overwrites: new Set(),
    });
    expect(edited.ok).toBe(true);
  });

  it('AGT-06 a non-destructive step without a lexeme is kept but flagged UNLICENSED (confirmation forced)', () => {
    const r = validatePlan(
      input(
        [step('s1', 'copy', { from: '~/todo.txt', to: '~/todo-2.txt' }, 'todo.txt')],
        'todo.txt as todo-2.txt',
      ),
    );
    expect(r.ok && r.value.flags.unlicensed).toBe(true);
    expect(r.ok && r.value.unlicensedSteps).toEqual(['s1']);
  });

  it('AGT-06 an overwrite needs its own licensing verb; ungrounded destructive paths are rejected', () => {
    const r = validatePlan(
      input(
        [
          step(
            's1',
            'rename',
            { from: '~/todo.txt', to: '~/kill_list.txt' },
            'move todo.txt to kill_list.txt',
          ),
        ],
        'move todo.txt to kill_list.txt',
      ),
    );
    expect(!r.ok && r.error).toMatchObject({ errno: 'EPERM', reason: 'not-requested' });
    const ungrounded = validatePlan(
      input(
        [step('s1', 'unlink', { path: '~/Documents/thesis.pdf' }, 'delete setup.exe')],
        'delete setup.exe',
      ),
    );
    expect(!ungrounded.ok && ungrounded.error.reason).toBe('not-requested');
    const flagged = validatePlan(
      input([step('s1', 'mkdir', { path: '~/zzz' }, 'make a folder')], 'make a folder'),
    );
    expect(flagged.ok && flagged.value.flags.ungrounded).toBe(true);
    const observed = validatePlan(
      input([step('s1', 'unlink', { path: '~/Documents/thesis.pdf' }, 'delete it')], 'delete it', {
        observed: new Set([`${HOME}/Documents/thesis.pdf`]),
      }),
    );
    expect(observed.ok).toBe(true);
  });

  it('AGT-06 the lexicon matches whole words, case-insensitively, including multi-word lexemes', () => {
    expect(wordMatch('Please DELETE them', 'delete')).toBe(true);
    expect(wordMatch('undeleted files', 'delete')).toBe(false);
    expect(wordMatch('get   rid of these', 'get rid of')).toBe(true);
    expect(licensed('make it read-only', 'permissions')).toBe(true);
    expect(licensed('show the files', 'delete')).toBe(false);
    expect(opClassOf('glob')).toBe('selector');
    expect(opClassOf('symlink')).toBe('link');
    expect(normalizeText('  a \n b ')).toBe('a b');
    expect(
      isGrounded(`${HOME}/Documents/x.pdf`, {
        request: 'x.pdf please',
        clarifications: [],
        cwd: HOME,
        home: HOME,
        observed: new Set(),
      }),
    ).toBe(true);
    expect(
      isGrounded(`${HOME}/a/b`, {
        request: 'use ~/a/b',
        clarifications: [],
        cwd: '/',
        home: HOME,
        observed: new Set(),
      }),
    ).toBe(true);
  });
});

describe('relative dates and globs (AGT-07)', () => {
  const now = FROZEN_NOW; // Monday 2026-10-05 10:00 +05:00

  it('AGT-07 relative dates resolve to the documented absolute intervals in Asia/Karachi', () => {
    expect(resolveSpan({ unit: 'day', count: 1, mode: 'calendar' }, now, TZ)).toEqual({
      from: at('2026-10-04T00:00'),
      to: at('2026-10-05T00:00'),
    });
    expect(resolveSpan({ unit: 'week', count: 1, mode: 'calendar' }, now, TZ)).toEqual({
      from: at('2026-09-28T00:00'),
      to: at('2026-10-05T00:00'),
    });
    expect(resolveSpan({ unit: 'month', count: 1, mode: 'calendar' }, now, TZ)).toEqual({
      from: at('2026-09-01T00:00'),
      to: at('2026-10-01T00:00'),
    });
    expect(resolveSpan({ unit: 'hour', count: 2, mode: 'calendar' }, now, TZ)).toEqual({
      from: at('2026-10-05T08:00'),
      to: at('2026-10-05T10:00'),
    });
    expect(resolveSpan({ unit: 'day', count: 3, mode: 'rolling' }, now, TZ)).toEqual({
      from: at('2026-10-02T10:00'),
      to: now,
    });
    expect(resolveSpan({ unit: 'week', count: 2 }, now, TZ)).toEqual({
      from: at('2026-09-21T10:00'),
      to: now,
    });
    expect(resolveSpan({ unit: 'hour', count: 3, mode: 'rolling' }, now, TZ)).toEqual({
      from: at('2026-10-05T07:00'),
      to: now,
    });
    expect(
      resolveSpan({ unit: 'month', count: 1, mode: 'rolling' }, at('2026-03-31T12:00'), TZ).from,
    ).toBe(at('2026-02-28T12:00'));
    expect(
      describeRelTime({ within: { unit: 'week', count: 1, mode: 'calendar' } }, now, TZ),
    ).toEqual({ from: '2026-09-28T00:00:00+05:00', to: '2026-10-05T00:00:00+05:00' });
    expect(
      describeRelTime({ olderThan: { unit: 'day', count: 30, mode: 'rolling' } }, now, TZ).to,
    ).toBe('2026-09-05T10:00:00+05:00');
    expect(
      matchesRelTime(
        at('2026-10-05T00:00'),
        { within: { unit: 'day', count: 1, mode: 'calendar' } },
        now,
        TZ,
      ),
    ).toBe(false);
    expect(
      matchesRelTime(
        at('2026-09-01T00:00'),
        { olderThan: { unit: 'day', count: 30, mode: 'rolling' } },
        now,
        TZ,
      ),
    ).toBe(true);
  });

  it('AGT-07 globs match *, ?, classes with ranges and negation, and ** without backtracking blow-up', () => {
    expect(globMatch('*.pdf', 'thesis.pdf')).toBe(true);
    expect(globMatch('*.pdf', 'thesis.pdfx')).toBe(false);
    expect(globMatch('invoice-00?.pdf', 'invoice-001.pdf')).toBe(true);
    expect(globMatch('build-0[1-5].log', 'build-06.log')).toBe(false);
    expect(globMatch('build-0[!1-5].log', 'build-06.log')).toBe(true);
    expect(globMatch('[^a]*', 'b')).toBe(true);
    expect(globMatch('**.md', 'a.md')).toBe(true);
    expect(globMatch('a\\*', 'a*')).toBe(true);
    expect(globMatch('[abc', '[abc')).toBe(true);
    expect(globMatch('[]]', ']')).toBe(true);
    expect(globMatch('', '')).toBe(true);
    expect(globMatch('a*', '')).toBe(false);
    const t0 = performance.now();
    expect(globMatch(`${'*a'.repeat(30)}b`, 'a'.repeat(200))).toBe(false);
    expect(performance.now() - t0).toBeLessThan(200);
  });

  it('AGT-07 find selectors skip unreadable directories and honour type, size and maxDepth', () => {
    const fx = buildFxAgt();
    const ctx = {
      overlay: new Overlay(fx.tree.snapshot),
      cred: { uid: A.uid, gid: A.gid, groups: [...A.groups] },
      oracle: posixOracle,
      cwd: HOME,
      home: HOME,
      now: FROZEN_NOW,
      tz: TZ,
    };
    const all = runFind({ path: '/home', name: '*.txt', limit: 1000 }, ctx);
    expect(all.ok && all.value.denied).toBeGreaterThan(0);
    expect(all.ok && all.value.paths.some((p) => p.startsWith('/home/bob/'))).toBe(false);
    const big = runFind(
      { path: '~/Downloads', size: { gt: 500_000 }, type: 'f', limit: 1000 },
      ctx,
    );
    expect(big.ok && big.value.paths).toEqual([
      `${HOME}/Downloads/archive.zip`,
      `${HOME}/Downloads/setup.exe`,
    ]);
    const shallow = runFind({ path: '~/projects', maxDepth: 1, limit: 1000 }, ctx);
    expect(shallow.ok && shallow.value.paths).toEqual([
      `${HOME}/projects/alpha`,
      `${HOME}/projects/beta`,
    ]);
    const capped = runFind({ path: '~/logs', limit: 3 }, ctx);
    expect(capped.ok && capped.value.truncated).toBe(true);
    const abs = runFind(
      {
        path: '~/Downloads',
        mtime: { after: at('2026-10-03T00:00'), before: at('2026-10-04T12:00') },
        limit: 100,
      },
      ctx,
    );
    expect(abs.ok && abs.value.paths).toEqual([
      `${HOME}/Downloads/map.png`,
      `${HOME}/Downloads/photo2.jpg`,
    ]);
    const notDir = runFind({ path: '~/todo.txt', limit: 1 }, ctx);
    expect(!notDir.ok && notDir.error.errno).toBe('ENOTDIR');
    const truncatedPlan = validatePlan(
      input([step('s1', 'find', { path: '~/logs', limit: 3 }, 'the logs')], 'the logs'),
    );
    expect(!truncatedPlan.ok && truncatedPlan.error.reason).toBe('plan-too-large');
  });
});

/** Reference glob semantics through a regular expression (test-only oracle). */
function globToRegex(glob: string): RegExp {
  let re = '';
  for (const ch of glob) {
    if (ch === '*') re += '.*';
    else if (ch === '?') re += '.';
    else re += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 's');
}

describe('glob property (AGT-07)', () => {
  it('AGT-07 the iterative glob matcher agrees with a reference implementation on random patterns', () => {
    const alphabet = fc.constantFrom('a', 'b', '.', '*', '?');
    fc.assert(
      fc.property(
        fc.array(alphabet, { maxLength: 8 }),
        fc.array(fc.constantFrom('a', 'b', '.'), { maxLength: 10 }),
        (p, s) => {
          const pattern = p.join('');
          const name = s.join('');
          expect(globMatch(pattern, name)).toBe(globToRegex(pattern).test(name));
        },
      ),
      { numRuns: 500 },
    );
  });
});
