import { describe, expect, it } from 'vitest';

import {
  ANSI,
  escapeForConfirmation,
  formatBlastRadius,
  formatConfirmationBlock,
  formatConfirmationHeader,
  formatConfirmReasons,
  formatOutcome,
  formatPlanStep,
  formatProceedPrompt,
  formatPrompt,
  padVisible,
  sanitizeForTty,
  sgr,
  sgrCodes,
  stripAnsi,
  toTerminalText,
  visibleWidth,
  type ConfirmationBlock,
} from './ansi.ts';

const SAMPLE: ConfirmationBlock = {
  header: { agent: 'ai.agent', pid: 812 },
  steps: [
    { command: 'mkdir', args: '~/reports', effect: 'create 1 dir' },
    { command: 'find', args: '~ -type f -name "*.pdf" -mtime -7', effect: '→ 12 files' },
    {
      command: 'mv',
      args: '<12 files> ~/reports/',
      effect: 'modify 12 entries',
      files: ['lab3-vfs.pdf', 'sched-paper.pdf', 'os-report-draft.pdf', 'x.pdf'],
      fileCount: 12,
    },
    {
      command: 'chmod',
      args: '-R o-w ~/reports',
      effect: 'modify 13 inodes',
      destructive: 'chmod',
    },
  ],
  blast: { inodes: 13, deletions: 0, overwrites: 0, quotaOk: true },
  reasons: ['chmod'],
};

