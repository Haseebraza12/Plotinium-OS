/**
 * @plotinium/server: the Fastify 5 modular monolith (specs/11-server/backend-api.md).
 * Primary owner R2 VFS/DB (sync, locks, vfsTxn); see server/README.md for the plugin owners.
 * The process entry is main.ts; the first-start seed is seed.ts. Tests and tools build the app
 * in-process with buildApp(config, deps) and drive it with app.inject().
 */
export { buildApp, type AppDeps, type PlotiniumApp } from './app.ts';
export { ConfigError, parseConfig, type Config } from './config.ts';

export const PACKAGE_NAME = '@plotinium/server';
