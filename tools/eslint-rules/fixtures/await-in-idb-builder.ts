// lint-as: vfs/src/store/fixture.ts
// expect: local/no-await-in-idb-builder
// Awaiting inside the transaction builder lets IndexedDB commit half-way (C4, DB-02).
declare function tx(stores: string[], build: (t: IDBTransaction) => void): void;
declare function fetchQuota(): Promise<number>;

tx(['inodes', 'users'], async (t) => {
  const quota = await fetchQuota();
  t.objectStore('users').put({ quota });
});
