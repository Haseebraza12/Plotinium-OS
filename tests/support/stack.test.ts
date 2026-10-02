import { describe, expect, it } from 'vitest';

import {
  assertBackendDown,
  composeArgs,
  execRunner,
  stack,
  stackOptions,
  type Runner,
} from './stack.ts';

function recorder(code = 0, stderr = ''): { runner: Runner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: Runner = (cmd, args) => {
    calls.push([cmd, ...args]);
    return Promise.resolve({ code, stdout: '', stderr });
  };
  return { runner, calls };
}

describe('TST-12 Compose stack control', () => {
  it('TST-12 stop runs docker compose stop for the listed services with every compose file', async () => {
    const { runner, calls } = recorder();
    await stack(
      stackOptions({ PLT_COMPOSE_FILES: 'compose.yaml, compose.test.yaml' }, { runner }),
    ).stop(['app', 'web']);
    expect(calls).toEqual([
      ['docker', 'compose', '-f', 'compose.yaml', '-f', 'compose.test.yaml', 'stop', 'app', 'web'],
    ]);
  });

  it('TST-12 start brings the services back without rebuilding and waits for health', async () => {
    const { runner, calls } = recorder();
    await stack(stackOptions({}, { runner, waitTimeoutS: 90 })).start(['app']);
    expect(calls[0]).toEqual([
      'docker',
      'compose',
      '-f',
      'compose.yaml',
      'up',
      '-d',
      '--wait',
      '--no-build',
      '--no-recreate',
      '--wait-timeout',
      '90',
      'app',
    ]);
  });

  it('TST-12 a failing compose command throws with its stderr', async () => {
    const { runner } = recorder(1, 'no such service: web2\n');
    await expect(stack(stackOptions({}, { runner })).stop(['web'])).rejects.toThrow(
      /failed \(1\): no such service/,
    );
  });

  it('TST-12 an empty service list is refused', () => {
    expect(() => composeArgs({ files: ['compose.yaml'], waitTimeoutS: 1 }, 'stop', [])).toThrow(
      RangeError,
    );
  });

  it('TST-12 the offline gate test fails if the backend is still reachable', async () => {
    const up = () => Promise.resolve({ ok: true, status: 200 });
    await expect(assertBackendDown('http://localhost:4717', up)).rejects.toThrow(/still reachable/);
  });

  it('TST-12 a refused connection or a failing readyz counts as down', async () => {
    const refused = () => Promise.reject(new TypeError('fetch failed'));
    const failing = () => Promise.resolve({ ok: false, status: 502 });
    await expect(assertBackendDown('http://localhost:4717', refused)).resolves.toBeUndefined();
    await expect(assertBackendDown('http://localhost:4717', failing)).resolves.toBeUndefined();
  });

  it('TST-12 the default runner reports the exit code of a real process', async () => {
    const ok = await execRunner(
      process.execPath,
      ['-e', 'process.stdout.write("hi")'],
      process.cwd(),
    );
    const bad = await execRunner(process.execPath, ['-e', 'process.exit(3)'], process.cwd());
    expect(ok).toEqual({ code: 0, stdout: 'hi', stderr: '' });
    expect(bad.code).toBe(3);
  });
});
