import { z } from 'zod';
const A = z.object({ call: z.literal('mkdir'), path: z.string() });
const B = z.object({ call: z.literal('unlink'), path: z.string(), recursive: z.boolean().nullable() });
console.log(JSON.stringify(z.toJSONSchema(z.discriminatedUnion('call',[A,B]))).slice(0,200));
console.log(JSON.stringify(z.toJSONSchema(z.union([A,B]))).slice(0,400));
console.log(JSON.stringify(z.toJSONSchema(z.object({steps: z.array(A).max(25)}))));
