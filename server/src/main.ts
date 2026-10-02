/**
 * Process entry (backend-api.md §3.18.2): configuration -> self-tests -> buildApp -> listen ->
 * ready; signal handlers (§3.17).
 *
 *   exit 78  invalid or unsafe configuration (the problems name variables, never values)
 *   exit 70  a self-test failed (Argon2id or SHA-256 known answer, blob store, database checks)
 *
 * Run from source with Node 24 type stripping: `node server/src/main.ts` (the app image runs it
 * from server/docker-entrypoint.sh after dbmate and the demo seed).
 */
import { buildApp } from './app.ts';
import { ConfigError, parseConfig } from './config.ts';
import { createDatabase } from './db/client.ts';
import { createLogger } from './obs/logger.ts';
import { createMetrics, startMetricsServer } from './obs/metrics.ts';
import { runDbChecks, newestMigrationIn } from './selftest/db-checks.ts';
import { argon2KnownAnswer, SelfTestError, sha256KnownAnswer } from './selftest/kat.ts';
import { createShutdownHandler } from './shutdown.ts';
import { FsBlobStore } from './storage/fs-blobstore.ts';

const EX_SOFTWARE = 70;
const EX_CONFIG = 78;

async function main(): Promise<void> {
  let config;
  try {
    config = parseConfig(process.env);
  } catch (e) {
    if (e instanceof ConfigError) {
      process.stderr.write(
        `${JSON.stringify({ level: 'fatal', msg: 'invalid configuration', problems: e.problems })}\n`,
      );
      process.exit(EX_CONFIG);
    }
    throw e;
  }
  const logger = createLogger(config);
  const fail = (test: string, err: unknown): never => {
    logger.fatal(
      { test, err: err instanceof Error ? err.message : String(err) },
      `self-test failed: ${test}`,
    );
    logger.flush();
    process.exit(EX_SOFTWARE);
  };

  // Self-tests (SRV-17)
  try {
    sha256KnownAnswer();
    await argon2KnownAnswer();
  } catch (e) {
    fail(e instanceof SelfTestError ? e.test : 'kat', e);
  }
  const blobStore = new FsBlobStore(config.blobDir);
  try {
    await blobStore.probe();
  } catch (e) {
    fail('blobstore-probe', e);
  }
  const expectedMigration = newestMigrationIn(config.migrationsDir);
  const database =
    config.database === null
      ? null
      : createDatabase(config.database, {
          onIdleError: (err) => logger.warn({ err }, 'idle database client error'),
        });
  if (database === null) {
    logger.warn(
      'DATABASE_URL is not set: running without a database (routes that need it answer 5xx)',
    );
  } else {
    try {
      const r = await runDbChecks(database, expectedMigration);
      for (const w of r.warnings) logger.warn(w);
      logger.info(
        { migrations: r.appliedMigration, server: r.serverVersionNum },
        'database checks passed',
      );
    } catch (e) {
      await database.close();
      fail('db-checks', e);
    }
  }
  logger.info(
    { env: config.env, ai: config.ai, faultInjection: config.faultInjection },
    'self-tests passed',
  );

  const metrics = createMetrics();
  const built = await buildApp(config, { database, blobStore, logger, metrics, expectedMigration });
  const metricsServer = await startMetricsServer(metrics, config.metrics.host, config.metrics.port);
  await built.app.listen({ host: config.host, port: config.port });
  built.readiness.markReady();
  logger.info({ host: config.host, port: config.port, build: config.build }, 'ready');

  const onSignal = createShutdownHandler({
    graceMs: config.shutdownGraceMs,
    drain: () => built.readiness.markDraining(),
    close: async () => {
      // Step 2 (backend-api.md §3.17): each socket finishes its running op, then gets
      // `bye restart` / 1012; leases stay in the table for clients that reconnect within the TTL.
      await built.drainSockets(Math.floor(config.shutdownGraceMs / 2));
      await built.app.close();
      if (database !== null) await database.close();
      await new Promise<void>((resolve) => metricsServer.close(() => resolve()));
      logger.flush();
    },
    exit: (code) => process.exit(code),
    log: (msg, fields) => logger.info(fields ?? {}, msg),
  });
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
}

main().catch((e: unknown) => {
  process.stderr.write(
    `${JSON.stringify({ level: 'fatal', msg: 'startup failed', err: String(e) })}\n`,
  );
  process.exit(EX_SOFTWARE);
});
