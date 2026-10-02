/**
 * The stage-2 profile decision (boot-and-services.md §3.7, SVC-07), first match wins:
 *   1. menu requested: Esc buffered since the first inline line, `?boot=menu`, or the
 *      one-shot `menuNextBoot` boot flag (the kernel's `meta.bootFlags`, or the router's local
 *      fallback written by Settings and `reboot --menu`, see next-boot.ts);
 *   2. auto-safe: the last 2 boots ended in panic, recovery or incomplete (menu, Safe preselected);
 *   3. the URL flag `?boot=safe|recovery|verbose|normal` (removed with history.replaceState);
 *   4. normal.
 */
import type { BootProfile } from '@plotinium/kernel/host/main';

export interface UrlBoot {
  readonly menu: boolean;
  readonly profile: BootProfile | null;
  readonly verbose: boolean;
  /** Boot-record flags: `url:<value>`. */
  readonly flags: readonly string[];
  /** Test builds only (`?bootflags=a,b`, SELECTORS.md §4): `hold-splash`, `inject-cycle`, … */
  readonly testFlags: readonly string[];
}

const PROFILES: ReadonlySet<string> = new Set(['normal', 'safe', 'recovery']);
const BOOT_VALUES: ReadonlySet<string> = new Set(['normal', 'safe', 'recovery', 'verbose', 'menu']);
const TEST_FLAG = /^[a-z][a-z0-9-]{0,31}$/;

const isProfile = (v: string): v is BootProfile => PROFILES.has(v);

/**
 * Read and remove `?boot=` (and `?bootflags=` in test builds) so a manual reload does not repeat
 * them. Unknown `?boot=` values are ignored but still removed.
 */
export function readUrlBoot(
  loc: Pick<Location, 'href'>,
  history: Pick<History, 'replaceState' | 'state'>,
  testBuild = false,
): UrlBoot {
  const url = new URL(loc.href);
  const boot = url.searchParams.get('boot');
  const rawTest = testBuild ? url.searchParams.get('bootflags') : null;
  if (boot === null && rawTest === null)
    return { menu: false, profile: null, verbose: false, flags: [], testFlags: [] };
  url.searchParams.delete('boot');
  if (rawTest !== null) url.searchParams.delete('bootflags');
  history.replaceState(history.state, '', `${url.pathname}${url.search}${url.hash}`);
  const known = boot !== null && BOOT_VALUES.has(boot);
  const testFlags = (rawTest ?? '')
    .split(',')
    .map((f) => f.trim())
    .filter((f) => TEST_FLAG.test(f));
  return {
    menu: boot === 'menu',
    profile: boot !== null && isProfile(boot) ? boot : null,
    verbose: boot === 'verbose',
    flags: [...(known ? [`url:${boot}`] : []), ...testFlags.map((f) => `test:${f}`)],
    testFlags,
  };
}

/** Buffered V presses toggle the verbose log; an odd count means it is on. */
export function verboseFromKeys(keys: readonly string[]): boolean {
  return keys.filter((k) => k === 'v').length % 2 === 1;
}

export interface Decision {
  readonly menu: boolean;
  readonly preselect: 'normal' | 'safe';
  readonly profile: BootProfile;
  readonly verbose: boolean;
  readonly flags: string[];
  /** Consecutive failed boots (the menu warns at 2 or more). */
  readonly failedBoots: number;
}

export interface LoaderView {
  readonly bootFlags: { readonly menuNextBoot?: boolean };
  readonly recentBoots: readonly { readonly outcome: string }[];
}

const FAILED: ReadonlySet<string> = new Set(['panic', 'recovery', 'incomplete']);

/** Consecutive failed boots, counted back from the most recent record. */
export function failedStreak(recent: readonly { readonly outcome: string }[]): number {
  let n = 0;
  for (let i = recent.length - 1; i >= 0 && FAILED.has(recent[i]?.outcome ?? ''); i--) n++;
  return n;
}

export function decideProfile(
  keys: readonly string[],
  url: UrlBoot,
  cfg: LoaderView,
  local: { readonly menuNextBoot?: boolean } = {},
): Decision {
  const verbose = url.verbose || verboseFromKeys(keys);
  const flags = [...url.flags];
  const esc = keys.includes('Escape');
  if (esc) flags.push('esc');
  const metaMenu = cfg.bootFlags.menuNextBoot === true;
  const localMenu = local.menuNextBoot === true;
  if (metaMenu) flags.push('meta:menuNextBoot');
  if (localMenu && !metaMenu) flags.push('local:menuNextBoot');
  const failedBoots = failedStreak(cfg.recentBoots);
  const autoSafe = failedBoots >= 2;
  if (autoSafe) flags.push('auto-safe');
  return {
    menu: esc || url.menu || metaMenu || localMenu || autoSafe,
    preselect: autoSafe ? 'safe' : 'normal',
    profile: url.profile ?? 'normal',
    verbose,
    flags,
    failedBoots,
  };
}
