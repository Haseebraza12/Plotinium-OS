// lint-as: apps/files/fixture.ts
// expect: local/no-relative-import-outside-package
// A relative path must not bypass the package boundary rules (SYS-01).
import { PACKAGE_NAME } from '../../vfs/src/index.ts';

export const leaked = PACKAGE_NAME;
