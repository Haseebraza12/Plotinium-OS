/**
 * The desktop host's side of the kernel's host requests (kernel/src/core/io/host.ts), over the
 * router port: the Control Centre memory budget (UI-047), the outbox list of the connectivity
 * popover (UI-026), file search for the Search palette (UI-045), and the page's CSP / Trusted
 * Types violation reports, which the kernel logs to klog (UI-137, security-model.md §3.9).
 *
 * Pure mapping functions are exported for the tests; `HostChannel` owns the request ids.
 */
import type { KernelToRouter, RouterToKernel } from '@plotinium/kernel/host/main';
import type { DesktopEnv, SearchEnv, SearchResponse } from '@plotinium/wm/shell';

type HostReply = Extract<KernelToRouter, { readonly t: 'host.reply' }>;
type OutboxMsg = Extract<KernelToRouter, { readonly t: 'outbox' }>;
type HostRequest = Extract<RouterToKernel, { readonly t: 'host.request' }>['req'];
type ReplyValue = Extract<HostReply, { readonly ok: true }>['value'];
export type HostQueuedOp = OutboxMsg['ops'][number];
export type HostSearchHit = Extract<ReplyValue, { readonly op: 'search' }>['hits'][number];

/** The shell's queued-op row (`DesktopEnv.outbox`). */
export type QueuedOp = ReturnType<NonNullable<DesktopEnv['outbox']>>[number];
/** The shell's search result row. */
export type SearchResult = SearchResponse['results'][number];

/** A request the kernel never answered (it answers every one; this is a backstop). */
export const HOST_REPLY_TIMEOUT_MS = 10_000;

export interface KernelPort {
  post(msg: RouterToKernel): void;
  onMessage(fn: (msg: unknown) => void): () => void;
}

function isMessage(m: unknown): m is { readonly t: string } {
  return typeof m === 'object' && m !== null && typeof (m as { t?: unknown }).t === 'string';
}

export class HostRequestError extends Error {
  readonly errno: string;

  constructor(errno: string, message: string) {
    super(message);
    this.name = 'HostRequestError';
    this.errno = errno;
  }
}

export class HostChannel {
  private readonly port: KernelPort;
  private nextRid = 1;
  private readonly pending = new Map<number, (r: HostReply) => void>();
  private ops: readonly HostQueuedOp[] = [];
  private readonly unlisten: () => void;

  constructor(port: KernelPort) {
    this.port = port;
    this.unlisten = port.onMessage((m) => {
      if (!isMessage(m)) return;
      if (m.t === 'host.reply') {
        const r = m as HostReply;
        const done = this.pending.get(r.rid);
        this.pending.delete(r.rid);
        done?.(r);
      } else if (m.t === 'outbox') {
        this.ops = (m as OutboxMsg).ops;
      }
    });
  }

  /** The last outbox list the kernel pushed (or answered). */
  get outbox(): readonly HostQueuedOp[] {
    return this.ops;
  }

  request<O extends HostRequest['op']>(
    req: Extract<HostRequest, { readonly op: O }>,
    timeoutMs: number = HOST_REPLY_TIMEOUT_MS,
  ): Promise<Extract<ReplyValue, { readonly op: O }>> {
    const rid = this.nextRid++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(rid);
        reject(new HostRequestError('ETIMEDOUT', 'The system did not answer'));
      }, timeoutMs);
      this.pending.set(rid, (r) => {
        clearTimeout(timer);
        if (!r.ok) {
          reject(new HostRequestError(r.errno, r.error));
          return;
        }
        if (r.value.op !== req.op) {
          reject(new HostRequestError('EIO', 'unexpected answer'));
          return;
        }
        resolve(r.value as Extract<ReplyValue, { readonly op: O }>);
      });
      this.port.post({ t: 'host.request', rid, req });
    });
  }

  /** Ask for the outbox list now (the kernel also pushes it when the count changes). */
  refreshOutbox(): void {
    this.request({ op: 'outbox' }).then(
      (v) => {
        this.ops = v.ops;
      },
      () => undefined,
    );
  }

  dispose(): void {
    this.unlisten();
    this.pending.clear();
  }
}

// ---------------------------------------------------------------------------------------------
// Mapping for the shell
// ---------------------------------------------------------------------------------------------

function twoDigits(n: number): string {
  return String(n).padStart(2, '0');
}

/** `14:29` in the page's local time. */
export function clockTime(epochMs: number): string {
  const d = new Date(epochMs);
  return `${twoDigits(d.getHours())}:${twoDigits(d.getMinutes())}`;
}

/** The connectivity popover's rows (UI-026): parked ops are shown as rejected by the server. */
export function queuedOps(ops: readonly HostQueuedOp[]): QueuedOp[] {
  return ops.map((o) => ({
    id: o.id,
    verb: o.verb,
    path: o.path,
    ...(o.target === undefined ? {} : { target: o.target }),
    time: clockTime(o.at),
    ...(o.state === 'parked'
      ? { state: 'rejected' as const, rejection: 'rejected by the server · kept on this device' }
      : { state: 'queued' as const }),
  }));
}

