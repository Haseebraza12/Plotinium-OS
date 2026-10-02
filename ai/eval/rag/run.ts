/**
 * `pnpm eval:rag`: RAG-04 Recall@5 and MRR through the ai/src pipeline, plus the RAG-03 leak check.
 *
 *   node ai/eval/rag/run.ts [options]
 *
 *   --embedder none|recorded|hashing|model|model-fallback
 *                                      none (default): the model is unavailable, BM25 only (the
 *                                      baseline); recorded: vectors from --vectors; hashing: the
 *                                      lexical plumbing stand-in (not a model); model: the REAL
 *                                      pinned MongoDB/mdbr-leaf-ir q8 in Node (onnxruntime-node,
 *                                      web/public/models from fetch-models.ts); model-fallback:
 *                                      Xenova/bge-small-en-v1.5 q8 the same way
 *   --vectors FILE                     recorded vectors (vectors.jsonl), with --embedder recorded
 *   --record FILE                      write every vector of this run to FILE (vectors.jsonl), so
 *                                      CI can replay it with --embedder recorded
 *   --threads N                        ONNX Runtime threads for --embedder model (default 1)
 *   --compare LABEL=FILE               add another run's EvalReport JSON to the report's
 *                                      comparison table (repeatable)
 *   --model-key KEY                    model key of the recorded vectors
 *   --hybrid                           fuse vector and BM25 rankings with RRF
 *   --mode auto|semantic|keyword       requested mode (default auto)
 *   --json FILE                        write the EvalReport JSON (ai-safety-and-evaluation.md §4.1)
 *   --report FILE                      write the Markdown report
 *   --version V --machine M --date YYYY-MM-DD   report metadata
 *   --gate                             exit 1 when RAG-04 fails (leaks always exit 1)
 *
 * Paths given on the command line are relative to the current directory.
 */
import type { RequestedMode } from '../../src/search/hybrid.ts';
import { loadCorpus } from './corpus.ts';
import {
  type EvalEmbedder,
  hashingEmbedder,
  parseRecordedVectors,
  recordedEmbedder,
} from './embedders.ts';
import { evaluateRag } from './evaluate.ts';
import { recordingEmbedder, transformersEmbedder } from './model-embedder.ts';
import { nodeHost, nodeProcess, ragDir } from './host.ts';
import {
  type ComparedRun,
  type RunMeta,
  comparedRun,
  renderMarkdown,
  toEvalReport,
} from './report.ts';

type EmbedderName = 'none' | 'recorded' | 'hashing' | 'model' | 'model-fallback';

interface Args {
  embedder: EmbedderName;
  vectors?: string;
  record?: string;
  threads: number;
  compare: Array<{ label: string; file: string }>;
  modelKey?: string;
  hybrid: boolean;
  mode: RequestedMode;
  json?: string;
  report?: string;
  version: string;
  machine: string;
  date: string;
  gate: boolean;
}

const USAGE =
  'usage: node ai/eval/rag/run.ts [--embedder none|recorded|hashing|model|model-fallback] [--vectors FILE] [--record FILE] [--threads N] [--compare LABEL=FILE] [--model-key KEY] [--hybrid] [--mode auto|semantic|keyword] [--json FILE] [--report FILE] [--version V] [--machine M] [--date YYYY-MM-DD] [--gate]';

