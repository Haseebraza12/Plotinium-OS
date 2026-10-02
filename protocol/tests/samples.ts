/**
 * Valid and invalid samples for every system call (syscall-abi.md §4.4). `satisfies Record<CallName,
 * CallSamples>` makes a missing call a type error, so a new call cannot ship without samples.
 */
import type { CallName } from '../src/sys/names.ts';

export interface CallSamples {
  /** Arguments the call's args schema MUST accept. */
  readonly args: readonly unknown[];
  /** Arguments it MUST reject (each targets one constraint). */
  readonly badArgs: readonly unknown[];
  /** Return values its ret schema MUST accept (empty for `exit`, which never replies). */
  readonly ret: readonly unknown[];
  /** Return values it MUST reject. */
  readonly badRet?: readonly unknown[];
}

export const INO = '0192f0c1-8a3b-7c4d-8e5f-0123456789ab';
export const INO2 = '0192f0c1-8a3b-7c4d-9e5f-0123456789ac';
export const SHA = 'ab'.repeat(32);
export const NOW = 1_790_000_000_000;
const MIB = 1_048_576;
export const TOKEN = `${INO}.${NOW + 120_000}.${'A'.repeat(43)}`;

const MUT = { opId: INO2, sync: 'applied' } as const;
export const STAT = {
  ino: INO,
  type: 'f',
  mode: 0o644,
  uid: 1001,
  gid: 100,
  size: 10,
  nlink: 1,
  atime: NOW,
  mtime: NOW,
  ctime: NOW,
  version: 1,
  blob: SHA,
  target: null,
} as const;
const STAT_DIR = { ...STAT, type: 'd', mode: 0o755, size: 0, nlink: 2, blob: null } as const;
const STAT_LINK = { ...STAT, type: 'l', mode: 0o777, blob: null, target: '../x' } as const;
const STAT_EXT = { ...STAT, btime: NOW, fs: 'tmp', synth: false, cached: true } as const;
export const DIRENT = { name: 'notes.md', ino: INO, type: 'f' } as const;
const LEASE = {
  path: '/home/alice/a.md',
  holder: 'alice@lab-pc-3',
  mode: 'X',
  expiresAt: NOW,
  scope: 'server',
} as const;
const RECT = { x: 10, y: 20, w: 640, h: 480 } as const;
export const PROC_INFO = {
  pid: 12,
  ppid: 1,
  pgid: 12,
  uid: 1001,
  user: 'alice',
  state: 'BLOCKED',
  class: 'user',
  waitingOn: 'tty:read:1',
  priority: 20,
  nice: 0,
  effPrio: 20,
  cpuPct: 0.5,
  cpuTimeMs: 120,
  residentBytes: 65_536,
  swappedBytes: 0,
  faults: 0,
  hitRatio: 1,
  speculative: false,
  argv: ['sh'],
  executor: 2,
  windows: [7],
  startedAt: NOW,
} as const;
const PROC_DETAIL = {
  ...PROC_INFO,
  pages: [
    {
      pageId: 0,
      loc: 'RESIDENT',
      dirty: false,
      size: 65_536,
      lastAccess: NOW,
      pinned: false,
      speculative: false,
    },
  ],
  fds: [
    { fd: 0, kind: 'tty', flags: 'rw' },
    { fd: 3, kind: 'file', path: '/a', flags: 'r' },
  ],
  leases: [LEASE],
  caps: ['fs.read'],
  exitReason: 'normal',
} as const;
const TTYATTR = {
  n: 1,
  canonical: true,
  echo: true,
  isig: true,
  altScreen: false,
  cols: 80,
  rows: 24,
  fgPgid: 12,
  sid: 12,
} as const;
const MEMSTAT = {
  budget: 268_435_456,
  accounted: 1000,
  reservedWaiting: 0,
  resident: 900,
  swappedLocal: 100,
  swappedRemote: 0,
  speculative: 0,
  embed: { bytes: 0, state: 'absent' },
  kernel: 4096,
  faults: 3,
  faultsPerSec: 0.1,
  hitRatio: 0.97,
  bytesIn: 100,
  bytesOut: 200,
  procs: [
    {
      pid: 12,
      accounted: 1000,
      resident: 900,
      swapped: 100,
      faults: 3,
      hitRatio: 0.97,
      softLimit: 65_536,
    },
  ],
} as const;
export const NETSTATUS = {
  state: 'offline',
  queuedOps: 3,
  lastAckAt: null,
  degraded: ['sync', 'lockd'],
  leaseTtlMs: 30_000,
  serverBuild: null,
} as const;
const EVENT_NOTIFY = {
  topic: 'notify',
  seq: 1,
  t: NOW,
  data: { nid: 1, title: 'Saved', body: 'x', level: 'info', pid: 12 },
} as const;
const MODEL_KEY = 'mdbr-leaf-ir-q8@4262131b-384';
const SEMSEARCH_RESULT = {
  mode: 'semantic',
  model: { key: MODEL_KEY, state: 'ready' },
  results: [
    {
      path: '/home/alice/notes.md',
      ino: INO,
      lineStart: 3,
      lineEnd: 9,
      score: 0.81,
      snippet: 'budget for Q3',
      verified: 'own',
    },
  ],
  notices: [],
  timings: { embedMs: 12, filterMs: 1, scanMs: 4, verifyMs: 0, totalMs: 18 },
} as const;
const INDEX_STATUS = {
  state: 'indexing',
  pending: 3,
  indexedFiles: 10,
  chunks: 40,
  modelKey: MODEL_KEY,
  modelState: 'ready',
  files: [{ ino: INO, inodeVersion: 2, state: 'indexed' }],
} as const;
const chunk = () => ({
  seq: 0,
  byteStart: 0,
  byteEnd: 100,
  lineStart: 1,
  lineEnd: 4,
  header: 'notes.md',
  contentHash: SHA,
  vector: new Float32Array(384),
  preview: 'budget',
  terms: [['budget', 2]],
});
const indexPut = () => ({
  ino: INO,
  inodeVersion: 2,
  modelKey: MODEL_KEY,
  chunks: [
    chunk(),
    {
      seq: 1,
      byteStart: 100,
      byteEnd: 120,
      lineStart: 5,
      lineEnd: 5,
      header: 'notes.md',
      contentHash: SHA,
      reuseOf: SHA,
    },
  ],
});
export const ENVELOPE = {
  cwd: '/home/alice',
  now: '2026-10-05T10:00:00+05:00',
  tz: 'Asia/Karachi',
  listing: [DIRENT],
  listingTotal: 1,
} as const;
export const PLAN_STEP = {
  id: 's1',
  op: 'unlink',
  args: { path: '/home/alice/drafts', recursive: true },
  span: 'delete old drafts',
} as const;
const SUBMIT_RESULT = {
  planId: INO,
  planHash: SHA,
  dryRunHash: SHA,
  dryRun: {
    ops: [{ op: 'unlink', path: '/home/alice/drafts', recursive: true }],
    inodes: 12,
    bytes: 4096,
    deletions: 12,
    overwrites: 0,
    quotaOk: true,
    resolvedTimes: [{ from: '2026-09-01T00:00:00+05:00', to: '2026-10-01T00:00:00+05:00' }],
  },
  confirm: { required: true, reasons: ['delete'] },
  expectedVersions: [{ ino: INO, version: 3 }],
} as const;
export const AUDIT = {
  auditId: INO,
  t: NOW,
  level: 'agent',
  osSessionId: INO2,
  pid: 12,
  uid: 1001,
  actor: 'agent',
  call: 'batch',
  argsDigest: SHA,
  argsSummary: 'unlink /home/alice/drafts (recursive)',
  outcome: 'ok',
  durationUs: 1200,
  promptId: INO,
  planHash: SHA,
  dryRunHash: SHA,
  confirmation: 'confirmed',
  observations: [{ call: 'find', argsDigest: SHA, ok: true }],
  txnId: INO,
  opId: INO,
  undoId: INO2,
  inodes: 12,
} as const;
const TELEMETRY_EVENT = {
  v: 1,
  seq: 10,
  ts: NOW,
  tzOffsetMin: 300,
  kind: 'launch',
  app: 'terminal',
  prev: 'files',
  hourBucket: 2,
  dow: 4,
  weekend: false,
  sessionPos: 3,
  origin: 'user',
  osSessionId: INO2,
} as const;
const UNAME = {
  sysname: 'Plotinium',
  version: '0.1.0',
  build: 'a1f93c2',
  buildDate: '2026-09-24',
  codename: null,
  browser: { brand: 'Chrome', major: 140 },
  cores: 8,
  uid: 1001,
  user: 'alice',
} as const;
const FSCK = {
  inodes: 100,
  orphans: 0,
  parentless: 0,
  unreachable: 0,
  nlinkErrors: 0,
  quotaDrift: 0,
  cycles: 0,
  danglingLinks: 1,
  checksum: SHA,
  durationMs: 42,
} as const;

