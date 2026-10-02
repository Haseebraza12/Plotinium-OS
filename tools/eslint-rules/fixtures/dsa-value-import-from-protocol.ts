// lint-as: dsa/src/heap/fixture.ts
// expect: @typescript-eslint/no-restricted-imports
// dsa/ may import only TYPES from @plotinium/protocol (ARC-01, C16).
import { PACKAGE_NAME } from '@plotinium/protocol';

export const leaked = PACKAGE_NAME;
