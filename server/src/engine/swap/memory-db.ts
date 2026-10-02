/**
 * MemorySwapDb: the SwapDb contract over in-process maps (unit tests and local tools), with the
 * same semantics as KyselySwapDb: owner-checked sessions, generation-guarded upsert, the quota
 * check that removes the page's row, newest-session-first keyset listing.
 */
import type {
  ListCursor,
  ListFilter,
  SwapDb,
  SwapKey,
  SwapPage,
  SwapRow,
  UpsertOutcome,
} from './types.ts';

const keyOf = (k: SwapKey): string => `${k.ownerUid}/${k.osSessionId}/${k.pid}/${k.pageId}`;

export class MemorySwapDb implements SwapDb {
  /** os_session_id -> owner_uid */
  readonly sessions = new Map<string, number>();
  readonly pages = new Map<string, SwapPage & { ownerUid: number; updatedAtMs: number }>();
  readonly #now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.#now = now;
  }

  sessionOwner(osSessionId: string): Promise<number | null> {
    return Promise.resolve(this.sessions.get(osSessionId) ?? null);
  }

  getPage(k: SwapKey): Promise<SwapPage | null> {
    const p = this.pages.get(keyOf(k));
    return Promise.resolve(p === undefined ? null : strip(p));
  }

  usedBytes(ownerUid: number): Promise<number> {
    let n = 0;
    for (const p of this.pages.values()) if (p.ownerUid === ownerUid) n += p.storedSize;
    return Promise.resolve(n);
  }

  upsertPage(row: SwapRow, quotaBytes: number): Promise<UpsertOutcome> {
    if (this.sessions.get(row.osSessionId) !== row.ownerUid) {
      return Promise.resolve({ ok: false, reason: 'foreign-session' });
    }
    const k = keyOf(row);
    let used = 0;
    for (const [pk, p] of this.pages)
      if (p.ownerUid === row.ownerUid && pk !== k) used += p.storedSize;
    if (used + row.storedSize > quotaBytes) {
      this.pages.delete(k);
      return Promise.resolve({ ok: false, reason: 'quota', usedBytes: used });
    }
    const old = this.pages.get(k);
    if (old !== undefined && old.gen > row.gen)
      return Promise.resolve({ ok: false, reason: 'stale' });
    const now = this.#now();
    this.pages.set(k, {
      ownerUid: row.ownerUid,
      osSessionId: row.osSessionId,
      pid: row.pid,
      pageId: row.pageId,
      gen: row.gen,
      size: row.size,
      storedSize: row.storedSize,
      checksum: row.checksum,
      updatedAt: new Date(now).toISOString(),
      updatedAtMs: now,
    });
    return Promise.resolve({ ok: true });
  }

  deletePages(
    ownerUid: number,
    osSessionId: string,
    pid?: number,
    pageId?: number,
  ): Promise<SwapKey[]> {
    const out: SwapKey[] = [];
    for (const [k, p] of this.pages) {
      if (
        p.ownerUid === ownerUid &&
        p.osSessionId === osSessionId &&
        (pid === undefined || p.pid === pid) &&
        (pageId === undefined || p.pageId === pageId)
      ) {
        this.pages.delete(k);
        out.push({ ownerUid, osSessionId, pid: p.pid, pageId: p.pageId });
      }
    }
    return Promise.resolve(out);
  }

  listPages(
    ownerUid: number,
    filter: ListFilter,
    after: ListCursor | null,
    limit: number,
  ): Promise<SwapPage[]> {
    const rows = [...this.pages.values()]
      .filter(
        (p) =>
          p.ownerUid === ownerUid &&
          (filter.osSessionId === undefined || p.osSessionId === filter.osSessionId) &&
          (filter.pid === undefined || p.pid === filter.pid) &&
          (after === null ||
            p.osSessionId < after.osSessionId ||
            (p.osSessionId === after.osSessionId &&
              (p.pid > after.pid || (p.pid === after.pid && p.pageId > after.pageId)))),
      )
      .sort((a, b) =>
        a.osSessionId !== b.osSessionId
          ? a.osSessionId < b.osSessionId
            ? 1
            : -1
          : a.pid - b.pid || a.pageId - b.pageId,
      )
      .slice(0, limit)
      .map(strip);
    return Promise.resolve(rows);
  }

  deleteExpired(olderThanDays: number): Promise<SwapKey[]> {
    const cutoff = this.#now() - olderThanDays * 86_400_000;
    const newest = new Map<string, number>();
    for (const p of this.pages.values()) {
      const s = `${p.ownerUid}/${p.osSessionId}`;
      newest.set(s, Math.max(newest.get(s) ?? 0, p.updatedAtMs));
    }
    const out: SwapKey[] = [];
    for (const [k, p] of this.pages) {
      if ((newest.get(`${p.ownerUid}/${p.osSessionId}`) ?? 0) < cutoff) {
        this.pages.delete(k);
        out.push({
          ownerUid: p.ownerUid,
          osSessionId: p.osSessionId,
          pid: p.pid,
          pageId: p.pageId,
        });
      }
    }
    return Promise.resolve(out);
  }
}

function strip(p: SwapPage & { ownerUid: number; updatedAtMs: number }): SwapPage {
  return {
    osSessionId: p.osSessionId,
    pid: p.pid,
    pageId: p.pageId,
    gen: p.gen,
    size: p.size,
    storedSize: p.storedSize,
    checksum: p.checksum,
    updatedAt: p.updatedAt,
  };
}
