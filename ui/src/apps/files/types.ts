/**
 * Presentational data for the Files views. apps/files maps syscall results (fs.stat, fs.readdir,
 * ai.semsearch, lock leases, quota) onto these shapes; the views never fetch anything (SYS-01).
 */
import type { Tint } from '../../primitives/sidebar/SidebarList.tsx';

export type EntryType = 'file' | 'dir' | 'symlink';

export interface FileLock {
  /** Who holds the write lease. */
  holder: string;
  /** Epoch ms when it was taken (for "2 min ago"). */
  since: number;
  /** The current user holds it. */
  mine?: boolean;
  /** The lease lapsed without being released. */
  stale?: boolean;
}

export interface FileEntry {
  /** Stable id (inode or path). */
  id: string;
  name: string;
  /** Absolute path. */
  path: string;
  type: EntryType;
  /** Permission bits, e.g. 0o644 (setuid, setgid and sticky included when set). */
  mode: number;
  /** Bytes; ignored for folders. */
  size: number;
  /** Modification time, epoch ms. */
  mtime: number;
  /** Creation time, epoch ms. */
  ctime?: number;
  owner: string;
  uid?: number;
  group?: string;
  /** Kind label override, e.g. "PDF Document". */
  kind?: string;
  /** VFS version (inspector "Version 7"). */
  version?: number;
  lock?: FileLock;
  /** An outbox operation is pending, or a sync conflict exists for this file. */
  sync?: 'pending' | 'conflict';
  /** Tag ids. */
  tags?: readonly string[];
  /** false: the name is listed but the user cannot read it (opens with EACCES). */
  readable?: boolean;
  /** The user may write the file (Lock for Editing needs it). */
  writable?: boolean;
  /** Cut to the clipboard: shown at half opacity. */
  cut?: boolean;
  /** Symlink target, shown as "→ target". */
  target?: string;
}

export type SortKey = 'name' | 'modified' | 'size' | 'kind' | 'permissions';
export type SortDirection = 'ascending' | 'descending';

export interface FileSort {
  key: SortKey;
  direction: SortDirection;
}

export type ViewMode = 'icons' | 'list' | 'columns' | 'gallery';

export type PlaceIcon =
  'home' | 'documents' | 'downloads' | 'recent' | 'trash' | 'root' | 'tmp' | 'mnt';

export interface Place {
  id: string;
  label: string;
  icon: PlaceIcon;
  path: string;
  /** A location that is not mounted: listed, dimmed, not selectable. */
  unmounted?: boolean;
}

export interface FileTag {
  id: string;
  label: string;
  tint: Tint;
}

export interface Quota {
  /** Bytes used. */
  used: number;
  /** Bytes allowed. */
  total: number;
}

/** A semantic-search hit (protocol ai/rag SemsearchResult.results[n], plus display fields). */
export interface SemanticHit {
  id: string;
  /** Path relative to the search scope's home, e.g. notes/week6-standup.md. */
  path: string;
  name: string;
  lineStart: number;
  lineEnd: number;
  /** 0..1. */
  score: number;
  /** At most 240 characters, rendered as text only (DSN-09). */
  snippet: string;
  /** [start, end) character ranges of `snippet` to highlight. */
  highlights?: readonly (readonly [number, number])[];
  owner: string;
  /** own: from the local index; server: a foreign result verified by the server. */
  verified: 'own' | 'server';
  /** The file changed and is being re-indexed. */
  stale?: boolean;
}

export type SearchMode = 'semantic' | 'keyword';

/** Notices from ai.semsearch, shown as chips above the results (RAG-06, exact strings). */
export type SearchNotice =
  | { kind: 'model-loading'; /** 0..1 of ai.embed paged in. */ progress: number }
  | { kind: 'model-ready' }
  | { kind: 'unavailable' }
  | { kind: 'shared-hidden'; count: number }
  | { kind: 'truncated' };

/** Who is looking: decides which menu items are enabled. */
export interface Viewer {
  user: string;
  /** Compared with `FileEntry.uid` for ownership (names can be missing or stale). */
  uid?: number;
  root?: boolean;
}
