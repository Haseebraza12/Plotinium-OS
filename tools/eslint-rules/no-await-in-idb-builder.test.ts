import { describe, expect, it } from 'vitest';

import { lintWithRule } from './test-utils.ts';

const RULE = 'no-await-in-idb-builder';
const ID = `local/${RULE}`;

const PRELUDE = `declare function tx(stores: string[], build: (t: IDBTransaction) => unknown): void;
declare function load(): Promise<number>;
`;

function messageIds(code: string, options: unknown[] = []): string[] {
  return lintWithRule(RULE, PRELUDE + code, 'vfs/src/store/test-snippet.ts', options)
    .filter((message) => message.ruleId === ID)
    .map((message) => message.messageId ?? '');
}

describe('local/no-await-in-idb-builder', () => {
  it('DB-02 accepts a synchronous builder that only issues requests', () => {
    const code = `tx(['inodes', 'users'], (t) => {
      const req = t.objectStore('inodes').put({ ino: '1' });
      req.onsuccess = () => { t.objectStore('users').put({ uid: 1 }); };
    });`;
    expect(messageIds(code)).toEqual([]);
  });

  it('DB-02 reports an async builder and every await inside it', () => {
    const code = `tx(['users'], async (t) => {
      const q = await load();
      t.objectStore('users').put({ q });
    });`;
    expect(messageIds(code)).toEqual(['asyncBuilder', 'await']);
  });

  it('DB-02 reports promise continuations inside a builder', () => {
    const code = `tx(['users'], (t) => { void load().then((q) => t.objectStore('users').put({ q })); });`;
    expect(messageIds(code)).toEqual(['promiseChain']);
  });

  it('DB-02 reports async callbacks and for-await nested inside a builder', () => {
    const code = `tx(['inodes'], (t) => {
      const req = t.objectStore('inodes').get('1');
      req.onsuccess = async () => { for await (const x of [load()]) { void x; } };
    });`;
    expect(messageIds(code)).toEqual(['nestedAsync', 'forAwait']);
  });

  it('DB-02 follows a builder passed by name to a function declared in the same file', () => {
    const code = `async function build(t: IDBTransaction) { await load(); t.abort(); }
      tx(['inodes'], build);`;
    expect(messageIds(code)).toEqual(['asyncBuilder', 'await']);
  });

  it('DB-02 ignores awaits outside builders, such as the planning phase', () => {
    const code = `async function plan() { const q = await load(); tx(['users'], (t) => { t.objectStore('users').put({ q }); }); }
      void plan();`;
    expect(messageIds(code)).toEqual([]);
  });

  it('DB-02 checks extra builder entry points given in the callees option', () => {
    const code = `declare const store: { batch(build: (t: IDBTransaction) => void): void };
      store.batch(async (t) => { await load(); t.abort(); });`;
    expect(messageIds(code, [{ callees: ['tx', 'batch'] }])).toEqual(['asyncBuilder', 'await']);
    expect(messageIds(code)).toEqual([]);
  });
});
