// lint-as: ui/src/apps/files/fixture.ts
// expect: @typescript-eslint/no-restricted-imports
// ui/ is presentational: its data arrives through props, never through a system call (SYS-01).
import { SYS_CLIENT_PLACEHOLDER } from '@plotinium/kernel/sys';

export const leaked = SYS_CLIENT_PLACEHOLDER;
