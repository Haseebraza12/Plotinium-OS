/**
 * GET /api/healthz and GET /api/readyz (backend-api.md §3.16, §3.17, §4.3; SRV-15, SRV-16, SRV-17).
 *
 * healthz: 200 {status: 'ok'} whenever the process runs, no database call (liveness; the
 *          client's offline probe).
 * readyz:  200 only when startup is complete, the database answers SELECT 1 within 1 s, the
 *          applied migration version is at least the build's newest, the blob store is writable
 *          and the blob volume has free space; otherwise 503 with status starting, draining or
 *          degraded and the failing checks. Cached for 2 s. The compose healthcheck (so that
 *          `docker compose up -d --wait` returns only when the app is ready) and UptimeRobot use it.
 */
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';

import type { Config } from '../config.ts';
import type { Database } from '../db/client.ts';
import type { Metrics } from './metrics.ts';

export type CheckState = 'ok' | 'fail' | 'skipped';

export interface Readiness {
  status: 'ready' | 'starting' | 'draining' | 'degraded';
  build: { name: 'Plotinium'; version: string; build: string; date: string };
  migrations: { version: string | null; expected: string | null };
  checks: { db: CheckState; migrations: CheckState; blobStore: CheckState; disk: CheckState };
  ai: { enabled: boolean; llm: 'available' | 'no-key' | 'disabled' };
  /** False whenever PLOTINIUM_ENV=production (quality-devops cross-spec request). */
  faultInjection: boolean;
}

export interface ReadinessProbeTargets {
  readonly db: Database | null;
  /** Newest migration version shipped with this build (from db/migrations), or null if unknown. */
  readonly expectedMigration: string | null;
  readonly blobStore: {
    probe(): Promise<void>;
    diskFree(): Promise<{ freeBytes: number; totalBytes: number }>;
  } | null;
  readonly metrics?: Metrics;
  /** The LLM gateway's own state (replay mode needs no key); absent: derived from the key. */
  readonly llmState?: () => 'available' | 'no-key';
}

/** Minimum free space on the blob volume for readiness (the disk check the ops spec asked for). */
export const MIN_FREE_FRACTION = 0.05;
const DB_TIMEOUT_MS = 1_000;
const CACHE_MS = 2_000;

export class ReadinessState {
  #phase: 'starting' | 'ready' | 'draining' = 'starting';
  #cached: { at: number; value: Readiness } | undefined;
  readonly #config: Config;
  readonly #targets: ReadinessProbeTargets;
  readonly #now: () => number;

  constructor(config: Config, targets: ReadinessProbeTargets, now: () => number = Date.now) {
    this.#config = config;
    this.#targets = targets;
    this.#now = now;
  }

  get phase(): 'starting' | 'ready' | 'draining' {
    return this.#phase;
  }

  markReady(): void {
    if (this.#phase === 'starting') this.#phase = 'ready';
    this.#cached = undefined;
  }

  markDraining(): void {
    this.#phase = 'draining';
    this.#cached = undefined;
  }

  async evaluate(): Promise<Readiness> {
    const now = this.#now();
    if (this.#cached !== undefined && now - this.#cached.at < CACHE_MS) return this.#cached.value;
    const value = await this.#compute();
    this.#cached = { at: now, value };
    return value;
  }

  async #compute(): Promise<Readiness> {
    const cfg = this.#config;
    const checks: Readiness['checks'] = {
      db: 'skipped',
      migrations: 'skipped',
      blobStore: 'skipped',
      disk: 'skipped',
    };
    let applied: string | null = null;

    const db = this.#targets.db;
    if (db !== null) {
      try {
        applied = await withTimeout(newestAppliedMigration(db), DB_TIMEOUT_MS);
        checks.db = 'ok';
        const expected = this.#targets.expectedMigration;
        checks.migrations =
          expected === null || (applied !== null && applied >= expected) ? 'ok' : 'fail';
      } catch {
        checks.db = 'fail';
        checks.migrations = 'fail';
      }
    }
    const store = this.#targets.blobStore;
    if (store !== null) {
      try {
        await store.probe();
        checks.blobStore = 'ok';
      } catch {
        checks.blobStore = 'fail';
      }
      try {
        const { freeBytes, totalBytes } = await store.diskFree();
        this.#targets.metrics?.diskFree.set({ volume: 'blobs' }, freeBytes);
        checks.disk =
          totalBytes === 0 || freeBytes / totalBytes >= MIN_FREE_FRACTION ? 'ok' : 'fail';
      } catch {
        checks.disk = 'fail';
      }
    }
    const allOk = Object.values(checks).every((c) => c !== 'fail');
    const status: Readiness['status'] =
      this.#phase === 'draining'
        ? 'draining'
        : this.#phase === 'starting'
          ? 'starting'
          : allOk
            ? 'ready'
            : 'degraded';
    return {
      status,
      build: {
        name: 'Plotinium',
        version: cfg.build.version,
        build: cfg.build.sha,
        date: cfg.build.date,
      },
      migrations: { version: applied, expected: this.#targets.expectedMigration },
      checks,
      ai: {
        enabled: cfg.ai,
        llm: !cfg.ai
          ? 'disabled'
          : (this.#targets.llmState?.() ?? (cfg.llm.apiKey === undefined ? 'no-key' : 'available')),
      },
      faultInjection: cfg.faultInjection && cfg.env !== 'production',
    };
  }
}

/** The newest version in schema_migrations (dbmate), or null when the table is empty. */
export async function newestAppliedMigration(database: Database): Promise<string | null> {
  const r = await sql<{
    version: string | null;
  }>`SELECT max(version) AS version FROM schema_migrations`.execute(database.db);
  return r.rows[0]?.version ?? null;
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function registerHealthRoutes(app: FastifyInstance, readiness: ReadinessState): void {
  app.get('/api/healthz', { config: { rateClass: 'health', auth: 'public' } }, (_request, reply) =>
    reply.send({ status: 'ok' }),
  );
  app.get(
    '/api/readyz',
    { config: { rateClass: 'health', auth: 'public' } },
    async (_req, reply) => {
      const r = await readiness.evaluate();
      return reply.code(r.status === 'ready' ? 200 : 503).send(r);
    },
  );
}
