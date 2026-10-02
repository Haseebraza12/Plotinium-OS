/**
 * Per-command smoke tests (shell-and-terminal.md §8.2): every command has a test whose title starts
 * with `SYS-02 <command> `, which tools/traceability.ts checks.
 */
import { describe, expect, it } from 'vitest';

import type { CommandName } from '../lib/command.ts';
import { specOf, synopsisForms } from '../lib/command.ts';
import type { CoreProgram } from '../index.ts';
import { PROGRAMS } from '../index.ts';
import { kernel } from './harness.ts';

describe('per-command smoke tests', () => {
  for (const name of Object.keys(PROGRAMS) as CommandName[]) {
    it(`SYS-02 ${name} --help prints its synopsis from the man page and exits 0`, () => {
      const program: CoreProgram = PROGRAMS[name];
      const r = kernel().run(program, [name, '--help']);
      expect(r.status).toBe(0);
      expect(r.err).toBe('');
      // echo prints its operands, --help included, as the shell builtin does.
      const expected =
        name === 'echo'
          ? '--help'
          : `Usage: ${synopsisForms(name, specOf(name).synopsis)[0] ?? ''}`;
      expect(r.out.split('\n')[0]).toBe(expected);
    });
  }
});
