/**
 * Requirement-to-test traceability matrix (C18; specs/00-product/requirements-traceability.md).
 *
 * Every test title MUST begin with its requirement ID, for example
 *   it('VFS-06 rejects a write beyond quota with EDQUOT and no partial data', ...)
 * The ID is the first whitespace-delimited token of the title. It must be one of the 84 spec IDs
 * or a registered Plotinium design ID (tools/traceability/ids.ts, which follows §4.1 and §3.13 of
 * the traceability spec).
 *
 * This first version parses every *.test.ts(x), *.spec.ts(x) and *.bench.ts(x) file with the
 * TypeScript compiler API, collects the titles of it / test / bench calls (including .skip,
 * .only, .todo, .each, .runIf and Playwright's test.describe blocks) and prints:
 *   - a summary; tests of the repository tooling under tools/ (for example the lint rules that
 *     enforce SYS-01) are counted separately from tests of the product, so they never inflate
 *     requirement coverage;
 *   - one row per spec requirement (84 IDs) with its tests;
 *   - the Plotinium design IDs found;
 *   - every title whose first token is an unregistered ID or no ID at all.
 * The gate mode described in the traceability spec §4.4 and §5 (docs/requirements.csv, JUnit
 * status per tag, evidence files, issues and PRs) is added by R5 before the P2 gate.
 *
 * Usage:
 *   pnpm traceability                 Markdown report on stdout
 *   pnpm traceability --json          JSON on stdout
 *   pnpm traceability --out FILE      also write the Markdown report to FILE
 *   pnpm traceability --strict        exit 1 on a title that does not begin with an ID (C18);
 *                                     an unregistered ID prefix is only a warning while the
 *                                     traceability spec is Draft (TRC-02)
 *   pnpm traceability --strict --strict-prefixes
 *                                     also exit 1 on an unregistered ID prefix (once Accepted)
 *
 * Skipped tests (.skip, .todo, Playwright fixme) are listed but never count as coverage. Tests
 * gated with runIf/skipIf (for example the dsa IMPLEMENTED flag) are listed as "conditional".
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import ts from 'typescript';

import { idOfTitle, SPEC_REQUIREMENTS } from './traceability/ids.ts';
import type { IdKind } from './traceability/ids.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'coverage',
  'test-results',
  'playwright-report',
  'docs',
  'specs',
  'fixtures',
]);
const TEST_FILE = /\.(test|spec|bench)\.tsx?$/;
const TEST_APIS = new Set(['it', 'test', 'bench', 'describe', 'suite']);
const NOT_TESTS = new Set([
  'beforeEach',
  'afterEach',
  'beforeAll',
  'afterAll',
  'use',
  'configure',
  'step',
  'extend',
  'info',
  'expect',
  'setTimeout',
  'slow',
]);

type Status = 'active' | 'skipped' | 'conditional' | 'only';

interface FoundTest {
  readonly file: string;
  readonly line: number;
  readonly title: string;
  readonly dynamic: boolean;
  readonly status: Status;
  readonly id: string | null;
  readonly kind: IdKind | null;
  readonly suites: readonly string[];
}

interface Chain {
  readonly base: string;
  readonly modifiers: readonly string[];
}

function walkFiles(dir: string, out: string[]): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
        walkFiles(path.join(dir, entry.name), out);
      }
    } else if (TEST_FILE.test(entry.name)) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

/** it / it.skip / describe.runIf(x) / it.each(table) / test.describe.skip → base + modifiers. */
function chainOf(expr: ts.Expression): Chain | null {
  if (ts.isIdentifier(expr)) return { base: expr.text, modifiers: [] };
  if (ts.isPropertyAccessExpression(expr)) {
    const inner = chainOf(expr.expression);
    return inner ? { base: inner.base, modifiers: [...inner.modifiers, expr.name.text] } : null;
  }
  if (ts.isCallExpression(expr)) return chainOf(expr.expression);
  return null;
}

function titleOf(arg: ts.Expression | undefined): { text: string; dynamic: boolean } | null {
  if (!arg) return null;
  if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
    return { text: arg.text, dynamic: false };
  }
  if (ts.isTemplateExpression(arg)) return { text: arg.head.text, dynamic: true };
  return null;
}

function statusOf(modifiers: readonly string[]): Status {
  if (modifiers.some((m) => m === 'skip' || m === 'todo' || m === 'fixme')) return 'skipped';
  if (modifiers.some((m) => m === 'runIf' || m === 'skipIf')) return 'conditional';
  if (modifiers.includes('only')) return 'only';
  return 'active';
}

const STATUS_RANK: Readonly<Record<Status, number>> = {
  active: 0,
  only: 1,
  conditional: 2,
  skipped: 3,
};

/** The stronger of an enclosing suite's status and a test's own status. */
function combine(outer: Status, own: Status): Status {
  return STATUS_RANK[own] >= STATUS_RANK[outer] ? own : outer;
}

