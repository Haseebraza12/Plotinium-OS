import { Syscall } from './valibot.js'; import { toJsonSchema } from '@valibot/to-json-schema';
export const toJSON = () => toJsonSchema(Syscall);