const DOC = new Set(['md', 'txt', 'rtf', 'pdf', 'doc', 'docx', 'odt', 'html', 'htm', 'log']);
const SHEET = new Set(['csv', 'tsv', 'xls', 'xlsx', 'ods']);
const CODE = new Set([
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'json',
  'css',
  'py',
  'c',
  'h',
  'cpp',
  'java',
  'rs',
  'go',
  'sh',
  'yaml',
  'yml',
  'toml',
  'sql',
  'xml',
]);
const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif']);

export function fileKindOf(
  name: string,
  type: HostSearchHit['type'],
): NonNullable<SearchResult['fileKind']> {
  if (type === 'd') return 'folder';
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  if (DOC.has(ext)) return 'document';
  if (SHEET.has(ext)) return 'spreadsheet';
  if (CODE.has(ext)) return 'code';
  if (IMAGE.has(ext)) return 'image';
  return 'other';
}

/** `~/…` for a path under `home`. */
export function tildePath(path: string, home: string): string {
  if (path === home) return '~';
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `Edited 18 Sep` (or `Folder · edited 18 Sep`). */
export function editedMeta(hit: HostSearchHit): string {
  const d = new Date(hit.mtime);
  const when = `${String(d.getDate())} ${MONTHS[d.getMonth()] ?? ''}`;
  return hit.type === 'd' ? `Folder · edited ${when}` : `Edited ${when}`;
}

export const FILE_RESULT_PREFIX = 'file:';

/** Search palette rows for the kernel's file hits (UI-045). */
export function fileResults(hits: readonly HostSearchHit[], home: string): SearchResult[] {
  return hits.map((h) => ({
    id: `${FILE_RESULT_PREFIX}${h.path}`,
    group: 'top' as const,
    kind: 'file' as const,
    title: h.name,
    citation: tildePath(h.path, home),
    meta: editedMeta(h),
    fileKind: fileKindOf(h.name, h.type),
    ...(h.owner === undefined ? {} : { owner: h.owner }),
  }));
}

function dirname(path: string): string {
  const i = path.lastIndexOf('/');
  return i <= 0 ? '/' : path.slice(0, i);
}

/** Extensions the Editor opens (plain text); a name without an extension counts as text. */
const TEXT = new Set([...CODE, 'md', 'txt', 'log', 'csv', 'tsv', 'html', 'htm', 'ini', 'conf']);

function textLike(path: string): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot <= 0 || TEXT.has(name.slice(dot + 1).toLowerCase());
}

/**
 * What opening a file result does: a folder opens in Files; a text file in the Editor; anything
 * else (images, PDFs, archives) is shown in its folder. `reveal` always opens the containing
 * folder in Files.
 */
export function launchFor(
  path: string,
  kind: SearchResult['fileKind'],
  how: 'open' | 'reveal',
): { readonly app: 'files' | 'editor'; readonly argv: readonly string[] } {
  if (how === 'reveal') return { app: 'files', argv: [dirname(path)] };
  if (kind === 'folder') return { app: 'files', argv: [path] };
  if (kind !== 'image' && textLike(path)) return { app: 'editor', argv: [path] };
  return { app: 'files', argv: [dirname(path)] };
}

/**
 * The Search provider (`DesktopEnv.search`): file and folder names under the user's home from
 * the kernel, merged by the shell with its own app results.
 */
export function fileSearch(
  chan: HostChannel,
  home: () => string,
  launch: (app: 'files' | 'editor', argv: readonly string[]) => void,
): SearchEnv {
  return {
    query: async (q, signal) => {
      const t0 = performance.now();
      const v = await chan.request({ op: 'search', q, limit: 20 });
      if (signal.aborted) return { results: [] };
      const results = fileResults(v.hits, home());
      return {
        results,
        stats: {
          count: results.length,
          ms: Math.round(performance.now() - t0),
          source: 'file names',
        },
        ...(v.partial ? { notice: 'Showing the first matches: your home folder is large.' } : {}),
      };
    },
    open: (r, how) => {
      if (!r.id.startsWith(FILE_RESULT_PREFIX)) return;
      const path = r.id.slice(FILE_RESULT_PREFIX.length);
      const target = launchFor(path, r.fileKind, how);
      launch(target.app, target.argv);
    },
  };
}

/** Forward a `securitypolicyviolation` to the kernel log (deduplicated there). */
export function violationMessage(e: {
  readonly effectiveDirective: string;
  readonly disposition: string;
  readonly sample: string;
  readonly sourceFile: string;
  readonly lineNumber: number;
}): Extract<RouterToKernel, { readonly t: 'sec.violation' }> {
  const file = e.sourceFile.replace(/^https?:\/\/[^/]+/, '');
  return {
    t: 'sec.violation',
    directive: e.effectiveDirective.slice(0, 64),
    disposition: e.disposition === 'enforce' ? 'enforce' : 'report',
    sample: e.sample.slice(0, 80),
    source:
      file === ''
        ? ''
        : `${file.slice(0, 100)}${e.lineNumber > 0 ? `:${String(e.lineNumber)}` : ''}`,
  };
}
