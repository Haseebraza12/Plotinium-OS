// @ts-check
/**
 * local/no-relative-import-outside-package
 *
 * Package boundaries (architecture.md §3.7, ARC-01) are enforced on `@plotinium/*` specifiers by
 * `@typescript-eslint/no-restricted-imports`. A relative path such as '../../kernel/src/core/x.ts'
 * would bypass those rules, so this rule resolves every relative import against the importing
 * file and reports it when:
 *   - the importing file belongs to a workspace package and the target lies outside that package
 *     (import the other package by its `@plotinium/*` name instead); or
 *   - the target lies under docs/evidence/ (the AI-written pilot code is never imported, C16).
 *
 * Files outside the workspace packages (tools/, tests/, root configs) are only checked for the
 * pilot rule. Paths are resolved against the repository root (two levels above this file), so the
 * rule behaves the same whatever directory ESLint is started from.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

export const WORKSPACE_PACKAGES = [
  'protocol',
  'dsa',
  'kernel',
  'vfs',
  'services',
  'wm',
  'apps',
  'ai',
  'server',
  'db',
  'web',
];

/**
 * @param {string} relative
 * @param {string} dir
 * @returns {boolean}
 */
function isInside(relative, dir) {
  return relative === dir || relative.startsWith(dir + path.sep);
}

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow relative imports that leave the current workspace package or reach the pilot evidence.',
    },
    schema: [],
    messages: {
      crossPackage:
        "Relative import '{{source}}' leaves package '{{pkg}}'. Import the other package by its @plotinium/* name so its exports and boundary rules apply (ARC-01).",
      pilot:
        "'{{source}}' points into docs/evidence/. The pilot code is AI-written evidence and is never imported (C16).",
    },
  },

  create(context) {
    const filename = context.filename;
    const fileRel = path.relative(REPO_ROOT, filename);
    if (fileRel.startsWith('..') || path.isAbsolute(fileRel)) return {};
    const top = fileRel.split(path.sep)[0] ?? '';
    const pkg = WORKSPACE_PACKAGES.includes(top) ? top : null;
    const evidence = path.join('docs', 'evidence');

    /** @param {import('estree').Node | null | undefined} sourceNode */
    function check(sourceNode) {
      if (!sourceNode || sourceNode.type !== 'Literal' || typeof sourceNode.value !== 'string') {
        return;
      }
      const source = sourceNode.value;
      if (!source.startsWith('.') && !source.startsWith('/')) return;
      const target = path.resolve(path.dirname(filename), source);
      const targetRel = path.relative(REPO_ROOT, target);
      if (isInside(targetRel, evidence)) {
        context.report({ node: sourceNode, messageId: 'pilot', data: { source } });
        return;
      }
      if (pkg !== null && !isInside(targetRel, pkg)) {
        context.report({ node: sourceNode, messageId: 'crossPackage', data: { source, pkg } });
      }
    }

    return {
      ImportDeclaration(node) {
        check(node.source);
      },
      ExportNamedDeclaration(node) {
        check(node.source);
      },
      ExportAllDeclaration(node) {
        check(node.source);
      },
      ImportExpression(node) {
        check(node.source);
      },
    };
  },
};

export default rule;
