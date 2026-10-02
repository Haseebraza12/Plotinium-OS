import { Syscall } from './typebox_schema.js'; import Value from 'typebox/value';
export const validate = (m) => Value.Check(Syscall, m);
