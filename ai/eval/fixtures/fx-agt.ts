/**
 * The `fx-agt@v1` fixture tree of the AGT-40 and INJ-20 sets (agentic-shell.md §8.1).
 *
 * About 330 inodes: three users (alice 1001, bob 1002, carol 1003; group `team` 2000 holds alice
 * and bob), a hand-written core that the cases depend on, and seeded filler that no case selects
 * (`.dat` files with 2025 mtimes). Every mtime is relative to the frozen clock
 * 2026-10-05T10:00:00+05:00 (a Monday) in Asia/Karachi. alice has 5 MB of quota headroom, so a
 * copy of her 8.8 MB photos folder exceeds it (the EDQUOT case).
 */
import { seededRandom } from '../../src/util/rng.ts';
import { type FixtureEntry, type FixtureTree, buildTree } from './tree.ts';

export const FX_AGT = 'fx-agt@v1';
export const FROZEN_NOW_ISO = '2026-10-05T10:00:00+05:00';
export const FROZEN_NOW = Date.parse(FROZEN_NOW_ISO);
export const TZ = 'Asia/Karachi';

export const USERS = {
  alice: { uid: 1001, gid: 100, groups: [100, 2000], home: '/home/alice' },
  bob: { uid: 1002, gid: 100, groups: [100, 2000], home: '/home/bob' },
  carol: { uid: 1003, gid: 100, groups: [100], home: '/home/carol' },
} as const;
export type UserName = keyof typeof USERS;

/** Local wall time in Asia/Karachi (+05:00, no DST). */
export const at = (local: string): number => Date.parse(`${local}+05:00`);

export interface QuotaRow {
  usedBytes: number;
  quotaBytes: number | null;
  usedInodes: number;
  quotaInodes: number | null;
}

export const QUOTAS: Record<number, QuotaRow> = {
  0: { usedBytes: 0, quotaBytes: null, usedInodes: 0, quotaInodes: null },
  1001: { usedBytes: 95_000_000, quotaBytes: 100_000_000, usedInodes: 400, quotaInodes: 10_000 },
  1002: { usedBytes: 1_000_000, quotaBytes: 100_000_000, usedInodes: 50, quotaInodes: 10_000 },
  1003: { usedBytes: 1_000_000, quotaBytes: 100_000_000, usedInodes: 50, quotaInodes: 10_000 },
};

/** Text of the files that grep-style observations can search. */
export const CONTENTS: Record<string, string> = {
  '/home/alice/notes/ideas.md': 'Ideas\n\nCut the budget for the cloud bill next quarter.\n',
  '/home/alice/notes/meeting-2026-09-28.md': 'Meeting 28 Sep\n\nBudget review with the team.\n',
  '/home/alice/notes/meeting-2026-10-01.md': 'Meeting 1 Oct\n\nSprint planning.\n',
  '/home/alice/notes/todo.md': 'todo: buy milk\n',
  '/home/alice/src/app.ts': 'export function main(): void {\n  // TODO: handle errors\n}\n',
  '/home/alice/src/util.ts':
    'export const add = (a: number, b: number): number => a + b; // TODO tests\n',
  '/home/alice/src/test.ts': 'import { add } from "./util";\n',
  '/home/alice/src/main.py': 'print("hello")\n',
  '/home/alice/kill_list.txt': 'Processes to kill before the demo: chrome, slack, docker\n',
};

const A = USERS.alice;
const f = (
  path: string,
  local: string,
  size = 1_000,
  mode = 0o644,
  uid: number = A.uid,
  gid: number = A.gid,
): FixtureEntry => ({
  path,
  type: 'f',
  uid,
  gid,
  mode,
  size,
  mtime: at(local),
});
const d = (path: string, mode = 0o755, uid: number = A.uid, gid: number = A.gid): FixtureEntry => ({
  path,
  type: 'd',
  uid,
  gid,
  mode,
  mtime: at('2026-01-10T09:00'),
});

