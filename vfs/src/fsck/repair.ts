/**
 * `fsck --repair` local repairs (virtual-file-system.md §3.21 table). They run on the `FsState`
 * copy; the store diff is computed afterwards. Repairs never bump versions and never write outbox
 * ops: the server keeps its own integrity, and the next online session re-validates (`fsckDirty`).
 * Structural repairs loop until stable, because one repair can expose another (a deleted tmpfs
 * directory orphans its children).
 */
import { INO, SYNTH_FILES, WELL_KNOWN_DIRS } from '@plotinium/protocol';

import { basename } from '../path.ts';
import { lostFoundName } from '../names.ts';
import { MODE_MASK } from '../perm.ts';
import { recomputeUsed, userCharge } from '../quota/quota.ts';
import type { DentryRec, InodeRec, Uuid } from '../store/records.ts';
import { expectedRefcounts, validName } from './check.ts';
import type { InvariantId } from './check.ts';
import type { FsState } from './state.ts';
import { dkey } from './state.ts';

export interface RepairOptions {
  readonly complete?: boolean;
  readonly now: number;
}

const MAX_ROUNDS = 64;
const SYNTH_INOS = new Set(SYNTH_FILES.map((f) => f.ino));
const SYNTH_KEYS = new Set(SYNTH_FILES.map((f) => dkey(INO[f.parent], basename(f.path))));

class Repairer {
  readonly counts = new Map<InvariantId, number>();
  private readonly s: FsState;
  private readonly opts: RepairOptions;

  constructor(s: FsState, opts: RepairOptions) {
    this.s = s;
    this.opts = opts;
  }

  private hit(id: InvariantId): void {
    this.counts.set(id, (this.counts.get(id) ?? 0) + 1);
  }

  private dropDentry(d: DentryRec): void {
    this.s.dentries.delete(dkey(d.parent, d.name));
  }

  private dropInode(ino: Uuid): void {
    this.s.inodes.delete(ino);
    for (const [k, d] of this.s.dentries) if (d.ino === ino) this.s.dentries.delete(k);
  }

  /** Link `ino` into /lost+found as `#<ino12>` (then `-2`, `-3` …). */
  private toLostFound(n: InodeRec): void {
    const name = lostFoundName(n.ino, (c) => this.s.dentries.has(dkey(INO.LOST_FOUND, c)));
    this.s.dentries.set(dkey(INO.LOST_FOUND, name), {
      parent: INO.LOST_FOUND,
      name,
      ino: n.ino,
      dtype: n.type,
    });
  }

  /** I9 first: /lost+found and every well-known directory must exist with the mkfs owner and mode. */
  wellKnown(): void {
    for (const w of WELL_KNOWN_DIRS) {
      const cur = this.s.inodes.get(w.ino);
      if (cur?.type === 'd') {
        if (cur.mode !== w.mode || cur.uid !== w.uid || cur.gid !== w.gid || cur.fs !== 'root') {
          this.s.inodes.set(w.ino, {
            ...cur,
            fs: 'root',
            mode: w.mode,
            uid: w.uid,
            gid: w.gid,
            ctime: this.opts.now,
          });
          this.hit('I9');
        }
        continue;
      }
      if (cur !== undefined) this.dropInode(w.ino);
      const t = this.opts.now;
      this.s.inodes.set(w.ino, {
        ino: w.ino,
        fs: 'root',
        type: 'd',
        mode: w.mode,
        uid: w.uid,
        gid: w.gid,
        size: 0,
        nlink: 2,
        version: 1,
        atime: t,
        mtime: t,
        ctime: t,
        btime: t,
        blob: null,
        target: null,
        mir: w.key === 'HOME' ? 0 : 1,
      });
      if (w.parent !== null) {
        const parent = INO[w.parent];
        const k = dkey(parent, basename(w.path));
        const occupant = this.s.dentries.get(k);
        if (occupant !== undefined) {
          this.dropDentry(occupant);
          const n = this.s.inodes.get(occupant.ino);
          if (n !== undefined) this.toLostFound(n);
        }
        this.s.dentries.set(k, { parent, name: basename(w.path), ino: w.ino, dtype: 'd' });
      }
      this.hit('I9');
    }
  }

