// @ts-check
/**
 * local/no-await-in-idb-builder
 *
 * Every user-visible VFS mutation is exactly ONE IndexedDB readwrite transaction (C4, DB-02).
 * IndexedDB commits a transaction automatically as soon as no request is pending at the end of a
 * task, so awaiting anything that is not an IndexedDB request inside a transaction builder lets the
 * transaction commit half-way: the "atomic" operation leaves partial state behind.
 *
 * Convention (vfs/src/store): writes go through a synchronous builder callback,
 *   tx(db, ['inodes', 'dentries', 'users', 'undo', 'outbox'], 'readwrite', (t) => { ... });
 * The rule finds builders as function arguments of calls to the configured callees (default
 * `tx`), either inline or as an identifier bound to a function in the same file, and reports:
 *   - a builder that is `async` or a generator;
 *   - any `await` or `for await` inside the builder, including in nested functions;
 *   - any nested `async` function inside the builder;
 *   - promise continuations (`.then`, `.catch`, `.finally`) inside the builder.
 *
 * Options: [{ callees: string[] }] to add builder entry points besides `tx`.
 */

/**
 * @typedef {import('estree').Node} Node
 * @typedef {import('estree').Function} FunctionNode
 * @typedef {{ node: Node, messageId: 'await' | 'forAwait' | 'nestedAsync' | 'promiseChain' }} Finding
 * @typedef {{ node: FunctionNode, findings: Finding[], children: FunctionNode[] }} FunctionInfo
 */

const PROMISE_CONTINUATIONS = new Set(['then', 'catch', 'finally']);

/**
 * @param {Node} node
 * @returns {node is FunctionNode}
 */
function isFunction(node) {
  return (
    node.type === 'FunctionDeclaration' ||
    node.type === 'FunctionExpression' ||
    node.type === 'ArrowFunctionExpression'
  );
}

/**
 * @param {import('estree').Expression | import('estree').Super} callee
 * @returns {string | null}
 */
function calleeName(callee) {
  if (callee.type === 'Identifier') return callee.name;
  if (
    callee.type === 'MemberExpression' &&
    !callee.computed &&
    callee.property.type === 'Identifier'
  ) {
    return callee.property.name;
  }
  return null;
}

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Keep IndexedDB transaction builders synchronous so a VFS mutation is exactly one transaction.',
    },
    schema: [
      {
        type: 'object',
        properties: {
          callees: { type: 'array', items: { type: 'string' }, uniqueItems: true },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      asyncBuilder:
        'IndexedDB transaction builders must be synchronous: an async or generator builder lets the transaction auto-commit half-way (C4, DB-02).',
      await:
        'No `await` inside an IndexedDB transaction builder: the transaction can auto-commit while it waits (C4, DB-02). Plan first, then build the transaction synchronously.',
      forAwait: 'No `for await` inside an IndexedDB transaction builder (C4, DB-02).',
      nestedAsync:
        'No async callbacks inside an IndexedDB transaction builder: they resume after the transaction may have committed (C4, DB-02).',
      promiseChain:
        'No promise continuations inside an IndexedDB transaction builder: they run after the transaction may have committed (C4, DB-02).',
    },
  },

  create(context) {
    const option = /** @type {{ callees?: string[] } | undefined} */ (context.options[0]);
    const callees = new Set(option?.callees ?? ['tx']);

    /** @type {Map<Node, FunctionInfo>} */
    const infos = new Map();
    /** @type {FunctionInfo[]} */
    const stack = [];
    /** @type {Set<Node>} */
    const builders = new Set();

    /** @param {Finding} finding */
    function record(finding) {
      stack.at(-1)?.findings.push(finding);
    }

    /** @param {FunctionNode} node */
    function enterFunction(node) {
      const info = { node, findings: [], children: [] };
      stack.at(-1)?.children.push(node);
      infos.set(node, info);
      stack.push(info);
    }

    function exitFunction() {
      stack.pop();
    }

    /**
     * Resolve a builder argument to a function node: inline functions, or identifiers bound to a
     * function declaration or a `const f = () => {}` in the same file.
     * @param {Node} arg
     * @param {Node} callNode
     * @returns {Node | null}
     */
    function resolveBuilder(arg, callNode) {
      if (isFunction(arg)) return arg;
      if (arg.type !== 'Identifier') return null;
      let scope = /** @type {import('eslint').Scope.Scope | null} */ (
        context.sourceCode.getScope(callNode)
      );
      while (scope) {
        const variable = scope.set.get(arg.name);
        if (variable) {
          for (const def of variable.defs) {
            if (def.node.type === 'FunctionDeclaration') return def.node;
            if (
              def.node.type === 'VariableDeclarator' &&
              def.node.init &&
              isFunction(def.node.init)
            ) {
              return def.node.init;
            }
          }
          return null;
        }
        scope = scope.upper;
      }
      return null;
    }

    /**
     * @param {FunctionInfo} info
     * @param {boolean} isRoot
     */
    function reportBuilder(info, isRoot) {
      if (isRoot && (info.node.async || info.node.generator)) {
        context.report({ node: info.node, messageId: 'asyncBuilder' });
      } else if (!isRoot && info.node.async) {
        context.report({ node: info.node, messageId: 'nestedAsync' });
      }
      for (const finding of info.findings) {
        context.report({ node: finding.node, messageId: finding.messageId });
      }
      for (const child of info.children) {
        const childInfo = infos.get(child);
        if (childInfo) reportBuilder(childInfo, false);
      }
    }

    return {
      FunctionDeclaration: enterFunction,
      'FunctionDeclaration:exit': exitFunction,
      FunctionExpression: enterFunction,
      'FunctionExpression:exit': exitFunction,
      ArrowFunctionExpression: enterFunction,
      'ArrowFunctionExpression:exit': exitFunction,

      AwaitExpression(node) {
        record({ node, messageId: 'await' });
      },

      ForOfStatement(node) {
        if (node.await) record({ node, messageId: 'forAwait' });
      },

      CallExpression(node) {
        const name = calleeName(node.callee);
        if (name !== null && callees.has(name)) {
          for (const arg of node.arguments) {
            const builder = resolveBuilder(arg, node);
            if (builder) builders.add(builder);
          }
        }
        if (
          node.callee.type === 'MemberExpression' &&
          !node.callee.computed &&
          node.callee.property.type === 'Identifier' &&
          PROMISE_CONTINUATIONS.has(node.callee.property.name)
        ) {
          record({ node, messageId: 'promiseChain' });
        }
      },

      'Program:exit'() {
        for (const builder of builders) {
          const info = infos.get(builder);
          if (info) reportBuilder(info, true);
        }
      },
    };
  },
};

export default rule;
