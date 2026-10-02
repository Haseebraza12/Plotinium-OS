/**
 * The Demo Day parsers against the sample outputs printed in the specs that own each command
 * (boot §3.7 and §5.8, shell §3.14, rag §3.5, agentic-shell §3.3, predictive-prefetch §3.8).
 * If a spec changes a layout, these fixtures change with it in the same pull request.
 */
import { describe, expect, it } from 'vitest';

import {
  appIdOf,
  criticalPathProblems,
  hitsInHomeOf,
  pagedOutKiBs,
  parseAgentLogOutcomes,
  parseAgentRun,
  parseArmed,
  parseChecksum,
  parseComposeProjects,
  parseComposeVersion,
  parseCredentials,
  parseCriticalPath,
  parseFree,
  parseFsck,
  parseLaunchLatency,
  parseLeases,
  parsePredict,
  parseQuota,
  parseRolledBack,
  parseSemsearch,
  parseSizeMiB,
  parseTop,
  parseVerboseLog,
  parseVersionJson,
  parseVmstat,
  scoresNonIncreasing,
  shellQuote,
  splitRun,
  STATUS_COMMAND,
  timestampsNonDecreasing,
  versionAtLeast,
  type CriticalPath,
} from './parse.ts';

const screen = (...lines: string[]): string => lines.join('\n');

describe('terminal buffer', () => {
  it('SYS-02 splitRun returns the lines between the command echo and the status echo, and $?', () => {
    const buf = screen(
      'alice@plotinium:~$ cat ~/notes.txt',
      'first line',
      'second line',
      `alice@plotinium:~$ ${STATUS_COMMAND}`,
      'rc=0',
      'alice@plotinium:~$ ',
    );
    expect(splitRun(buf, 'cat ~/notes.txt')).toEqual({
      output: 'first line\nsecond line',
      status: 0,
    });
  });

  it('SYS-02 splitRun finds a command the terminal hard-wrapped and reads a non-zero status', () => {
    const buf = screen(
      'alice@plotinium:~$ rm -r ~/fixtures/tree10',
      '00',
      "rm: cannot remove '~/fixtures/tree1000': Input/output error (injected fault at node 500) — rolled back",
      `alice@plotinium:~$ ${STATUS_COMMAND}`,
      'rc=1',
    );
    const run = splitRun(buf, 'rm -r ~/fixtures/tree1000');
    expect(run.status).toBe(1);
    expect(run.output).toMatch(/^rm: cannot remove/);
  });

  it('SYS-02 splitRun returns empty output for a silent command and drops prompt lines', () => {
    const buf = screen(
      'bob@plotinium:~$ mkdir -p ~/x',
      `bob@plotinium:~$ ${STATUS_COMMAND}`,
      'rc=0',
    );
    expect(splitRun(buf, 'mkdir -p ~/x')).toEqual({ output: '', status: 0 });
  });

  it('SYS-02 shellQuote makes one literal shell word of any prompt, quotes and dollars included', () => {
    expect(shellQuote('tree1000')).toBe('tree1000');
    expect(shellQuote('how does LRU eviction work')).toBe("'how does LRU eviction work'");
    expect(shellQuote("alice's $HOME notes")).toBe("'alice'\\''s $HOME notes'");
    expect(shellQuote('~/notes')).toBe("'~/notes'");
    expect(shellQuote('')).toBe("''");
  });

  it('SYS-02 splitRun throws with the screen when an echo is missing', () => {
    expect(() => splitRun('alice@plotinium:~$ ls', 'cat x')).toThrow(
      /command echo not found: cat x/,
    );
    expect(() => splitRun('alice@plotinium:~$ ls\nfoo', 'ls')).toThrow(/status echo not found/);
  });
});