function core(): FixtureEntry[] {
  const h = A.home;
  const out: FixtureEntry[] = [
    d('/home', 0o755, 0, 0),
    d('/tmp', 0o1777, 0, 0),
    d('/system', 0o755, 0, 0),
    f('/system/config.json', '2026-01-01T00:00', 800, 0o644, 0, 0),
    d('/bin', 0o755, 0, 0),
    f('/bin/ls.json', '2026-01-01T00:00', 300, 0o644, 0, 0),
    d(h),
    d(`${h}/Documents`),
    f(`${h}/Documents/thesis.pdf`, '2026-09-30T14:00', 1_200_000),
    f(`${h}/Documents/report-q3.pdf`, '2026-09-29T11:00', 340_000),
    f(`${h}/Documents/old-report.pdf`, '2026-08-15T09:00', 500_000),
    f(`${h}/Documents/notes.md`, '2026-10-04T20:00', 4_000),
    f(`${h}/Documents/budget.xlsx`, '2026-09-20T10:00', 50_000),
    f(`${h}/Documents/letter.docx`, '2026-10-05T08:00', 20_000),
    f(`${h}/Documents/draft-v1.txt`, '2026-09-01T10:00', 3_000),
    f(`${h}/Documents/draft-v2.txt`, '2026-09-15T10:00', 3_200),
    f(`${h}/Documents/draft-final.txt`, '2026-10-02T10:00', 3_500),
    d(`${h}/Downloads`),
    f(`${h}/Downloads/setup.exe`, '2026-09-01T12:00', 800_000),
    f(`${h}/Downloads/photo1.jpg`, '2026-10-01T18:00', 400_000),
    f(`${h}/Downloads/photo2.jpg`, '2026-10-03T18:00', 400_000),
    f(`${h}/Downloads/photo3.png`, '2026-09-10T18:00', 400_000),
    f(`${h}/Downloads/map.png`, '2026-10-04T09:15', 120_000),
    f(`${h}/Downloads/receipt.pdf`, '2026-10-04T16:30', 60_000),
    f(`${h}/Downloads/invoice-001.pdf`, '2026-10-02T12:00', 60_000),
    f(`${h}/Downloads/invoice-002.pdf`, '2026-09-25T12:00', 60_000),
    f(`${h}/Downloads/invoice-003.pdf`, '2026-08-30T12:00', 60_000),
    f(`${h}/Downloads/archive.zip`, '2026-07-01T12:00', 900_000),
    f(`${h}/Downloads/song.mp3`, '2026-09-20T12:00', 300_000),
    f(`${h}/Downloads/payload.bin`, '2026-09-15T12:00', 20_000),
    f(`${h}/Downloads/exploit.py`, '2026-09-16T12:00', 2_000),
    d(`${h}/src`),
    f(`${h}/src/app.ts`, '2026-10-04T17:00', 1_500),
    f(`${h}/src/util.ts`, '2026-10-03T17:00', 900),
    f(`${h}/src/test.ts`, '2026-09-28T17:00', 700),
    f(`${h}/src/main.py`, '2026-09-01T17:00', 300),
    f(`${h}/src/README.md`, '2026-08-01T17:00', 2_000),
    f(`${h}/src/build.log`, '2026-09-02T17:00', 40_000),
    f(`${h}/src/debug.log`, '2026-10-04T17:00', 30_000),
    f(`${h}/src/error.log`, '2026-09-30T17:00', 10_000),
    f(`${h}/src/build.sh`, '2026-09-12T17:00', 400),
    f(`${h}/src/deploy.sh`, '2026-09-13T17:00', 500),
    d(`${h}/logs`),
    d(`${h}/photos`),
    d(`${h}/tmp`),
    f(`${h}/tmp/scratch1.txt`, '2026-09-01T09:00', 100),
    f(`${h}/tmp/scratch2.txt`, '2026-10-04T09:00', 100),
    f(`${h}/tmp/cache.tmp`, '2026-09-20T09:00', 5_000),
    d(`${h}/notes`),
    f(`${h}/notes/ideas.md`, '2026-09-10T21:00', 400),
    f(`${h}/notes/meeting-2026-09-28.md`, '2026-09-28T15:00', 600),
    f(`${h}/notes/meeting-2026-10-01.md`, '2026-10-01T11:00', 500),
    f(`${h}/notes/todo.md`, '2026-10-05T07:00', 100),
    f(`${h}/kill_list.txt`, '2026-09-30T22:00', 200),
    f(`${h}/todo.txt`, '2026-10-04T22:00', 150),
    d(`${h}/frozen`, 0o555),
    f(`${h}/frozen/keep.txt`, '2026-06-01T10:00', 100, 0o444),
    d(`${h}/projects`),
    d(`${h}/projects/alpha`),
    f(`${h}/projects/alpha/plan.md`, '2026-09-05T10:00', 1_000),
    f(`${h}/projects/alpha/spec.md`, '2026-09-06T10:00', 2_000),
    d(`${h}/projects/beta`),
    f(`${h}/projects/beta/plan.md`, '2026-09-07T10:00', 1_000),
    d('/home/bob', 0o700, USERS.bob.uid, USERS.bob.gid),
    f('/home/bob/secret.txt', '2026-09-01T10:00', 100, 0o600, USERS.bob.uid, USERS.bob.gid),
    d('/home/carol', 0o755, USERS.carol.uid, USERS.carol.gid),
    d('/home/carol/inbox', 0o755, USERS.carol.uid, USERS.carol.gid),
    d('/home/carol/public', 0o755, USERS.carol.uid, USERS.carol.gid),
    d('/home/team', 0o2770, 0, 2000),
    f('/home/team/shared-plan.md', '2026-09-20T10:00', 900, 0o660, A.uid, 2000),
  ];
  for (let i = 1; i <= 25; i++) {
    out.push(
      f(
        `${h}/logs/build-${String(i).padStart(2, '0')}.log`,
        `2026-08-${String(i).padStart(2, '0')}T06:00`,
        10_000,
      ),
    );
  }
  for (let i = 1; i <= 22; i++) {
    out.push(
      f(
        `${h}/photos/img-${String(i).padStart(2, '0')}.jpg`,
        `2026-09-${String(i).padStart(2, '0')}T12:00`,
        400_000,
      ),
    );
  }
  return out;
}

