/**
 * Copy-on-write overlay over a base view (virtual-file-system.md §3.12.7): the writes of a plan in
 * progress are visible to the rest of that plan (`mkdir -p` levels, `cp -r` merges, op i of a
 * `batch` seeing ops 0..i-1) while the base view (the committed tree) is never touched. The in-memory
 * tree changes only after `oncomplete` (§3.11), from the same write list.
 */
import type { ChildLookup, EntryList, FsView } from '../view.ts';
import type { DentryRec, InodeRec, UserRec, Uuid } from '../store/records.ts';

const linkKey = (parent: Uuid, name: string): string => `${parent}\u0000${name}`;

export class OverlayView implements FsView {
  readonly base: FsView;
  private readonly inodes = new Map<Uuid, InodeRec | null>();
  private readonly dents = new Map<Uuid, Map<string, DentryRec | null>>();
  /** Directories created by this overlay: their entry set is fully known here. */
  private readonly fresh = new Set<Uuid>();
  private readonly dirEnts = new Map<Uuid, DentryRec | null>();
  private readonly linkEdits = new Map<Uuid, Map<string, DentryRec | null>>();

  constructor(base: FsView) {
    this.base = base;
  }

  get rootIno(): Uuid {
    return this.base.rootIno;
  }

  inode(ino: Uuid): InodeRec | undefined {
    const o = this.inodes.get(ino);
    if (o === undefined) return this.base.inode(ino);
    return o ?? undefined;
  }

  child(dir: Uuid, name: string): ChildLookup {
    const d = this.dents.get(dir)?.get(name);
    if (d !== undefined) return d === null ? null : (this.inode(d.ino) ?? null);
    if (this.fresh.has(dir)) return null;
    return this.base.child(dir, name);
  }

  entries(dir: Uuid): EntryList {
    const edits = this.dents.get(dir);
    const base = this.fresh.has(dir) ? [] : this.base.entries(dir);
    if (typeof base === 'string' || edits === undefined) return base;
    const out = new Map<string, DentryRec>();
    for (const d of base) out.set(d.name, d);
    for (const [name, d] of edits) {
      if (d === null) out.delete(name);
      else out.set(name, d);
    }
    return [...out.values()];
  }

  dirEntry(dir: Uuid): DentryRec | undefined {
    if (this.dirEnts.has(dir)) return this.dirEnts.get(dir) ?? undefined;
    return this.base.dirEntry(dir);
  }

  links(ino: Uuid): readonly DentryRec[] {
    const edits = this.linkEdits.get(ino);
    const base = this.base.links(ino);
    if (edits === undefined) return base;
    const out = new Map<string, DentryRec>();
    for (const d of base) out.set(linkKey(d.parent, d.name), d);
    for (const [k, d] of edits) {
      if (d === null) out.delete(k);
      else out.set(k, d);
    }
    return [...out.values()];
  }

  user(uid: number): UserRec | undefined {
    return this.base.user(uid);
  }

  // Mutators (called only by PlanBuilder, which records the matching store writes).

  setInode(rec: InodeRec, created: boolean): void {
    this.inodes.set(rec.ino, rec);
    if (created && rec.type === 'd') this.fresh.add(rec.ino);
  }

  deleteInode(ino: Uuid): void {
    this.inodes.set(ino, null);
  }

  addDentry(d: DentryRec): void {
    this.dirMap(d.parent).set(d.name, d);
    if (d.dtype === 'd') this.dirEnts.set(d.ino, d);
    this.linkMap(d.ino).set(linkKey(d.parent, d.name), d);
  }

  deleteDentry(d: DentryRec): void {
    this.dirMap(d.parent).set(d.name, null);
    if (d.dtype === 'd') {
      const cur = this.dirEntry(d.ino);
      if (cur !== undefined && cur.parent === d.parent && cur.name === d.name)
        this.dirEnts.set(d.ino, null);
    }
    this.linkMap(d.ino).set(linkKey(d.parent, d.name), null);
  }

  private dirMap(dir: Uuid): Map<string, DentryRec | null> {
    let m = this.dents.get(dir);
    if (m === undefined) {
      m = new Map();
      this.dents.set(dir, m);
    }
    return m;
  }

  private linkMap(ino: Uuid): Map<string, DentryRec | null> {
    let m = this.linkEdits.get(ino);
    if (m === undefined) {
      m = new Map();
      this.linkEdits.set(ino, m);
    }
    return m;
  }
}
