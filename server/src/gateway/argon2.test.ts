import { describe, expect, it } from 'vitest';

import {
  argon2Available,
  hashPassword,
  needsRehash,
  parsePhc,
  Semaphore,
  verifyPassword,
} from './argon2.ts';

describe.runIf(argon2Available())(
  'OFF-03 Argon2id password hashing (backend-api.md §3.8.5)',
  () => {
    it('OFF-03 a hash is a PHC Argon2id string with the OWASP parameters and never contains the password', async () => {
      const phc = await hashPassword('correct horse battery staple');
      expect(phc).toMatch(
        /^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/,
      );
      expect(phc).not.toContain('horse');
      expect(parsePhc(phc)?.salt.length).toBe(16);
      expect(needsRehash(phc)).toBe(false);
    });

    it('OFF-03 verification accepts the password, refuses others and treats a locked or malformed hash as a mismatch', async () => {
      const phc = await hashPassword('s3cret-pass', { pepper: 'p'.repeat(32) });
      expect(await verifyPassword(phc, 's3cret-pass', { pepper: 'p'.repeat(32) })).toBe(true);
      expect(await verifyPassword(phc, 's3cret-pass')).toBe(false); // the pepper is part of the hash
      expect(await verifyPassword(phc, 'wrong')).toBe(false);
      expect(await verifyPassword('!', 'anything')).toBe(false);
      expect(await verifyPassword('$argon2id$v=19$m=1,t=1,p=1$AAAA$AAAA', 'x')).toBe(false);
      expect(
        needsRehash(
          '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHRzYWx0c2FsdA$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g',
        ),
      ).toBe(true);
    });

    it('SEC-06 at most two hashes run at once under the semaphore', async () => {
      const sem = new Semaphore(2);
      let running = 0;
      let peak = 0;
      const task = () =>
        sem.run(async () => {
          running++;
          peak = Math.max(peak, running);
          await new Promise((r) => setTimeout(r, 5));
          running--;
          return 1;
        });
      const results = await Promise.all(Array.from({ length: 8 }, task));
      expect(results).toHaveLength(8);
      expect(peak).toBe(2);
      expect(sem.active).toBe(0);
      expect(sem.waiting).toBe(0);
    });
  },
);
