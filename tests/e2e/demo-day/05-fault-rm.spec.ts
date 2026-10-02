/**
 * Demo Day 0:08–0:18, item 6: a fault-injected recursive delete that rolls back (spec §17.1;
 * testing §3.16.5 item 6; Appendix A DB-02; shell §3.14.50).
 *
 * Local stack only (C7: `FAULT_INJECTION=1` exists only there, never on production). alice
 * records `quota` and `fsck --checksum ~/fixtures/tree1000`; root (password from
 * `docker compose logs app`, typed into the compositor's secure prompt) arms a one-shot server
 * fault with `debug inject rm N --target server`; alice's `rm -r` then prints
 * `Input/output error (injected fault at node N) — rolled back` before the prompt returns, and
 * the checksum, `fsck` and `quota` are unchanged, as is the client oracle; `fsck --server` as
 * root is clean. The examiner may choose N (PLT_DEMO_FAULT_NODE, default 500).
 */
import { expect, test } from '@playwright/test';

import type { SeedUser } from '../../fixtures/users.ts';
import { baseUrl } from '../../support/env.ts';
import { clientSnapshot } from '../../support/hooks.ts';
import { sameState, type OracleSnapshot } from '../../support/oracle.ts';

import { demoUser } from './compose.ts';
import {
  demoDay,
  faultNode,
  FIXME_UI,
  isLocalStack,
  SKIP_DEMO_DAY,
  SKIP_NOT_LOCAL,
  uiReady,
} from './env.ts';
import {
  parseArmed,
  parseChecksum,
  parseFsck,
  parseQuota,
  parseRolledBack,
  type QuotaReport,
} from './parse.ts';
import { bootAs, measure, recordRehearsal, Shell, type DemoOS } from './session.ts';

const TREE = '~/fixtures/tree1000';

test.describe.serial('Demo Day 0:08–0:18 item 6: fault-injected rm -r rolls back', () => {
  test.skip(!demoDay(), SKIP_DEMO_DAY);
  test.skip(!isLocalStack(baseUrl()), SKIP_NOT_LOCAL);
  test.fixme(!uiReady(), FIXME_UI);
  test.describe.configure({ timeout: 4 * 60_000 });

  const node = faultNode();
  let alice: DemoOS;
  let root: SeedUser;
  let shell: Shell;
  let checksum = '';
  let quota: QuotaReport | undefined;
  let oracle: OracleSnapshot;
  let treePath = '';
  let chrome: string | null = null;
  recordRehearsal('sut', '6 fault-injected rm -r', () => chrome);

  test.beforeAll(async () => {
    alice = await bootAs('alice');
    chrome = alice.chrome;
    root = await demoUser('root');
    shell = await Shell.open(alice.page);
  });

  test.afterAll(async () => {
    // The fault is one-shot, but a failed run may leave it armed: clear it for the next item.
    if (shell !== undefined && root?.password !== undefined)
      await shell.asRoot('debug clear', root.password).catch(() => undefined);
    await alice?.close();
  });

  test('DB-02 before the fault, tree1000 has a checksum and alice has a quota reading', async () => {
    const exists = await shell.run(`ls -d ${TREE}`);
    expect(
      exists.status,
      `${TREE} is missing: the demo seed must provide fixtures/tree1000 (server/src/seed/demo.ts)`,
    ).toBe(0);
    const sum = parseChecksum(await shell.ok(`fsck --checksum ${TREE}`));
    expect(sum, 'fsck --checksum printed no sha256').toBeDefined();
    checksum = sum?.sha256 ?? '';
    // The oracle hook takes an absolute path; fsck may print the tree relative to ~.
    treePath = (sum?.path ?? '').replace(/^~(?=\/|$)/, `/home/${alice.user.username}`);
    measure('checksum', checksum.slice(0, 12));
    measure('nodes', sum?.nodes ?? 'n/a');
    quota = parseQuota(await shell.ok('quota'));
    expect(quota, 'quota printed no usage').toBeDefined();
    measure(
      'quota before',
      `${quota?.bytesUsedMiB ?? '?'} MiB, ${quota?.inodesUsed ?? '?'} inodes`,
    );
    oracle = await clientSnapshot(alice.page, treePath);
    expect(oracle.fsckClean).toBe(true);
  });

  test(`DB-02 as root through su, debug inject arms a one-shot server fault for rm at node ${node}`, async () => {
    const run = await shell.asRoot(`debug inject rm ${node} --target server`, root.password);
    expect(run.status, run.output).toBe(0);
    const armed = parseArmed(run.output);
    expect(armed, `not armed:\n${run.output}`).toBeDefined();
    expect(armed?.op).toBe('rm');
    expect(armed?.node).toBe(node);
    expect(armed?.target).toBe('server');
  });

  test(`DB-02 rm -r of tree1000 prints Input/output error at node ${node} and rolled back before the prompt returns`, async () => {
    const run = await shell.run(`rm -r ${TREE}`, { timeoutMs: 60_000 });
    measure('rm status', run.status);
    measure('rm output', run.output.split('\n')[0] ?? '');
    const rolled = parseRolledBack(run.output);
    expect(rolled, `no rolled-back line:\n${run.output}`).toBeDefined();
    expect(rolled?.node).toBe(node);
    expect(run.status).toBe(1);
  });

  test('DB-02 after the rollback the checksum, fsck, quota and the client oracle are unchanged', async () => {
    expect(parseChecksum(await shell.ok(`fsck --checksum ${TREE}`))?.sha256).toBe(checksum);
    const fsck = parseFsck(await shell.ok(`fsck ${TREE}`));
    expect(fsck, 'fsck printed no report').toBeDefined();
    expect(fsck?.unreachable).toBe(0);
    expect(fsck?.dangling).toBe(0);
    expect(fsck?.wrongLinks).toBe(0);
    expect(fsck?.clean).toBe(true);
    const after = parseQuota(await shell.ok('quota'));
    expect(after?.bytesUsedMiB).toBe(quota?.bytesUsedMiB);
    expect(after?.inodesUsed).toBe(quota?.inodesUsed);
    const same = sameState(oracle, await clientSnapshot(alice.page, treePath));
    expect(same.diffs).toEqual([]);
  });

  test('DB-02 fsck --server as root reports the server tree clean after the rollback', async () => {
    const run = await shell.asRoot(`fsck --server ${treePath}`, root.password, {
      timeoutMs: 60_000,
    });
    measure('fsck --server', run.output.split('\n').slice(-1)[0] ?? '');
    expect(run.status, run.output).toBe(0);
    expect(run.output).toMatch(/clean/);
  });
});
