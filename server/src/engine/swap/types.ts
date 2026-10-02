/**
 * Shapes of the remote swap store (backend-api.md §3.11, §4.3; memory-and-paging.md §3.11, §4.5;
 * database.md §3.18; MEM-03, MEM-04, MEM-05, SRV-11).
 *
 * TODO(protocol): SwapPage / SwapList belong in protocol/src/http/storage.ts (backend-api.md
 * §4.3); they are declared here until that module exists.
 */

/** One page's address. `ownerUid` is ALWAYS the session uid, never an su principal (§3.11). */
export interface SwapKey {
  readonly ownerUid: number;
  readonly osSessionId: string;
  readonly pid: number;
  readonly pageId: number;
}

/** backend-api.md §4.3 SwapPage, plus the page generation (memory-and-paging.md §4.5). */
export interface SwapPage {
  readonly osSessionId: string;
  readonly pid: number;
  readonly pageId: number;
  readonly gen: number;
  /** Uncompressed bytes. */
  readonly size: number;
  /** Compressed (stored) bytes. */
  readonly storedSize: number;
  /** Hex SHA-256 of the uncompressed bytes. */
  readonly checksum: string;
  readonly updatedAt: string;
}

export interface SwapList {
  readonly pages: readonly SwapPage[];
  readonly next?: string;
}

/** A swap_pages row as the store writes it. */
export interface SwapRow extends SwapKey {
  readonly gen: number;
  readonly storageKey: string;
  readonly size: number;
  readonly storedSize: number;
  readonly checksum: string;
}

export type UpsertOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'quota'; readonly usedBytes: number }
  | { readonly ok: false; readonly reason: 'stale' }
  | { readonly ok: false; readonly reason: 'foreign-session' };

export interface ListFilter {
  readonly osSessionId?: string;
  readonly pid?: number;
}

/** A keyset cursor position: newest OS session first, then (pid, pageId) ascending. */
export interface ListCursor {
  readonly osSessionId: string;
  readonly pid: number;
  readonly pageId: number;
}

/** The storage side of the swap API; every method is one statement or one short transaction. */
export interface SwapDb {
  /** os_sessions.owner_uid, or null when the OS session does not exist. */
  sessionOwner(osSessionId: string): Promise<number | null>;
  getPage(key: SwapKey): Promise<SwapPage | null>;
  /** Sum of the owner's stored_size. */
  usedBytes(ownerUid: number): Promise<number>;
  /**
   * One short transaction (database.md §3.18): lock the owner's users row FOR UPDATE, sum the
   * owner's stored_size except this page, and either upsert the row (only when its generation is
   * not older than the stored one) or, when the quota would be exceeded, DELETE this page's row
   * (its stored object is no longer valid) and report 'quota'.
   */
  upsertPage(row: SwapRow, quotaBytes: number): Promise<UpsertOutcome>;
  /** Rows of one page, one pid or a whole OS session; returns the deleted keys. */
  deletePages(
    ownerUid: number,
    osSessionId: string,
    pid?: number,
    pageId?: number,
  ): Promise<SwapKey[]>;
  listPages(
    ownerUid: number,
    filter: ListFilter,
    after: ListCursor | null,
    limit: number,
  ): Promise<SwapPage[]>;
  /** Retention: deletes every page of OS sessions whose newest page is older than the cutoff. */
  deleteExpired(olderThanDays: number): Promise<SwapKey[]>;
}
