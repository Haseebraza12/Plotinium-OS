import { describe, expect, it } from 'vitest';

import { lintWithRule } from './test-utils.ts';

const RULE = 'no-yieldless-loop-in-generator';
const ID = `local/${RULE}`;

function reported(code: string): number {
  return lintWithRule(RULE, code).filter((message) => message.ruleId === ID).length;
}

describe('local/no-yieldless-loop-in-generator', () => {
  it('PROC-03 reports a while loop without yield inside a generator', () => {
    expect(reported('function* run() { let i = 0; while (i < 10) { i++; } yield 1; }')).toBe(1);
  });

  it('PROC-03 reports every loop kind: for, for-in, for-of and do-while', () => {
    const code = `function* run(xs: number[], o: object) {
      for (let i = 0; i < 3; i++) { void i; }
      for (const k in o) { void k; }
      for (const x of xs) { void x; }
      do { void xs; } while (xs.length > 5);
      yield 0;
    }`;
    expect(reported(code)).toBe(4);
  });

  it('PROC-03 accepts loops that yield or delegate with yield*', () => {
    const code = `function* run(ctx: { tick: undefined; sys: { read(): Generator<undefined, number> } }) {
      while (true) { yield ctx.tick; }
      for (;;) { const n = yield* ctx.sys.read(); if (n === 0) break; }
    }`;
    expect(reported(code)).toBe(0);
  });

  it('PROC-03 counts a yield in the loop test as a pre-emption point', () => {
    expect(reported('function* run() { while ((yield 1) !== undefined) { /* empty */ } }')).toBe(0);
  });

  it('PROC-03 reports an inner loop without yield even when the outer loop yields', () => {
    const code = `function* run(grid: number[][]) {
      for (const row of grid) {
        for (const cell of row) { void cell; }
        yield row.length;
      }
    }`;
    expect(reported(code)).toBe(1);
  });

  it('PROC-03 ignores loops outside generators and in nested plain callbacks', () => {
    const code = `function plain(xs: number[]) { for (const x of xs) { void x; } }
      function* run(xs: number[]) {
        const total = xs.reduce((sum, x) => { let s = sum; while (s > 100) { s -= 100; } return s + x; }, 0);
        yield total;
      }`;
    expect(reported(code)).toBe(0);
  });

  it('PROC-03 does not credit a yield inside a nested generator to the outer loop', () => {
    const code = `function* run(xs: number[]) {
      for (const x of xs) { const inner = function* () { yield x; }; void inner; }
      yield 0;
    }`;
    expect(reported(code)).toBe(1);
  });
});
