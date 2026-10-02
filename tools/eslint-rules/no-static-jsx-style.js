// @ts-check
/**
 * local/no-static-jsx-style
 *
 * The production CSP sends `style-src 'self'` plus hashes, with no 'unsafe-inline' (CLAUDE.md
 * standing decision 1, BUGS.md contract C5). Solid's compiler turns a JSX `style` whose value is
 * known at build time into a `style="…"` attribute of the template HTML, and the browser drops it
 * with a `style-src-attr` violation. Only values computed at run time are safe: Solid sets them
 * through the CSSOM (`el.style.setProperty`), which the CSP allows.
 *
 * This rule reports a JSX `style` attribute that is
 *   - a string: `style="display: flex"`, `style={'display: flex'}`, or a template literal with no
 *     expressions; or
 *   - an object literal whose every property has a plain key and a constant value (a string,
 *     a number, a negative number or an expression-free template literal), including `{}`.
 *
 * It does not report objects with a spread or any computed value (`{ width: w() }`), or a style
 * that is a variable (`style={HOST_STYLE}`): both compile to a run-time `style()` call. Put static
 * styles in a CSS module or a token instead (BUGS.md UI-147).
 */

/**
 * @param {import('estree').Node | null | undefined} node
 * @returns {boolean}
 */
function isConstant(node) {
  if (node === null || node === undefined) return false;
  if (node.type === 'Literal')
    return typeof node.value === 'string' || typeof node.value === 'number';
  if (node.type === 'TemplateLiteral') return node.expressions.length === 0;
  if (node.type === 'UnaryExpression')
    return (node.operator === '-' || node.operator === '+') && isConstant(node.argument);
  return false;
}

/**
 * @param {import('estree').ObjectExpression} object
 * @returns {boolean}
 */
function isAllLiteralObject(object) {
  return object.properties.every(
    (p) =>
      p.type === 'Property' &&
      !p.computed &&
      p.kind === 'init' &&
      !p.method &&
      (p.key.type === 'Identifier' || p.key.type === 'Literal') &&
      isConstant(/** @type {import('estree').Node} */ (p.value)),
  );
}

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow JSX style attributes whose value is known at build time (the CSP drops them)',
    },
    schema: [],
    messages: {
      staticStyle:
        'This style is static, so Solid compiles it to a style="…" attribute that the production CSP blocks (style-src-attr). Move it to a CSS module or a token; keep `style` for values computed at run time.',
    },
  },
  create(context) {
    return {
      /** @param {any} node JSXAttribute (JSX nodes are not in the estree types) */
      JSXAttribute(node) {
        if (node.name?.type !== 'JSXIdentifier' || node.name.name !== 'style') return;
        const value = node.value;
        if (value === null || value === undefined) return;
        if (value.type === 'Literal') {
          context.report({ node, messageId: 'staticStyle' });
          return;
        }
        if (value.type !== 'JSXExpressionContainer') return;
        const expr = value.expression;
        if (
          (expr.type === 'ObjectExpression' && isAllLiteralObject(expr)) ||
          (expr.type !== 'ObjectExpression' && isConstant(expr))
        )
          context.report({ node, messageId: 'staticStyle' });
      },
    };
  },
};

export default rule;
