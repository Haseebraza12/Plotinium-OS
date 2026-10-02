import Type from 'typebox';
const Path = Type.String({ minLength: 1, maxLength: 4096 }); const Id = Type.Integer({ minimum: 0 });
export const Syscall = Type.Union([
  Type.Object({ id: Id, call: Type.Literal('stat'), args: Type.Object({ path: Path, nofollow: Type.Optional(Type.Boolean()) }) }),
  Type.Object({ id: Id, call: Type.Literal('open'), args: Type.Object({ path: Path, flags: Type.Union(['r', 'w', 'a', 'r+', 'w+'].map(x => Type.Literal(x))), mode: Type.Optional(Type.Integer({ minimum: 0, maximum: 4095 })) }) }),
  Type.Object({ id: Id, call: Type.Literal('read'), args: Type.Object({ fd: Id, len: Type.Integer({ minimum: 0, maximum: 67108864 }) }) }),
  Type.Object({ id: Id, call: Type.Literal('unlink'), args: Type.Object({ path: Path, recursive: Type.Optional(Type.Boolean()) }) }),
  Type.Object({ id: Id, call: Type.Literal('rename'), args: Type.Object({ from: Path, to: Path }) }),
  Type.Object({ id: Id, call: Type.Literal('chmod'), args: Type.Object({ path: Path, mode: Type.String({ pattern: '^([0-7]{3,4}|[ugoa]*[+-=][rwxt]+)$' }), recursive: Type.Optional(Type.Boolean()) }) }),
  Type.Object({ id: Id, call: Type.Literal('spawn'), args: Type.Object({ image: Path, argv: Type.Array(Type.String({ maxLength: 4096 }), { maxItems: 256 }), nice: Type.Optional(Type.Integer({ minimum: -20, maximum: 19 })) }) }),
  Type.Object({ id: Id, call: Type.Literal('kill'), args: Type.Object({ pid: Type.Integer({ minimum: 1 }), signal: Type.Optional(Type.Union(['TERM', 'KILL', 'STOP', 'CONT'].map(x => Type.Literal(x)))) }) }),
]);