describe('boot', () => {
  const VERBOSE = screen(
    '[    0.000] firmware: Plotinium 0.3.0 · POST ok (workers, indexeddb, opfs, crypto, isolated) · quota 2.1 GB, persisted',
    '[    0.004] loader: profile=normal · service worker active (offline-capable) · kernel image 104 KB (cache)',
    '[    0.058] kernel: process table ready (hash table, cap 64) · pid 1 = init · klog 8192',
    '[    0.060] svc: 18 manifests (volume) · 30 edges · acyclic · 7 levels',
    '[    0.402] sync: WARN backend unreachable · offline mode · outbox holds 3 ops · retry in 2 s',
    '[    0.405] lockd: DEGRADED (requires sync) · local advisory locks only',
    '[    0.644] ai.indexer: 412 chunks pending · scheduled at priority 32 (background)',
    '[    0.731] desktop: interactive · 4 windows restored · boot 0.73 s · 2 services degraded',
  );

  it('BOOT-05 parseVerboseLog reads [ssss.mmm] subsystem: message lines with their text levels', () => {
    const lines = parseVerboseLog(VERBOSE);
    expect(lines.map((l) => l.subsystem)).toEqual([
      'firmware',
      'loader',
      'kernel',
      'svc',
      'sync',
      'lockd',
      'ai.indexer',
      'desktop',
    ]);
    expect(lines[4]?.level).toBe('WARN');
    expect(lines[5]?.level).toBe('DEGRADED');
    expect(lines[0]?.level).toBeNull();
    expect(lines[7]?.t).toBeCloseTo(0.731, 6);
    expect(timestampsNonDecreasing(lines)).toBe(true);
    expect(timestampsNonDecreasing([...lines].reverse())).toBe(false);
  });

  const CRITICAL = screen(
    'boot #37 · normal · warm · 0.731 s to desktop-interactive (user wait 0.000 s excluded)',
    'stage  post        0.000 → 0.012    12 ms',
    'stage  loader      0.012 → 0.058    46 ms   kernel image 104 KB (cache)',
    'svc    kernel      0.058 → 0.060     2 ms',
    'svc    storage     0.060 → 0.122    62 ms   gated by kernel',
    'svc    vfs         0.122 → 0.212    90 ms   gated by storage',
    'svc    login       0.212 → 0.341   129 ms   gated by vfs      (wm done 0.083, slack 129 ms)',
    'svc    session     0.341 → 0.402    61 ms   gated by login    (mm done 0.130, slack 211 ms)',
    'svc    desktop     0.402 → 0.731   329 ms   gated by session  (wm done 0.083, slack 319 ms)',
    'off the path: sync degraded (offline, 3 queued, attempt 2), lockd degraded (requires sync)',
  );

  it('BOOT-11 parseCriticalPath reads the boot spec sample and it passes every critical-path check', () => {
    const cp = parseCriticalPath(CRITICAL);
    expect(cp).toBeDefined();
    if (cp === undefined) return;
    expect(cp.seq).toBe(37);
    expect(cp.kind).toBe('warm');
    expect(cp.totalS).toBeCloseTo(0.731, 6);
    expect(cp.rows.filter((r) => r.kind === 'svc').map((r) => r.name)).toEqual([
      'kernel',
      'storage',
      'vfs',
      'login',
      'session',
      'desktop',
    ]);
    expect(cp.rows[5]?.gatedBy).toBe('vfs');
    expect(cp.offPath).toMatch(/^sync degraded/);
    expect(criticalPathProblems(cp)).toEqual([]);
  });

  it('BOOT-11 criticalPathProblems reports a broken chain, a wrong end and durations that do not add up', () => {
    const cp = parseCriticalPath(CRITICAL) as CriticalPath;
    const broken: CriticalPath = {
      ...cp,
      totalS: 0.9,
      rows: cp.rows
        .filter((r) => r.name !== 'desktop')
        .map((r) => (r.name === 'vfs' ? { ...r, gatedBy: 'wm' } : r)),
    };
    const problems = criticalPathProblems(broken);
    expect(problems.some((p) => p.includes('ends at session, not desktop'))).toBe(true);
    expect(problems.some((p) => p.includes('vfs is gated by wm, not by storage'))).toBe(true);
    expect(problems.some((p) => p.includes('the boot took 0.9 s'))).toBe(true);
    expect(problems.some((p) => p.includes('add up to'))).toBe(true);
    expect(parseCriticalPath('bootlog: no boot #99')).toBeUndefined();
  });
});

