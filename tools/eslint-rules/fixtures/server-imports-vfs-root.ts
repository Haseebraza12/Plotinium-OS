// lint-as: server/src/sync/fixture.ts
// expect: @typescript-eslint/no-restricted-imports
// The server may import only the isomorphic vfs/path and vfs/perm modules (ARC-01).
import { PACKAGE_NAME } from '@plotinium/vfs';

export const leaked = PACKAGE_NAME;
