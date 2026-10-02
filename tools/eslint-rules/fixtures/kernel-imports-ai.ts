// lint-as: kernel/src/core/sched/fixture.ts
// expect: @typescript-eslint/no-restricted-imports
// The kernel reaches AI only through no-op hooks, so the litmus build still works (ARC-01, C12).
import { PACKAGE_NAME } from '@plotinium/ai';

export const leaked = PACKAGE_NAME;
