// lint-as: apps/files/fixture.ts
// expect: no-restricted-properties
// Apps may not reach OPFS directly (SYS-01).
export const root = navigator.storage.getDirectory();
