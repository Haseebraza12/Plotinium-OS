// Regenerates apps/demo/lib/argspec.gen.ts from the demo man pages' JSON front matter (SHL-12:
// the page is the single source of a command's flags). Same front-matter format and output shape
// as apps/coreutils/scripts/gen-argspec.mjs.
// Usage: node apps/demo/scripts/gen-argspec.mjs            (write)
//        node apps/demo/scripts/gen-argspec.mjs --check    (exit 1 when the file is out of date)
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const manDir = join(root, 'man');
const outFile = join(root, 'lib', 'argspec.gen.ts');

/** @param {string} text */
function frontMatter(text) {
  const match = /^---json\n([\s\S]*?)\n---\n/.exec(text);
  if (!match || match[1] === undefined) throw new Error('missing ---json front matter');
  return JSON.parse(match[1]);
}

const table = {};
for (const file of readdirSync(manDir)
  .filter((f) => f.endsWith('.md'))
  .sort()) {
  const fm = frontMatter(readFileSync(join(manDir, file), 'utf8'));
  table[fm.name] = {
    synopsis: fm.synopsis,
    summary: fm.summary,
    flags: fm.flags.map(
      (
        /** @type {{short: string|null, long: string|null, arg: string|null, desc: string}} */ f,
      ) => ({
        short: f.short,
        long: f.long,
        arg: f.arg,
        optionalArg: f.long !== null && fm.synopsis.includes(`${f.long}[=`),
        desc: f.desc,
      }),
    ),
  };
}

const header = `/**
 * GENERATED from apps/demo/man/*.md front matter (the single source of flags, SHL-12) by
 * apps/demo/scripts/gen-argspec.mjs. Do not edit by hand.
 */
import type { ArgSpecTable } from '../../coreutils/lib/argspec.ts';

export const DEMO_ARGSPEC = `;
const body = JSON.stringify(table, null, 2);
const text = `${header}${body} as const satisfies ArgSpecTable;\n`;

if (process.argv.includes('--check')) {
  const current = readFileSync(outFile, 'utf8');
  if (current !== text) {
    console.error(
      'apps/demo/lib/argspec.gen.ts is out of date: run node apps/demo/scripts/gen-argspec.mjs',
    );
    process.exit(1);
  }
} else {
  writeFileSync(outFile, text);
}
