/**
 * Capabilities (syscall-abi.md §3.5 and §4.5, ABI-06).
 *
 * A capability is a named right checked at dispatcher stage 4, in addition to rwx at stage 5. The
 * PCB stores them as a bitset (`caps: Uint32Array(2)`); the bit of a capability is its index in
 * CAP_NAMES, so the order below is part of the ABI (a reorder changes ABI_DIGEST). `fs.scope` is
 * parameterised (a prefix list kept next to the bitset).
 */
import * as v from 'valibot';

/** Every capability, in the order of syscall-abi.md §4.5. */
export const CAP_NAMES = [
  'fs.read',
  'fs.write',
  'fs.scope',
  'proc',
  'kill.other',
  'window',
  'tty',
  'lock',
  'mem',
  'mm.speculative',
  'mm.hint',
  'ai.index',
  'ai.search',
  'ai.plan',
  'batch.grant',
  'ai.telemetry',
  'ai.predict',
  'privacy',
  'auth.session',
  'sys.admin',
  'debug.fault',
  'net.sync',
] as const;

export type Cap = (typeof CAP_NAMES)[number];

export const Cap = v.picklist(CAP_NAMES);

/** Process classes; the executor isolation key is `(uid, class)` (C2, syscall-abi.md §3.2.1). */
export const PROC_CLASSES = ['user', 'agent', 'system'] as const;
export type ProcClass = (typeof PROC_CLASSES)[number];
export const ProcClass = v.picklist(PROC_CLASSES);

/** Capabilities that no manifest can ever grant (syscall-abi.md §5.3). */
export const NEVER_FROM_MANIFEST: readonly Cap[] = ['batch.grant', 'net.sync'];

const USER_BOUNDING: readonly Cap[] = [
  'fs.read',
  'fs.write',
  'proc',
  'window',
  'tty',
  'lock',
  'mem',
  'privacy',
];
const ROOT_EXTRA: readonly Cap[] = ['kill.other', 'sys.admin'];
const AGENT_BOUNDING: readonly Cap[] = ['fs.read', 'fs.scope', 'ai.plan', 'mem'];
const SYSTEM_BOUNDING: readonly Cap[] = [
  'fs.read',
  'mem',
  'mm.speculative',
  'mm.hint',
  'ai.index',
  'ai.search',
  'ai.telemetry',
  'ai.predict',
  'auth.session',
  'window',
  'proc',
];

/**
 * The bounding set of syscall-abi.md §3.5 for a process of class `cls` running as `uid`.
 *
 * - user, uid ≠ 0: `fs.read fs.write proc window tty lock mem privacy`;
 * - user, uid 0: the above + `kill.other sys.admin`, + `debug.fault` only while fault injection is
 *   enabled (`faultInjection`);
 * - agent (any uid): `fs.read fs.scope ai.plan mem`. The kernel-issued `batch.grant` is NOT part of
 *   the bounding set: it is added only for one plan, one-shot, for 120 s (§5.4);
 * - system: the union of the service manifests' caps listed in §3.5.
 */
export function boundingSet(uid: number, cls: ProcClass, faultInjection: boolean): readonly Cap[] {
  switch (cls) {
    case 'agent':
      return AGENT_BOUNDING;
    case 'system':
      return SYSTEM_BOUNDING;
    case 'user':
      if (uid !== 0) return USER_BOUNDING;
      return faultInjection
        ? [...USER_BOUNDING, ...ROOT_EXTRA, 'debug.fault']
        : [...USER_BOUNDING, ...ROOT_EXTRA];
  }
}

/** Bit index of a capability in the PCB bitset. */
export function capBit(cap: Cap): number {
  return CAP_NAMES.indexOf(cap);
}

/** Encode a capability list as the PCB bitset (`Uint32Array(2)`). */
export function capsToBits(caps: Iterable<Cap>): Uint32Array {
  const bits = new Uint32Array(2);
  for (const cap of caps) {
    const bit = capBit(cap);
    const word = bit >>> 5;
    bits[word] = ((bits[word] ?? 0) | (1 << (bit & 31))) >>> 0;
  }
  return bits;
}

/** Decode a PCB bitset back into capability names, in CAP_NAMES order. */
export function bitsToCaps(bits: Uint32Array): Cap[] {
  return CAP_NAMES.filter((_, bit) => (((bits[bit >>> 5] ?? 0) >>> (bit & 31)) & 1) === 1);
}
