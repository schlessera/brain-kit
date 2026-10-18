import { z } from "zod";
const id=z.string().regex(/^[a-z][a-z0-9-]*$/).max(80), text=z.string().min(1).max(2048);
const date=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value=>{const d=new Date(`${value}T00:00:00Z`);return Number.isFinite(d.getTime())&&d.toISOString().slice(0,10)===value;},"Expected a real ISO calendar date");
/** Optional family data extends, rather than replaces, the original nodes/edges grammar. */
export const axisSchema=z.discriminatedUnion("kind",[
 z.object({kind:z.literal("sequence"),messages:z.array(z.object({id,from:id,to:id,label:text,kind:z.enum(["message","return","async"]).optional(),focal:z.boolean().optional(),note:text.optional()}).strict()).max(4096),fragments:z.array(z.object({kind:z.enum(["alt","opt","loop"]),from:z.number().int().nonnegative(),to:z.number().int().nonnegative(),guard:text,elseAt:z.number().int().nonnegative().optional(),elseGuard:text.optional()}).strict()).max(1024).optional()}).strict(),
 z.object({kind:z.literal("swimlane"),lanes:z.array(z.object({id,label:text}).strict()).min(1).max(1024),steps:z.array(z.object({node:id,lane:id}).strict()).max(1024)}).strict(),
 z.object({kind:z.literal("timeline"),events:z.array(z.object({node:id,date}).strict()).min(1).max(1024)}).strict(),
 z.object({kind:z.literal("gantt"),tasks:z.array(z.object({node:id,start:date,end:date,phase:id.optional()}).strict()).min(1).max(1024),phases:z.array(z.object({id,label:text}).strict()).max(1024).optional(),marker:date.optional()}).strict(),
]);
export type AxisData=z.infer<typeof axisSchema>;
