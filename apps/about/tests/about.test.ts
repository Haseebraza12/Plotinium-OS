/**
 * About Plotinium (identity-and-branding.md §3.10 row 9, §4.3–§4.4; DSN-18) against a fake
 * system-call client: `uname`, the build identity, the memory budget, storage and the team from
 * docs/identity/identity.json.
 */
import type { Quota, StatFs, UnameInfo } from '@plotinium/protocol';
import { describe, expect, it } from 'vitest';

import type { AppBuildIdentity, TeamIdentity } from '../../src/descriptor.ts';
import { parseTeamIdentity } from '../../src/descriptor.ts';
import { FakeSys, MB } from '../../taskmgr/tests/fake-sys.ts';
import { budgetFromSysctl, loadAbout } from '../controller.ts';
import {
  browserText,
  DEFAULT_TAGLINE,
  isPlaceholder,
  kernelRelease,
  sizeText,
  systemReport,
  teamMembers,
  toAboutModel,
  unameLine,
} from '../model.ts';

const IDENTITY: AppBuildIdentity = {
  name: 'Plotinium',
  version: '0.3.0',
  build: 'a1f93c2',
  buildDate: '2026-09-24',
  codename: 'Pu',
  abi: 1,
};

const UNAME: UnameInfo = {
  sysname: 'Plotinium',
  version: '0.3.0',
  build: 'a1f93c2',
  buildDate: '2026-09-24',
  codename: 'Pu',
  browser: { brand: 'Chrome', major: 154 },
  cores: 8,
  uid: 1001,
  user: 'student',
};

const STATFS: StatFs = {
  fsId: 'plotinium',
  usageBytes: 300 * MB,
  quotaBytes: 2048 * MB,
  inodes: 1200,
  persisted: true,
  swapBytes: { local: 0, remote: 0 },
};

const QUOTA: Quota = {
  uid: 1001,
  usedBytes: 1536 * MB,
  quotaBytes: 4096 * MB,
  usedInodes: 900,
  quotaInodes: null,
  source: 'server',
};

/**
 * docs/identity/identity.json as committed (placeholders until the team fills it in). Inlined:
 * docs/ is not a package, so a test may not import it (local/no-relative-import-outside-package).
 */
const identityJson: unknown = {
  name: 'Plotinium',
  tagline:
    'A local-first web OS that pages its own memory and lets AI act only through the kernel.',
  section: '<S>',
  teamCode: '<NN>',
  members: [
    { name: '<R1 name>', role: 'R1' },
    { name: '<R2 name>', role: 'R2' },
    { name: '<R3 name>', role: 'R3' },
    { name: '<R4 name>', role: 'R4' },
    { name: '<R5 name>', role: 'R5' },
  ],
};

const NAMED_TEAM: TeamIdentity = {
  tagline: 'A local-first web OS.',
  section: 'B',
  teamCode: '07',
  members: [
    { name: 'Ayesha', role: 'R1' },
    { name: 'Bilal', role: 'R2' },
    { name: 'Haseeb', role: 'R3' },
    { name: '<R4 name>', role: 'R4' },
    { name: 'Sara', role: 'R5' },
  ],
};

function fullSys(): FakeSys {
  return new FakeSys()
    .on('uname', () => UNAME)
    .on('proc.cred', () => ({
      uid: 1001,
      gid: 1001,
      groups: [1001],
      user: 'student',
      groupNames: ['student'],
      home: '/home/student',
      ruid: 1001,
    }))
    .on('sysctl.get', () => ({ values: { 'mm.budget': 256 * MB } }))
    .on('statfs', () => STATFS)
    .on('quota', () => QUOTA);
}

