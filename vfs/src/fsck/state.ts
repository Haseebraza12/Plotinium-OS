/**
 * The rows `fsck` works on (virtual-file-system.md §5.9): a copy of what the chunked scans read, with
 * the indexes the passes need. Repairs mutate this copy; the store diff is computed afterwards.
 */
import { INO } from '@plotinium/protocol';

import type {
  BlobRec,
  DentryRec,
  InodeRec,
  OutboxRec,
  Sha256Hex,
  TmpfsUsage,
  UndoRec,
  UserRec,
  Uuid,
} from '../store/records.ts';

export interface FsckInput {
  readonly inodes: readonly InodeRec[];
  readonly dentries: readonly DentryRec[];
  readonly users?: readonly UserRec[];
  readonly blobs?: readonly BlobRec[];
  /** Chunk hashes present on the device; absent: chunk presence is not checked. */
  readonly chunkShas?: ReadonlySet<Sha256Hex>;
  readonly outbox?: readonly OutboxRec[];
  readonly undo?: readonly UndoRec[];
  readonly tmpfsUsage?: TmpfsUsage;
  /** `--memory` (I14): the loaded directories' in-memory entries, synthesised ones excluded. */
  readonly memory?: { readonly dentries: readonly DentryRec[] };
}

export const dkey = (parent: Uuid, name: string): string => `${parent}\u0000${name}`;

export class FsState {
  readonly inodes = new Map<Uuid, InodeRec>();
  readonly dentries = new Map<string, DentryRec>();
  readonly users = new Map<number, UserRec>();
  readonly blobs = new Map<Sha256Hex, BlobRec>();
  readonly outbox: OutboxRec[];
  readonly undo = new Map<Uuid, UndoRec>();
  tmpfsUsage: TmpfsUsage | undefined;
  readonly input: FsckInput;
  /** Duplicate `(parent, name)` rows seen while copying (I13). */
  readonly duplicates: DentryRec[] = [];

  constructor(input: FsckInput) {
    this.input = input;
    for (const r of input.inodes) this.inodes.set(r.ino, { ...r });
    for (const d of input.dentries) {
      const k = dkey(d.parent, d.name);
      if (this.dentries.has(k)) this.duplicates.push(d);
      else this.dentries.set(k, { ...d });
    }
    for (const u of input.users ?? []) this.users.set(u.uid, { ...u });
    for (const b of input.blobs ?? []) this.blobs.set(b.sha, { ...b });
    this.outbox = (input.outbox ?? []).map((o) => ({ ...o }));
    for (const u of input.undo ?? []) this.undo.set(u.opId, { ...u });
    this.tmpfsUsage = input.tmpfsUsage === undefined ? undefined : { ...input.tmpfsUsage };
  }

  /** Dentries whose parent exists as a directory and whose child exists. */
  validDentries(): DentryRec[] {
    const out: DentryRec[] = [];
    for (const d of this.dentries.values()) {
      if (this.inodes.get(d.parent)?.type === 'd' && this.inodes.has(d.ino)) out.push(d);
    }
    return out;
  }

  childrenOf(valid: readonly DentryRec[]): Map<Uuid, DentryRec[]> {
    const m = new Map<Uuid, DentryRec[]>();
    for (const d of valid) {
      const list = m.get(d.parent);
      if (list === undefined) m.set(d.parent, [d]);
      else list.push(d);
    }
    return m;
  }

  linksOf(dentries: Iterable<DentryRec>): Map<Uuid, DentryRec[]> {
    const m = new Map<Uuid, DentryRec[]>();
    for (const d of dentries) {
      const list = m.get(d.ino);
      if (list === undefined) m.set(d.ino, [d]);
      else list.push(d);
    }
    return m;
  }

  /**
   * Breadth-first reachability from `/` over valid dentries (§5.9 pass 3); `belowTmp` holds the
   * descendants of `/tmp` (I11), `/tmp` itself excluded.
   */
  reach(): { reached: Set<Uuid>; belowTmp: Set<Uuid> } {
    const children = this.childrenOf(this.validDentries());
    const reached = new Set<Uuid>();
    const belowTmp = new Set<Uuid>();
    if (!this.inodes.has(INO.ROOT)) return { reached, belowTmp };
    reached.add(INO.ROOT);
    const queue: { ino: Uuid; tmp: boolean }[] = [{ ino: INO.ROOT, tmp: false }];
    for (let i = 0; i < queue.length; i++) {
      const cur = queue[i];
      if (cur === undefined) break;
      for (const d of children.get(cur.ino) ?? []) {
        if (reached.has(d.ino)) continue;
        reached.add(d.ino);
        const tmp = cur.tmp || cur.ino === INO.TMP;
        if (tmp) belowTmp.add(d.ino);
        if (this.inodes.get(d.ino)?.type === 'd') queue.push({ ino: d.ino, tmp });
      }
    }
    return { reached, belowTmp };
  }
}
