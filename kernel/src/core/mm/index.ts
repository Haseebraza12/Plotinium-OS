/**
 * kernel/src/core/mm: the memory manager (specs/03-kernel/memory-and-paging.md).
 *
 * Primary owner: R1 Kernel. Secondary reviewer: R2 VFS/DB.
 * Requirement IDs: MEM-01…MEM-07, WM-05 (paging side); Plotinium design KMM-01…KMM-14.
 * Environment-free: no self, document, Worker or indexedDB (ESLint-enforced); the host injects
 * the executor port, the swap devices (kernel/src/blkio) and the clock.
 */
export * from './accounting.ts';
export * from './codec.ts';
export * from './errors.ts';
export * from './lru.ts';
export * from './mm.ts';
export * from './params.ts';
export * from './reclaim.ts';
export * from './remote.ts';
export * from './reserve.ts';
export * from './stats.ts';
export * from './swap.ts';
export * from './thrash.ts';
export * from './types.ts';
export * from './writebehind.ts';
