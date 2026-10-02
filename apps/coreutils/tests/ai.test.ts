import { describe, expect, it } from 'vitest';

import ai, {
  AGENT_MANIFEST,
  AGENT_MANIFESTS,
  logTable,
  parseAi,
  recordLines,
  unavailableReason,
} from '../cmd/ai.ts';
import predict, { modelLine } from '../cmd/predict.ts';
import semsearch, { tildePath } from '../cmd/semsearch.ts';
import { aiError } from '../lib/ai.ts';
import { SysError } from '../lib/sys.ts';
import type { FakeKernel } from './harness.ts';
import { kernel } from './harness.ts';

const NOW = Date.UTC(2026, 10, 16, 5, 13, 0);
const CRED = {
  uid: 1001,
  gid: 1001,
  groups: [1001],
  user: 'alice',
  groupNames: ['alice'],
  home: '/home/alice',
  ruid: 1001,
};
const HASH = 'c'.repeat(64);

const RECORD = {
  auditId: '0192f0c1-7c2e-7a51-9d6f-000000000009',
  t: NOW,
  level: 'agent' as const,
  osSessionId: '0192f0c1-7c2e-7a51-9d6f-000000000001',
  pid: 300,
  uid: 1001,
  actor: 'agent' as const,
  call: 'batch' as const,
  argsDigest: HASH,
  argsSummary: 'batch 4 ops',
  outcome: 'ok' as const,
  durationUs: 212_000,
  promptId: '0192f0c1-7c2e-7a51-9d6f-000000000002',
  request:
    'move every PDF I changed last week into a new folder called reports, and make it read-only for others',
  txnId: '0192f0c1-7c2e-7a51-9d6f-000000000003',
  inodes: 13,
  confirmation: 'confirmed' as const,
};

function agentWorld(): FakeKernel {
  const k = kernel().on('proc.cred', () => CRED);
  k.fs.addFile(AGENT_MANIFEST, '{}');
  return k
    .on('spawn', () => ({ pid: 600 }))
    .on('wait', () => ({ pid: 600, status: { kind: 'exited' as const, code: 0 } }));
}

