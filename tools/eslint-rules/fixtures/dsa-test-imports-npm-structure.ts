// lint-as: dsa/src/heap/heap.test.ts
// expect: @typescript-eslint/no-restricted-imports
// No package may stand in for a mandatory structure, not even as a test oracle (spec §10.2, C16).
import Heap from 'heap-js';

export const oracle = new Heap();