describe('processes and memory', () => {
  it('MEM-07 parseSizeMiB converts the units the memory commands print', () => {
    expect(parseSizeMiB('256.0M')).toBe(256);
    expect(parseSizeMiB('1.5G')).toBe(1536);
    expect(parseSizeMiB('512K')).toBe(0.5);
    expect(parseSizeMiB('812.0MiB')).toBe(812);
    expect(parseSizeMiB('1,204')).toBe(1204);
    expect(parseSizeMiB('lots')).toBeUndefined();
  });

  it('MEM-07 parseFree reads the shell spec sample in MiB with its paging line', () => {
    const free = parseFree(
      screen(
        '            budget  accounted      free  reclaimable  speculative   kernel',
        'Mem:        256.0M     198.4M     57.6M        31.2M         4.1M    14.2M',
        'Swap:    local 812.0M · remote 804.3M (write-behind) · device OPFS',
        'Paging:  faults 1,204 · hit ratio 97.4% · in 38.2M · out 412.6M',
      ),
    );
    expect(free).toEqual({
      budget: 256,
      accounted: 198.4,
      free: 57.6,
      reclaimable: 31.2,
      speculative: 4.1,
      kernel: 14.2,
      paging: { faults: 1204, hitPct: 97.4, inMiB: 38.2, outMiB: 412.6 },
    });
    expect(parseFree('free: invalid option')).toBeUndefined();
  });

  it('MEM-07 parseVmstat keys numeric rows by column name and pagedOutKiBs adds local and remote', () => {
    const rows = parseVmstat(
      screen(
        'procs     memory (MiB)            swap (KiB/s)              paging        cpu',
        ' r  b  w    acct    free  spec    si     so   rsi    rso  flt/s  hit%   us  id',
        ' 2 35  2   198.4    57.6   4.1     0   5120     0   4980     12  97.4   78  22',
        ' 3 35  4   255.1     0.9   0.0     0      0     0      0      0  99.0   80  20',
      ),
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]?.['acct']).toBe(198.4);
    expect(rows[0]?.['flt/s']).toBe(12);
    expect(pagedOutKiBs(rows[0] ?? {})).toBe(10100);
    expect(pagedOutKiBs(rows[1] ?? {})).toBe(0);
    expect(parseVmstat('no header here')).toEqual([]);
  });

  it('PROC-05 parseTop reads the frame p95 of the header and the burn process rows', () => {
    const top = parseTop(
      screen(
        'top - 10:12:05 up 12 min, 1 user, load average: 1.20, 0.80, 0.51 · frame p95 16.7 ms',
        'Tasks: 41 total, 3 running, 35 blocked, 1 stopped, 2 suspended',
        '  PID USER     PRI  NI S  %CPU    ACCT    SWAP   FLT     TIME+ COMMAND',
        '  301 alice     20   0 R  48.2    0.4M      0M     0   1:02.31 burn --ms 120000',
        '  311 alice     39   0 S   0.1    6.2M      0M     0   0:00.20 prefetch:editor',
      ),
    );
    expect(top.frameP95Ms).toBe(16.7);
    expect(top.processes).toEqual([
      { pid: 301, user: 'alice', pri: 20, state: 'R', command: 'burn --ms 120000' },
      { pid: 311, user: 'alice', pri: 39, state: 'S', command: 'prefetch:editor' },
    ]);
  });
});

