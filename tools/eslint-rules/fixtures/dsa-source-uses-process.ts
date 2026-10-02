// lint-as: dsa/src/lru/lru.ts
// expect: no-restricted-globals
// dsa/ source runs in the kernel worker, on the main thread and on Node: no Node globals (ARC-01).
export const pid = process.pid;
