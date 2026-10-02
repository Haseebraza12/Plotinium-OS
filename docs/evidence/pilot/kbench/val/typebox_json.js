import { Syscall } from './typebox_schema.js';
export const toJSON = () => JSON.parse(JSON.stringify(Syscall));
