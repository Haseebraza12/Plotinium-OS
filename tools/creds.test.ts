import { describe, expect, it } from 'vitest';

import { extractCredentialsBlock } from './creds.ts';

const RULE = '='.repeat(78);

/** The block exactly as server/src/seed/demo.ts credentialsBlock() prints it. */
const BLOCK = [
  RULE,
  '  FIRST-START CREDENTIALS (shown once)',
  '  Generated for this stack only; stored as Argon2id hashes; printed nowhere else.',
  RULE,
  '  root       aaaaaaaaaaaaaaaaaaaa   (su only: root has no greeter login)',
  '  demo       bbbbbbbbbbbbbbbbbbbb',
  '  examiner1  cccccccccccccccccccc',
  RULE,
];

const json = (msg: string): string =>
  JSON.stringify({ level: 'info', msg, ts: '2026-09-25T18:06:30.550Z' });

describe('tools/creds.ts extractCredentialsBlock', () => {
  it('OPS-03 prints the seed credentials block from the app log and nothing around it', () => {
    const log = [json('migrations applied'), ...BLOCK, json('Server listening'), ''].join('\n');
    expect(extractCredentialsBlock(log)).toBe(BLOCK.join('\n'));
  });

  it('OPS-03 drops the JSON log lines that stderr interleaves with the block', () => {
    const interleaved = [...BLOCK.slice(0, 6), json('demo seed: done'), ...BLOCK.slice(6)];
    expect(extractCredentialsBlock(interleaved.join('\n'))).toBe(BLOCK.join('\n'));
  });

  it('OPS-03 returns the last block when the log holds two (a reset stack seeds again)', () => {
    const older = BLOCK.map((line) => line.replace('bbbbbbbbbbbbbbbbbbbb', 'olderolderolderolder'));
    const log = [...older, json('restart'), ...BLOCK].join('\r\n');
    expect(extractCredentialsBlock(log)).toBe(BLOCK.join('\n'));
  });

  it('OPS-03 returns null when the container log has no block (the container was replaced)', () => {
    expect(extractCredentialsBlock([json('database checks passed'), ''].join('\n'))).toBeNull();
    expect(extractCredentialsBlock('')).toBeNull();
  });

  it('OPS-03 returns null for a truncated block rather than printing half of it', () => {
    expect(extractCredentialsBlock(BLOCK.slice(0, 5).join('\n'))).toBeNull();
    expect(extractCredentialsBlock(BLOCK.slice(1).join('\n'))).toBeNull();
    expect(extractCredentialsBlock([...BLOCK.slice(0, 4), RULE].join('\n'))).toBeNull();
  });
});