describe('ai', () => {
  it('AGT-01 ai starts the agent process with the instruction as one argument and passes its status', () => {
    const k = agentWorld();
    k.on('wait', () => ({ pid: 600, status: { kind: 'exited' as const, code: 1 } }));
    expect(k.run(ai, ['ai', 'create a folder called demo-out']).status).toBe(1);
    expect(k.argsOf('spawn')[0]).toMatchObject({
      path: AGENT_MANIFEST,
      argv: ['ai', 'create a folder called demo-out'],
    });
    k.run(ai, ['ai', '-n', '--json', 'x']);
    expect(k.argsOf('spawn')[0]).toMatchObject({ argv: ['ai', '--dry-run', '--json', 'x'] });
    k.run(ai, ['ai', 'undo', '0192f0c1']);
    expect(k.argsOf('spawn')[0]).toMatchObject({ argv: ['ai', 'undo', '0192f0c1'] });
  });

  it('AGT-04 ai refuses a root login and says when it drops from su to the login user', () => {
    const k = agentWorld();
    k.on('proc.cred', () => ({ ...CRED, uid: 0, ruid: 0, user: 'root' }));
    expect(k.run(ai, ['ai', 'x'])).toMatchObject({
      status: 2,
      err: 'ai: the agent never runs as root (§3.4); log in as a regular user and use su for elevation\n',
    });
    k.on('proc.cred', () => ({ ...CRED, uid: 0, user: 'root' }));
    expect(k.run(ai, ['ai', 'x'])).toMatchObject({
      status: 0,
      err: 'ai: running as alice (login user), not root\n',
    });
  });

  it('SHL-18 ai without the agent installed reports it unavailable with status 4', () => {
    const k = kernel().on('proc.cred', () => CRED);
    expect(k.run(ai, ['ai', 'x'])).toMatchObject({
      status: 4,
      err: 'ai: agent unavailable (the agent program is not installed in this terminal) — nothing was run\n',
    });
  });

  it('UI-055 ai says why the agent is unavailable: the ai.agent service state from svc.status', () => {
    const status = (state: string, lastError?: string) => () => ({
      services: [
        {
          name: 'ai.agent',
          state,
          critical: false,
          restarts: 0,
          ...(lastError === undefined ? {} : { lastError }),
        },
      ],
    });
    const k = kernel()
      .on('proc.cred', () => CRED)
      .on('svc.status', status('degraded', 'requires sync'));
    expect(k.run(ai, ['ai', 'list my files'])).toMatchObject({
      status: 4,
      err: 'ai: agent unavailable (ai.agent is degraded: requires sync) — nothing was run\n',
    });
    k.on('svc.status', status('failed'));
    expect(k.run(ai, ['ai', 'x']).err).toBe(
      'ai: agent unavailable (ai.agent is failed) — nothing was run\n',
    );
    // A running service but no agent program in this terminal.
    k.on('svc.status', status('running'));
    expect(k.run(ai, ['ai', 'x']).err).toBe(
      'ai: agent unavailable (the agent program is not installed in this terminal) — nothing was run\n',
    );
    expect(unavailableReason(null)).toBe('the agent program is not installed in this terminal');
  });

  it('UI-055 ai finds the agent under any of its manifest names; a manifest no program backs is "unavailable", not a crash', () => {
    expect(AGENT_MANIFESTS).toEqual([
      '/bin/lib/ai.agent.json',
      '/bin/lib/ai-agent.json',
      '/bin/ai-agent.json',
    ]);
    const k = kernel().on('proc.cred', () => CRED);
    k.fs.addDir('/bin');
    k.fs.addFile('/bin/ai-agent.json', '{}');
    k.fail('spawn', 'ENOENT', { msg: '/bin/ai-agent.json: no such program' });
    expect(k.run(ai, ['ai', 'x'])).toMatchObject({
      status: 4,
      err: 'ai: agent unavailable (the agent program is not installed in this terminal) — nothing was run\n',
    });
    expect(k.argsOf('spawn')).toMatchObject([{ path: '/bin/ai-agent.json' }]);
  });

  it('UI-055 ai status without the ai.status call reports the agent service instead of "not installed"', () => {
    const k = kernel().on('svc.status', () => ({
      services: [
        {
          name: 'ai.agent',
          state: 'degraded' as const,
          critical: false,
          restarts: 0,
          lastError: 'requires sync',
        },
      ],
    }));
    expect(k.run(ai, ['ai', 'status'])).toMatchObject({
      status: 4,
      out: 'agent: ai.agent degraded (requires sync) · not installed in this terminal\ngateway: not reported (ai.status is not available yet)\n',
    });
  });

  it('AGT-08 ai log lists the audit records and shows one in full', () => {
    const k = kernel().on('ai.agent.log', () => ({
      records: [
        RECORD,
        {
          ...RECORD,
          txnId: undefined,
          request: undefined,
          errno: 'EPERM' as const,
          outcome: 'rejected' as const,
          inodes: undefined,
        },
      ],
    }));
    const lines = k.run(ai, ['ai', 'log', '-n', '3']).out.split('\n');
    expect(lines[0]).toMatch(/^TXN +WHEN +OUTCOME +STEPS +INODES +PROMPT$/);
    expect(lines[1]).toMatch(
      /^0192f0c1 +2026-11-16 10:13 +ok +- +13 +move every PDF I changed last week into a new…$/,
    );
    expect(lines[2]).toMatch(/rejected +- +- +EPERM batch 4 ops$/);
    expect(k.argsOf('ai.agent.log')).toEqual([{ limit: 3 }]);
    const full = k.run(ai, ['ai', 'log', '0192f0c17c2e']).out;
    expect(full).toContain('confirmation: confirmed\n');
    expect(k.run(ai, ['ai', 'log', 'ffff'])).toMatchObject({
      status: 1,
      err: 'ai: log: no record ffff\n',
    });
    expect(k.run(ai, ['ai', 'log', '--json']).out.split('\n')).toHaveLength(3);
    expect(logTable([], 0)).toHaveLength(1);
    expect(recordLines(RECORD, 300)[0]).toBe(`txn:          ${RECORD.txnId}`);
  });

  it('AGT-08 ai status shows the gateway, model and budget', () => {
    const k = kernel().on('ai.status', () => ({
      gateway: 'healthy',
      budgetLeft: 1.25,
      model: 'claude',
    }));
    expect(k.run(ai, ['ai', 'status']).out).toBe(
      'gateway: healthy\nmodel: claude\nbudget left: 1.25\n',
    );
    k.on('ai.status', () => ({ gateway: 'down', budgetLeft: null, model: null }));
    expect(k.run(ai, ['ai', 'status']).out).toBe('gateway: down\nmodel: -\nbudget left: -\n');
  });

  it('AGT-03 ai unavailability messages follow the agentic spec and exit 4', () => {
    const k = kernel();
    const cases: [SysError['errno'], Record<string, unknown> | undefined, string][] = [
      [
        'EAIUNAVAIL',
        { reason: 'offline' },
        'agent unavailable (offline) — nothing was run; find, mv and chmod still work',
      ],
      [
        'EAIUNAVAIL',
        { reason: 'rate', retryAfterMs: 39_500 },
        'agent busy (rate limit) — nothing was run; retry in 40 s',
      ],
      ['EAIUNAVAIL', { reason: 'rate' }, 'agent busy (rate limit) — nothing was run'],
      ['EAIUNAVAIL', { reason: 'budget' }, "today's AI budget is used up — nothing was run"],
      ['EAIUNAVAIL', { reason: 'expired' }, 'conversation expired — nothing was run; please retry'],
      ['EAIUNAVAIL', { reason: 'safe-mode' }, 'AI services are disabled in safe mode'],
      ['EAIUNAVAIL', { reason: 'upstream' }, 'agent unavailable (model service) — nothing was run'],
      ['EAIREFUSED', undefined, 'the model declined this request — nothing was run'],
      ['ENOSYS', undefined, 'agent unavailable (not installed) — nothing was run'],
    ];
    for (const [errno, detail, text] of cases) {
      k.fail('ai.agent.log', errno, detail === undefined ? {} : { detail });
      expect(k.run(ai, ['ai', 'log'])).toMatchObject({ status: 4, err: `ai: ${text}\n` });
    }
    k.fail('ai.agent.log', 'EIO');
    expect(k.run(ai, ['ai', 'log'])).toMatchObject({ status: 2, err: 'ai: Input/output error\n' });
    expect(aiError(new SysError('EACCES'))).toBe('Permission denied');
  });

  it('SHL-15 ai takes the instruction as one argument and rejects bad usage with 2', () => {
    expect(parseAi(['--', '-weird'])).toEqual({
      sub: 'run',
      instruction: '-weird',
      dryRun: false,
      json: false,
    });
    for (const bad of [
      [],
      ['a', 'b'],
      ['-x', 'a'],
      ['--yes', 'a'],
      ['undo'],
      ['status', 'x'],
      ['log', '-n', '0'],
      ['log', 'a', 'b'],
      ['log', '--dry-run'],
    ]) {
      expect(() => parseAi(bad)).toThrow();
    }
    expect(kernel().run(ai, ['ai']).status).toBe(2);
  });
});

