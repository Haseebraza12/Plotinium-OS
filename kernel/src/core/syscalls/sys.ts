/**
 * `uname` (identity-and-branding.md §3.8 and §4.3) and `dmesg`, the read side of the klog ring
 * (syscall-abi.md §4.4.11). Identity comes from the port's PCB, never from args.
 */
import { DMESG_PAGE_MAX } from '@plotinium/protocol';

import type { CallImpl } from '../ipc/handlers.ts';
import { toKlogEntry } from '../klog/format.ts';
import type { KlogRecord } from '../klog/records.ts';
import type { SyscallContext } from './context.ts';

export function uname(k: SyscallContext): CallImpl<'uname'> {
  return {
    handle: ({ pcb }) => ({
      sysname: k.identity.name,
      version: k.identity.version,
      build: k.identity.build,
      buildDate: k.identity.buildDate,
      codename: k.identity.codename,
      browser: { brand: k.platform.browser.brand, major: k.platform.browser.major },
      cores: k.platform.cores,
      uid: pcb.cred.uid,
      user: k.users.nameOf(pcb.cred.uid),
    }),
  };
}

/** Owner uid of a record, or undefined when it names no process. */
function ownerOf(rec: KlogRecord, k: SyscallContext): number | undefined {
  if (rec.kind === 'trace') return rec.pid > 0 ? rec.uid : undefined;
  if (rec.kind === 'proc') return rec.uid ?? k.procs.get(rec.pid)?.cred.uid;
  if (rec.pid === undefined || rec.pid <= 0) return undefined;
  return k.procs.get(rec.pid)?.cred.uid ?? -1;
}

export function dmesg(k: SyscallContext): CallImpl<'dmesg'> {
  return {
    handle: ({ pcb }, args) => {
      const uid = pcb.cred.uid;
      const records = k.klog.read({
        ...(args.since === undefined ? {} : { since: args.since }),
        ...(args.level === undefined ? {} : { level: args.level }),
        limit: Math.min(args.limit ?? DMESG_PAGE_MAX, DMESG_PAGE_MAX),
        // Entries about other uids' processes are root-only (§4.4.11).
        filter: (rec) => {
          if (uid === 0) return true;
          const owner = ownerOf(rec, k);
          return owner === undefined || owner === uid;
        },
      });
      return { entries: records.map((rec) => toKlogEntry(rec, k.epochAtZero)) };
    },
  };
}
