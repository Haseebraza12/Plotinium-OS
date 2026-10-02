/**
 * Prints the scripted rehearsal record as Markdown for docs/evidence/defence/rehearsal-<n>.md
 * (TST-18). Node 24 runs it from source:
 *
 *   node tests/e2e/demo-day/report.ts                         default record file
 *   node tests/e2e/demo-day/report.ts --in path/to/rehearsal.jsonl --run rehearsal-3
 *
 * The live rehearsal still needs the stopwatch times and the drills; docs/demo/REHEARSAL.md §7
 * has the template this output is pasted into.
 */
import { parseArgs } from 'node:util';

import { readEntries, recordFile, renderReport } from './protocol.ts';

export async function main(argv: readonly string[]): Promise<string> {
  const { values } = parseArgs({
    args: [...argv],
    options: { in: { type: 'string' }, run: { type: 'string' } },
    strict: true,
  });
  const entries = await readEntries(values.in ?? recordFile());
  const selected = values.run === undefined ? entries : entries.filter((e) => e.run === values.run);
  if (selected.length === 0) return `No rehearsal entries in ${values.in ?? recordFile()}.\n`;
  return renderReport(selected);
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.filename === process.argv[1];
if (invokedDirectly) {
  process.stdout.write(await main(process.argv.slice(2)));
}
