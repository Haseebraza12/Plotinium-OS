/**
 * `fsck` checks: invariants I1–I14 (virtual-file-system.md §5.12, §5.9), O(N + E).
 *
 * Client semantics by default (partial mirroring): I4 equalities only where the directory is fully
 * mirrored, I6 as "server-confirmed + unacknowledged deltas". `complete` switches to the server's
 * exact equalities, for stores that hold every row (tests, a fully mirrored device).
 */
import { INO, SYNTH_FILES, WELL_KNOWN_DIRS } from '@plotinium/protocol';

import { utf8Length, validateName } from '../path.ts';
import { MODE_MASK } from '../perm.ts';
import { userCharge } from '../quota/quota.ts';
import type { DentryRec, InodeRec } from '../store/records.ts';
import type { FsState } from './state.ts';
import { dkey } from './state.ts';

export type InvariantId = `I${number}`;

export interface InvariantResult {
  readonly id: InvariantId;
  readonly ok: boolean;
  readonly count: number;
  readonly examples: readonly string[];
  /** Reported but not failures (I9 owner or mode deviations). */
  readonly warnings: readonly string[];
}

export interface CheckOptions {
  readonly complete?: boolean;
}

const EXAMPLES_MAX = 100;

class Tally {
  count = 0;
  readonly examples: string[] = [];
  readonly warnings: string[] = [];

  add(example: string): void {
    this.count++;
    if (this.examples.length < EXAMPLES_MAX) this.examples.push(example);
  }

  result(id: InvariantId): InvariantResult {
    return {
      id,
      ok: this.count === 0,
      count: this.count,
      examples: this.examples,
      warnings: this.warnings,
    };
  }
}

const SYNTH_NAMES = new Map(
  SYNTH_FILES.map((s) => [dkey(INO[s.parent], s.path.slice(s.path.lastIndexOf('/') + 1)), s.ino]),
);
const SYNTH_INOS = new Set(SYNTH_FILES.map((s) => s.ino));

export function validInode(n: InodeRec): boolean {
  if (n.type !== 'f' && n.type !== 'd' && n.type !== 'l') return false;
  if (!Number.isInteger(n.mode) || n.mode < 0 || (n.mode & ~MODE_MASK) !== 0) return false;
  if ((n.type === 'l') !== (n.target !== null)) return false;
  if ((n.blob !== null) !== (n.type === 'f')) return false;
  if (n.type === 'l' && n.target !== null && n.size !== utf8Length(n.target)) return false;
  return n.type !== 'd' || n.size === 0;
}

export function validName(name: string): boolean {
  const v = validateName(name);
  return v.ok && v.value === name;
}

/** Whether `nlink` must equal the local count (I4 on a partially mirrored client). */
function exactNlink(
  s: FsState,
  n: InodeRec,
  links: readonly DentryRec[],
  complete: boolean,
): boolean {
  if (complete) return true;
  if (n.type === 'd') return n.mir === 1;
  return links.every((d) => s.inodes.get(d.parent)?.mir === 1);
}

export function checkAll(s: FsState, opts: CheckOptions = {}): InvariantResult[] {
  const complete = opts.complete === true;
  const t = new Map<InvariantId, Tally>();
  const tally = (id: InvariantId): Tally => {
    let x = t.get(id);
    if (x === undefined) {
      x = new Tally();
      t.set(id, x);
    }
    return x;
  };
  for (let i = 1; i <= 14; i++) tally(`I${i}`);

  const all = [...s.dentries.values()];
  const valid = s.validDentries();
  const { reached, belowTmp } = s.reach();
  const linksAll = s.linksOf(all);
  const linksValid = s.linksOf(valid);
  const children = s.childrenOf(valid);

  for (const d of s.duplicates) tally('I13').add(`${d.parent}/${d.name}`);
  for (const d of all) {
    const parent = s.inodes.get(d.parent);
    const child = s.inodes.get(d.ino);
    if (parent?.type !== 'd') tally('I2').add(`${d.parent}/${d.name}`);
    if (child === undefined) tally('I3').add(`${d.parent}/${d.name} -> missing ${d.ino}`);
    else if (child.type !== d.dtype)
      tally('I3').add(`${d.parent}/${d.name} dtype ${d.dtype} != ${child.type}`);
    if (!validName(d.name)) tally('I8').add(`name ${JSON.stringify(d.name)} in ${d.parent}`);
    if (SYNTH_NAMES.has(dkey(d.parent, d.name))) tally('I12').add(`${d.parent}/${d.name}`);
  }

  for (const n of s.inodes.values()) {
    const links = linksAll.get(n.ino) ?? [];
    const vlinks = linksValid.get(n.ino) ?? [];
    if (!validInode(n)) tally('I8').add(`inode ${n.ino}`);
    if (SYNTH_INOS.has(n.ino)) tally('I12').add(`stored synthesised ${n.ino}`);
    if (n.ino === INO.ROOT) continue;
    if (!reached.has(n.ino)) {
      if (links.length === 0) tally('I1').add(n.ino);
      else if (n.type === 'd' && vlinks.length > 0)
        tally('I5').add(`unreachable directory ${n.ino}`);
    }
    if (n.type === 'd' && vlinks.length > 1)
      tally('I5').add(`directory ${n.ino} has ${vlinks.length} parents`);
    if (reached.has(n.ino) && (n.fs === 'tmp') !== belowTmp.has(n.ino))
      tally('I11').add(`${n.ino} fs=${n.fs}`);
  }

  // I4: link counts.
  for (const n of s.inodes.values()) {
    const vlinks = linksValid.get(n.ino) ?? [];
    const want =
      n.type === 'd'
        ? 2 +
          (children.get(n.ino) ?? []).filter(
            (d) => d.dtype === 'd' && s.inodes.get(d.ino)?.type === 'd',
          ).length
        : vlinks.length;
    const exact = exactNlink(s, n, vlinks, complete);
    if (exact ? n.nlink !== want : n.nlink < want)
      tally('I4').add(`${n.ino} nlink ${n.nlink}, counted ${want}`);
  }

  checkQuota(s, complete, tally('I6'));
  checkBlobs(s, tally('I7'));

  for (const w of WELL_KNOWN_DIRS) {
    const n = s.inodes.get(w.ino);
    if (n?.type !== 'd') tally('I9').add(`missing ${w.path}`);
    else if (n.mode !== w.mode || n.uid !== w.uid || n.gid !== w.gid)
      tally('I9').warnings.push(`${w.path} is ${n.uid}:${n.gid} ${n.mode.toString(8)}`);
  }

  if (s.input.outbox !== undefined || s.input.undo !== undefined) {
    const ops = new Set(s.outbox.map((o) => o.opId));
    for (const o of s.outbox) {
      if ((o.state === 'pending' || o.state === 'sent') && !s.undo.has(o.opId))
        tally('I10').add(`op ${o.opId} without undo`);
    }
    for (const u of s.undo.values())
      if (u.state === 'open' && !ops.has(u.opId)) tally('I10').add(`undo ${u.opId} without op`);
  }

  if (s.input.memory !== undefined) {
    const mem = new Map(s.input.memory.dentries.map((d) => [dkey(d.parent, d.name), d]));
    const loaded = new Set(s.input.memory.dentries.map((d) => d.parent));
    for (const [k, d] of mem)
      if (s.dentries.get(k)?.ino !== d.ino) tally('I14').add(`memory ${d.parent}/${d.name}`);
    for (const [k, d] of s.dentries) {
      if (loaded.has(d.parent) && !mem.has(k) && !SYNTH_NAMES.has(k))
        tally('I14').add(`store ${d.parent}/${d.name}`);
    }
  }

  return [...t.entries()].map(([id, x]) => x.result(id));
}

