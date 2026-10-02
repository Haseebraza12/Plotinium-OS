/**
 * Realistic sample data for the Search palette (tests and the gallery), taken from
 * docs/design/stitch/search-palette. Not exported from the package.
 */
import type { SearchPreview, SearchResult, SearchStats } from './SearchPalette.tsx';

export const SEARCH_QUERY = 'budget report from last week';

export const SEARCH_RESULTS: readonly SearchResult[] = [
  {
    id: 'os-report',
    group: 'top',
    kind: 'file',
    title: 'os-report.md',
    citation: '/home/student/notes/os-report.md:14',
    line: 14,
    snippet: '…the weekly budget report shows compute spend of $3.20 for last week…',
    terms: ['budget report', 'last week'],
    meta: 'Edited 18 Sep',
    fileKind: 'document',
  },
  {
    id: 'budget-csv',
    group: 'semantic',
    kind: 'file',
    title: 'budget-2026-w38.csv',
    citation: '~/finance/budget-2026-w38.csv:14',
    line: 14,
    relevance: 0.92,
    fileKind: 'spreadsheet',
  },
  {
    id: 'meeting-notes',
    group: 'semantic',
    kind: 'file',
    title: 'meeting-notes-17-sep.md',
    citation: '~/notes/meeting-notes-17-sep.md:42',
    line: 42,
    relevance: 0.81,
    fileKind: 'document',
  },
  {
    id: 'lab4-costs',
    group: 'semantic',
    kind: 'file',
    title: 'lab4-costs.md',
    citation: '/home/alice/shared/lab4-costs.md:7',
    line: 7,
    relevance: 0.67,
    owner: 'alice',
    fileKind: 'document',
  },
  {
    id: 'app-files',
    group: 'apps',
    kind: 'app',
    title: 'Files',
    app: 'files',
    running: true,
    meta: 'Application',
  },
  {
    id: 'app-editor',
    group: 'apps',
    kind: 'app',
    title: 'Editor',
    app: 'editor',
    meta: 'Application',
  },
  {
    id: 'cmd-ai',
    group: 'commands',
    kind: 'command',
    title: 'ai "summarise budget report"',
    meta: 'Ask the AI agent · Terminal',
  },
  {
    id: 'cmd-semsearch',
    group: 'commands',
    kind: 'command',
    title: 'semsearch budget',
    meta: 'Semantic search in shell',
  },
];

export const SEARCH_STATS: SearchStats = { count: 8, ms: 38, source: 'local index' };

export const SEARCH_PREVIEWS: Readonly<Record<string, SearchPreview>> = {
  'os-report': {
    resultId: 'os-report',
    state: 'ready',
    title: 'os-report.md',
    meta: 'Markdown · 12 KB · owner student · modified 18 Sep 16:20',
    lines: [
      { n: 1, text: '# OS Report — Week 38', style: 'h1' },
      { n: 2, text: 'Team 07 · Section B · compiled by student', style: 'muted' },
      { n: 3, text: '' },
      {
        n: 4,
        text: 'The scheduler now ages background jobs every 250 ms; ai.indexer (pid 23) runs at priority 32.',
      },
      { style: 'gap' },
      { n: 12, text: '## Budget', style: 'h2' },
      { n: 13, text: '' },
      {
        n: 14,
        text: 'The weekly budget report shows compute spend of $3.20 for last week, against the $50 monthly cap.',
        highlight: true,
      },
      { n: 15, text: '' },
      {
        n: 16,
        style: 'table',
        cells: [
          ['Item', 'Cost'],
          ['LLM gateway', '$3.20'],
          ['Storage', '$0.00'],
          ['CI minutes', '$0.00'],
        ],
      },
      { n: 21, text: 'Next: re-run the RAG benchmark over 10k chunks.' },
    ],
  },
  'budget-csv': {
    resultId: 'budget-csv',
    state: 'ready',
    title: 'budget-2026-w38.csv',
    meta: 'CSV · 2 KB · owner student · modified 20 Sep 09:12',
    lines: [
      { n: 1, text: 'week,item,cost_usd', style: 'muted' },
      { n: 12, text: '38,storage,0.00' },
      { n: 13, text: '38,ci_minutes,0.00' },
      { n: 14, text: '38,llm_gateway,3.20', highlight: true },
    ],
  },
  'lab4-costs': {
    resultId: 'lab4-costs',
    state: 'unavailable',
    title: 'lab4-costs.md',
    message: 'You do not have permission to read this file · EACCES',
  },
  'app-files': {
    resultId: 'app-files',
    state: 'ready',
    title: 'Files',
    meta: 'Application · running',
    description: 'Browse, search and share the files in your home and in /home/shared.',
  },
  'cmd-ai': {
    resultId: 'cmd-ai',
    state: 'ready',
    title: 'ai',
    meta: 'Command · agentic shell',
    description: 'Ask the AI agent to plan and run file operations in a new Terminal window.',
    syntax: 'ai "summarise budget report"',
    note: 'The agent will show a plan before changing anything.',
  },
};