describe('semsearch', () => {
  const RESULT = {
    mode: 'semantic' as const,
    model: { key: 'mdbr-leaf-ir-q8@4262131b-384', state: 'ready' as const },
    results: [
      {
        path: '/home/alice/notes/os/memory.md',
        ino: '0192f0c1-7c2e-7a51-9d6f-000000000004',
        lineStart: 41,
        lineEnd: 67,
        score: 0.834,
        snippet: 'The LRU list keeps pages in recency order',
        verified: 'own' as const,
      },
      {
        path: '/srv/shared.md',
        ino: '0192f0c1-7c2e-7a51-9d6f-000000000005',
        lineStart: 1,
        lineEnd: 9,
        score: 0.79,
        snippet: 'leak',
        verified: 'server' as const,
      },
    ],
    notices: ['1 shared result hidden while offline'],
    timings: { embedMs: 7, filterMs: 1, scanMs: 2, verifyMs: 0, totalMs: 10 },
  };

  it('RAG-06 semsearch prints path:line citations with scores and notices on stderr', () => {
    const k = kernel().on('ai.semsearch', () => RESULT);
    const r = k.run(semsearch, ['semsearch', '-k', '2', 'lru eviction']);
    expect(r).toMatchObject({
      status: 0,
      out: '~/notes/os/memory.md:41-67  0.83  The LRU list keeps pages in recency order\n/srv/shared.md:1-9  0.79  leak\n',
      err: 'semsearch: 1 shared result hidden while offline\n',
    });
    expect(k.argsOf('ai.semsearch')).toEqual([{ q: 'lru eviction', k: 2 }]);
  });

  it('RAG-06 semsearch -l prints paths for pipes, --json one object per line, and the mode flags', () => {
    const k = kernel().on('ai.semsearch', () => RESULT);
    expect(k.run(semsearch, ['semsearch', '-l', 'x']).out).toBe(
      '/home/alice/notes/os/memory.md\n/srv/shared.md\n',
    );
    expect(k.run(semsearch, ['semsearch', '--json', 'x']).out.split('\n')).toHaveLength(3);
    k.run(semsearch, ['semsearch', '--keyword', '--chunks', '--dir', '~/notes', 'q']);
    expect(k.argsOf('ai.semsearch')).toEqual([
      { q: 'q', k: 5, scope: '~/notes', mode: 'keyword', chunks: true },
    ]);
    expect(tildePath('/home/alice', '/home/alice')).toBe('~');
    expect(tildePath('/x', undefined)).toBe('/x');
  });

  it('UI-124 semsearch says when nothing matched, with the search mode and model state; --json stays valid', () => {
    const k = kernel().on('ai.semsearch', () => ({
      ...RESULT,
      mode: 'keyword' as const,
      model: { ...RESULT.model, state: 'loading' as const },
      results: [],
      notices: [],
    }));
    expect(k.run(semsearch, ['semsearch', 'hello'])).toMatchObject({
      status: 1,
      out: '',
      err: "semsearch: no results for 'hello' (keyword search, model still loading)\n",
    });
    // JSON lines on stdout: none for no result; the notice goes to stderr only.
    expect(k.run(semsearch, ['semsearch', '--json', '--dir', '/tmp', 'hello'])).toMatchObject({
      status: 1,
      out: '',
      err: "semsearch: no results for 'hello' in /tmp (keyword search, model still loading)\n",
    });
  });

  it('RAG-06 semsearch exits 1 with no results and 2 on an error or bad usage', () => {
    const k = kernel().on('ai.semsearch', () => ({
      ...RESULT,
      results: [],
      notices: ['Semantic search unavailable — showing keyword matches'],
    }));
    expect(k.run(semsearch, ['semsearch', 'x'])).toMatchObject({
      status: 1,
      out: '',
      err:
        'semsearch: Semantic search unavailable — showing keyword matches\n' +
        "semsearch: no results for 'x' (semantic search, model ready)\n",
    });
    k.fail('ai.semsearch', 'EAIUNAVAIL', { detail: { reason: 'safe-mode' } });
    expect(k.run(semsearch, ['semsearch', 'x'])).toMatchObject({
      status: 2,
      err: 'semsearch: AI services are disabled in safe mode\n',
    });
    expect(k.run(semsearch, ['semsearch']).status).toBe(2);
    expect(k.run(semsearch, ['semsearch', '-k', '51', 'x']).status).toBe(2);
  });
});

