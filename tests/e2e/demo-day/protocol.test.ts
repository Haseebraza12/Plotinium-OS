/**
 * The Demo Day schedule, the system-under-test order and the rehearsal record (spec §17.1;
 * testing §3.16; TST-18; AIS-11).
 */
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  appendEntry,
  clock,
  measurementsFrom,
  orderProblems,
  parseEntries,
  PROTOCOL,
  readEntries,
  recordFile,
  renderReport,
  requirementOf,
  slotMs,
  SUT_ITEMS,
  type RehearsalEntry,
} from './protocol.ts';

const HERE = fileURLToPath(new URL('./', import.meta.url));

function entry(over: Partial<RehearsalEntry> = {}): RehearsalEntry {
  return {
    run: 'rehearsal-1',
    network: 'lab LAN',
    machine: 'Linux 6.8 x64 · 8 CPUs · 16.0 GiB',
    chrome: '141.0.7390.54',
    segment: 'boot',
    item: 'boot',
    title: 'BOOT-11 bootlog --critical-path shows the chain',
    req: 'BOOT-11',
    status: 'passed',
    startedAt: '2026-12-01T09:00:00.000Z',
    durationMs: 4_200,
    measurements: { 'boot s': '0.731' },
    ...over,
  };
}

describe('protocol', () => {
  it('TST-18 the protocol covers 30 minutes in five contiguous segments with the spec 17.1 slots', () => {
    expect(PROTOCOL.map((s) => s.id)).toEqual(['bringup', 'boot', 'sut', 'viva', 'questions']);
    expect(PROTOCOL[0]?.startS).toBe(0);
    expect(PROTOCOL[PROTOCOL.length - 1]?.endS).toBe(30 * 60);
    for (let i = 1; i < PROTOCOL.length; i++)
      expect(PROTOCOL[i]?.startS).toBe(PROTOCOL[i - 1]?.endS);
    expect(slotMs('bringup')).toBe(5 * 60_000);
    expect(slotMs('boot')).toBe(3 * 60_000);
    expect(slotMs('sut')).toBe(10 * 60_000);
    expect(slotMs('viva')).toBe(8 * 60_000);
    expect(slotMs('questions')).toBe(4 * 60_000);
  });

  it('AIS-11 the rehearsal order runs the hidden semantic query before the 2x memory workload', () => {
    expect(orderProblems(SUT_ITEMS)).toEqual([]);
    const at = (id: string): number => SUT_ITEMS.findIndex((i) => i.id === id);
    expect(at('semantic-query')).toBeLessThan(at('memory'));
  });

  it('AIS-11 orderProblems catches the memory workload moved before the semantic query', () => {
    const memory = SUT_ITEMS.find((i) => i.id === 'memory');
    const rest = SUT_ITEMS.filter((i) => i.id !== 'memory');
    if (memory === undefined) throw new Error('no memory item');
    const problems = orderProblems([memory, ...rest]);
    expect(problems.some((p) => p.startsWith('AIS-11'))).toBe(true);
    expect(
      orderProblems(SUT_ITEMS.slice(1)).some((p) => p.includes('missing item semantic-query')),
    ).toBe(true);
  });

  it('TST-18 each system-under-test item names its requirements and a script that exists in this folder', () => {
    for (const item of SUT_ITEMS) {
      expect(item.req.length, item.id).toBeGreaterThan(0);
      expect(existsSync(join(HERE, item.script)), item.script).toBe(true);
    }
    expect(SUT_ITEMS.find((i) => i.id === 'fault-rm')?.instance).toBe('local');
  });

  it('TST-18 clock formats seconds as the stopwatch shows them', () => {
    expect(clock(0)).toBe('0:00');
    expect(clock(305)).toBe('5:05');
    expect(clock(1800)).toBe('30:00');
    expect(clock(-3)).toBe('0:00');
  });
});