function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    embedder: 'none',
    threads: 1,
    compare: [],
    hybrid: false,
    mode: 'auto',
    version: 'dev',
    machine: 'local',
    date: new Date().toISOString().slice(0, 10),
    gate: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i] ?? '';
    const value = (): string => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value\n${USAGE}`);
      return v;
    };
    switch (flag) {
      case '--embedder': {
        const v = value();
        if (
          v !== 'none' &&
          v !== 'recorded' &&
          v !== 'hashing' &&
          v !== 'model' &&
          v !== 'model-fallback'
        )
          throw new Error(`unknown embedder ${v}`);
        args.embedder = v;
        break;
      }
      case '--record':
        args.record = value();
        break;
      case '--compare': {
        const v = value();
        const eq = v.indexOf('=');
        if (eq <= 0) throw new Error('--compare needs LABEL=FILE');
        args.compare.push({ label: v.slice(0, eq), file: v.slice(eq + 1) });
        break;
      }
      case '--threads': {
        const n = Number(value());
        if (!Number.isInteger(n) || n < 1 || n > 16) throw new Error('--threads must be 1..16');
        args.threads = n;
        break;
      }
      case '--mode': {
        const v = value();
        if (v !== 'auto' && v !== 'semantic' && v !== 'keyword')
          throw new Error(`unknown mode ${v}`);
        args.mode = v;
        break;
      }
      case '--vectors':
        args.vectors = value();
        break;
      case '--model-key':
        args.modelKey = value();
        break;
      case '--hybrid':
        args.hybrid = true;
        break;
      case '--json':
        args.json = value();
        break;
      case '--report':
        args.report = value();
        break;
      case '--version':
        args.version = value();
        break;
      case '--machine':
        args.machine = value();
        break;
      case '--date': {
        const v = value();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error('--date must be YYYY-MM-DD');
        args.date = v;
        break;
      }
      case '--gate':
        args.gate = true;
        break;
      default:
        throw new Error(`unknown option ${flag}\n${USAGE}`);
    }
  }
  return args;
}

async function main(): Promise<number> {
  const proc = nodeProcess();
  const argv = proc.argv.slice(2);
  if (argv.includes('--help')) {
    console.log(USAGE);
    return 0;
  }
  const args = parseArgs(argv);
  const host = nodeHost();
  const corpus = await loadCorpus(host, ragDir());

  let embedder: EvalEmbedder | undefined;
  if (args.embedder === 'hashing') embedder = hashingEmbedder();
  if (args.embedder === 'recorded') {
    if (args.vectors === undefined || args.modelKey === undefined)
      throw new Error('--embedder recorded needs --vectors FILE and --model-key KEY');
    embedder = recordedEmbedder(
      args.modelKey,
      parseRecordedVectors(host.readText(args.vectors), args.vectors),
    );
  }

  if (args.embedder === 'model' || args.embedder === 'model-fallback') {
    const real = await transformersEmbedder(args.embedder === 'model' ? 'primary' : 'fallback', {
      threads: args.threads,
    });
    console.log(`model ${real.modelKey} loaded in ${(real.loadMs / 1000).toFixed(1)} s`);
    embedder = real;
  }
  const recorder =
    args.record === undefined || embedder === undefined ? undefined : recordingEmbedder(embedder);
  if (recorder !== undefined) embedder = recorder;

  const started = performance.now();
  const ev = await evaluateRag(corpus, {
    ...(embedder === undefined ? {} : { embedder }),
    hybrid: args.hybrid,
    requested: args.mode,
  });
  const seconds = (performance.now() - started) / 1000;

  const quote = (a: string): string => (/[\s()',]/.test(a) ? `'${a.replace(/'/g, "'\\''")}'` : a);
  const command = [
    'node ai/eval/rag/run.ts',
    ...argv.filter((a) => a !== '--gate').map(quote),
  ].join(' ');
  const comparison: ComparedRun[] = args.compare.map((c) =>
    comparedRun(c.label, c.file, JSON.parse(host.readText(c.file)) as unknown),
  );
  const meta: RunMeta = {
    version: args.version,
    date: args.date,
    machine: args.machine,
    command,
    comparison,
  };
  const a = ev.aggregate;
  console.log(
    `${ev.fixtures}: ${ev.documents} documents, ${ev.index.chunks} chunks, ${a.queries} queries as ${ev.queryUser}`,
  );
  console.log(
    `embedder: ${ev.embedder?.name ?? 'none (keyword fallback)'}; modes: ${JSON.stringify(ev.modes)}`,
  );
  console.log(
    `Recall@5 ${a.recallAt5.value.toFixed(3)} [${a.recallAt5.ci95.map((x) => x.toFixed(3)).join(', ')}]  ` +
      `MRR ${a.mrr.value.toFixed(3)}  nDCG@10 ${a.ndcg10.value.toFixed(3)}  (${seconds.toFixed(1)} s)`,
  );
  for (const c of ev.leakChecks)
    console.log(
      `RAG-03 ${c.user}: ${c.searches} searches, ${c.results} results, ${c.leaks.length} leaks`,
    );
  for (const g of ev.gates) console.log(`${g.pass ? 'PASS' : 'FAIL'} ${g.id} ${g.target}`);

  if (recorder !== undefined && args.record !== undefined) {
    const lines = recorder.lines();
    host.writeText(args.record, `${lines.join('\n')}\n`);
    console.log(
      `recorded ${String(lines.length)} vectors to ${args.record} (replay: --embedder recorded --vectors ${args.record} --model-key ${recorder.modelKey})`,
    );
  }
  if (args.json !== undefined)
    host.writeText(args.json, `${JSON.stringify(toEvalReport(ev, meta), null, 2)}\n`);
  if (args.report !== undefined) host.writeText(args.report, renderMarkdown(ev, corpus, meta));

  if (ev.leaks.length > 0) {
    for (const l of ev.leaks) console.error(`LEAK ${l.user} ${l.queryId} ${l.path}`);
    return 1;
  }
  return args.gate && ev.gates.some((g) => !g.pass) ? 1 : 0;
}

try {
  nodeProcess().exitCode = await main();
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  nodeProcess().exitCode = 2;
}
