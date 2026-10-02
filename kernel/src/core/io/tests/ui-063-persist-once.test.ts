/**
 * UI-063: "persistent storage" is logged once per boot. The storage service reports what it found
 * at open; the router's later `navigator.storage.persist()` answer (the `persist` router event)
 * adds a line only when it changes that answer.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { MemStore } from '../../fs/mem-store.ts';
import { DEV_IDENTITY } from '../../host.ts';
import { messageOf } from '../../klog/format.ts';
import { Klog, createKlogRing } from '../../klog/klog.ts';
import { BootRecorder } from '../bootlog.ts';
import { StorageIo } from '../storage.ts';
import type { World } from './world.ts';
import { bootToDesktop } from './world.ts';

const worlds: World[] = [];
afterEach(() => {
  for (const w of worlds.splice(0)) w.close();
});

function persistLines(w: World): string[] {
  return w.lb.kernel.klog
    .read()
    .map((r) => messageOf(r))
    .filter((m) => m.includes('persistent storage'));
}

function storageIo(persisted: boolean | undefined): StorageIo {
  const recorder = new BootRecorder({
    klog: new Klog(createKlogRing(64)),
    identity: DEV_IDENTITY,
    epochAtZero: 0,
    t0: () => 0,
    services: () => null,
    now: () => 0,
  });
  return new StorageIo({
    indexedDB: null,
    storage:
      persisted === undefined
        ? undefined
        : { estimate: () => Promise.resolve({}), persisted: () => Promise.resolve(persisted) },
    store: new MemStore(),
    recorder,
    flags: () => [],
    verbose: false,
  });
}

describe('UI-063 one persistent-storage line per boot', () => {
  it('UI-063 a router answer that repeats what open() reported adds no line; a change adds one', async () => {
    const s = storageIo(false);
    expect(s.notePersist(false)).toBeNull(); // before open: kept, reported by the service
    const o = await s.open('normal');
    expect(o.persisted).toBe(false);
    expect(s.notePersist(false)).toBeNull();
    expect(s.notePersist(false)).toBeNull();
    expect(s.notePersist(true)).toEqual({ level: 'info', msg: 'persistent storage granted' });
    expect(s.notePersist(true)).toBeNull();
  });

  it('UI-063 the router answer that arrives before open() is what open() reports', async () => {
    const s = storageIo(undefined);
    expect(s.notePersist(true)).toBeNull();
    const o = await s.open('normal');
    expect(o.persisted).toBe(true);
    expect(s.notePersist(true)).toBeNull();
  });

  it('UI-063 an unknown answer at open is logged once when the router learns it', async () => {
    const s = storageIo(undefined);
    const o = await s.open('normal');
    expect(o.persisted).toBeNull();
    expect(s.notePersist(false)?.level).toBe('warn');
    expect(s.notePersist(false)).toBeNull();
  });

  it('UI-063 a whole boot with two persist events logs exactly one line', async () => {
    const w = await bootToDesktop();
    worlds.push(w);
    w.io.router({ t: 'persist', persisted: false });
    w.io.router({ t: 'persist', persisted: false });
    const lines = persistLines(w);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/persistent storage not granted/);
  });
});
