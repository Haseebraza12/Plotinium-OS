/**
 * The kernel-owned confirmation of a destructive agent plan in the Terminal (shell-and-terminal.md
 * §3.11; agentic-shell.md §3.4; AGT-03, SHL-14, DSN-16): `ai "…"` starts the agent, the agent's
 * `ai.agent.confirm` takes the TTY over, the block is written by the owner of the TTY, and the one
 * answer is read from the TTY's keyboard only, never from the agent's stdin.
 */
import type { PlanStep, SubmitResult } from '@plotinium/protocol';
import type { Program, SysGen } from '@plotinium/kernel/sys';
import { errnoOf } from '@plotinium/kernel/sys';
import { describe, expect, it } from 'vitest';

import { confirmationModel } from '../plan.ts';
import type { Harness } from './harness.ts';
import { startSession } from './harness.ts';

const PLAN_ID = '0192f0c1-7c2e-7a51-9d6f-00000000a001';
const HASH = 'a'.repeat(64);

const STEPS: PlanStep[] = [
  {
    id: 's1',
    op: 'glob',
    args: { pattern: '~/logs/*.log' },
    span: 'old logs',
    sources: ['/home/demo/logs/a.log', '/home/demo/logs/b.log'],
  },
  { id: 's2', op: 'unlink', args: {}, span: 'delete', sources: { ref: 's1' } },
];

const RESULT: SubmitResult = {
  planId: PLAN_ID,
  planHash: HASH,
  dryRunHash: HASH,
  dryRun: {
    ops: [
      { op: 'unlink', path: '/home/demo/logs/a.log' },
      { op: 'unlink', path: '/home/demo/logs/b.log' },
    ],
    inodes: 2,
    bytes: 0,
    deletions: 2,
    overwrites: 0,
    quotaOk: true,
  },
  confirm: { required: true, reasons: ['delete'] },
  expectedVersions: [],
};

interface AgentState {
  done: boolean;
}

/** A stand-in for ai/'s agent: submit the plan, ask the kernel to confirm, report. */
const agent: Program<AgentState> = {
  init: () => ({ done: false }),
  *run(ctx): SysGen<number> {
    const say = (text: string): SysGen<unknown> =>
      ctx.sys.call('write', { fd: 1, data: new TextEncoder().encode(text).buffer });
    const r = yield* ctx.sys.call('ai.agent.submit', {
      requestId: '0192f0c1-7c2e-7a51-9d6f-00000000b001',
      steps: STEPS,
    });
    try {
      yield* ctx.sys.call('ai.agent.confirm', { planId: r.planId });
    } catch (e) {
      yield* say(`agent: ${errnoOf(e) ?? 'error'}\n`);
      return 1;
    }
    yield* say('✓ committed\n');
    return 0;
  },
};

interface Setup {
  h: Harness;
  confirms: () => number;
  strip: boolean[];
}

async function session(): Promise<Setup> {
  let confirms = 0;
  const strip: boolean[] = [];
  const h = await startSession({
    registry: { extra: { 'ai.agent': agent } },
    host: { onConfirmStrip: (_tty, active) => strip.push(active) },
    setup: (fs) => {
      fs.handlers.set('ai.agent.submit', () => RESULT);
      fs.handlers.set('ai.agent.confirm', () => {
        confirms += 1;
        return { token: 'b'.repeat(64), expiresAt: Date.UTC(2026, 8, 26, 9, 2), granted: true };
      });
    },
  });
  return { h, confirms: () => confirms, strip };
}

function promptShown(h: Harness): boolean {
  return h.screen.text().includes('Proceed? [y/N/e=edit]');
}

describe('kernel TTY confirmation of agent plans', () => {
  it('AGT-03 the block is shown by the TTY owner and y from the keyboard confirms', async () => {
    const { h, confirms, strip } = await session();
    await h.keys('ai "delete my old logs"\r');
    expect(promptShown(h)).toBe(true);
    expect(h.screen.text()).toContain('Kernel confirmation · ai.agent');
    expect(h.screen.text()).toContain('Needs confirmation because: delete');
    expect(strip).toEqual([true]);
    expect(confirms()).toBe(0);
    await h.keys('y');
    expect(confirms()).toBe(1);
    expect(strip).toEqual([true, false]);
    expect(h.screen.text()).toContain('✓ committed');
    expect(await h.cmd('echo $?')).toBe('0');
  });

  it('AGT-03 a y on the agent’s stdin is not an answer (echo y | ai …)', async () => {
    const { h, confirms } = await session();
    await h.keys('echo y | ai "delete my old logs"\r');
    expect(promptShown(h)).toBe(true);
    expect(confirms()).toBe(0);
    await h.keys('\r');
    expect(confirms()).toBe(0);
    expect(h.screen.text()).toContain('✗ declined — nothing ran');
    expect(h.screen.text()).toContain('agent: ECANCELED');
    expect(await h.cmd('echo $?')).not.toBe('0');
  });

  it('SHL-14 type-ahead typed before the prompt is discarded', async () => {
    const { h, confirms } = await session();
    await h.keys('ai "delete my old logs"\ryyy');
    expect(promptShown(h)).toBe(true);
    expect(confirms()).toBe(0);
    await h.keys('n');
    expect(confirms()).toBe(0);
    expect(h.screen.text()).toContain('✗ declined — nothing ran');
  });

  it('SHL-14 a bracketed paste cannot answer', async () => {
    const { h, confirms } = await session();
    await h.keys('ai "delete my old logs"\r');
    await h.keys('\x1b[200~y\r\x1b[201~');
    expect(confirms()).toBe(0);
    await h.keys('y');
    expect(confirms()).toBe(1);
  });

  it('SHL-14 no answer within 120 s: the plan is refused', async () => {
    const { h, confirms } = await session();
    await h.keys('ai "delete my old logs"\r');
    await h.clock.advance(119_000);
    expect(h.screen.text()).not.toContain('timed out');
    await h.clock.advance(1_000);
    expect(h.screen.text()).toContain('✗ confirmation timed out — nothing ran');
    expect(confirms()).toBe(0);
    // The keyboard belongs to the shell again.
    expect(await h.cmd('echo back')).toBe('back');
  });

  it('SHL-14 e (edit) is refused without running anything', async () => {
    const { h, confirms } = await session();
    await h.keys('ai "delete my old logs"\r');
    await h.keys('e');
    expect(confirms()).toBe(0);
    expect(h.screen.text()).toContain('editing a plan is not available here');
  });
});

describe('the confirmation block model (plan.ts)', () => {
  it('AGT-08 steps, destructive words, disclosed files and the blast radius', () => {
    const m = confirmationModel({
      steps: STEPS,
      result: RESULT,
      requester: { pid: 812, comm: 'ai.agent' },
    });
    expect(m.header).toEqual({ agent: 'ai.agent', pid: 812 });
    expect(m.steps[0]).toMatchObject({
      command: 'glob',
      args: '~/logs/*.log',
      effect: '→ 2 files',
      fileCount: 2,
    });
    expect(m.steps[1]).toMatchObject({
      command: 'unlink',
      destructive: 'delete',
      effect: 'remove 2 entries',
    });
    expect(m.blast).toEqual({ inodes: 2, deletions: 2, overwrites: 0, quotaOk: true });
    expect(m.reasons).toEqual(['delete']);
  });
});
