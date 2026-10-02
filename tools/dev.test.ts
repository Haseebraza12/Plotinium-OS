import { describe, expect, it } from 'vitest';

import { logsCommand } from './creds.ts';
import { backendCommand, parseDevOptions, viteEnv } from './dev.ts';

describe('tools/dev.ts (pnpm dev)', () => {
  it('OPS-02 defaults: Vite on 5173, API on loopback 4780, APP_ORIGIN port 4717, backend built', () => {
    const options = parseDevOptions([], {});
    expect(options).toEqual({
      skipBackend: false,
      build: true,
      apiPort: 4780,
      devPort: 5173,
      appPort: 4717,
      project: undefined,
    });
    expect(backendCommand(options)).toEqual([
      'compose',
      '-f',
      'compose.yaml',
      '-f',
      'tools/compose.dev.yaml',
      'up',
      '-d',
      '--wait',
      '--build',
      'db',
      'app',
    ]);
  });

  it('OPS-02 starts only db and app: the web (Caddy) container is neither started nor stopped', () => {
    const args = backendCommand(parseDevOptions(['--no-build'], {}));
    expect(args).not.toContain('web');
    expect(args).not.toContain('stop');
    expect(args).not.toContain('--build');
    expect(args.slice(-2)).toEqual(['db', 'app']);
  });

  it('OPS-02 hands Vite the variables web/vite.config.ts reads, keeping the rest of the environment', () => {
    const env = {
      PATH: '/usr/bin',
      PLOTINIUM_PORT: '4800',
      PLOTINIUM_API_PORT: '4801',
      PLOTINIUM_DEV_PORT: '4802',
    };
    const options = parseDevOptions(['--skip-backend'], env);
    expect(options.skipBackend).toBe(true);
    expect(viteEnv(options, env)).toEqual({
      ...env,
      PLOTINIUM_BACKEND: 'http://127.0.0.1:4801',
      // SRV-07: the proxy presents the origin the server was started with, not the dev server's.
      PLOTINIUM_BACKEND_ORIGIN: 'http://localhost:4800',
    });
  });

  it('OPS-02 passes a Compose project name to both the backend and the log reader', () => {
    const options = parseDevOptions([], { PLOTINIUM_PROJECT: 'plt-dev' });
    expect(backendCommand(options).slice(0, 3)).toEqual(['compose', '--project-name', 'plt-dev']);
    expect(logsCommand(options.project).slice(0, 3)).toEqual([
      'compose',
      '--project-name',
      'plt-dev',
    ]);
    expect(logsCommand(undefined)).toEqual([
      'compose',
      'logs',
      '--no-color',
      '--no-log-prefix',
      'app',
    ]);
  });

  it('OPS-02 rejects unknown flags, bad ports and any two equal ports', () => {
    expect(() => parseDevOptions(['--prod'], {})).toThrow(/unknown option --prod/);
    expect(() => parseDevOptions([], { PLOTINIUM_API_PORT: '70000' })).toThrow(/TCP port/);
    expect(() => parseDevOptions([], { PLOTINIUM_DEV_PORT: 'x' })).toThrow(/TCP port/);
    expect(() => parseDevOptions([], { PLOTINIUM_API_PORT: '4717' })).toThrow(/must differ/);
    expect(() => parseDevOptions([], { PLOTINIUM_DEV_PORT: '4780' })).toThrow(/must differ/);
    expect(() => parseDevOptions([], { PLOTINIUM_PORT: '5173' })).toThrow(/must differ/);
  });
});