describe('fault-injected rm -r', () => {
  it('DB-02 parseArmed reads the debug inject confirmation', () => {
    expect(parseArmed('debug: armed rm fault at node 500 (target server, one-shot)')).toEqual({
      op: 'rm',
      node: 500,
      target: 'server',
    });
    expect(parseArmed('debug: fault injection is disabled on this server')).toBeUndefined();
  });

  it('DB-02 parseRolledBack reads the exact rm error form and its node', () => {
    expect(
      parseRolledBack(
        "rm: cannot remove '~/fixtures/tree1000': Input/output error (injected fault at node 999) — rolled back",
      ),
    ).toEqual({ path: '~/fixtures/tree1000', node: 999 });
    expect(
      parseRolledBack("rm: cannot remove 'x': Permission denied (server) — restored"),
    ).toBeUndefined();
  });

  it('DB-02 parseChecksum, parseFsck and parseQuota read the shell spec layouts', () => {
    expect(parseChecksum('sha256:3f1a09c2…  /home/alice/fixtures/tree1000 (1,000 nodes)')).toEqual({
      sha256: '3f1a09c2',
      path: '/home/alice/fixtures/tree1000',
      nodes: 1000,
    });
    expect(
      parseFsck(
        screen(
          'fsck: checked 12,408 inodes and 3,201 directories in 0.41 s',
          'fsck: unreachable 0 · wrong link counts 0 · directory cycles 0 · dangling dentries 0',
          'fsck: quota totals consistent for 3 users',
          'fsck: clean',
        ),
      ),
    ).toEqual({
      inodes: 12408,
      unreachable: 0,
      wrongLinks: 0,
      cycles: 0,
      dangling: 0,
      clean: true,
    });
    const dirty = parseFsck(
      screen(
        'fsck: checked 10 inodes and 2 directories in 0.01 s',
        'fsck: unreachable 2 · wrong link counts 0 · directory cycles 0 · dangling dentries 1',
        'fsck: 2 problems found (run fsck -y as root to repair)',
      ),
    );
    expect(dirty?.clean).toBe(false);
    expect(dirty?.unreachable).toBe(2);
    expect(
      parseQuota(
        screen(
          'Disk quotas for user alice (uid 1001):',
          '  bytes used   18.2M   of 100M',
          '  inodes used    412   of 10000',
          '  source: server (confirmed 10:12:05)',
        ),
      ),
    ).toEqual({ bytesUsedMiB: 18.2, inodesUsed: 412, source: 'server (confirmed 10:12:05)' });
  });
});

describe('locks', () => {
  it('VFS-09 parseLeases reads the holder, mode, fence and countdown of each lease on the path', () => {
    const out = screen(
      'COMMAND   PID  USER   FD  TYPE  MODE  NAME                    LEASE',
      'editor    214  alice  3   REG   rw    /home/shared/plan.md    X · fence 17 · expires in 12 s',
      'sh        198  alice  0   TTY   rw    tty2                    -',
      '-         -    bob    -   REG   -     /home/shared/plan.md    S · waiting (queued)',
    );
    expect(parseLeases(out, '/home/shared/plan.md')).toEqual([
      {
        user: 'alice',
        mode: 'X',
        path: '/home/shared/plan.md',
        fence: 17,
        expiresInS: 12,
        waiting: false,
      },
      {
        user: 'bob',
        mode: 'S',
        path: '/home/shared/plan.md',
        fence: null,
        expiresInS: null,
        waiting: true,
      },
    ]);
  });
});

