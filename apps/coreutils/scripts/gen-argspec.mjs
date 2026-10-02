// Regenerates apps/coreutils/lib/argspec.gen.ts from the man pages' JSON front matter (SHL-12:
// the page is the single source of a command's flags).
// Usage: node apps/coreutils/scripts/gen-argspec.mjs
// TODO(R3): tools/manpages.ts takes this over in CI (shell-and-terminal.md §3.12).
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const manDir = join(root, 'man');

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
 * GENERATED from apps/coreutils/man/*.md front matter (the single source of flags, SHL-12) by
 * apps/coreutils/scripts/gen-argspec.mjs. Do not edit by hand.
 * TODO(R3): tools/manpages.ts takes over generation in CI (shell spec §3.12).
 */
import type { ArgSpecTable } from './argspec.ts';

export const ARGSPEC = `;
const body = JSON.stringify(table, null, 2);
writeFileSync(
  join(root, 'lib', 'argspec.gen.ts'),
  `${header}${body} as const satisfies ArgSpecTable;\n`,
);