describe('predict', () => {
  const PRED = {
    predictions: [
      {
        app: 'editor',
        confidence: 0.62,
        reason: 'after terminal → files on weekday mornings (Markov-2)',
      },
      { app: 'files', confidence: 0.21, reason: 'after terminal (Markov-1 back-off)' },
      { app: 'taskmgr', confidence: 0.07, reason: 'most used at this hour (time-bucket MFU)' },
    ],
    model: 'markov2' as const,
    launches: 214,
    updatedAt: NOW,
  };

  it('PRE-06 predict prints the top 3 apps with confidence and a reason', () => {
    const k = kernel().on('ai.predict', () => PRED);
    const r = k.run(predict, ['predict']);
    expect(r.status).toBe(0);
    expect(r.out).toBe(
      'MODEL  markov-2 (witten-bell) · 214 launches · updated 10:13\n  1  editor   0.62  after terminal → files on weekday mornings (Markov-2)\n  2  files    0.21  after terminal (Markov-1 back-off)\n  3  taskmgr  0.07  most used at this hour (time-bucket MFU)\n',
    );
    expect(k.argsOf('ai.predict')).toEqual([{ k: 3 }]);
    k.run(predict, ['predict', '-n', '5']);
    expect(k.argsOf('ai.predict')).toEqual([{ k: 5 }]);
  });

  it('PRE-06 predict below 50 launches shows the MFU fallback with status 1', () => {
    const k = kernel().on('ai.predict', () => ({ ...PRED, model: 'mfu' as const, launches: 37 }));
    const r = k.run(predict, ['predict']);
    expect(r.status).toBe(1);
    expect(r.out.split('\n')[0]).toBe('MODEL  MFU fallback (37 of 50 launches)');
    expect(modelLine('mfu-bucket', 60, NOW, 0)).toBe(
      'MODEL  time-bucket MFU · 60 launches · updated 05:13',
    );
  });

  it('PRE-06 predict reports a stopped predictor and the options it cannot answer yet', () => {
    const k = kernel().fail('ai.predict', 'EAIUNAVAIL');
    expect(k.run(predict, ['predict'])).toMatchObject({
      status: 2,
      err: 'predict: predictor not running\n',
    });
    k.fail('ai.predict', 'EIO');
    expect(k.run(predict, ['predict']).err).toBe('predict: Input/output error\n');
    expect(k.run(predict, ['predict', '--latency', 'editor'])).toMatchObject({
      status: 2,
      err: 'predict: --latency: Function not implemented\n',
    });
    expect(k.run(predict, ['predict', '--eval']).err).toBe(
      'predict: --eval: Function not implemented\n',
    );
    expect(k.run(predict, ['predict', '--explain']).err).toBe(
      'predict: --why: Function not implemented\n',
    );
    expect(k.run(predict, ['predict', '-n', '11']).status).toBe(2);
    expect(k.run(predict, ['predict', 'x']).status).toBe(2);
    k.on('ai.predict', () => PRED);
    expect(JSON.parse(k.run(predict, ['predict', '--json']).out)).toMatchObject({ launches: 214 });
  });
});