describe('UI-TerminalAnsi', () => {
  it('UI-TerminalAnsi builds SGR sequences for bright and normal slots', () => {
    expect(sgrCodes({ fg: ANSI.red, bold: true })).toEqual([1, 31]);
    expect(sgrCodes({ fg: ANSI.brightBlue, bg: ANSI.black })).toEqual([94, 40]);
    expect(sgr('x', { fg: ANSI.green })).toBe('\u001b[32mx\u001b[0m');
    expect(sgr('x', {})).toBe('x');
  });

  it('UI-TerminalAnsi strips escapes and measures visible width', () => {
    const styled = sgr('abc', { bold: true }) + '\u001b]0;title\u0007';
    expect(stripAnsi(styled)).toBe('abc');
    expect(visibleWidth(styled)).toBe(3);
    expect(visibleWidth('日本')).toBe(4);
    expect(visibleWidth('é')).toBe(1);
    expect(visibleWidth(padVisible(sgr('ab', { dim: true }), 6))).toBe(6);
  });

  it('SHL-13 confirmation text escapes control and bidi characters as \\u{…}', () => {
    expect(escapeForConfirmation('evil\u001b[2Jname')).toBe('evil\\u{1B}[2Jname');
    expect(escapeForConfirmation('gpj.‮exe')).toBe('gpj.\\u{202E}exe');
    expect(escapeForConfirmation('plain ✓ name')).toBe('plain ✓ name');
    expect(sanitizeForTty('a\u0007b⁦c')).toBe('a?b?c');
  });

  it('SHL-13 file names inside a plan step cannot inject escapes', () => {
    const line = formatPlanStep(1, { command: 'rm', args: 'x\u001b[31m', effect: 'delete 1' });
    expect(line).toContain('x\\u{1B}[31m');
    expect(line).not.toContain('x\u001b[31m');
  });

  it('UI-TerminalAnsi prompt: green user@host, blue path, $ for users and # plus red for root', () => {
    const user = formatPrompt({ user: 'alice', host: 'plotinium', cwd: '~/notes' });
    expect(stripAnsi(user)).toBe('alice@plotinium:~/notes$ ');
    expect(user).toContain('\u001b[1;32malice@plotinium');
    expect(user).toContain('\u001b[1;34m~/notes');
    const root = formatPrompt({ user: 'root', host: 'plotinium', cwd: '/', root: true });
    expect(stripAnsi(root)).toBe('root@plotinium:/# ');
    expect(root).toContain('\u001b[1;31mroot@plotinium');
  });

  it('AGT-03 header names the kernel and the agent pid in bright blue bold', () => {
    const header = formatConfirmationHeader({ agent: 'ai.agent', pid: 812 }, 72);
    expect(stripAnsi(header)).toMatch(/^── Kernel confirmation · ai\.agent \(pid 812\) ─+$/u);
    expect(visibleWidth(header)).toBe(72);
    expect(header.startsWith('\u001b[1;94m')).toBe(true);
  });

  it('AGT-03 a destructive step names its operation in red and in text', () => {
    const chmod = SAMPLE.steps[3];
    expect(chmod).toBeDefined();
    if (chmod === undefined) return;
    const line = formatPlanStep(4, chmod);
    expect(stripAnsi(line)).toMatch(
      /^ {2}4 {2}chmod {3}-R o-w ~\/reports +chmod · modify 13 inodes$/u,
    );
    expect(line).toContain('\u001b[1;31mchmod\u001b[0m');
  });

  it('AGT-08 blast radius: zero counts green, non-zero red, quota in words', () => {
    const ok = formatBlastRadius(SAMPLE.blast);
    expect(stripAnsi(ok)).toBe(
      'Blast radius: 13 inodes · 0 deletions · 0 overwrites · within quota',
    );
    expect(ok).toContain('\u001b[32m0 deletions');
    const bad = formatBlastRadius({
      inodes: 1,
      deletions: 2,
      overwrites: 1,
      quotaOk: false,
      quotaText: 'over quota by 38 MB',
    });
    expect(stripAnsi(bad)).toBe(
      'Blast radius: 1 inode · 2 deletions · 1 overwrite · over quota by 38 MB',
    );
    expect(bad).toContain('\u001b[1;31m2 deletions');
  });

  it('DSN-15 the prompt shows N as the default in words and in emphasis', () => {
    const prompt = formatProceedPrompt();
    expect(stripAnsi(prompt)).toBe('Proceed? [y/N/e=edit] N is the default · Enter declines ');
    expect(prompt).toContain('\u001b[1;4;35mN\u001b[0m');
    expect(stripAnsi(formatProceedPrompt({ hint: false }))).toBe('Proceed? [y/N/e=edit] ');
    expect(stripAnsi(formatConfirmReasons(['chmod', 'delete']))).toBe(
      'Needs confirmation because: chmod, delete',
    );
  });

  it('AGT-03 the full block follows ui-design-system.md §3.8.15 line by line', () => {
    const lines = formatConfirmationBlock(SAMPLE, 100).map(stripAnsi);
    expect(lines[0]).toMatch(/^── Kernel confirmation · ai\.agent \(pid 812\) ─+$/u);
    expect(lines[1]).toBe('Plan · 4 steps · 1 transaction');
    expect(lines[2]).toMatch(/^ {2}1 {2}mkdir {3}~\/reports +create 1 dir$/u);
    expect(lines[3]).toMatch(/^ {2}2 {2}find {4}~ -type f -name "\*\.pdf" -mtime -7 +→ 12 files$/u);
    expect(lines[4]).toMatch(/^ {2}3 {2}mv {6}<12 files> ~\/reports\/ +modify 12 entries$/u);
    expect(lines[5]).toBe(
      '       ▸ show 12 files · lab3-vfs.pdf, sched-paper.pdf, os-report-draft.pdf …',
    );
    expect(lines[6]).toMatch(/chmod · modify 13 inodes$/u);
    expect(lines[7]).toBe('Blast radius: 13 inodes · 0 deletions · 0 overwrites · within quota');
    expect(lines[8]).toBe('Needs confirmation because: chmod');
    expect(lines[9]).toMatch(/^Proceed\? \[y\/N\/e=edit\]/u);
    // The effect column lines up across steps.
    const ends = [lines[2], lines[3], lines[4]].map((l) => (l ?? '').search(/(create|→|modify)/u));
    expect(new Set(ends).size).toBe(1);
    expect(toTerminalText(['a', 'b'])).toBe('a\r\nb');
  });

  it('AGT-03 a plan that needs no confirmation prints no prompt', () => {
    const lines = formatConfirmationBlock({ ...SAMPLE, reasons: [] }).map(stripAnsi);
    expect(lines.some((l) => l.startsWith('Proceed?'))).toBe(false);
    expect(lines.some((l) => l.startsWith('Needs confirmation'))).toBe(false);
  });

  it('AGT-03 outcome lines: committed with its undo command, declined, rejected', () => {
    const committed = formatOutcome({ kind: 'committed', ms: 41, txn: '8f2c' });
    expect(stripAnsi(committed)).toBe('✓ committed in 41 ms · txn 8f2c · undo with: ai undo 8f2c');
    expect(committed.startsWith('\u001b[32m')).toBe(true);
    expect(stripAnsi(formatOutcome({ kind: 'declined' }))).toBe('✗ declined — nothing ran');
    expect(stripAnsi(formatOutcome({ kind: 'timeout' }))).toBe(
      '✗ confirmation timed out — nothing ran',
    );
    expect(stripAnsi(formatOutcome({ kind: 'rejected', reason: 'EAGAIN changed-since' }))).toBe(
      '✗ rejected: EAGAIN changed-since — nothing ran',
    );
    expect(stripAnsi(formatOutcome({ kind: 'committed-offline', txn: '8f2c' }))).toContain(
      'sync pending (offline)',
    );
  });
});
