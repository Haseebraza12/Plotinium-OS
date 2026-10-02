import { describe, expect, it } from 'vitest';

import { sandboxRealm, SANDBOX_MESSAGE, SHADOWED_GLOBALS } from '../src/runtime/sandbox.ts';

/** A fake worker global with a prototype chain like WorkerGlobalScope's. */
function fakeGlobal() {
  class StorageManager {
    getDirectory(): string {
      return 'opfs';
    }
  }
  const eventTarget = {
    added: [] as string[],
    addEventListener(this: { added: string[] }, type: string): void {
      this.added.push(type);
    },
  };
  const workerScopeProto = Object.create(eventTarget) as Record<string, unknown>;
  workerScopeProto['indexedDB'] = { open: () => 'db' };
  workerScopeProto['fetch'] = () => 'net';
  const navProto = { storage: new StorageManager(), locks: { request: () => 'lock' } };
  const g = Object.create(workerScopeProto) as Record<string, unknown>;
  g['navigator'] = Object.create(navProto) as object;
  g['StorageManager'] = StorageManager;
  g['setTimeout'] = () => 1;
  g['postMessage'] = () => undefined;
  return { g, workerScopeProto, navProto, StorageManager, eventTarget };
}

describe('executor sandbox', () => {
  it('ABI-16 no live accessor for indexedDB, caches, storage, locks, Worker or fetch remains anywhere on the prototype chains', () => {
    const { g, workerScopeProto, navProto, StorageManager } = fakeGlobal();
    const report = sandboxRealm(g);
    expect(report.failed).toEqual([]);
    for (const name of SHADOWED_GLOBALS) {
      expect(() => g[name]).toThrow(SANDBOX_MESSAGE);
    }
    expect(() => workerScopeProto['indexedDB']).toThrow(TypeError);
    const nav = g['navigator'] as Record<string, unknown>;
    expect(() => nav['storage']).toThrow(TypeError);
    expect(() => (navProto as Record<string, unknown>)['locks']).toThrow(TypeError);
    expect(() => new StorageManager().getDirectory()).toThrow(TypeError);
    expect(() => {
      g['fetch'] = () => 'again';
    }).toThrow(TypeError);
    expect(Object.getOwnPropertyDescriptor(g, 'setTimeout')?.configurable).toBe(false);
  });

  it('KPS-04 message listeners are refused after the sandbox while other events still work', () => {
    const { g, eventTarget } = fakeGlobal();
    sandboxRealm(g);
    const add = g['addEventListener'] as (type: string) => void;
    expect(() => add.call(g, 'message')).toThrow(SANDBOX_MESSAGE);
    expect(() => add.call(g, 'messageerror')).toThrow(TypeError);
    add.call(g, 'error');
    expect((g as unknown as { added: string[] }).added ?? eventTarget.added).toContain('error');
  });

  it('ABI-16 a non-configurable global is reported as a sandbox gap', () => {
    const g: Record<string, unknown> = {};
    Object.defineProperty(g, 'fetch', { value: () => 1, configurable: false });
    const report = sandboxRealm(g);
    expect(report.failed).toContain('fetch');
  });
});
