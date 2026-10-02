/**
 * The bring-up plan, Compose calls and credential resolution of the Demo Day suite (spec §17.1;
 * deployment-and-ci §3.6; C10). The runner is a fake, so no Docker is needed.
 */
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { Env } from '../../support/env.ts';
import { REPO_ROOT, type RunResult } from '../../support/stack.ts';

import {
  bringupPlan,
  compose,
  composeEnv,
  composeRecentEnough,
  projectName,
  resolveUser,
  type EnvRunner,
  type RunOptions,
} from './compose.ts';

interface Call {
  cmd: string;
  args: readonly string[];
  opts: RunOptions;
}

function fakeRunner(reply: (args: readonly string[]) => RunResult): {
  runner: EnvRunner;
  calls: Call[];
} {
  const calls: Call[] = [];
  const runner: EnvRunner = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return Promise.resolve(reply(args));
  };
  return { runner, calls };
}

const OK = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '' });

const LOGS = [
  '==============================================================================',
  '  FIRST-START CREDENTIALS (shown once)',
  '  Generated for this stack only; stored as Argon2id hashes; printed nowhere else.',
  '==============================================================================',
  '  root    FAKEROOTFAKEROOTFAKE   (su only: root has no greeter login)',
  '  demo    FAKEDEMOFAKEDEMOFAKE',
  '==============================================================================',
]
  .map((l) => `app-1  | ${l}`)
  .join('\n');

describe('bring-up plan', () => {
  it('OPS-05 without a repository the working tree is used, the run is not scored and it is still three commands', () => {
    const plan = bringupPlan({}, '/tmp/w');
    expect(plan.clone).toBeNull();
    expect(plan.cwd).toBe(REPO_ROOT);
    expect(plan.up).toEqual(['compose', 'up', '-d', '--wait']);
    expect(plan.scored).toBe(false);
    expect(plan.commands).toHaveLength(3);
    expect(plan.notes.join(' ')).toMatch(/working tree/);
  });

  it('OPS-05 with a repository and a ref the clone is shallow, lands in the work dir and the run is scored', () => {
    const plan = bringupPlan(
      { PLT_BRINGUP_REPO: 'https://github.com/example/plotinium.git', PLT_BRINGUP_REF: 'v1.0.0' },
      '/tmp/w',
    );
    expect(plan.clone).toEqual([
      'clone',
      '--depth',
      '1',
      '--branch',
      'v1.0.0',
      'https://github.com/example/plotinium.git',
      join('/tmp/w', 'plotinium'),
    ]);
    expect(plan.cwd).toBe(join('/tmp/w', 'plotinium'));
    expect(plan.scored).toBe(true);
    expect(plan.commands).toEqual([
      'git clone https://github.com/example/plotinium.git',
      'cd plotinium',
      'docker compose up -d --wait',
    ]);
  });

  it('OPS-05 PLT_BRINGUP_BUILD=1 adds --build and makes the run unscored', () => {
    const plan = bringupPlan(
      { PLT_BRINGUP_REPO: 'https://example.invalid/p.git', PLT_BRINGUP_BUILD: '1' },
      '/w',
    );
    expect(plan.up).toEqual(['compose', 'up', '-d', '--wait', '--build']);
    expect(plan.scored).toBe(false);
    expect(plan.notes.join(' ')).toMatch(/not the scored path/);
  });
});

