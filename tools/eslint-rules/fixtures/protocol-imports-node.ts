// lint-as: protocol/src/fixture.ts
// expect: @typescript-eslint/no-restricted-imports
// protocol/ is pure: valibot and its own modules only (ARC-01).
import { readFileSync } from 'node:fs';

export const read = readFileSync;
