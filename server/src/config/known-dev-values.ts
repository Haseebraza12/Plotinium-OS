/**
 * Values that must never be accepted as a secret in production (backend-api.md §3.4, SRV-02;
 * the deploy record's rule). Compared exactly after the trailing newline is removed.
 *
 * Add any value that ever appears in a tutorial, a test fixture, a screenshot or a chat message.
 * Tests use their own values and never these.
 */
export const KNOWN_DEV_VALUES: ReadonlySet<string> = new Set([
  '',
  'password',
  'Password1',
  'changeme',
  'change-me',
  'secret',
  'postgres',
  'plotinium',
  'plotinium_owner',
  'plotinium_app',
  'admin',
  'root',
  'test',
  'dev',
  'development',
  'example',
  '0000000000000000000000000000000000000000000000000000000000000000',
  'sk-ant-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
  'dev-only-not-a-secret-dev-only-not-a-secret',
]);
