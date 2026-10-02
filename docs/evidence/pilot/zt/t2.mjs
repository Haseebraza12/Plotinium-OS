import { z } from "zod";
const A = z.strictObject({ call: z.literal("mkdir"), path: z.string() });
const B = z.strictObject({ call: z.literal("unlink"), path: z.string(), recursive: z.boolean() });
const s = z.toJSONSchema(z.strictObject({ steps: z.array(z.union([A, B])), n: z.string().nullable() }));
console.log(JSON.stringify(s));
