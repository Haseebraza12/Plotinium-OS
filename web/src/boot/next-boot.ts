/**
 * One-shot next-boot requests made on the main thread (boot-and-services.md §3.7, SVC-07):
 * Settings → System → "Show boot menu on next boot" and `reboot --menu`.
 *
 * The normative store is the kernel's `meta.bootFlags` (the `boot.setFlags` syscall, read back in
 * the stage-2 boot-volume read). Until the kernel persists it, the router keeps the same flag in
 * localStorage; `decideProfile` ORs both and the router clears the local copy once the boot
 * proceeds, so the flag stays one-shot either way. Never throws: storage may be unavailable.
 */
export const NEXT_BOOT_KEY = 'plotinium:next-boot';

export interface NextBootFlags {
  readonly menuNextBoot?: boolean;
}

type KV = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function readNextBoot(store: KV | null): NextBootFlags {
  try {
    const raw = store?.getItem(NEXT_BOOT_KEY) ?? null;
    if (raw === null) return {};
    const v: unknown = JSON.parse(raw);
    return typeof v === 'object' && v !== null && (v as NextBootFlags).menuNextBoot === true
      ? { menuNextBoot: true }
      : {};
  } catch {
    return {};
  }
}

export function writeNextBoot(store: KV | null, flags: NextBootFlags): void {
  try {
    if (flags.menuNextBoot === true) store?.setItem(NEXT_BOOT_KEY, '{"menuNextBoot":true}');
    else store?.removeItem(NEXT_BOOT_KEY);
  } catch {
    // Storage blocked (private mode, quota): the kernel flag is the durable path anyway.
  }
}

/** The local store, or null where the accessor throws. */
export function localStore(win: { readonly localStorage: Storage }): KV | null {
  try {
    return win.localStorage;
  } catch {
    return null;
  }
}