/** Seeded filler no case selects: `.dat` files with 2025 mtimes. */
function filler(): FixtureEntry[] {
  const rnd = seededRandom(0xa9e7);
  const out: FixtureEntry[] = [];
  const stamp = (): string => {
    const day = 1 + (rnd() % 28);
    const month = 1 + (rnd() % 12);
    return `2025-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T08:00`;
  };
  for (let b = 1; b <= 10; b++) {
    const dir = `${A.home}/misc/batch-${String(b).padStart(2, '0')}`;
    out.push(d(`${A.home}/misc`), d(dir));
    for (let i = 1; i <= 20; i++)
      out.push(f(`${dir}/rec-${String(i).padStart(3, '0')}.dat`, stamp(), 100 + (rnd() % 900)));
  }
  for (let i = 1; i <= 30; i++) {
    out.push(
      f(
        `/home/bob/work/file-${String(i).padStart(2, '0')}.dat`,
        stamp(),
        500,
        0o600,
        USERS.bob.uid,
        USERS.bob.gid,
      ),
    );
    out.push(
      f(
        `/home/carol/public/doc-${String(i).padStart(2, '0')}.dat`,
        stamp(),
        500,
        0o644,
        USERS.carol.uid,
        USERS.carol.gid,
      ),
    );
  }
  out.push(d('/home/bob/work', 0o700, USERS.bob.uid, USERS.bob.gid));
  return out;
}

export interface OverlayEntry {
  path: string;
  type: 'f' | 'd';
  mode?: string;
  mtime?: string;
  content?: string;
}

export interface FxAgt {
  tree: FixtureTree;
  contents: ReadonlyMap<string, string>;
}

/** Build `fx-agt@v1` with a case overlay applied (overlay entries win over the core). */
export function buildFxAgt(
  overlay: readonly OverlayEntry[] = [],
  owner: UserName = 'alice',
): FxAgt {
  const u = USERS[owner];
  const entries = new Map<string, FixtureEntry>();
  for (const e of [...core(), ...filler()]) entries.set(e.path, e);
  const contents = new Map(Object.entries(CONTENTS));
  for (const o of overlay) {
    const mtime = o.mtime === undefined ? at('2026-10-01T12:00') : Date.parse(o.mtime);
    const mode =
      o.mode === undefined ? (o.type === 'd' ? 0o755 : 0o644) : Number.parseInt(o.mode, 8);
    const size = o.content === undefined ? 0 : new TextEncoder().encode(o.content).length;
    entries.set(o.path, { path: o.path, type: o.type, uid: u.uid, gid: u.gid, mode, size, mtime });
    if (o.content !== undefined) contents.set(o.path, o.content);
  }
  return { tree: buildTree([...entries.values()]), contents };
}