/** Created lazily so each test gets fresh ports and buffers. */
export function samples(port: MessagePort): Record<CallName, CallSamples> {
  return {
    // §4.4.1
    spawn: {
      args: [
        { path: '/bin/ls.json', argv: ['ls', '-l'] },
        {
          path: '/bin/sh.json',
          argv: ['sh'],
          env: { HOME: '/home/alice' },
          cwd: '/home/alice',
          fds: { 0: 0, 1: 1, 2: 2 },
          pgid: 0,
          priority: 20,
          nice: 5,
          dropCaps: ['window'],
        },
      ],
      badArgs: [
        { argv: ['ls'] },
        { path: '/bin/ls.json', argv: Array.from({ length: 257 }, () => 'x') },
        { path: '/bin/x.json', argv: [], nice: 20 },
        { path: '/bin/x.json', argv: ['a'.repeat(40_000), 'b'.repeat(40_000)] },
        { path: '/bin/x.json', argv: [], env: { 'BAD-NAME': 'x' } },
        { path: '/bin/x.json', argv: [], dropCaps: ['root'] },
      ],
      ret: [{ pid: 42 }],
      badRet: [{ pid: 0 }],
    },
    exit: {
      args: [{ code: 0 }, { code: 255 }],
      badArgs: [{ code: 256 }, { code: -1 }, { code: 1.5 }, {}],
      ret: [],
      badRet: [undefined, {}],
    },
    wait: {
      args: [{ pid: 5 }, { pid: -1, nohang: true }, { pid: -7, untraced: true, continued: true }],
      badArgs: [{ pid: 0 }, { pid: 40_000 }],
      ret: [
        { pid: 5, status: { kind: 'exited', code: 0 } },
        { pid: 5, status: { kind: 'signaled', signal: 'SIGKILL', code: 137 } },
        { pid: 5, status: { kind: 'stopped', signal: 'SIGTSTP' } },
        { pid: 5, status: { kind: 'continued' } },
        { pid: 0 },
      ],
      badRet: [
        { pid: 5, status: { kind: 'exited', code: 300 } },
        { pid: 0, status: { kind: 'continued' } },
      ],
    },
    kill: {
      args: [
        { pid: 5, sig: 'SIGTERM' },
        { pid: -5, sig: 'SIGINT' },
        { pid: 0, sig: 0 },
      ],
      badArgs: [{ pid: 5, sig: 'TERM' }, { pid: 5, sig: 9 }, { pid: 5 }],
      ret: [{ delivered: 1 }],
    },
    getpid: {
      args: [{}],
      badArgs: [{ pid: 1 }],
      ret: [
        { pid: 5, ppid: 1, pgid: 5, sid: 3 },
        { pid: 1, ppid: 0, pgid: 1, sid: 1 },
      ],
    },
    'proc.cred': {
      args: [{}],
      badArgs: [{ uid: 0 }],
      ret: [
        {
          uid: 1001,
          gid: 100,
          groups: [100, 200],
          user: 'alice',
          groupNames: ['users', 'team'],
          home: '/home/alice',
          ruid: 1001,
        },
        {
          uid: 0,
          gid: 0,
          groups: [0],
          user: 'root',
          groupNames: ['root'],
          home: '/root',
          ruid: 1001,
          grantExpiresAt: NOW,
        },
      ],
    },
    getcwd: { args: [{}], badArgs: [{ path: '/' }], ret: [{ path: '/home/alice', ino: INO }] },
    chdir: {
      args: [{ path: '/tmp' }, { path: 'docs' }],
      badArgs: [{ path: '' }, {}],
      ret: [{ path: '/tmp', ino: INO }],
    },
    umask: { args: [{}, { mask: 0o022 }], badArgs: [{ mask: 0o1000 }], ret: [{ old: 0o022 }] },
    nice: {
      args: [{ inc: 5 }, { inc: -39 }],
      badArgs: [{ inc: 40 }],
      ret: [{ priority: 20, nice: 5, effPrio: 25 }],
    },
    setpriority: {
      args: [
        { pid: 0, nice: 3 },
        { pid: 12, group: true, priority: 30 },
      ],
      badArgs: [{ pid: 12, nice: 20 }],
      ret: [{ priority: 20, nice: 3, effPrio: 23 }],
    },
    getpriority: {
      args: [{ pid: 12 }],
      badArgs: [{ pid: 0 }],
      ret: [{ priority: 20, nice: 0, effPrio: 20, band: 'normal' }],
    },
    setpgid: {
      args: [
        { pid: 0, pgid: 0 },
        { pid: 12, pgid: 10 },
      ],
      badArgs: [{ pid: -1, pgid: 0 }],
      ret: [{ pgid: 12 }],
    },
    'sig.action': {
      args: [
        { sig: 'SIGINT', action: 'catch' },
        { sig: 'SIGKILL', action: 'default' },
      ],
      badArgs: [
        { sig: 'SIGKILL', action: 'ignore' },
        { sig: 'SIGSTOP', action: 'catch' },
        { sig: 'SIGINT', action: 'block' },
      ],
      ret: [{ old: 'default' }],
    },
    'proc.list': {
      args: [{}, { uid: 1001, pgid: 5, cursor: 'c1', limit: 1024 }],
      badArgs: [{ limit: 1025 }, { limit: 0 }],
      ret: [{ procs: [PROC_INFO], next: 'c2' }, { procs: [] }],
    },
    'proc.info': { args: [{ pid: 12 }], badArgs: [{ pid: 'x' }], ret: [PROC_DETAIL, PROC_INFO] },

    // §4.4.2
    open: {
      args: [
        { path: '/home/alice/a.md', flags: 'r' },
        {
          path: 'b.md',
          flags: 'w',
          create: true,
          excl: true,
          trunc: true,
          mode: 0o600,
          follow: false,
        },
      ],
      badArgs: [
        { path: '/a', flags: 'x' },
        { path: '/a' },
        { path: '/a', flags: 'r', mode: 0o10000 },
      ],
      ret: [{ fd: 3, ino: INO, type: 'f', version: 1, size: 0 }],
    },
    read: {
      args: [
        { fd: 3, len: 4096 },
        { fd: 3, len: 16 * MIB, offset: 10 },
      ],
      badArgs: [
        { fd: 3, len: 0 },
        { fd: 3, len: 16 * MIB + 1 },
        { fd: 1024, len: 1 },
      ],
      ret: [new ArrayBuffer(0), new ArrayBuffer(10)],
      badRet: ['text', new Uint8Array(4)],
    },
    write: {
      args: [
        { fd: 3, data: new ArrayBuffer(4) },
        { fd: 3, data: new ArrayBuffer(1), offset: 5, expectedVersion: 2 },
      ],
      badArgs: [
        { fd: 3, data: 'hello' },
        { fd: 3, data: new Uint8Array(4) },
      ],
      ret: [
        { bytes: 4 },
        {
          bytes: 4,
          version: 3,
          opId: INO2,
          sync: 'pending',
          conflict: {
            keptAs: { ino: INO, path: '/home/alice/a (conflict from bob, 2026-09-24).md' },
          },
        },
      ],
    },
    writeFile: {
      args: [{ path: '/a.md', data: new ArrayBuffer(3) }],
      badArgs: [{ path: '/a.md', data: 'x' }],
      ret: [{ ino: INO, version: 1, bytes: 3, ...MUT }],
    },
    close: { args: [{ fd: 3 }], badArgs: [{ fd: -1 }], ret: [{}] },
    seek: {
      args: [{ fd: 3, offset: -10, whence: 'end' }],
      badArgs: [{ fd: 3, offset: 1, whence: 'start' }],
      ret: [{ offset: 0 }],
    },
    stat: {
      args: [{ path: '/' }, { path: '/a', follow: false }],
      badArgs: [{ path: 'a'.repeat(4097) }, { path: '/a\u0000b' }],
      ret: [STAT, STAT_DIR, STAT_LINK, STAT_EXT],
      badRet: [
        { ...STAT, type: 'x' },
        { ...STAT, extra: 1 },
      ],
    },
    lstat: { args: [{ path: '/a' }], badArgs: [{ path: '/a', follow: true }], ret: [STAT_LINK] },
    fstat: { args: [{ fd: 3 }], badArgs: [{ path: '/a' }], ret: [STAT] },
    readdir: {
      args: [{ path: '/home' }, { path: '/home', plus: true, cursor: 'c', limit: 1000 }],
      badArgs: [{ path: '/', limit: 1001 }],
      ret: [
        {
          entries: [DIRENT, { ...DIRENT, name: 'sub', type: 'd', stat: STAT_DIR }],
          dirVersion: 3,
          next: 'c2',
        },
      ],
    },
    mkdir: {
      args: [{ path: '/a/b' }, { path: '/a/b/c', mode: 0o700, parents: true }],
      badArgs: [{ path: '/a', mode: -1 }],
      ret: [{ ino: INO, created: 1, ...MUT }],
    },
    rmdir: { args: [{ path: '/a' }], badArgs: [{}], ret: [{ ...MUT }] },
    unlink: {
      args: [{ path: '/a' }, { path: '/a', recursive: true }],
      badArgs: [{ path: '/a', recursive: 'yes' }],
      ret: [{ removed: 1000, bytes: 7_340_032, ...MUT }],
    },
    rename: {
      args: [
        { from: '/a', to: '/b' },
        { from: '/a', to: '/b', noReplace: true },
      ],
      badArgs: [{ from: '/a' }],
      ret: [
        { ino: INO, ...MUT },
        { ino: INO, replaced: INO2, ...MUT },
      ],
    },
    symlink: {
      args: [
        { target: '../x', path: '/l' },
        { target: '', path: '/l2' },
      ],
      badArgs: [{ target: 'x'.repeat(4097), path: '/l' }],
      ret: [{ ino: INO, ...MUT }],
    },
    readlink: { args: [{ path: '/l' }], badArgs: [{}], ret: [{ target: '../x' }] },
    link: {
      args: [{ existing: '/a', path: '/b' }],
      badArgs: [{ from: '/a', to: '/b' }],
      ret: [{ ino: INO, nlink: 2, ...MUT }],
    },
    chmod: {
      args: [
        { path: '/a', mode: { op: 'set', bits: 0o644 } },
        { path: '/d', mode: { op: 'delta', add: 0o1000, clear: 0o002 }, recursive: true },
      ],
      badArgs: [
        { path: '/a', mode: { op: 'set', bits: 0o4755 } },
        { path: '/a', mode: 0o644 },
        { path: '/a', mode: { op: 'delta', add: 0o2000, clear: 0 } },
      ],
      ret: [{ changed: 1, ...MUT }],
    },
    chown: {
      args: [{ path: '/a', uid: 1001 }, { path: '/a', gid: 100, recursive: true }, { path: '/a' }],
      badArgs: [{ path: '/a', uid: -1 }],
      ret: [{ changed: 3, ...MUT }],
    },
    truncate: {
      args: [
        { path: '/a', size: 0 },
        { fd: 3, size: 100 },
      ],
      badArgs: [{ path: '/a', fd: 3, size: 0 }, { size: 1 }],
      ret: [{ version: 2, ...MUT }],
    },
    utimes: {
      args: [{ path: '/a' }, { path: '/a', atime: 'now', mtime: NOW }],
      badArgs: [{ path: '/a', mtime: 'later' }],
      ret: [{ ...MUT }],
    },
    statfs: {
      args: [{}, { path: '/tmp' }],
      badArgs: [{ path: '' }],
      ret: [
        {
          fsId: 'plotinium',
          usageBytes: 10,
          quotaBytes: null,
          inodes: 5,
          persisted: true,
          swapBytes: { local: 0, remote: 0 },
        },
      ],
    },
    quota: {
      args: [{}, { uid: 1001 }],
      badArgs: [{ uid: -5 }],
      ret: [
        {
          uid: 1001,
          usedBytes: 10,
          quotaBytes: 100,
          usedInodes: 1,
          quotaInodes: 10,
          source: 'server',
        },
        {
          uid: 0,
          usedBytes: 0,
          quotaBytes: null,
          usedInodes: 0,
          quotaInodes: null,
          source: 'mirror',
        },
      ],
    },
    copy: {
      args: [
        { from: '/a', to: '/b' },
        { from: '/a', to: '/b', recursive: true, noReplace: true, preserve: false },
      ],
      badArgs: [{ from: '/a', to: '/b', recursive: 1 }],
      ret: [{ copied: 3, bytes: 10, ...MUT }],
    },
    find: {
      args: [
        { path: '/home/alice' },
        {
          path: '.',
          name: '*.md',
          type: 'f',
          mtime: { within: { unit: 'day', count: 7 } },
          size: { gt: 1024 },
          maxDepth: 3,
          limit: 500,
          plus: true,
          cursor: 'c',
        },
        { path: '/', mtime: { olderThan: { unit: 'month', count: 1, mode: 'calendar' } } },
        { path: '/', mtime: { after: 1, before: 2 } },
      ],
      badArgs: [
        { path: '/', name: '' },
        { path: '/', mtime: { within: { unit: 'year', count: 1 } } },
        { path: '/', maxDepth: 65 },
        { path: '/', limit: 10_001 },
        {
          path: '/',
          mtime: { within: { unit: 'day', count: 1 }, olderThan: { unit: 'day', count: 1 } },
        },
      ],
      ret: [
        { paths: ['/a'], denied: 0, truncated: false },
        {
          paths: [],
          entries: [DIRENT],
          next: 'c',
          denied: 2,
          truncated: true,
          resolved: { from: '2026-09-17T00:00:00+05:00', to: '2026-09-24T10:00:00+05:00' },
        },
      ],
    },
    grep: {
      args: [
        { paths: ['/a'], pattern: 'TODO', mode: 'l' },
        { paths: ['/d'], pattern: 'x', recursive: true, ignoreCase: true, mode: 'c', limit: 10 },
      ],
      badArgs: [
        { paths: [], pattern: 'x', mode: 'l' },
        { paths: ['/a'], pattern: '', mode: 'c' },
        { paths: ['/a'], pattern: 'x', mode: 'n' },
      ],
      ret: [{ matches: [{ path: '/a', count: 2 }], denied: 0, skippedBinary: 1 }],
    },
    du: {
      args: [{ path: '/' }, { path: '/', maxDepth: 1, apparent: true }],
      badArgs: [{ path: '/', maxDepth: -1 }],
      ret: [{ bytes: 100, inodes: 3, denied: 0, children: [{ name: 'a', bytes: 10, inodes: 1 }] }],
    },
    wc: {
      args: [{ paths: ['/a', '/b'] }],
      badArgs: [{ paths: [] }],
      ret: [
        {
          files: [{ path: '/a', lines: 1, words: 2, bytes: 3 }],
          total: { lines: 1, words: 2, bytes: 3 },
        },
      ],
    },
    lsof: {
      args: [{}, { path: '/a' }, { pid: 5 }],
      badArgs: [{ pid: 0 }],
      ret: [{ open: [{ pid: 5, uid: 1001, fd: 3, path: '/a', flags: 'r' }], leases: [LEASE] }],
    },
    batch: {
      args: [
        {
          txnId: INO,
          ops: [
            { op: 'mkdir', path: '/a' },
            { op: 'write', path: '/a/x', text: 'hi' },
            { op: 'rename', from: '/a/x', to: '/a/y' },
            { op: 'copy', from: '/a/y', to: '/a/z', recursive: false },
            { op: 'unlink', path: '/a/z' },
            { op: 'symlink', target: 'y', path: '/a/l' },
            { op: 'chmod', path: '/a', mode: { op: 'set', bits: 0o755 } },
            { op: 'chown', path: '/a', uid: 1001 },
            { op: 'utimes', path: '/a', mtime: 'now' },
          ],
          expectedVersions: [{ ino: INO, version: 1 }],
          token: TOKEN,
          planId: INO2,
        },
      ],
      badArgs: [
        { txnId: INO, ops: [], expectedVersions: [] },
        { txnId: INO, ops: [{ op: 'rmdir', path: '/a' }], expectedVersions: [] },
        { txnId: INO, ops: [{ op: 'mkdir', path: '/a' }], expectedVersions: [], token: 'forged' },
      ],
      ret: [{ txnId: INO, applied: 9, inodes: 5, bytes: 2, undoId: INO2, ...MUT }],
    },

    // §4.4.3
    pipe: { args: [{}, { capacity: 4096 }], badArgs: [{ capacity: 1024 }], ret: [{ r: 3, w: 4 }] },
    dup: { args: [{ fd: 1 }], badArgs: [{ fd: 1.5 }], ret: [{ fd: 5 }] },
    dup2: { args: [{ fd: 3, to: 1 }], badArgs: [{ fd: 3 }], ret: [{ fd: 1 }] },
    isatty: { args: [{ fd: 0 }], badArgs: [{}], ret: [{ tty: true, n: 1 }, { tty: false }] },
    'tty.open': { args: [{ wid: 7 }], badArgs: [{ wid: 0 }], ret: [{ fd: 0, n: 1 }] },
    'tty.input': { args: [{ data: 'ls\r' }], badArgs: [{ data: 'x'.repeat(4097) }], ret: [{}] },
    'tty.resize': {
      args: [{ cols: 80, rows: 24 }],
      badArgs: [
        { cols: 1, rows: 24 },
        { cols: 80, rows: 501 },
      ],
      ret: [{}],
    },
    'tty.getattr': { args: [{ fd: 0 }], badArgs: [{ fd: 'tty' }], ret: [TTYATTR] },
    'tty.setattr': {
      args: [{ fd: 0, canonical: false, echo: false }],
      badArgs: [{ fd: 0, cols: 80 }],
      ret: [TTYATTR],
    },
    tcsetpgrp: { args: [{ fd: 0, pgid: 12 }], badArgs: [{ fd: 0, pgid: 0 }], ret: [{}] },
    tcgetpgrp: { args: [{ fd: 0 }], badArgs: [{}], ret: [{ pgid: 12 }] },

    // §4.4.4
    'window.create': {
      args: [
        { title: 'Editor' },
        {
          title: 'x',
          icon: 'app-files',
          rect: RECT,
          minSize: { w: 200, h: 100 },
          restoreKey: 'editor:main',
        },
      ],
      badArgs: [
        { title: 'x'.repeat(257) },
        { title: 'x', icon: 'Bad Icon' },
        { title: 'x', rect: { x: 0, y: 0, w: -1, h: 1 } },
      ],
      ret: [{ wid: 7, rect: RECT, display: port }],
      badRet: [{ wid: 7, rect: RECT, display: {} }],
    },
    'window.close': { args: [{ wid: 7 }], badArgs: [{ wid: 0 }], ret: [{}] },
    'window.focus': { args: [{ wid: 7 }], badArgs: [{}], ret: [{ focused: false }] },
    'window.setTitle': {
      args: [{ wid: 7, title: 'notes.md — Editor' }],
      badArgs: [{ wid: 7 }],
      ret: [{}],
    },
    'window.setCloseGuard': {
      args: [
        { wid: 7, reason: 'notes.md has unsaved changes' },
        { wid: 7, reason: null },
      ],
      badArgs: [{ wid: 7 }, { wid: 7, reason: 'x'.repeat(257) }],
      ret: [{}],
    },
    'window.requestAttention': {
      args: [{ wid: 7, level: 'urgent' }],
      badArgs: [{ wid: 7, level: 'high' }],
      ret: [{}],
    },
    'notify.post': {
      args: [
        { title: 'Saved', body: 'notes.md', level: 'info' },
        { title: 't', body: '', level: 'error', wid: 7 },
      ],
      badArgs: [{ title: 't', body: 'x'.repeat(1025), level: 'info' }],
      ret: [{ nid: 1 }],
    },

    // §4.4.5
    'mem.alloc': {
      args: [{ bytes: 1024 }, { bytes: 1, key: 'state', kind: 'state' }],
      badArgs: [{ bytes: 0 }, { bytes: 1.5 }],
      ret: [{ segId: 1, bytes: 1024 }],
    },
    'mem.declare': {
      args: [{ key: 'canvas', kind: 'imagebitmap', bytes: 0 }],
      badArgs: [
        { key: '', kind: 'other', bytes: 1 },
        { key: 'k', kind: 'gpu', bytes: 1 },
      ],
      ret: [{ key: 'canvas', bytes: 4096 }],
    },
    'mem.free': {
      args: [{ segId: 1 }, { key: 'canvas' }],
      badArgs: [{ segId: 1, key: 'x' }, {}],
      ret: [{ bytes: 1024 }],
    },
    'mem.stat': { args: [{}, { pid: 5 }], badArgs: [{ pid: 0 }], ret: [MEMSTAT] },
    'mem.prefetch': {
      args: [{ app: 'editor' }, { ino: INO, offset: 0, len: 4096 }, { pid: 5, pages: [1, 2, 3] }],
      badArgs: [{ app: 'Editor' }, { app: 'editor', pid: 5 }],
      ret: [{ bytes: 65_536, pages: 16 }],
    },
    'mem.hint': {
      args: [{ app: 'files', ttlMs: 60_000 }],
      badArgs: [{ app: 'files', ttlMs: 999 }],
      ret: [{}],
    },
    mmap: {
      args: [{ path: '/a', flags: 'rw' }],
      badArgs: [{ path: '/a', flags: 'w' }],
      ret: [{ handle: 1, size: 100, pageSize: 65_536 }],
    },
    msync: {
      args: [{ handle: 1 }, { handle: 1, pages: [0] }],
      badArgs: [{ handle: 0 }],
      ret: [{ version: 2, ...MUT }],
    },
    munmap: { args: [{ handle: 1 }], badArgs: [{}], ret: [{}] },

    // §4.4.6
    'time.now': {
      args: [{}],
      badArgs: [{ tz: 'UTC' }],
      ret: [{ epochMs: NOW, monotonicMs: 12.5, tz: 'Asia/Karachi', tzOffsetMin: 300 }],
    },
    sleep: {
      args: [{ ms: 0 }, { ms: 2_147_483_647 }],
      badArgs: [{ ms: -1 }, { ms: 2_147_483_648 }],
      ret: [{ sleptMs: 10.2 }],
    },
    uptime: {
      args: [{}],
      badArgs: [{ x: 1 }],
      ret: [{ bootAt: NOW, uptimeMs: 1000, users: 1, load: [0.1, 0.2, 0.3] }],
      badRet: [{ bootAt: NOW, uptimeMs: 1000, users: 1, load: [0.1, 0.2] }],
    },

    // §4.4.7
    'lock.acquire': {
      args: [
        { path: '/a', mode: 'X' },
        { fd: 3, mode: 'S', wait: true, timeoutMs: 1000 },
      ],
      badArgs: [
        { path: '/a', mode: 'R' },
        { path: '/a', fd: 3, mode: 'X' },
        { path: '/a', mode: 'X', timeoutMs: 600_001 },
      ],
      ret: [{ leaseId: INO, fence: 7, expiresAt: NOW, scope: 'server' }],
    },
    'lock.release': { args: [{ leaseId: INO }], badArgs: [{ leaseId: 'lease-1' }], ret: [{}] },
    'lock.status': {
      args: [{ path: '/a' }],
      badArgs: [{}],
      ret: [{ holders: [LEASE], queued: 1 }],
    },

    // §4.4.8
    'net.status': { args: [{}], badArgs: [{ force: true }], ret: [NETSTATUS] },
    'sync.flush': {
      args: [{ timeoutMs: 5000 }],
      badArgs: [{ timeoutMs: 0 }, { timeoutMs: 60_001 }],
      ret: [{ remaining: 0 }],
      badRet: [{ remaining: 3 }],
    },

    // §4.4.9
    'sys.subscribe': {
      args: [
        { topics: ['vfs.*'] },
        { topics: ['vfs.write', 'proc.exit', 'notify'], path: '/home/alice' },
      ],
      badArgs: [{ topics: [] }, { topics: ['nope.*'] }, { topics: ['vfs.explode'] }],
      ret: [{ fd: 9 }],
    },
    'sys.events': {
      args: [{ fd: 9 }, { fd: 9, max: 256, timeoutMs: 1000 }],
      badArgs: [{ fd: 9, max: 257 }],
      ret: [{ events: [EVENT_NOTIFY], dropped: 0 }],
    },

    // §4.4.10 A
    'ai.semsearch': {
      args: [
        { q: 'quarterly budget' },
        { q: 'x', k: 50, scope: '/home/alice/docs', mode: 'keyword', chunks: true },
      ],
      badArgs: [{ q: '' }, { q: 'x', k: 51 }, { q: 'x', uid: 0 }],
      ret: [SEMSEARCH_RESULT],
    },
    'ai.search.focus': { args: [{ on: true }], badArgs: [{ on: 'yes' }], ret: [{}] },
    'ai.index.status': {
      args: [{}, { files: true }],
      badArgs: [{ files: 1 }],
      ret: [INDEX_STATUS],
    },
    'ai.index.lookup': {
      args: [{ hashes: [SHA] }, { hashes: [] }],
      badArgs: [{ hashes: ['xyz'] }],
      ret: [{ known: [true] }],
    },
    'ai.index.embed': {
      args: [{ text: 'hello', header: 'notes.md', kind: 'doc' }],
      badArgs: [{ text: 'x', header: 'h', kind: 'query' }],
      ret: [new Float32Array(384)],
      badRet: [new Float32Array(383), [0.1]],
    },
    'ai.index.put': {
      args: [indexPut()],
      badArgs: [{ ...indexPut(), chunks: [{ ...chunk(), vector: new Float32Array(10) }] }],
      ret: [{ rows: 2 }],
    },
    'ai.index.drop': { args: [{ inos: [INO] }], badArgs: [{ inos: [] }], ret: [{ rows: 3 }] },
    'ai.search.serve': {
      args: [{}],
      badArgs: [{ k: 1 }],
      ret: [{ jobId: 1, qvec: new Float32Array(384), readable: new ArrayBuffer(128), kPrime: 20 }],
    },
    'ai.search.done': {
      args: [{ jobId: 1, hits: [{ row: 0, fileIdx: 3, seq: 0, score: 0.87 }] }],
      badArgs: [{ jobId: 0, hits: [] }],
      ret: [{}],
    },

    // §4.4.10 B
    'ai.agent.plan': {
      args: [
        { requestId: INO, turn: 1, request: 'delete old drafts', envelope: ENVELOPE },
        {
          requestId: INO,
          turn: 2,
          observations: [{ callId: 'toolu_01', call: 'find', ok: true, value: { paths: [] } }],
        },
        { requestId: INO, turn: 3, clarification: 'only .md files' },
      ],
      badArgs: [
        { requestId: INO, turn: 7, clarification: 'x' },
        { requestId: INO, turn: 1, clarification: 'x' },
        { requestId: INO, turn: 1, request: 'x'.repeat(2001), envelope: ENVELOPE },
      ],
      ret: [
        {
          kind: 'tools',
          calls: [{ callId: 'toolu_01', call: 'find', args: { path: '.' } }],
          turnsLeft: 5,
        },
        { kind: 'plan', steps: [PLAN_STEP] },
        { kind: 'clarify', question: 'Which folder?', options: ['docs', 'drafts'] },
        { kind: 'cannot', reason: 'outside your home' },
      ],
    },
    'ai.agent.submit': {
      args: [{ requestId: INO, steps: [PLAN_STEP] }],
      badArgs: [
        { requestId: INO, steps: [] },
        { requestId: INO, steps: [{ ...PLAN_STEP, op: 'rmdir' }] },
      ],
      ret: [SUBMIT_RESULT],
    },
    'ai.agent.confirm': {
      args: [{ planId: INO }],
      badArgs: [{ planId: INO, answer: 'y' }],
      ret: [{ token: TOKEN, expiresAt: NOW, granted: true }],
    },
    'ai.agent.log': {
      args: [{}, { requestId: INO, limit: 200, cursor: 'c' }],
      badArgs: [{ limit: 201 }],
      ret: [{ records: [AUDIT], next: 'c2' }],
    },
    'ai.undo': { args: [{ txnId: INO }], badArgs: [{ txnId: 'abc' }], ret: [SUBMIT_RESULT] },

    // §4.4.10 C
    'ai.predict': {
      args: [{}, { k: 10 }],
      badArgs: [{ k: 0 }],
      ret: [
        {
          predictions: [{ app: 'terminal', confidence: 0.62, reason: 'Markov-2 after files' }],
          model: 'markov2',
          launches: 120,
          updatedAt: NOW,
        },
      ],
    },
    'ai.predict.publish': {
      args: [{ predictions: [], model: 'mfu', launches: 3 }],
      badArgs: [{ predictions: [], model: 'lstm', launches: 3 }],
      ret: [{}],
    },
    'ai.telemetry.read': {
      args: [{}, { since: 10, limit: 4096 }],
      badArgs: [{ limit: 4097 }],
      ret: [{ events: [TELEMETRY_EVENT], next: 11 }],
    },
    'ai.telemetry.clear': { args: [{}], badArgs: [{ uid: 1 }], ret: [{ cleared: 42 }] },
    'ai.telemetry.export': {
      args: [{}],
      badArgs: [{ format: 'csv' }],
      ret: [new ArrayBuffer(8)],
      badRet: ['{}'],
    },
    'ai.telemetry.optin': {
      args: [{ on: true }],
      badArgs: [{}],
      ret: [{ on: true, synced: false }],
    },

    // §4.4.11
    uname: {
      args: [{}],
      badArgs: [{ uid: 0 }],
      ret: [UNAME],
      badRet: [{ ...UNAME, sysname: 'Linux' }],
    },
    'users.list': {
      args: [{}],
      badArgs: [{ all: true }],
      ret: [
        {
          users: [{ uid: 1001, name: 'alice', gid: 100, home: '/home/alice', groups: [100, 200] }],
          groups: [{ gid: 100, name: 'users' }],
        },
      ],
    },
    bootlog: {
      args: [{}, { criticalPath: true, verbose: true, boot: 'previous' }],
      badArgs: [{ boot: 3 }],
      ret: [
        {
          entries: [{ t: 0.012, sub: 'svc', level: 'info', msg: 'kernel started' }],
          criticalPath: ['kernel', 'storage', 'vfs', 'login', 'session', 'desktop'],
          totalMs: 1234,
        },
      ],
    },
    dmesg: {
      args: [{}, { since: 10, level: 'warn', limit: 8192 }],
      badArgs: [{ limit: 8193 }],
      ret: [
        { entries: [{ seq: 1, t: NOW, sub: 'proc', level: 'info', msg: 'spawn 12', pid: 12 }] },
      ],
    },
    'svc.status': {
      args: [{}],
      badArgs: [{ name: 'sync' }],
      ret: [
        {
          services: [
            { name: 'sync', state: 'degraded', critical: false, restarts: 2, lastError: 'offline' },
            { name: 'kernel', state: 'running', critical: true, pid: 1, restarts: 0 },
          ],
        },
      ],
    },
    'svc.restart': { args: [{ name: 'sync' }], badArgs: [{ name: '' }], ret: [{}] },
    'sysctl.get': {
      args: [{}, { key: 'mm.budgetMB' }],
      badArgs: [{ key: 'MM.budget' }],
      ret: [{ values: { 'mm.budgetMB': 256, 'ui.theme': 'dark', 'boot.showMenuNextBoot': false } }],
    },
    'sysctl.set': {
      args: [
        { key: 'ui.theme', value: 'dark' },
        { key: 'mm.budgetMB', value: 256 },
      ],
      badArgs: [{ key: 'ui.theme' }, { key: 'ui.theme', value: { nested: true } }],
      ret: [
        { old: 'light', value: 'dark' },
        { old: null, value: true },
      ],
    },
    shutdown: {
      args: [{}, { delayMs: 0 }],
      badArgs: [{ delayMs: 3_600_001 }],
      ret: [{ scheduledAt: NOW }],
    },
    reboot: {
      args: [{}, { menu: true, safe: false, delayMs: 100 }],
      badArgs: [{ menu: 'yes' }],
      ret: [{ scheduledAt: NOW }],
    },
    su: {
      args: [
        { spawn: { path: '/bin/sh.json', argv: ['sh'] } },
        { user: 'bob', spawn: { path: '/bin/sh.json', argv: ['sh'], env: { TERM: 'xterm' } } },
      ],
      badArgs: [{ user: 'root' }, { spawn: { path: '/bin/sh.json', argv: ['sh'] }, password: 'x' }],
      ret: [{ pid: 44, uid: 0, grantExpiresAt: NOW + 900_000 }],
    },
    'auth.login': {
      args: [{ user: 'alice', secret: 'correct horse' }],
      badArgs: [
        { user: 'Alice!', secret: 'x' },
        { user: 'alice', secret: '' },
      ],
      ret: [{ uid: 1001, offline: false }],
    },
    'auth.logout': { args: [{}], badArgs: [{ uid: 1 }], ret: [{}] },
    'auth.lock': { args: [{}], badArgs: [{ now: true }], ret: [{}] },
    fsck: {
      args: [{}, { repair: true, checksum: true, scope: 'both' }],
      badArgs: [{ scope: 'all' }],
      ret: [FSCK],
    },
    'debug.inject': {
      args: [{ target: 'server', op: 'unlink', after: 500 }],
      badArgs: [
        { target: 'server', op: 'unlink', after: 0 },
        { target: 'db', op: 'any', after: 1 },
      ],
      ret: [{ armed: true, faultId: INO }],
    },
    'debug.delay': {
      args: [{ op: 'batch', ms: 5000 }],
      badArgs: [{ op: 'batch', ms: 10_001 }],
      ret: [{ armed: true }],
    },
  } satisfies Record<CallName, CallSamples>;
}
