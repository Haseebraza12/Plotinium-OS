/** Shared, environment-agnostic helpers of dsa/ (§3.4). Node-only memory measurement lives in bench/. */
export { DsaError, NotImplementedError } from './errors.ts';
export type { DsaErrorCode, DsaStats, OwnerRole } from './errors.ts';
export { mulberry32, randomInt } from './prng.ts';
export { percentile, sampleOps } from './sampler.ts';
export type { SampleOptions, SampleResult } from './sampler.ts';
