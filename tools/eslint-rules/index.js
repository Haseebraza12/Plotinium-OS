// @ts-check
/**
 * Plotinium's local ESLint plugin, registered as `local` in eslint.config.js.
 * Each rule has unit tests next to it and at least one failing fixture in ./fixtures/.
 */
import noAwaitInIdbBuilder from './no-await-in-idb-builder.js';
import noHtmlSinks from './no-html-sinks.js';
import noRelativeImportOutsidePackage from './no-relative-import-outside-package.js';
import noStaticJsxStyle from './no-static-jsx-style.js';
import noYieldlessLoopInGenerator from './no-yieldless-loop-in-generator.js';

/** @type {import('eslint').ESLint.Plugin} */
const plugin = {
  meta: { name: 'eslint-plugin-plotinium-local', version: '0.1.0' },
  rules: {
    'no-yieldless-loop-in-generator': noYieldlessLoopInGenerator,
    'no-await-in-idb-builder': noAwaitInIdbBuilder,
    'no-html-sinks': noHtmlSinks,
    'no-relative-import-outside-package': noRelativeImportOutsidePackage,
    'no-static-jsx-style': noStaticJsxStyle,
  },
};

export default plugin;