describe('hidden AI prompts', () => {
  const SEARCH = screen(
    '~/notes/os/memory.md:41-67   0.83  The LRU list keeps pages in recency order; eviction takes the least…',
    '~/src/wm/compositor.ts:210-244  0.79  // leak: listeners registered on every drag were never removed…',
    'semsearch: 1 shared result hidden while offline',
  );

  it('RAG-06 parseSemsearch reads path:line citations, scores and notices', () => {
    const r = parseSemsearch(SEARCH);
    expect(r.hits.map((h) => [h.path, h.lineStart, h.lineEnd, h.score])).toEqual([
      ['~/notes/os/memory.md', 41, 67, 0.83],
      ['~/src/wm/compositor.ts', 210, 244, 0.79],
    ]);
    expect(r.notices).toEqual(['1 shared result hidden while offline']);
    expect(scoresNonIncreasing(r.hits)).toBe(true);
    expect(scoresNonIncreasing([...r.hits].reverse())).toBe(false);
  });

  it("RAG-03 hitsInHomeOf finds results inside another user's home and only there", () => {
    const r = parseSemsearch(
      screen(
        '/home/alice/private/plan.md:1-9  0.91  secret plan',
        '/home/alicex/notes.md:1-2  0.50  similar prefix, other user',
        '/home/shared/plan.md:3-4  0.40  shared',
      ),
    );
    expect(hitsInHomeOf(r.hits, 'alice').map((h) => h.path)).toEqual([
      '/home/alice/private/plan.md',
    ]);
    expect(hitsInHomeOf(r.hits, 'bob')).toEqual([]);
  });

  it('AGT-03 parseAgentRun recognises the plan, blast radius, kernel prompt and commit of the agentic-shell example', () => {
    const run = parseAgentRun(
      screen(
        'ai: looking: find ~ -type f -name "*.pdf" (changed 2026-11-09 → 2026-11-16) … 12 files',
        'Plan · 4 steps · 1 transaction',
        '  1  mkdir   ~/reports                                     create 1 dir',
        'Blast radius: 13 inodes · 0 deletions · 0 overwrites · within quota',
        'Confirmation required: chmod',
        'Proceed? [y/N/e=edit] y',
        '✓ committed in 212 ms · txn 0192f0c1 · undo with: ai undo 0192f0c1',
      ),
    );
    expect(run).toEqual({
      planned: true,
      blastRadius: '13 inodes · 0 deletions · 0 overwrites · within quota',
      prompted: true,
      committed: { ms: 212, txn: '0192f0c1' },
      unavailable: false,
      nothingRun: false,
    });
    const declined = parseAgentRun(
      'Plan · 1 step · 1 transaction\nBlast radius: 2 inodes\nProceed? [y/N/e=edit] ',
    );
    expect(declined.committed).toBeNull();
    expect(declined.prompted).toBe(true);
  });

  it('AIS-02 parseAgentRun recognises the unavailable notice and that nothing was run', () => {
    const run = parseAgentRun('ai: agent unavailable (model service) — nothing was run');
    expect(run.unavailable).toBe(true);
    expect(run.nothingRun).toBe(true);
    expect(run.planned).toBe(false);
  });

  it('AGT-08 parseAgentLogOutcomes lists the outcome of each ai log row', () => {
    expect(
      parseAgentLogOutcomes(
        screen(
          '0192f0c1  2026-11-16 10:02  committed           4      13      move every PDF …',
          '0192f0a7  2026-11-16 09:58  declined            1      42      delete the old build logs',
        ),
      ),
    ).toEqual(['committed', 'declined']);
  });

  it('PRE-06 parsePredict reads the predictive-prefetch layout with its model and prefetch lines', () => {
    const r = parsePredict(
      screen(
        'MODEL  markov-2 (witten-bell) · 612 launches · θ = 0.40 · updated 10:12',
        '  1  Editor        0.58  after Terminal → Files (markov-2, 14 obs)          pre-fetched',
        '  2  Terminal      0.21  after Files (markov-1, 40 obs)',
        '  3  Task Manager  0.07  weekday 08:00–12:00 (time bucket, 22 obs)',
        'prefetch:editor (pid 311) exited 0 · 6.2 MB speculative · expires 10:17',
      ),
    );
    expect(r.model).toMatch(/^markov-2/);
    expect(r.predictions.map((p) => [p.rank, p.app, p.confidence, p.prefetched])).toEqual([
      [1, 'Editor', 0.58, true],
      [2, 'Terminal', 0.21, false],
      [3, 'Task Manager', 0.07, false],
    ]);
    expect(r.predictions[0]?.reason).toBe('after Terminal → Files (markov-2, 14 obs)');
    expect(r.prefetch).toEqual({ app: 'editor', pid: 311 });
  });

  it('PRE-06 parsePredict reads the shell spec layout too', () => {
    const r = parsePredict(
      screen(
        ' #  app        confidence  reason',
        ' 1  editor     0.62        after terminal → files on weekday mornings (Markov-2)',
        ' 2  files      0.21        after terminal (Markov-1 back-off)',
        ' 3  taskmgr    0.07        most used at this hour (time-bucket MFU)',
        'model markov2-wb · 214 launches · prefetch: editor (idle 2.4 s, θ 0.35, 18.2M free)',
      ),
    );
    expect(r.predictions.map((p) => p.app)).toEqual(['editor', 'files', 'taskmgr']);
    expect(r.model).toMatch(/^markov2-wb/);
  });

  it('PRE-06 appIdOf maps the names predict prints to dock app ids', () => {
    expect(appIdOf('Editor')).toBe('editor');
    expect(appIdOf('Task Manager')).toBe('task-manager');
    expect(appIdOf('taskmgr')).toBe('task-manager');
    expect(appIdOf('File Explorer')).toBe('files');
    expect(appIdOf('Calculator')).toBeUndefined();
  });

  it('PRE-03 parseLaunchLatency reads the medians with and without pre-fetch, on one line or two', () => {
    expect(
      parseLaunchLatency(
        'pre-fetch hits: median 212 ms (n 14)\nwithout pre-fetch: median 488 ms (n 31)',
      ),
    ).toEqual({ withPrefetchMs: 212, withoutPrefetchMs: 488 });
    expect(parseLaunchLatency('launch median · hits 120 ms · none 300 ms')).toEqual({
      withPrefetchMs: 120,
      withoutPrefetchMs: 300,
    });
    expect(parseLaunchLatency('no launches recorded yet')).toEqual({
      withPrefetchMs: null,
      withoutPrefetchMs: null,
    });
  });
});

