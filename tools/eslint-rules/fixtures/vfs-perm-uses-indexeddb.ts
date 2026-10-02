// lint-as: vfs/src/perm.ts
// expect: no-restricted-globals
// vfs/src/perm.ts also runs on the Node server: no DOM or worker globals (ARC-01, boundary B3).
export const request = indexedDB.open('plotinium');