  /** I12, I3, I8 row-level repairs. */
  rows(): void {
    for (const ino of SYNTH_INOS) {
      if (this.s.inodes.has(ino)) {
        this.dropInode(ino);
        this.hit('I12');
      }
    }
    for (const d of [...this.s.dentries.values()]) {
      const child = this.s.inodes.get(d.ino);
      if (child === undefined) {
        this.dropDentry(d);
        this.hit('I3');
        continue;
      }
      if (child.type !== d.dtype) {
        this.s.dentries.set(dkey(d.parent, d.name), { ...d, dtype: child.type });
        this.hit('I3');
      }
      if (SYNTH_KEYS.has(dkey(d.parent, d.name)) || !validName(d.name)) {
        this.dropDentry(d);
        this.toLostFound(child);
        this.hit(SYNTH_KEYS.has(dkey(d.parent, d.name)) ? 'I12' : 'I8');
      }
    }
    for (const n of [...this.s.inodes.values()]) {
      let fixed = n;
      if (!Number.isInteger(n.mode) || n.mode < 0 || (n.mode & ~MODE_MASK) !== 0)
        fixed = { ...fixed, mode: Math.max(0, Math.trunc(n.mode)) & MODE_MASK };
      if (n.type === 'd' && n.size !== 0) fixed = { ...fixed, size: 0 };
      if (n.type !== 'f' && n.blob !== null) fixed = { ...fixed, blob: null };
      if (fixed !== n) {
        this.s.inodes.set(n.ino, fixed);
        this.hit('I8');
      }
    }
  }

  /** One round of I2, I5, I11 and I1; returns whether anything changed. */
  structure(): boolean {
    let changed = false;
    const valid = new Set(this.s.validDentries().map((d) => dkey(d.parent, d.name)));
    const linksAll = this.s.linksOf(this.s.dentries.values());

    // I2: a dentry whose parent is missing or not a directory.
    for (const d of [...this.s.dentries.values()]) {
      if (valid.has(dkey(d.parent, d.name))) continue;
      const n = this.s.inodes.get(d.ino);
      this.dropDentry(d);
      const others = (linksAll.get(d.ino) ?? []).filter(
        (x) => x !== d && valid.has(dkey(x.parent, x.name)),
      );
      if (n !== undefined && others.length === 0) {
        if (n.fs === 'tmp') this.dropInode(n.ino);
        else this.toLostFound(n);
      }
      this.hit('I2');
      changed = true;
    }
    if (changed) return true;

    // I5: a directory with several parents keeps the entry whose parent is reachable (lowest ino).
    const { reached } = this.s.reach();
    const vlinks = this.s.linksOf(this.s.validDentries());
    for (const [ino, links] of vlinks) {
      if (this.s.inodes.get(ino)?.type !== 'd' || links.length < 2) continue;
      const sorted = [...links].sort(
        (a, b) =>
          Number(!reached.has(a.parent)) - Number(!reached.has(b.parent)) ||
          (a.parent < b.parent ? -1 : 1),
      );
      for (const extra of sorted.slice(1)) this.dropDentry(extra);
      this.hit('I5');
      changed = true;
    }
    if (changed) return true;

    // I5: a cycle of directories detached from `/` is broken at its lowest ino.
    const parentOf = new Map<Uuid, Uuid>();
    for (const [ino, links] of vlinks) {
      const [only] = links;
      if (only !== undefined && this.s.inodes.get(ino)?.type === 'd')
        parentOf.set(ino, only.parent);
    }
    for (const ino of parentOf.keys()) {
      if (reached.has(ino)) continue;
      const cycle = findCycle(ino, parentOf);
      if (cycle === null) continue;
      const lowest = [...cycle].sort()[0];
      const n = lowest === undefined ? undefined : this.s.inodes.get(lowest);
      const d = n === undefined ? undefined : vlinks.get(n.ino)?.[0];
      if (n === undefined || d === undefined) continue;
      this.dropDentry(d);
      this.toLostFound(n);
      this.hit('I5');
      return true;
    }

    // I11: tmpfs rows outside /tmp are deleted; synced rows below it go to /lost+found.
    const { belowTmp } = this.s.reach();
    for (const n of [...this.s.inodes.values()]) {
      if (!reached.has(n.ino) || n.ino === INO.ROOT) continue;
      if (n.fs === 'tmp' && !belowTmp.has(n.ino)) {
        this.dropInode(n.ino);
        this.hit('I11');
        return true;
      }
      if (n.fs === 'root' && belowTmp.has(n.ino)) {
        const d = (vlinks.get(n.ino) ?? []).find(
          (x) => x.parent === INO.TMP || this.s.inodes.get(x.parent)?.fs === 'tmp',
        );
        if (d === undefined) continue;
        this.dropDentry(d);
        this.toLostFound(n);
        this.hit('I11');
        return true;
      }
    }

    // I1: an inode with no name at all is reattached (a tmpfs orphan is deleted).
    const named = this.s.linksOf(this.s.dentries.values());
    for (const n of [...this.s.inodes.values()]) {
      if (n.ino === INO.ROOT || (named.get(n.ino)?.length ?? 0) > 0) continue;
      if (n.fs === 'tmp') this.dropInode(n.ino);
      else this.toLostFound(n);
      this.hit('I1');
      changed = true;
    }
    return changed;
  }

