import * as z from 'zod';
const Path = z.string().min(1).max(4096);
export const Syscall = z.discriminatedUnion('call', [
  z.object({ id: z.int().nonnegative(), call: z.literal('stat'), args: z.object({ path: Path, nofollow: z.boolean().optional() }) }),
  z.object({ id: z.int().nonnegative(), call: z.literal('open'), args: z.object({ path: Path, flags: z.enum(['r', 'w', 'a', 'r+', 'w+']), mode: z.int().min(0).max(0o7777).optional() }) }),
  z.object({ id: z.int().nonnegative(), call: z.literal('read'), args: z.object({ fd: z.int().nonnegative(), len: z.int().min(0).max(1 << 26) }) }),
  z.object({ id: z.int().nonnegative(), call: z.literal('unlink'), args: z.object({ path: Path, recursive: z.boolean().optional() }) }),
  z.object({ id: z.int().nonnegative(), call: z.literal('rename'), args: z.object({ from: Path, to: Path }) }),
  z.object({ id: z.int().nonnegative(), call: z.literal('chmod'), args: z.object({ path: Path, mode: z.string().regex(/^([0-7]{3,4}|[ugoa]*[+-=][rwxt]+)$/), recursive: z.boolean().optional() }) }),
  z.object({ id: z.int().nonnegative(), call: z.literal('spawn'), args: z.object({ image: Path, argv: z.array(z.string().max(4096)).max(256), nice: z.int().min(-20).max(19).optional() }) }),
  z.object({ id: z.int().nonnegative(), call: z.literal('kill'), args: z.object({ pid: z.int().positive(), signal: z.enum(['TERM', 'KILL', 'STOP', 'CONT']).optional() }) }),
]);
export const validate = (m) => Syscall.safeParse(m).success;
export const toJSON = () => z.toJSONSchema(Syscall);
