// lint-as: apps/editor/fixture.ts
// expect: no-restricted-globals
// Apps may not open storage directly; they use system calls (SYS-01).
export const request = indexedDB.open('plotinium');