describe('compose', () => {
  it('OPS-05 composeEnv sets COMPOSE_PROJECT_NAME only when PLT_DEMO_PROJECT is set', () => {
    expect(composeEnv({ PATH: '/bin' })).toEqual({ PATH: '/bin' });
    expect(composeEnv({ PLT_DEMO_PROJECT: 'plt-rehearsal' })['COMPOSE_PROJECT_NAME']).toBe(
      'plt-rehearsal',
    );
    expect(projectName({})).toBe('plotinium');
    expect(projectName({ PLT_DEMO_PROJECT: 'plt-rehearsal' })).toBe('plt-rehearsal');
  });

  it('OPS-05 every docker call carries the project environment and the right argument vector', async () => {
    const { runner, calls } = fakeRunner((args) => {
      if (args[0] === 'volume') return OK('plt-rehearsal_pgdata\nplt-rehearsal_blobs\n');
      if (args[1] === 'version') return OK('Docker Compose version v2.29.7');
      if (args[1] === 'ls') return OK('[{"Name":"other"}]');
      if (args[1] === 'logs') return OK(LOGS);
      return OK();
    });
    const env: Env = { PLT_DEMO_PROJECT: 'plt-rehearsal' };
    const c = compose('/repo', env, runner);
    expect(await c.version()).toEqual([2, 29, 7]);
    expect(await c.projects()).toEqual(['other']);
    expect(await c.volumes()).toEqual(['plt-rehearsal_pgdata', 'plt-rehearsal_blobs']);
    expect(await c.logs('app')).toContain('FIRST-START CREDENTIALS');
    await c.up(['compose', 'up', '-d', '--wait'], 1_000);
    await c.down();
    expect(calls.map((x) => x.args.join(' '))).toEqual([
      'compose version',
      'compose ls --all --format json',
      'volume ls -q --filter label=com.docker.compose.project=plt-rehearsal',
      'compose logs --no-color app',
      'compose up -d --wait',
      'compose down -v',
    ]);
    for (const call of calls) {
      expect(call.cmd).toBe('docker');
      expect(call.opts.cwd).toBe('/repo');
      expect(call.opts.env['COMPOSE_PROJECT_NAME']).toBe('plt-rehearsal');
    }
  });

  it('OPS-05 a failing docker compose ls or logs throws with its stderr', async () => {
    const { runner } = fakeRunner(() => ({
      code: 1,
      stdout: '',
      stderr: 'Cannot connect to the Docker daemon',
    }));
    const c = compose('/repo', {}, runner);
    await expect(c.projects()).rejects.toThrow(/Cannot connect to the Docker daemon/);
    await expect(c.logs('app')).rejects.toThrow(/logs app failed/);
    expect(await c.version()).toBeUndefined();
  });

  it('OPS-05 composeRecentEnough rejects Compose older than 2.24 and a missing Compose', () => {
    expect(composeRecentEnough([2, 24, 0])).toBe(true);
    expect(composeRecentEnough([2, 23, 3])).toBe(false);
    expect(composeRecentEnough(undefined)).toBe(false);
  });
});

describe('credentials', () => {
  const local: Env = { PLOTINIUM_BASE_URL: 'http://localhost:4717' };

  it('OPS-05 resolveUser prefers PLT_TEST_<USER>_PASSWORD over the logs', async () => {
    let read = 0;
    const user = await resolveUser('demo', { ...local, PLT_TEST_DEMO_PASSWORD: 'from-env' }, () => {
      read++;
      return Promise.resolve(LOGS);
    });
    expect(user.password).toBe('from-env');
    expect(read).toBe(0);
  });

  it('OPS-05 on the local stack resolveUser reads the password from the first-start block of docker compose logs app', async () => {
    const user = await resolveUser('demo', local, () => Promise.resolve(LOGS));
    expect(user.username).toBe('demo');
    expect(user.password).toBe('FAKEDEMOFAKEDEMOFAKE');
    const root = await resolveUser('root', local, () => Promise.resolve(LOGS));
    expect(root.password).toBe('FAKEROOTFAKEROOTFAKE');
  });

  it('OPS-05 resolveUser falls back to the fixture password when the logs are unreadable or lack the user', async () => {
    const failing = await resolveUser('alice', local, () => Promise.reject(new Error('no docker')));
    expect(failing.password).toBe('alice-test-only');
    const missing = await resolveUser('bob', local, () => Promise.resolve(LOGS));
    expect(missing.password).toBe('bob-test-only');
  });

  it('OPS-05 resolveUser never reads compose logs for a remote base URL', async () => {
    let read = 0;
    const user = await resolveUser(
      'demo',
      { PLOTINIUM_BASE_URL: 'https://plotinium.example' },
      () => {
        read++;
        return Promise.resolve(LOGS);
      },
    );
    expect(read).toBe(0);
    expect(user.password).toBe('demo-test-only');
  });
});
