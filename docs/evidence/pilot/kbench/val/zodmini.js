import * as z from 'zod/mini';
const Path = z.string().check(z.minLength(1), z.maxLength(4096));
const Id = z.int().check(z.nonnegative());
export const Syscall = z.discriminatedUnion('call', [
  z.object({ id: Id, call: z.literal('stat'), args: z.object({ path: Path, nofollow: z.optional(z.boolean()) }) }),
  z.object({ id: Id, call: z.literal('open'), args: z.object({ path: Path, flags: z.enum(['r', 'w', 'a', 'r+', 'w+']), mode: z.optional(z.int().check(z.minimum(0), z.maximum(0o7777))) }) }),
  z.object({ id: Id, call: z.literal('read'), args: z.object({ fd: Id, len: z.int().check(z.minimum(0), z.maximum(1 << 26)) }) }),
  z.object({ id: Id, call: z.literal('unlink'), args: z.object({ path: Path, recursive: z.optional(z.boolean()) }) }),
  z.object({ id: Id, call: z.literal('rename'), args: z.object({ from: Path, to: Path }) }),
  z.object({ id: Id, call: z.literal('chmod'), args: z.object({ path: Path, mode: z.string().check(z.regex(/^([0-7]{3,4}|[ugoa]*[+-=][rwxt]+)$/)), recursive: z.optional(z.boolean()) }) }),
  z.object({ id: Id, call: z.literal('spawn'), args: z.object({ image: Path, argv: z.array(z.string().check(z.maxLength(4096))).check(z.maxLength(256)), nice: z.optional(z.int().check(z.minimum(-20), z.maximum(19))) }) }),
  z.object({ id: Id, call: z.literal('kill'), args: z.object({ pid: z.int().check(z.positive()), signal: z.optional(z.enum(['TERM', 'KILL', 'STOP', 'CONT'])) }) }),
]);
export const validate = (m) => Syscall.safeParse(m).success;
export const toJSON = () => z.toJSONSchema(Syscall);
