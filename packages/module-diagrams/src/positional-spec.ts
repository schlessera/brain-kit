import { z } from "zod";
const id=z.string().regex(/^[a-z][a-z0-9-]*$/).max(80), text=z.string().min(1).max(2048), axis=z.object({negative:text,positive:text}).strict();
/** Additive typed content; common semantic nodes remain the single source of identity. */
export const positionalSchema=z.object({
 quadrant:z.object({xAxis:axis,yAxis:axis,points:z.array(z.object({node:id,x:z.number().min(-1).max(1),y:z.number().min(-1).max(1)}).strict()).max(1024)}).strict().optional(),
 stack:z.object({order:z.array(id).max(1024).optional(),direction:z.enum(["up","down"]).optional(),directionLabel:text.optional()}).strict().optional(),
 pyramid:z.object({layers:z.array(z.object({node:id,value:z.number().positive().optional(),annotation:text.optional()}).strict()).max(1024)}).strict().optional(),
 loop:z.object({hub:id,stations:z.array(id).max(1024),spokeLabels:z.array(z.object({station:id,text}).strict()).max(1024).optional()}).strict().optional(),
 venn:z.object({sets:z.array(z.object({node:id,weight:z.number().positive().optional()}).strict()).max(1024),intersections:z.array(z.object({members:z.array(id).min(2).max(3),label:text,focal:z.boolean().optional()}).strict()).max(1024).optional()}).strict().optional(),
}).strict();
export type PositionalSpec=z.infer<typeof positionalSchema>;