describe('rehearsal record', () => {
  let dir: string | undefined;

  afterEach(async () => {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('TRC-02 requirementOf returns the first token of a title only when it has the shape of an ID', () => {
    expect(requirementOf('BOOT-11 bootlog --critical-path shows the chain')).toBe('BOOT-11');
    expect(requirementOf('PLT-DEL-02 the production URL is ready')).toBe('PLT-DEL-02');
    expect(requirementOf('E2 offline boot')).toBeNull();
    expect(requirementOf('bootlog prints the stages')).toBeNull();
  });

  it('TST-18 measurementsFrom keeps only measure: annotations', () => {
    expect(
      measurementsFrom([
        { type: 'measure:boot ms', description: '731' },
        { type: 'issue', description: 'https://example.invalid/1' },
        { type: 'measure:variant' },
      ]),
    ).toEqual({ 'boot ms': '731', variant: '' });
  });

  it('TST-18 appendEntry and readEntries round-trip through a JSON-lines file', async () => {
    dir = await mkdtemp(join(tmpdir(), 'plt-demo-record-'));
    const file = join(dir, 'nested', 'rehearsal.jsonl');
    await appendEntry(entry(), file);
    await appendEntry(
      entry({ segment: 'sut', item: '7 lock', title: 'VFS-09 x', req: 'VFS-09' }),
      file,
    );
    const back = await readEntries(file);
    expect(back).toHaveLength(2);
    expect(back[1]?.req).toBe('VFS-09');
    expect(await readEntries(join(dir, 'missing.jsonl'))).toEqual([]);
  });

  it('TST-18 parseEntries skips a truncated last line and lines that are not entries', async () => {
    dir = await mkdtemp(join(tmpdir(), 'plt-demo-record-'));
    const file = join(dir, 'r.jsonl');
    await writeFile(
      file,
      `${JSON.stringify(entry())}\n{"run":"x"}\n{"run":"rehearsal-1","segm`,
      'utf8',
    );
    expect(
      parseEntries(`${JSON.stringify(entry())}\n{"run":"x"}\n{"run":"rehearsal-1","segm`),
    ).toHaveLength(1);
    expect(await readEntries(file)).toHaveLength(1);
  });

  it('TST-18 recordFile honours PLT_DEMO_RECORD_DIR and defaults under test-results', () => {
    expect(recordFile({ PLT_DEMO_RECORD_DIR: '/tmp/demo' })).toBe(
      join('/tmp/demo', 'rehearsal.jsonl'),
    );
    expect(recordFile({})).toMatch(/test-results[\\/]demo-day[\\/]rehearsal\.jsonl$/);
  });

  it('TST-18 renderReport prints machine, network, Chrome, every check and the scripted time per segment', () => {
    const md = renderReport([
      entry(),
      entry({
        title: 'BOOT-09 offline reboot',
        req: 'BOOT-09',
        status: 'failed',
        durationMs: 20_000,
      }),
      entry({
        segment: 'bringup',
        item: 'clean bring-up',
        title: 'OPS-05 x',
        req: 'OPS-05',
        durationMs: 400_000,
      }),
      entry({ run: 'rehearsal-2', network: '4G hotspot' }),
    ]);
    expect(md).toContain('## Rehearsal rehearsal-1');
    expect(md).toContain('## Rehearsal rehearsal-2');
    expect(md).toContain('- Network: lab LAN');
    expect(md).toContain('- Chrome: 141.0.7390.54');
    expect(md).toContain('- Checks: 3 (2 passed, 1 failed, 0 skipped)');
    expect(md).toContain(
      '| boot | boot | BOOT-11 bootlog --critical-path shows the chain | passed | 4.2 s | boot s=0.731 |',
    );
    expect(md).toContain('| Clean bring-up | 0:00–5:00 | 6:40 | NO |');
    expect(md).toContain('| Boot | 5:00–8:00 | 0:24 | yes |');
  });
});
