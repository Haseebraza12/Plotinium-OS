import * as v from 'valibot';
const Path = v.pipe(v.string(), v.minLength(1), v.maxLength(4096));
const Id = v.pipe(v.number(), v.integer(), v.minValue(0));
export const Syscall = v.variant('call', [
  v.object({ id: Id, call: v.literal('stat'), args: v.object({ path: Path, nofollow: v.optional(v.boolean()) }) }),
  v.object({ id: Id, call: v.literal('open'), args: v.object({ path: Path, flags: v.picklist(['r', 'w', 'a', 'r+', 'w+']), mode: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(0o7777))) }) }),
  v.object({ id: Id, call: v.literal('read'), args: v.object({ fd: Id, len: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(1 << 26)) }) }),
  v.object({ id: Id, call: v.literal('unlink'), args: v.object({ path: Path, recursive: v.optional(v.boolean()) }) }),
  v.object({ id: Id, call: v.literal('rename'), args: v.object({ from: Path, to: Path }) }),
  v.object({ id: Id, call: v.literal('chmod'), args: v.object({ path: Path, mode: v.pipe(v.string(), v.regex(/^([0-7]{3,4}|[ugoa]*[+-=][rwxt]+)$/)), recursive: v.optional(v.boolean()) }) }),
  v.object({ id: Id, call: v.literal('spawn'), args: v.object({ image: Path, argv: v.pipe(v.array(v.pipe(v.string(), v.maxLength(4096))), v.maxLength(256)), nice: v.optional(v.pipe(v.number(), v.integer(), v.minValue(-20), v.maxValue(19))) }) }),
  v.object({ id: Id, call: v.literal('kill'), args: v.object({ pid: v.pipe(v.number(), v.integer(), v.minValue(1)), signal: v.optional(v.picklist(['TERM', 'KILL', 'STOP', 'CONT'])) }) }),
]);
export const validate = (m) => v.safeParse(Syscall, m).success;