  /** I4, I6, I7, I10 counters. */
  counters(): void {
    const complete = this.opts.complete === true;
    const valid = this.s.validDentries();
    const links = this.s.linksOf(valid);
    const children = this.s.childrenOf(valid);
    for (const n of [...this.s.inodes.values()]) {
      const l = links.get(n.ino) ?? [];
      const want =
        n.type === 'd'
          ? 2 + (children.get(n.ino) ?? []).filter((d) => d.dtype === 'd').length
          : l.length;
      const exact =
        complete ||
        (n.type === 'd' ? n.mir === 1 : l.every((d) => this.s.inodes.get(d.parent)?.mir === 1));
      if (exact && n.nlink !== want) {
        this.s.inodes.set(n.ino, { ...n, nlink: want });
        this.hit('I4');
      }
    }

    const sums = new Map<number, { bytes: number; inodes: number }>();
    let tmpBytes = 0;
    let tmpInodes = 0;
    for (const n of this.s.inodes.values()) {
      const c = userCharge(n);
      if (c.inodes > 0) {
        const cur = sums.get(n.uid) ?? { bytes: 0, inodes: 0 };
        sums.set(n.uid, { bytes: cur.bytes + c.bytes, inodes: cur.inodes + c.inodes });
      }
      if (n.fs === 'tmp') {
        tmpInodes++;
        if (n.type !== 'd') tmpBytes += n.size;
      }
    }
    for (const u of [...this.s.users.values()]) {
      const sum = sums.get(u.uid) ?? { bytes: 0, inodes: 0 };
      const next = complete
        ? { ...u, usedBytes: sum.bytes, usedInodes: sum.inodes }
        : this.s.input.undo !== undefined
          ? recomputeUsed(u, [...this.s.undo.values()])
          : u;
      if (next.usedBytes !== u.usedBytes || next.usedInodes !== u.usedInodes) {
        this.s.users.set(u.uid, next);
        this.hit('I6');
      }
    }
    if (
      this.s.tmpfsUsage !== undefined &&
      (this.s.tmpfsUsage.bytes !== tmpBytes || this.s.tmpfsUsage.inodes !== tmpInodes)
    ) {
      this.s.tmpfsUsage = { bytes: tmpBytes, inodes: tmpInodes };
      this.hit('I6');
    }

    if (this.s.input.outbox !== undefined || this.s.input.undo !== undefined) {
      const ops = new Set(this.s.outbox.map((o) => o.opId));
      this.s.outbox.forEach((o, i) => {
        if ((o.state === 'pending' || o.state === 'sent') && !this.s.undo.has(o.opId)) {
          this.s.outbox[i] = { ...o, state: 'parked' };
          this.hit('I10');
        }
      });
      for (const u of [...this.s.undo.values()]) {
        if (u.state === 'open' && !ops.has(u.opId)) {
          this.s.undo.delete(u.opId);
          this.hit('I10');
        }
      }
    }

    if (this.s.input.blobs === undefined) return;
    const want = expectedRefcounts(this.s);
    for (const n of this.s.inodes.values()) {
      if (n.type !== 'f' || n.blob === null || this.s.blobs.has(n.blob)) continue;
      // Metadata only: the bytes are fetched online, or the file reads EIO offline (damaged).
      this.s.blobs.set(n.blob, {
        sha: n.blob,
        size: n.size,
        chunks: null,
        refcount: 0,
        uploaded: true,
      });
      this.hit('I7');
    }
    for (const b of [...this.s.blobs.values()]) {
      const w = want.get(b.sha) ?? 0;
      if (b.refcount === w) continue;
      const { zeroSince: _z, ...rest } = b;
      this.s.blobs.set(
        b.sha,
        w === 0 ? { ...rest, refcount: 0, zeroSince: this.opts.now } : { ...rest, refcount: w },
      );
      this.hit('I7');
    }
  }
}

function findCycle(start: Uuid, parentOf: ReadonlyMap<Uuid, Uuid>): Set<Uuid> | null {
  const path: Uuid[] = [];
  const index = new Map<Uuid, number>();
  let cur: Uuid | undefined = start;
  while (cur !== undefined && cur !== INO.ROOT) {
    const at = index.get(cur);
    if (at !== undefined) return new Set(path.slice(at));
    index.set(cur, path.length);
    path.push(cur);
    cur = parentOf.get(cur);
  }
  return null;
}

/** Repair `s` in place; returns how many problems each invariant had repaired. */
export function repairAll(s: FsState, opts: RepairOptions): Map<InvariantId, number> {
  const r = new Repairer(s, opts);
  if (s.duplicates.length > 0) r.counts.set('I13', s.duplicates.length);
  r.wellKnown();
  r.rows();
  const rounds = MAX_ROUNDS + s.inodes.size;
  for (let i = 0; i < rounds; i++) if (!r.structure()) break;
  r.wellKnown(); // a structural repair may have detached a well-known directory
  r.counters();
  return r.counts;
}
