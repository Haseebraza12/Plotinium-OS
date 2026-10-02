// @ts-check
/**
 * local/no-yieldless-loop-in-generator
 *
 * Plotinium programs are resumable generators: `init(argv)` builds the state and `*run(ctx, st)`
 * does the work, yielding to the executor at every pre-emption point. A loop inside a generator
 * that never yields cannot be pre-empted at its quantum; the process then monopolises its executor
 * until the watchdog kills it (PROC-03 round robin, PROC-04 aging bound, PROC-05 frame budget).
 *
 * The rule reports every loop (for, for-in, for-of, while, do-while) inside a generator function
 * whose test, update or body contains no `yield` or `yield*`. Yields inside nested functions do
 * not count, and loops inside nested non-generator functions are ignored. A nested loop without its
 * own yield is reported even when the outer loop yields, because the inner loop runs to completion
 * between two pre-emption points.
 *
 * Escape hatch for a loop that is provably bounded and short: disable the rule on that line with
 * a reason, for example
 *   // eslint-disable-next-line local/no-yieldless-loop-in-generator -- at most 8 iterations
 */

/**
 * @typedef {{ node: import('estree').Node, hasYield: boolean }} LoopFrame
 * @typedef {{ generator: boolean, loops: LoopFrame[] }} FunctionFrame
 */

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require every loop inside a generator function to contain a yield, so a process can be pre-empted at its quantum.',
    },
    schema: [],
    messages: {
      yieldless:
        'This loop inside a generator never yields, so the process cannot be pre-empted until the watchdog kills it (PROC-03). Add `yield ctx.tick` or a `yield*` syscall inside the loop, or move a provably short loop out of the generator.',
    },
  },

  create(context) {
    /** @type {FunctionFrame[]} */
    const functions = [];

    /** @param {import('estree').Function} node */
    function enterFunction(node) {
      functions.push({ generator: node.generator === true, loops: [] });
    }

    function exitFunction() {
      functions.pop();
    }

    /** @param {import('estree').Node} node */
    function enterLoop(node) {
      const frame = functions.at(-1);
      if (frame?.generator) frame.loops.push({ node, hasYield: false });
    }

    /** @param {import('estree').Node} node */
    function exitLoop(node) {
      const frame = functions.at(-1);
      if (!frame?.generator) return;
      const loop = frame.loops.pop();
      if (loop && loop.node === node && !loop.hasYield) {
        context.report({ node, messageId: 'yieldless' });
      }
    }

    function onYield() {
      const frame = functions.at(-1);
      if (!frame) return;
      for (const loop of frame.loops) loop.hasYield = true;
    }

    return {
      FunctionDeclaration: enterFunction,
      'FunctionDeclaration:exit': exitFunction,
      FunctionExpression: enterFunction,
      'FunctionExpression:exit': exitFunction,
      ArrowFunctionExpression: enterFunction,
      'ArrowFunctionExpression:exit': exitFunction,

      WhileStatement: enterLoop,
      'WhileStatement:exit': exitLoop,
      DoWhileStatement: enterLoop,
      'DoWhileStatement:exit': exitLoop,
      ForStatement: enterLoop,
      'ForStatement:exit': exitLoop,
      ForInStatement: enterLoop,
      'ForInStatement:exit': exitLoop,
      ForOfStatement: enterLoop,
      'ForOfStatement:exit': exitLoop,

      YieldExpression: onYield,
    };
  },
};

export default rule;
