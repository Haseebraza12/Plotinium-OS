import { type } from 'arktype';
const Id = 'number.integer >= 0';
export const Syscall = type.or(
  { id: Id, call: "'stat'", args: { path: '0 < string <= 4096', 'nofollow?': 'boolean' } },
  { id: Id, call: "'open'", args: { path: '0 < string <= 4096', flags: "'r'|'w'|'a'|'r+'|'w+'", 'mode?': '0 <= number.integer <= 4095' } },
  { id: Id, call: "'read'", args: { fd: Id, len: '0 <= number.integer <= 67108864' } },
  { id: Id, call: "'unlink'", args: { path: '0 < string <= 4096', 'recursive?': 'boolean' } },
  { id: Id, call: "'rename'", args: { from: '0 < string <= 4096', to: '0 < string <= 4096' } },
  { id: Id, call: "'chmod'", args: { path: '0 < string <= 4096', mode: /^([0-7]{3,4}|[ugoa]*[+-=][rwxt]+)$/, 'recursive?': 'boolean' } },
  { id: Id, call: "'spawn'", args: { image: '0 < string <= 4096', argv: 'string[] <= 256', 'nice?': '-20 <= number.integer <= 19' } },
  { id: Id, call: "'kill'", args: { pid: 'number.integer > 0', 'signal?': "'TERM'|'KILL'|'STOP'|'CONT'" } },
);
export const validate = (m) => !(Syscall(m) instanceof type.errors);
export const toJSON = () => Syscall.toJsonSchema();
