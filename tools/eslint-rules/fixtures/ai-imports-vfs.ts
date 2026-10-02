// lint-as: ai/src/agent/fixture.ts
// expect: @typescript-eslint/no-restricted-imports
// The agent acts through typed system calls, never through VFS internals (ARC-01, C12).
import { PACKAGE_NAME } from '@plotinium/vfs';

export const leaked = PACKAGE_NAME;
