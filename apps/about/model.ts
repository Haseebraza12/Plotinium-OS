/**
 * About Plotinium (identity-and-branding.md §3.10 row 9, §4.3, §4.4; DSN-18): the `AboutModel`
 * shown by the About window and by Settings > About, built from one `uname`, the build identity
 * and docs/identity/identity.json. Pure functions, unit-tested.
 *
 * Every surface reads the same BuildIdentity (I-1): `uname` is the kernel's copy of it; the build
 * identity the host injected is the fallback when the kernel cannot answer yet.
 */
import type { UnameInfo } from '@plotinium/protocol';
import type { AboutModel, LicenceNotice, TeamMember } from '@plotinium/ui/apps/settings';

import type { AppBuildIdentity, RoleCode, TeamIdentity } from '../src/descriptor.ts';

/** docs/identity/identity.json's tagline, used when the host did not bundle identity.json. */
export const DEFAULT_TAGLINE =
  'A local-first web OS that pages its own memory and lets AI act only through the kernel.';

/**
 * The third-party software the browser build ships (THIRD_PARTY.md §2.1, §2.2 and the embedding
 * stack of the ai package), shown by About › Licences (UI-146). The full list, with versions and
 * the licence texts, is THIRD_PARTY.md in the source repository.
 */
export const LICENCE_NOTICES: readonly LicenceNotice[] = [
  { name: 'SolidJS (solid-js)', licence: 'MIT', use: 'UI framework' },
  { name: 'Lucide (lucide-solid)', licence: 'ISC', use: 'Interface icons' },
  { name: 'xterm.js (@xterm/xterm, @xterm/addon-fit)', licence: 'MIT', use: 'Terminal' },
  { name: 'CodeMirror 6 (@codemirror/*)', licence: 'MIT', use: 'Text Editor' },
  { name: 'Valibot', licence: 'MIT', use: 'System-call and protocol schemas' },
  { name: 'idb', licence: 'ISC', use: 'IndexedDB helpers' },
  { name: 'Workbox (workbox-*)', licence: 'MIT', use: 'Offline cache and updates' },
  {
    name: 'Transformers.js (@huggingface/transformers)',
    licence: 'Apache-2.0',
    use: 'On-device embeddings',
  },
  { name: 'ONNX Runtime Web', licence: 'MIT', use: 'Model inference' },
  { name: 'MongoDB/mdbr-leaf-ir', licence: 'Apache-2.0', use: 'Semantic search model' },
  { name: 'Inter', licence: 'OFL-1.1', use: 'Interface typeface' },
  { name: 'JetBrains Mono', licence: 'OFL-1.1', use: 'Monospace typeface' },
];

/** The five capstone roles (TEAM_CONTRACT.md §1; identity-and-branding.md §3.10). */
export const ROLES: readonly { role: RoleCode; title: string; area: string }[] = [
  { role: 'R1', title: 'Systems Architect', area: 'Kernel' },
  { role: 'R2', title: 'Database Engineer', area: 'VFS / Database' },
  { role: 'R3', title: 'UI Subsystem Lead', area: 'WM / UI' },
  { role: 'R4', title: 'Pipeline Specialist', area: 'AI Pipeline' },
  { role: 'R5', title: 'Integration Engineer', area: 'QA / DevOps' },
];

/** `<R1 name>`, `<S>`, `<NN>`: identity.json placeholders not filled in yet. */
export function isPlaceholder(text: string): boolean {
  const t = text.trim();
  return t === '' || /^<[^>]*>$/.test(t);
}

/** Team rows in role order; a placeholder name leaves `name` unset ("Member to be announced"). */
export function teamMembers(team: TeamIdentity | undefined): TeamMember[] {
  return ROLES.map((r) => {
    const member: TeamMember = { role: r.role, title: r.title, area: r.area };
    const name = team?.members.find((m) => m.role === r.role)?.name;
    if (name !== undefined && !isPlaceholder(name)) member.name = name;
    return member;
  });
}

/** "Chrome 154", "Unknown browser". */
export function browserText(b: UnameInfo['browser']): string {
  if (b.brand === 'Unknown browser') return b.brand;
  return b.major === null ? b.brand : `${b.brand} ${String(b.major)}`;
}

/** `krelease = version "-" build` (identity-and-branding.md §4.4). */
export function kernelRelease(version: string, build: string): string {
  return `${version}-${build}`;
}