function scanFile(file: string): FoundTest[] {
  const text = readFileSync(file, 'utf8');
  const kind = file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const found: FoundTest[] = [];
  const relative = path.relative(REPO_ROOT, file).split(path.sep).join('/');

  // `inherited` is the strongest status of the enclosing describe blocks: a test inside
  // describe.skip is skipped, and a test inside describe.runIf(IMPLEMENTED) is conditional.
  const visit = (node: ts.Node, suites: readonly string[], inherited: Status): void => {
    if (ts.isCallExpression(node)) {
      const chain = chainOf(node.expression);
      const title = titleOf(node.arguments[0]);
      if (
        chain &&
        title &&
        TEST_APIS.has(chain.base) &&
        !chain.modifiers.some((m) => NOT_TESTS.has(m))
      ) {
        const isSuite =
          chain.base === 'describe' ||
          chain.base === 'suite' ||
          chain.modifiers.includes('describe');
        if (isSuite) {
          const suiteStatus = combine(inherited, statusOf(chain.modifiers));
          for (const arg of node.arguments) visit(arg, [...suites, title.text], suiteStatus);
          return;
        }
        const titleId = idOfTitle(title.text);
        found.push({
          file: relative,
          line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
          title: title.text,
          dynamic: title.dynamic,
          status: combine(inherited, statusOf(chain.modifiers)),
          id: titleId?.id ?? null,
          kind: titleId?.kind ?? null,
          suites,
        });
      }
    }
    ts.forEachChild(node, (child) => {
      visit(child, suites, inherited);
    });
  };

  visit(source, [], 'active');
  return found;
}

function escapeCell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function describeTest(test: FoundTest): string {
  return `${escapeCell(test.title)} (${test.file}:${test.line}, ${test.status})`;
}

function renderMarkdown(tests: readonly FoundTest[]): string {
  const byId = new Map<string, FoundTest[]>();
  for (const test of tests) {
    if (test.id === null) continue;
    const list = byId.get(test.id) ?? [];
    list.push(test);
    byId.set(test.id, list);
  }
  const isTooling = (test: FoundTest): boolean => test.file.startsWith('tools/');
  // Only tests that always run count as coverage. A test gated by runIf/skipIf (for example on the
  // dsa IMPLEMENTED flag) may not run at all, so it is listed but not counted (TRC-03).
  const counts = (test: FoundTest): boolean => test.status === 'active' || test.status === 'only';
  const covered = SPEC_REQUIREMENTS.filter((requirement) =>
    (byId.get(requirement.id) ?? []).some((test) => counts(test) && !isTooling(test)),
  );
  const toolingOnly = SPEC_REQUIREMENTS.filter(
    (requirement) =>
      !covered.includes(requirement) && (byId.get(requirement.id) ?? []).some(counts),
  );
  const noId = tests.filter((test) => test.kind === null);
  const unregistered = tests.filter((test) => test.kind === 'unregistered');
  const designIds = [
    ...new Set(tests.filter((test) => test.kind === 'plotinium').map((test) => test.id ?? '')),
  ].sort();

  const lines: string[] = [];
  lines.push('# Requirement traceability matrix', '');
  lines.push(`Generated by \`pnpm traceability\` on ${new Date().toISOString().slice(0, 10)}.`, '');
  lines.push(
    `- Tests found: ${tests.length} (${tests.filter(counts).length} always run; skipped and conditional tests do not count)`,
    `- Titles that begin with a registered requirement ID: ${tests.length - noId.length - unregistered.length}`,
    `- Spec requirements with at least one product test that always runs: ${covered.length} of ${SPEC_REQUIREMENTS.length}`,
    `- Spec requirements with tooling tests only (tools/, for example lint rules): ${toolingOnly.length}`,
    '',
  );

  lines.push('## Spec requirements', '');
  lines.push('| ID | Keyword | Spec § | Tests | Titles |', '|---|---|---|---|---|');
  for (const requirement of SPEC_REQUIREMENTS) {
    const list = byId.get(requirement.id) ?? [];
    const titles = list.map(describeTest).join('<br>');
    lines.push(
      `| ${requirement.id} | ${requirement.keyword} | ${requirement.section} | ${list.length} | ${titles || '–'} |`,
    );
  }

  lines.push('', '## Plotinium design IDs', '');
  if (designIds.length === 0) {
    lines.push('None found.');
  } else {
    lines.push('| ID | Tests | Titles |', '|---|---|---|');
    for (const id of designIds) {
      const list = byId.get(id) ?? [];
      lines.push(`| ${id} | ${list.length} | ${list.map(describeTest).join('<br>')} |`);
    }
  }

  lines.push('', '## Titles with an unregistered ID (TRC-02)', '');
  if (unregistered.length === 0) lines.push('None.');
  for (const test of unregistered) lines.push(`- ${describeTest(test)}`);

  lines.push('', '## Titles without a requirement ID (C18)', '');
  if (noId.length === 0) lines.push('None.');
  for (const test of noId) lines.push(`- ${describeTest(test)}`);
  lines.push('');
  return lines.join('\n');
}

function main(): void {
  const { values } = parseArgs({
    options: {
      json: { type: 'boolean', default: false },
      strict: { type: 'boolean', default: false },
      'strict-prefixes': { type: 'boolean', default: false },
      out: { type: 'string' },
    },
  });

  const files = walkFiles(REPO_ROOT, []).sort();
  const tests = files.flatMap(scanFile);
  const markdown = renderMarkdown(tests);

  if (values.out !== undefined) writeFileSync(values.out, markdown);
  process.stdout.write(values.json ? `${JSON.stringify(tests, null, 2)}\n` : markdown);

  const untagged = tests.filter((test) => test.kind === null);
  const unregistered = tests.filter((test) => test.kind === 'unregistered');
  if (unregistered.length > 0) {
    process.stderr.write(
      `traceability: warning: ${unregistered.length} test title(s) begin with an unregistered ID prefix (TRC-02).\n`,
    );
  }
  if (values.strict && untagged.length > 0) {
    process.stderr.write(
      `traceability: ${untagged.length} test title(s) do not begin with a requirement ID (C18).\n`,
    );
    process.exitCode = 1;
  }
  if (values.strict && values['strict-prefixes'] && unregistered.length > 0) {
    process.exitCode = 1;
  }
}

main();
