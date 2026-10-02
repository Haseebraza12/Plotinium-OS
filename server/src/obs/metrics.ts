/**
 * prom-client metrics (C9, SRV-15; backend-api.md §3.16). Served on an INTERNAL listener only
 * (METRICS_HOST:METRICS_PORT, default 127.0.0.1:9464); Caddy never routes /metrics.
 * One Registry per app instance, so tests can build several apps in one process.
 * Plugins register their own metrics on `registry` when they are implemented.
 */
import { createServer, type Server } from 'node:http';

import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';

export interface Metrics {
  readonly registry: Registry;
  readonly httpRequests: Counter<'route' | 'method' | 'status'>;
  readonly httpDuration: Histogram<'route' | 'method' | 'status'>;
  readonly rateLimited: Counter<'class'>;
  readonly diskFree: Gauge<'volume'>;
  readonly dbTxRetries: Counter<'sqlstate'>;
  readonly authLogins: Counter<'result'>;
  readonly argon2Seconds: Histogram;
  readonly authRevocations: Counter<'reason'>;
  readonly wsConnections: Gauge;
  readonly wsCloses: Counter<'code'>;
  readonly blobBytes: Counter<'dir'>;
  readonly swapBytes: Counter<'dir'>;
  readonly llmRequests: Counter<'model' | 'status'>;
  readonly llmTokens: Counter<'kind'>;
  readonly llmCostUsd: Counter<'model'>;
  readonly llmLatency: Histogram<'model'>;
  readonly llmBudgetRatio: Gauge<'scope'>;
  readonly jobRuns: Counter<'job' | 'result'>;
}

export function createMetrics(options: { defaultMetrics?: boolean } = {}): Metrics {
  const registry = new Registry();
  if (options.defaultMetrics !== false) collectDefaultMetrics({ register: registry });
  return {
    registry,
    httpRequests: new Counter({
      name: 'plotinium_http_requests_total',
      help: 'HTTP requests by route, method and status',
      labelNames: ['route', 'method', 'status'],
      registers: [registry],
    }),
    httpDuration: new Histogram({
      name: 'plotinium_http_request_duration_seconds',
      help: 'HTTP request duration',
      labelNames: ['route', 'method', 'status'],
      buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [registry],
    }),
    rateLimited: new Counter({
      name: 'plotinium_rate_limited_total',
      help: 'Requests or frames denied by the token-bucket limiter',
      labelNames: ['class'],
      registers: [registry],
    }),
    diskFree: new Gauge({
      name: 'plotinium_disk_free_bytes',
      help: 'Free bytes on a volume',
      labelNames: ['volume'],
      registers: [registry],
    }),
    dbTxRetries: new Counter({
      name: 'plotinium_db_tx_retries_total',
      help: 'vfsTxn retries by SQLSTATE (or lockset)',
      labelNames: ['sqlstate'],
      registers: [registry],
    }),
    authLogins: new Counter({
      name: 'plotinium_auth_logins_total',
      help: 'Login and guest-login attempts by result',
      labelNames: ['result'],
      registers: [registry],
    }),
    argon2Seconds: new Histogram({
      name: 'plotinium_argon2_seconds',
      help: 'Argon2id hash or verification time, including the wait for the semaphore',
      buckets: [0.01, 0.025, 0.05, 0.075, 0.1, 0.15, 0.25, 0.5, 1, 2.5],
      registers: [registry],
    }),
    authRevocations: new Counter({
      name: 'plotinium_auth_revocations_total',
      help: 'Auth sessions revoked, by reason',
      labelNames: ['reason'],
      registers: [registry],
    }),
    wsConnections: new Gauge({
      name: 'plotinium_ws_connections',
      help: 'Open /ws sockets',
      registers: [registry],
    }),
    wsCloses: new Counter({
      name: 'plotinium_ws_closes_total',
      help: '/ws closes by close code',
      labelNames: ['code'],
      registers: [registry],
    }),
    blobBytes: new Counter({
      name: 'plotinium_blob_bytes_total',
      help: 'Content blob bytes uploaded (in) and served (out)',
      labelNames: ['dir'],
      registers: [registry],
    }),
    swapBytes: new Counter({
      name: 'plotinium_swap_bytes_total',
      help: 'Remote swap bytes paged out (out) and paged in (in), compressed',
      labelNames: ['dir'],
      registers: [registry],
    }),
    llmRequests: new Counter({
      name: 'plotinium_llm_requests_total',
      help: 'LLM provider calls by served model and settlement status',
      labelNames: ['model', 'status'],
      registers: [registry],
    }),
    llmTokens: new Counter({
      name: 'plotinium_llm_tokens_total',
      help: 'LLM tokens by kind (input, output, cache_read, cache_write)',
      labelNames: ['kind'],
      registers: [registry],
    }),
    llmCostUsd: new Counter({
      name: 'plotinium_llm_cost_usd_total',
      help: 'LLM cost charged, in US dollars',
      labelNames: ['model'],
      registers: [registry],
    }),
    llmLatency: new Histogram({
      name: 'plotinium_llm_latency_seconds',
      help: 'LLM provider call latency',
      labelNames: ['model'],
      buckets: [0.25, 0.5, 1, 2, 4, 8, 16, 32, 64],
      registers: [registry],
    }),
    llmBudgetRatio: new Gauge({
      name: 'plotinium_llm_budget_used_ratio',
      help: 'Share of an LLM budget cap used (spent + reserved) / limit',
      labelNames: ['scope'],
      registers: [registry],
    }),
    jobRuns: new Counter({
      name: 'plotinium_job_runs_total',
      help: 'Background job runs by job and result',
      labelNames: ['job', 'result'],
      registers: [registry],
    }),
  };
}

/** Starts the internal metrics listener. GET /metrics only; everything else 404. */
export async function startMetricsServer(
  metrics: Metrics,
  host: string,
  port: number,
): Promise<Server> {
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/metrics') {
      metrics.registry
        .metrics()
        .then((body) => {
          res.writeHead(200, { 'content-type': metrics.registry.contentType });
          res.end(body);
        })
        .catch(() => {
          res.writeHead(500);
          res.end();
        });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  return server;
}
