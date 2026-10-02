/**
 * Known-answer self-tests run at startup (SRV-17; backend-api.md §3.18.2). A failure stops the
 * process with exit code 70 and a log line naming the failed test.
 */
import { createHash } from 'node:crypto';

import { argon2Available, argon2id } from '../gateway/argon2.ts';

/** RFC 9106 §5.3 Argon2id test vector (reproduced with crypto.argon2Sync on Node 24.13.1). */
export const ARGON2ID_KAT = {
  message: Buffer.alloc(32, 0x01),
  nonce: Buffer.alloc(16, 0x02),
  secret: Buffer.alloc(8, 0x03),
  associatedData: Buffer.alloc(12, 0x04),
  passes: 3,
  memory: 32,
  parallelism: 4,
  tagLength: 32,
  expected: '0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659',
} as const;

/** FIPS 180-2 example: SHA-256("abc"). */
export const SHA256_KAT = {
  input: 'abc',
  expected: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
} as const;

export class SelfTestError extends Error {
  readonly test: string;
  constructor(test: string, message: string) {
    super(`self-test ${test} failed: ${message}`);
    this.name = 'SelfTestError';
    this.test = test;
  }
}

export async function argon2KnownAnswer(expected: string = ARGON2ID_KAT.expected): Promise<void> {
  if (!argon2Available()) {
    throw new SelfTestError(
      'argon2-kat',
      'node:crypto argon2 is not available (ERR_CRYPTO_ARGON2_NOT_SUPPORTED): run Node >= 24.7 built against OpenSSL >= 3.2, for example the node:24-trixie-slim image',
    );
  }
  const { expected: _vector, ...params } = ARGON2ID_KAT;
  const tag = (await argon2id(params)).toString('hex');
  if (tag !== expected)
    throw new SelfTestError('argon2-kat', 'the RFC 9106 Argon2id vector does not match');
}

export function sha256KnownAnswer(expected: string = SHA256_KAT.expected): void {
  const got = createHash('sha256').update(SHA256_KAT.input).digest('hex');
  if (got !== expected)
    throw new SelfTestError('sha256-kat', 'SHA-256("abc") does not match FIPS 180-2');
}
