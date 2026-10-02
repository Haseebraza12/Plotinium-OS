/**
 * Deterministic test time (spec TST-22): AI tests run on this frozen clock and every seeded
 * generator starts from seed 42 (see rng.ts).
 */
export const FROZEN_CLOCK_ISO = '2026-10-05T10:00:00+05:00';
export const FROZEN_CLOCK_MS = Date.parse(FROZEN_CLOCK_ISO);
