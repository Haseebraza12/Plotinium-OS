// lint-as: web/src/fixture.ts
// expect: @typescript-eslint/no-restricted-imports
// Server code must never reach the client bundle (ARC-01, spec §12.6 key handling).
import { PACKAGE_NAME } from '@plotinium/server';

export const leaked = PACKAGE_NAME;