describe('bring-up', () => {
  const RULE = '='.repeat(78);
  const BLOCK = [
    RULE,
    '  FIRST-START CREDENTIALS (shown once)',
    '  Generated for this stack only; stored as Argon2id hashes; printed nowhere else.',
    RULE,
    '  root        FAKEROOTFAKEROOTFAKE   (su only: root has no greeter login)',
    '  demo        FAKEDEMOFAKEDEMOFAKE',
    '  alice       FAKEALICEFAKEALICEFA',
    '  examiner1   FAKEEXAMFAKEEXAMFAKE',
    RULE,
    '',
  ];

  it('OPS-05 parseCredentials reads the FIRST-START block with the Compose log prefix', () => {
    const logs = [
      'app-1  | migrations: 6 applied',
      ...BLOCK.map((l) => `app-1  | ${l}`),
      'app-1  | listening',
    ].join('\n');
    const creds = parseCredentials(logs);
    expect([...creds.keys()]).toEqual(['root', 'demo', 'alice', 'examiner1']);
    expect(creds.get('root')).toBe('FAKEROOTFAKEROOTFAKE');
    expect(creds.get('demo')).toBe('FAKEDEMOFAKEDEMOFAKE');
  });

  it('OPS-05 parseCredentials reads the block without a prefix and finds nothing in logs without it', () => {
    expect(parseCredentials(BLOCK.join('\n')).get('alice')).toBe('FAKEALICEFAKEALICEFA');
    expect(parseCredentials('app-1  | seed: demo exists, nothing to do').size).toBe(0);
  });

  it('OPS-05 parseComposeVersion and versionAtLeast enforce the Compose 2.24 prerequisite', () => {
    const v = parseComposeVersion('Docker Compose version v2.29.7');
    expect(v).toEqual([2, 29, 7]);
    expect(parseComposeVersion('Docker Compose version 2.23.3-desktop.2')).toEqual([2, 23, 3]);
    expect(versionAtLeast([2, 29, 7], [2, 24, 0])).toBe(true);
    expect(versionAtLeast([2, 24, 0], [2, 24, 0])).toBe(true);
    expect(versionAtLeast([2, 23, 9], [2, 24, 0])).toBe(false);
    expect(versionAtLeast([3, 0, 0], [2, 24, 0])).toBe(true);
    expect(parseComposeVersion('docker: command not found')).toBeUndefined();
  });

  it('OPS-05 parseComposeProjects reads the project names of docker compose ls JSON', () => {
    expect(
      parseComposeProjects(
        '[{"Name":"plotinium","Status":"running(3)","ConfigFiles":"/x/compose.yaml"}]',
      ),
    ).toEqual(['plotinium']);
    expect(parseComposeProjects('')).toEqual([]);
    expect(parseComposeProjects('[]')).toEqual([]);
  });

  it('PLT-ID-14 parseVersionJson accepts the identity section 4.2 shape and rejects others', () => {
    expect(
      parseVersionJson({
        name: 'Plotinium',
        version: '1.0.0',
        build: 'a1f93c2',
        buildDate: '2026-12-01',
        abi: 1,
      }),
    ).toEqual({ name: 'Plotinium', version: '1.0.0', build: 'a1f93c2' });
    expect(parseVersionJson({ name: 'Plotinium', version: 1 })).toBeUndefined();
    expect(parseVersionJson(null)).toBeUndefined();
  });
});