describe('About Plotinium', () => {
  it('DSN-18 About shows name, version, codename, build hash, build date, tagline and five team members', async () => {
    const team = parseTeamIdentity(identityJson);
    expect(team).toBeDefined();
    const { model, uname } = await loadAbout(fullSys(), {
      identity: IDENTITY,
      ...(team === undefined ? {} : { team }),
    });
    expect(uname).toEqual(UNAME);
    expect(model).toMatchObject({
      name: 'Plotinium',
      version: '0.3.0',
      codename: 'Pu',
      build: 'a1f93c2',
      builtAt: '2026-09-24',
      tagline: DEFAULT_TAGLINE,
      kernel: 'plotinium 0.3.0-a1f93c2',
      host: { browser: 'Chrome 154', cores: 8 },
      memoryBudget: '256 MB',
      storage: 'OPFS 300 MB · Cloud 1.5 GB',
      signedIn: 'student · uid 1001',
    });
    expect(model.team.map((m) => m.role)).toEqual(['R1', 'R2', 'R3', 'R4', 'R5']);
    // identity.json still holds placeholders: About says "to be announced" instead of "<R1 name>".
    expect(model.team.every((m) => m.name === undefined)).toBe(true);
    expect(model.footer).toEqual(['Capstone, Fall 2026', '© 2026 Plotinium Team']);
  });

  it('DSN-18 filled-in team names, section and team code appear; placeholders stay unnamed', () => {
    const members = teamMembers(NAMED_TEAM);
    expect(members.map((m) => m.name)).toEqual(['Ayesha', 'Bilal', 'Haseeb', undefined, 'Sara']);
    expect(members[2]).toMatchObject({ role: 'R3', title: 'UI Subsystem Lead', area: 'WM / UI' });
    const model = toAboutModel({
      identity: IDENTITY,
      team: NAMED_TEAM,
      uname: UNAME,
      budgetBytes: 512 * MB,
      storage: null,
      user: null,
      updateAvailable: '0.3.1',
    });
    expect(model.footer[0]).toBe('Section B · Team 07');
    expect(model.updateStatus).toBe('0.3.1 available');
    expect(model.storage).toBeUndefined();
    expect(isPlaceholder('<S>')).toBe(true);
    expect(isPlaceholder('B')).toBe(false);
  });

  it('DSN-18 uname -a follows the identity ABNF: version, kernel release, build date, browser, cores and uid', () => {
    expect(unameLine(UNAME)).toBe(
      'Plotinium 0.3.0 (kernel 0.3.0-a1f93c2, built 2026-09-24) · Chrome 154 · 8 cores · uid=1001(student)',
    );
    expect(unameLine({ ...UNAME, cores: 1, browser: { brand: 'Edge', major: null } })).toContain(
      '· Edge · 1 core ·',
    );
    expect(browserText({ brand: 'Unknown browser', major: 3 })).toBe('Unknown browser');
    expect(kernelRelease('1.0.0-rc.1', 'deadbee')).toBe('1.0.0-rc.1-deadbee');
  });

  it('DSN-18 a kernel that cannot answer uname falls back to the build identity and says why', async () => {
    const sys = fullSys().fail('uname', 'ENOSYS').fail('mem.stat', 'ENOSYS');
    const state = await loadAbout(sys, {
      identity: IDENTITY,
      user: { name: 'guest', uid: 65_534, guest: true },
    });
    expect(state.uname).toBeNull();
    expect(state.unameError).toContain('ENOSYS');
    expect(state.model).toMatchObject({
      version: '0.3.0',
      build: 'a1f93c2',
      builtAt: '2026-09-24',
      tagline: DEFAULT_TAGLINE,
      host: { browser: 'Unknown browser', cores: 1 },
      signedIn: 'student · uid 1001',
    });
  });

  it('MEM-01 the About budget comes from mem.stat, else sysctl, and a stopped memory manager reads unknown', async () => {
    expect(budgetFromSysctl({ 'mm.budget': 512 * MB })).toBe(512 * MB);
    expect(budgetFromSysctl({ 'mm.budgetMB': 384 })).toBe(384 * MB);
    expect(budgetFromSysctl({ 'mm.budget': 0 })).toBeNull();
    expect(budgetFromSysctl({})).toBeNull();
    const none = await loadAbout(new FakeSys(), { identity: IDENTITY });
    expect(none.model.memoryBudget).toBe('unknown');
    expect(none.model.signedIn).toBe('not signed in');
    expect(none.model.storage).toBeUndefined();
  });

  it('DSN-18 the system report lists version, build, kernel, host, budget, storage and uname', () => {
    const model = toAboutModel({
      identity: IDENTITY,
      uname: UNAME,
      budgetBytes: 256 * MB,
      storage: { localBytes: 5 * MB, cloudBytes: null },
      user: null,
      updateAvailable: null,
    });
    const report = systemReport(model, UNAME).split('\n');
    expect(report).toEqual([
      'Plotinium 0.3.0 "Pu"',
      'build a1f93c2 · built 2026-09-24',
      'kernel plotinium 0.3.0-a1f93c2',
      'host Chrome 154 · 8 cores',
      'memory budget 256 MB',
      'storage OPFS 5 MB',
      'signed in student · uid 1001',
      `uname ${unameLine(UNAME)}`,
    ]);
    expect(sizeText(1.5 * MB)).toBe('1.5 MB');
    expect(sizeText(2048 * MB)).toBe('2.0 GB');
  });

  it('DSN-18 identity.json parses into a TeamIdentity and malformed input is refused', () => {
    expect(parseTeamIdentity(identityJson)?.members).toHaveLength(5);
    expect(
      parseTeamIdentity({ ...NAMED_TEAM, members: [{ name: 'X', role: 'R9' }] })?.members,
    ).toEqual([]);
    expect(parseTeamIdentity({ tagline: 1 })).toBeUndefined();
    expect(parseTeamIdentity(null)).toBeUndefined();
  });
});
