import { Syscall } from './typebox_schema.js'; import { Compile } from 'typebox/compile';
const C = Compile(Syscall);
export const validate = (m) => C.Check(m);
