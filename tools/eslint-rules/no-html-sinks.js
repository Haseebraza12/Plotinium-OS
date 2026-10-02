// @ts-check
/**
 * local/no-html-sinks
 *
 * File names, file contents and every piece of AI output are untrusted data (AGT-06). They are
 * rendered as text, never parsed as HTML or code. This rule reports the DOM and JavaScript sinks
 * that would turn such a string into markup or script:
 *   - assignments to `innerHTML`, `outerHTML` or `srcdoc`;
 *   - calls to `insertAdjacentHTML`, `createContextualFragment`, `setHTMLUnsafe`,
 *     `parseHTMLUnsafe`, and `document.write` / `document.writeln`;
 *   - `setAttribute` with a literal `on*` event-handler name or `srcdoc`;
 *   - `eval(...)`, `Function(...)` / `new Function(...)`, and `setTimeout` / `setInterval` with a
 *     string argument;
 *   - JSX props `innerHTML`, `outerHTML`, `srcdoc` and `dangerouslySetInnerHTML` (including
 *     Solid's `prop:innerHTML`).
 *
 * Solid's compiled templates use `innerHTML` on a `<template>` element internally; that is build
 * output, not our source, so it is not affected. See SECURITY.md.
 */

const SINK_PROPERTIES = new Set(['innerHTML', 'outerHTML', 'srcdoc']);
const SINK_METHODS = new Set([
  'insertAdjacentHTML',
  'createContextualFragment',
  'setHTMLUnsafe',
  'parseHTMLUnsafe',
]);
const DOCUMENT_WRITERS = new Set(['write', 'writeln']);
const JSX_SINKS = new Set(['innerHTML', 'outerHTML', 'srcdoc', 'dangerouslySetInnerHTML']);
const STRING_TIMERS = new Set(['setTimeout', 'setInterval']);

/**
 * @param {import('estree').MemberExpression} member
 * @returns {string | null}
 */
function propertyName(member) {
  if (!member.computed && member.property.type === 'Identifier') return member.property.name;
  if (
    member.computed &&
    member.property.type === 'Literal' &&
    typeof member.property.value === 'string'
  ) {
    return member.property.value;
  }
  return null;
}

/**
 * @param {import('estree').Node} node
 * @returns {boolean}
 */
function isDocument(node) {
  if (node.type === 'Identifier') return node.name === 'document';
  if (node.type === 'MemberExpression') return propertyName(node) === 'document';
  return false;
}

/**
 * @param {import('estree').Node | undefined} node
 * @returns {boolean}
 */
function isStringLike(node) {
  if (!node) return false;
  if (node.type === 'Literal') return typeof node.value === 'string';
  return node.type === 'TemplateLiteral';
}

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow HTML and code sinks: untrusted file names, contents and AI output are rendered as text.',
    },
    schema: [],
    messages: {
      property:
        'Do not assign to `{{name}}`: render untrusted text with `textContent` or a Solid text node (AGT-06, SECURITY.md).',
      method:
        'Do not call `{{name}}`: it parses a string as HTML. Build DOM nodes or render text instead (AGT-06, SECURITY.md).',
      attribute:
        'Do not set the `{{name}}` attribute from code: it turns a string into script or markup (AGT-06, SECURITY.md).',
      code: 'Do not evaluate strings as code (`{{name}}`); the CSP forbids it and it is an injection sink (SECURITY.md).',
      jsx: 'Do not use the `{{name}}` prop: render untrusted text as a child text node instead (AGT-06, SECURITY.md).',
    },
  },

  create(context) {
    return {
      AssignmentExpression(node) {
        if (node.left.type !== 'MemberExpression') return;
        const name = propertyName(node.left);
        if (name !== null && SINK_PROPERTIES.has(name)) {
          context.report({ node: node.left, messageId: 'property', data: { name } });
        }
      },

      CallExpression(node) {
        const { callee } = node;
        if (callee.type === 'Identifier') {
          if (callee.name === 'eval' || callee.name === 'Function') {
            context.report({ node, messageId: 'code', data: { name: callee.name } });
          } else if (STRING_TIMERS.has(callee.name) && isStringLike(node.arguments[0])) {
            context.report({ node, messageId: 'code', data: { name: `${callee.name}(string)` } });
          }
          return;
        }
        if (callee.type !== 'MemberExpression') return;
        const name = propertyName(callee);
        if (name === null) return;
        if (SINK_METHODS.has(name)) {
          context.report({ node, messageId: 'method', data: { name } });
        } else if (DOCUMENT_WRITERS.has(name) && isDocument(callee.object)) {
          context.report({ node, messageId: 'method', data: { name: `document.${name}` } });
        } else if (name === 'setAttribute') {
          const first = node.arguments[0];
          if (first && first.type === 'Literal' && typeof first.value === 'string') {
            const attr = first.value.toLowerCase();
            if (attr.startsWith('on') || attr === 'srcdoc') {
              context.report({ node, messageId: 'attribute', data: { name: first.value } });
            }
          }
        } else if (STRING_TIMERS.has(name) && isStringLike(node.arguments[0])) {
          context.report({ node, messageId: 'code', data: { name: `${name}(string)` } });
        }
      },

      NewExpression(node) {
        if (node.callee.type === 'Identifier' && node.callee.name === 'Function') {
          context.report({ node, messageId: 'code', data: { name: 'new Function' } });
        }
      },

      /** @param {any} node JSXAttribute (not part of the estree typings) */
      JSXAttribute(node) {
        const attrName =
          node.name.type === 'JSXNamespacedName' ? node.name.name.name : node.name.name;
        if (typeof attrName === 'string' && JSX_SINKS.has(attrName)) {
          context.report({ node, messageId: 'jsx', data: { name: attrName } });
        }
      },
    };
  },
};

export default rule;
