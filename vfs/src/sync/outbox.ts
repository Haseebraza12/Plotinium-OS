/**
 * The in-memory view of the durable outbox (offline-and-sync.md §3.4; virtual-file-system.md §3.14).
 *
 * The VFS appends records in the op's own transaction; `syncd` loads them in commit order (`seq`,
 * the autoIncrement key) and keeps the states that live in memory only: `sent` (on the current
 * connection) and the `principal-auth` / `blob-upload` holds. `parked` and `reverted` are on disk.
 */
import type { OpSubmit, VfsOp } from '@plotinium/protocol';

import type { OutboxRec } from '../store/records.ts';
import type { OutboxSummary, QueueEntry } from './types.ts';

const encoder = new TextEncoder();

/** UTF-8 length of a JSON value, as the socket sends it. */
export function jsonBytes(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).length;
}

/** The inode a fence protects: the op's target file (§3.14.4). */
export function fencedIno(op: VfsOp): string | undefined {
  switch (op.kind) {
    case 'write':
    case 'utimes':
    case 'chmod':
    case 'chown':
    case 'unlink':
    case 'rename':
    case 'link':
      return op.ino;
    case 'create':
    case 'copy':
    case 'batch':
    case 'audit.append':
    case 'session.layout':
      return undefined;
  }
}

/** The `op.submit` body of a record (§4.3 `op.submit`, `OpSubmit`). */
export function toSubmit(rec: OutboxRec): OpSubmit {
  const ino = rec.fence === undefined ? undefined : fencedIno(rec.op);
  return {
    opId: rec.opId,
    osSessionId: rec.osSessionId,
    cseq: rec.cseq,
    lamport: rec.lamport,
    principal: rec.principal,
    clientTime: new Date(rec.createdAt).toISOString(),
    op: rec.op,
    base: rec.base,
    ...(ino !== undefined && rec.fence !== undefined
      ? { fences: [{ ino, fence: rec.fence }] }
      : {}),
    ...(rec.blobs.length > 0 ? { blobs: [...rec.blobs] } : {}),
  };
}

/** Content-bearing ops keep their bytes on a rejection (§3.12.4 step 3; VFS §3.14.4 step 2). */
export function isContentBearing(op: VfsOp): boolean {
  switch (op.kind) {
    case 'write':
      return true;
    case 'create':
      return op.blob !== undefined;
    case 'copy':
      return true;
    case 'batch':
      return op.ops.some(
        (m) =>
          m.kind === 'write' || (m.kind === 'create' && m.blob !== undefined) || m.kind === 'copy',
      );
    case 'unlink':
    case 'rename':
    case 'link':
    case 'chmod':
    case 'chown':
    case 'utimes':
    case 'audit.append':
    case 'session.layout':
      return false;
  }
}

/** A single content op whose bytes can become a local file (write, or create with a blob). */
export function singleContent(
  op: VfsOp,
): { ino: string; blob: string; size: number; name?: string } | null {
  if (op.kind === 'write') return { ino: op.ino, blob: op.blob, size: op.size };
  if (op.kind === 'create' && op.type === 'f' && op.blob !== undefined) {
    return { ino: op.ino, blob: op.blob, size: op.size ?? 0, name: op.name };
  }
  return null;
}

/** Records by commit order, with their in-memory state. */
export class OutboxQueue {
  private readonly byOp = new Map<string, QueueEntry>();
  private order: QueueEntry[] = [];
  private dirty = false;

  /** Merge freshly loaded records: new ones are added, known ones keep their memory state. */
  load(records: readonly OutboxRec[]): void {
    const seen = new Set<string>();
    for (const rec of records) {
      seen.add(rec.opId);
      const cur = this.byOp.get(rec.opId);
      if (cur === undefined) {
        const e: QueueEntry = {
          rec,
          sent: false,
          everSent: rec.attempts > 0,
          held: rec.state === 'parked' ? 'parked' : null,
          reserved: false,
          locked: false,
          cancel: false,
          size: -1,
        };
        this.byOp.set(rec.opId, e);
        this.dirty = true;
      } else if (!cur.sent) {
        // Coalesced by the VFS while pending (§3.14.2): take the new body.
        if (cur.rec !== rec) cur.size = -1;
        cur.rec = rec;
        cur.held = rec.state === 'parked' ? 'parked' : cur.held === 'parked' ? null : cur.held;
      }
    }
    // Records deleted on disk behind our back (a local cancel): drop them unless in flight.
    for (const [opId, e] of this.byOp) if (!seen.has(opId) && !e.sent) this.byOp.delete(opId);
    this.dirty = true;
  }

  get(opId: string): QueueEntry | undefined {
    return this.byOp.get(opId);
  }

  /** Every record, in `seq` order. */
  all(): readonly QueueEntry[] {
    if (this.dirty) {
      this.order = [...this.byOp.values()].sort(
        (a, b) => (a.rec.seq ?? 0) - (b.rec.seq ?? 0) || a.rec.cseq - b.rec.cseq,
      );
      this.dirty = false;
    }
    return this.order;
  }

  remove(opId: string): void {
    if (this.byOp.delete(opId)) this.dirty = true;
  }

  /** Replace a record after a transaction rewrote it (state, attempts, touches). */
  update(rec: OutboxRec): void {
    const e = this.byOp.get(rec.opId);
    if (e === undefined) return;
    e.rec = rec;
    if (rec.state === 'parked') e.held = 'parked';
  }

  /** The connection dropped: every `sent` record goes back to `pending` (memory only). */
  resetSent(): void {
    for (const e of this.byOp.values()) e.sent = false;
  }

  /** Clear the in-memory holds so the next send decision re-derives them. */
  clearHolds(reason: 'principal-auth' | 'blob-upload'): void {
    for (const e of this.byOp.values()) if (e.held === reason) e.held = null;
  }

  sizeOf(e: QueueEntry): number {
    if (e.size < 0) e.size = jsonBytes(toSubmit(e.rec));
    return e.size;
  }

  summary(): OutboxSummary {
    let pending = 0;
    let inflight = 0;
    let held = 0;
    let parked = 0;
    let reverted = 0;
    for (const e of this.byOp.values()) {
      if (e.held === 'parked' || e.rec.state === 'parked') parked++;
      else if (e.sent) inflight++;
      else if (e.held === 'principal-auth') held++;
      else pending++;
      if (e.rec.state === 'reverted') reverted++;
    }
    return { pending, inflight, held, parked, reverted };
  }

  get size(): number {
    return this.byOp.size;
  }
}