/**
 * `uname -a` (identity-and-branding.md §4.4 ABNF):
 * `Plotinium 0.3.0 (kernel 0.3.0-a1f93c2, built 2026-09-24) · Chrome 154 · 8 cores · uid=1001(student)`.
 */
export function unameLine(u: UnameInfo): string {
  const cores = `${String(u.cores)} ${u.cores === 1 ? 'core' : 'cores'}`;
  return (
    `${u.sysname} ${u.version} (kernel ${kernelRelease(u.version, u.build)}, built ${u.buildDate})` +
    ` · ${browserText(u.browser)} · ${cores} · uid=${String(u.uid)}(${u.user})`
  );
}

/** Binary units as `free` writes them: "256 MB", "1.2 GB". */
export function sizeText(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  if (mb >= 10 || Number.isInteger(mb)) return `${String(Math.round(mb))} MB`;
  return `${mb.toFixed(1)} MB`;
}

export interface AboutFacts {
  readonly identity: AppBuildIdentity;
  readonly team?: TeamIdentity;
  /** null when `uname` failed: the build identity fills in and the host line says so. */
  readonly uname: UnameInfo | null;
  readonly budgetBytes: number | null;
  /** Local usage (statfs) and the server copy (quota), when known. */
  readonly storage: { readonly localBytes: number; readonly cloudBytes: number | null } | null;
  readonly user: { readonly name: string; readonly uid: number } | null;
  readonly updateAvailable: string | null;
  /**
   * The kernel lists the `update` service as degraded (`net.status`), so nobody is checking for
   * updates: the version pill must not claim "up to date" (UI-141).
   */
  readonly updateServiceDown?: boolean;
}

/** "0.3.1 available", "up to date on this channel", or why the status is unknown. */
export function updateStatusText(
  f: Pick<AboutFacts, 'updateAvailable' | 'updateServiceDown'>,
): string {
  if (f.updateAvailable !== null) return `${f.updateAvailable} available`;
  return f.updateServiceDown === true ? 'update check unavailable' : 'up to date on this channel';
}

export function toAboutModel(f: AboutFacts): AboutModel {
  const u = f.uname;
  const version = u?.version ?? f.identity.version;
  const build = u?.build ?? f.identity.build;
  const codename = u === null ? f.identity.codename : u.codename;
  const user = f.user ?? (u === null ? null : { name: u.user, uid: u.uid });
  const team = f.team;
  const footer: string[] = [];
  if (team !== undefined && !isPlaceholder(team.section) && !isPlaceholder(team.teamCode))
    footer.push(`Section ${team.section} · Team ${team.teamCode}`);
  footer.push('Capstone, Fall 2026', '© 2026 Plotinium Team');
  const model: AboutModel = {
    name: f.identity.name,
    version,
    build,
    builtAt: u?.buildDate ?? f.identity.buildDate,
    tagline: team?.tagline ?? DEFAULT_TAGLINE,
    kernel: `plotinium ${kernelRelease(version, build)}`,
    host:
      u === null
        ? { browser: 'Unknown browser', cores: 1 }
        : { browser: browserText(u.browser), cores: u.cores },
    memoryBudget: f.budgetBytes === null ? 'unknown' : sizeText(f.budgetBytes),
    signedIn: user === null ? 'not signed in' : `${user.name} · uid ${String(user.uid)}`,
    updateStatus: updateStatusText(f),
    team: teamMembers(team),
    footer,
    licences: LICENCE_NOTICES,
  };
  if (codename !== null) model.codename = codename;
  if (f.storage !== null) {
    model.storage =
      f.storage.cloudBytes === null
        ? `OPFS ${sizeText(f.storage.localBytes)}`
        : `OPFS ${sizeText(f.storage.localBytes)} · Cloud ${sizeText(f.storage.cloudBytes)}`;
  }
  return model;
}

/** A plain-text system report (Settings > About > System Report…), copied to the clipboard. */
export function systemReport(
  model: AboutModel,
  uname: UnameInfo | null,
  extra: readonly string[] = [],
): string {
  const lines = [
    `${model.name} ${model.version}${model.codename === undefined ? '' : ` "${model.codename}"`}`,
    `build ${model.build} · built ${model.builtAt}`,
    `kernel ${model.kernel}`,
    `host ${model.host.browser} · ${String(model.host.cores)} cores`,
    `memory budget ${model.memoryBudget}`,
    `storage ${model.storage ?? 'unavailable'}`,
    `signed in ${model.signedIn}`,
  ];
  if (uname !== null) lines.push(`uname ${unameLine(uname)}`);
  return [...lines, ...extra].join('\n');
}
