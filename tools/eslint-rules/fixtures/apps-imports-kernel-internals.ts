// lint-as: apps/terminal/fixture.ts
// expect: @typescript-eslint/no-restricted-imports
// An app may not import the kernel package itself, only @plotinium/kernel/sys (SYS-01).
import { PACKAGE_NAME } from '@plotinium/kernel';

export const leaked = PACKAGE_NAME;
