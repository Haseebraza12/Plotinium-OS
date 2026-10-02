/**
 * UI-147: Solid compiles a static `style={{…}}` literal into a `style="…"` attribute of its
 * template HTML, and the production CSP (`style-src 'self'` + hashes, no 'unsafe-inline')
 * refuses it with a `style-src-attr` violation. Dynamic values are set through the CSSOM
 * (`setStyleProperty`), which the CSP allows. This test compiles every component of the
 * primitives, Task Manager, Settings and About (views and apps) with the same compiler the build
 * uses (babel-preset-solid, from vite-plugin-solid) and fails on any template that still carries
 * a static style attribute.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

interface BabelLike {
  transformSync(
    code: string,
    options: {
      filename: string;
      babelrc: boolean;
      configFile: boolean;
      parserOpts: { plugins: string[] };
      presets: unknown[];
    },
  ): { code?: string | null } | null;
}

/** The repository root: the nearest folder up from the working directory with the workspace. */
function repoRoot(): string {
  let dir = process.cwd();
  while (!existsSync(join(dir, 'pnpm-workspace.yaml'))) {
    const up = dirname(dir);
    if (up === dir) throw new Error('pnpm-workspace.yaml not found');
    dir = up;
  }
  return dir;
}

const repo = repoRoot();
const fromUi = createRequire(join(repo, 'ui/package.json'));
const fromPlugin = createRequire(fromUi.resolve('vite-plugin-solid'));
const babel = fromPlugin('@babel/core') as BabelLike;
const solidPreset: unknown = fromPlugin('babel-preset-solid');

/** The component folders UI-147 covers (fix-apps-settings-a11y's surfaces). */
const ROOTS = [
  'ui/src/primitives',
  'ui/src/apps/taskmgr',
  'ui/src/apps/settings',
  'apps/taskmgr',
  'apps/settings',
  'apps/about',
  'apps/src/notice.tsx',
];

function* components(path: string): Generator<string> {
  if (path.endsWith('.tsx')) {
    yield path;
    return;
  }
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const full = join(path, entry.name);
    if (entry.isDirectory()) yield* components(full);
    else if (entry.name.endsWith('.tsx') && !entry.name.includes('.test.')) yield full;
  }
}

/** `<tag … style=…>` openings inside the compiled `template(\`…\`)` strings of one file. */
function staticStyleAttributes(file: string): string[] {
  const out = babel.transformSync(readFileSync(file, 'utf8'), {
    filename: file,
    babelrc: false,
    configFile: false,
    parserOpts: { plugins: ['jsx', 'typescript'] },
    presets: [[solidPreset, { generate: 'dom' }]],
  })?.code;
  if (out === undefined || out === null) throw new Error(`could not compile ${file}`);
  const found: string[] = [];
  for (const template of out.matchAll(/_\$template\(`([^`]*)`/gu)) {
    for (const tag of (template[1] ?? '').matchAll(/<[a-z][^<>]*\sstyle=[^<>]*>/giu))
      found.push(tag[0]);
  }
  return found;
}

describe('UI-147 no static inline styles (CSP style-src-attr)', () => {
  it('UI-147 the checker finds a static style literal and ignores a dynamic one', () => {
    const compile = (code: string): string =>
      babel.transformSync(code, {
        filename: 'probe.tsx',
        babelrc: false,
        configFile: false,
        parserOpts: { plugins: ['jsx', 'typescript'] },
        presets: [[solidPreset, { generate: 'dom' }]],
      })?.code ?? '';
    expect(compile("const a = <div style={{ display: 'flex' }} />;")).toMatch(
      /style=display:flex/u,
    );
    expect(compile('const a = <div style={{ width: w() }} />;')).not.toMatch(/<div[^>]*style=/u);
  });

  it('UI-147 Task Manager, Settings, About and the primitives compile without one', () => {
    const offenders: string[] = [];
    let files = 0;
    for (const root of ROOTS) {
      for (const file of components(join(repo, root))) {
        files++;
        for (const tag of staticStyleAttributes(file))
          offenders.push(`${relative(repo, file)}: ${tag.slice(0, 100)}`);
      }
    }
    expect(files).toBeGreaterThan(40);
    expect(offenders).toEqual([]);
  });
});
