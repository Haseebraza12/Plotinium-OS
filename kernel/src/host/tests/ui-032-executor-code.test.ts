/**
 * UI-032: the executor transport tells `sched` when executor 1's code has downloaded (its first
 * message), so the `sched` budget covers only the ABI hello; a worker that errors first rejects.
 */
import { describe, expect, it } from 'vitest';

import { ABI_VERSION, abiDigest } from '@plotinium/protocol';

import { WorkerExecutorTransport } from '../executors.ts';

/** A stand-in for a module Worker: the test plays its messages and errors. */
class FakeWorker extends EventTarget {
  readonly posted: unknown[] = [];
  terminated = false;

  postMessage(m: unknown): void {
    this.posted.push(m);
  }

  terminate(): void {
    this.terminated = true;
  }

  say(data: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data }));
  }

  fail(message: string): void {
    const ev = new Event('error') as Event & { message: string };
    Object.defineProperty(ev, 'message', { value: message });
    this.dispatchEvent(ev);
  }
}

function transport(): { t: WorkerExecutorTransport; workers: FakeWorker[] } {
  const workers: FakeWorker[] = [];
  const t = new WorkerExecutorTransport(false, () => {
    const w = new FakeWorker();
    workers.push(w);
    return w as unknown as Worker;
  });
  t.connect(
    () => undefined,
    () => undefined,
  );
  return { t, workers };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('UI-032 executor code download signal', () => {
  it('UI-032 codeLoaded resolves at the entry’s booting message, before the ABI hello', async () => {
    const { t, workers } = transport();
    const started = t.start(0);
    let code = false;
    void t.codeLoaded(0).then(() => {
      code = true;
    });
    const w = workers[0] as FakeWorker;
    await tick();
    expect(code).toBe(false);
    w.say({ t: 'booting' });
    await tick();
    expect(code).toBe(true);
    let up = false;
    void started.then(() => {
      up = true;
    });
    await tick();
    expect(up).toBe(false);
    w.say({ t: 'hello', abi: ABI_VERSION, digest: abiDigest() });
    await started;
    expect(t.alive(0)).toBe(true);
  });

  it('UI-032 a bundle without a booting message counts its hello as the end of the download', async () => {
    const { t, workers } = transport();
    const started = t.start(0);
    const w = workers[0] as FakeWorker;
    w.say({ t: 'hello', abi: ABI_VERSION, digest: abiDigest() });
    await expect(t.codeLoaded(0)).resolves.toBeUndefined();
    await started;
  });

  it('UI-032 a worker that fails to load rejects codeLoaded, so sched fails at once', async () => {
    const { t, workers } = transport();
    const started = t.start(0);
    const code = t.codeLoaded(0);
    (workers[0] as FakeWorker).fail('404 executor.worker.js');
    await expect(started).rejects.toThrow('executor 0: 404 executor.worker.js');
    await expect(code).rejects.toThrow('executor 0: 404 executor.worker.js');
  });
});
