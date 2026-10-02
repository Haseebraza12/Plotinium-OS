import solid from 'eslint-plugin-solid/configs/typescript';
import tseslint from 'typescript-eslint';
export default [{ files: ['**/*.tsx'], ...solid, languageOptions: { parser: tseslint.parser, parserOptions: { project: false } } }];