function checkQuota(s: FsState, complete: boolean, out: Tally): void {
  const sums = new Map<number, { bytes: number; inodes: number }>();
  let tmpBytes = 0;
  let tmpInodes = 0;
  for (const n of s.inodes.values()) {
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
  for (const u of s.users.values()) {
    const sum = sums.get(u.uid) ?? { bytes: 0, inodes: 0 };
    if (
      complete
        ? sum.bytes !== u.usedBytes || sum.inodes !== u.usedInodes
        : sum.bytes > u.usedBytes || sum.inodes > u.usedInodes
    ) {
      out.add(
        `uid ${u.uid} used ${u.usedBytes}/${u.usedInodes}, stored ${sum.bytes}/${sum.inodes}`,
      );
    }
    if (!complete && s.input.undo !== undefined) {
      let b = u.serverUsedBytes;
      let i = u.serverUsedInodes;
      for (const r of s.undo.values()) {
        if (r.state !== 'open') continue;
        for (const d of r.users) {
          if (d.uid !== u.uid) continue;
          b += d.dBytes;
          i += d.dInodes;
        }
      }
      if (b !== u.usedBytes || i !== u.usedInodes)
        out.add(`uid ${u.uid} used ${u.usedBytes}/${u.usedInodes}, server+pending ${b}/${i}`);
    }
  }
  if (
    s.tmpfsUsage !== undefined &&
    (s.tmpfsUsage.bytes !== tmpBytes || s.tmpfsUsage.inodes !== tmpInodes)
  ) {
    out.add(
      `tmpfsUsage ${s.tmpfsUsage.bytes}/${s.tmpfsUsage.inodes}, stored ${tmpBytes}/${tmpInodes}`,
    );
  }
}

/** Expected refcount per blob: inode references + undo pins + outbox pins (§3.13.4). */
export function expectedRefcounts(s: FsState): Map<string, number> {
  const want = new Map<string, number>();
  const add = (sha: string): void => {
    want.set(sha, (want.get(sha) ?? 0) + 1);
  };
  for (const n of s.inodes.values()) if (n.type === 'f' && n.blob !== null) add(n.blob);
  for (const u of s.undo.values()) for (const sha of u.pins) add(sha);
  for (const o of s.outbox) for (const sha of o.blobs) add(sha);
  return want;
}

function checkBlobs(s: FsState, out: Tally): void {
  if (s.input.blobs === undefined) return;
  const want = expectedRefcounts(s);
  for (const n of s.inodes.values()) {
    if (n.type === 'f' && n.blob !== null && !s.blobs.has(n.blob))
      out.add(`missing blob ${n.blob} of ${n.ino}`);
  }
  for (const b of s.blobs.values()) {
    const w = want.get(b.sha) ?? 0;
    if (b.refcount !== w) out.add(`blob ${b.sha} refcount ${b.refcount}, counted ${w}`);
    const chunks = s.input.chunkShas;
    if (chunks !== undefined && b.chunks !== null) {
      for (const c of b.chunks) if (!chunks.has(c)) out.add(`blob ${b.sha} missing chunk ${c}`);
    }
  }
}

export function isClean(results: readonly InvariantResult[]): boolean {
  return results.every((r) => r.ok);
}
