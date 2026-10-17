import { positionalSchema } from "./positional-spec.js";
import { z } from "zod";
import { axisSchema } from "./axis-spec.js";

/** Common v1 grammar. Type-specific content fields are added by their family. */
export const FREE_LAYOUT_TYPES = ["architecture", "flowchart", "state-machine", "tree", "er", "dependency"] as const;
export const AXIS_TYPES = ["sequence", "swimlane", "timeline", "gantt"] as const;
export const FIXED_LAYOUT_TYPES = ["quadrant", "layer-stack", "pyramid", "funnel", "loop", "flywheel", "venn"] as const;
export const DIAGRAM_SIZES = ["doc-inline", "doc-wide", "slide-16x9", "slide-4x3", "social-og", "social-square", "print-a4-landscape", "print-a3-landscape", "print-letter-landscape", "fit"] as const;
const id = z.string().regex(/^[a-z][a-z0-9-]*$/).max(80);
const text = z.string().min(1).max(2048);
const link = z.string().max(2048).regex(/^\[\[[^\[\]\r\n]+\]\]$/, "Expected an internal [[wiki-link]]");
const node = z.object({ id, label: text, sub: text.optional(), tag: text.optional(),
  role: z.enum(["focal", "default", "store", "external", "input", "optional", "boundary"]).optional(), link: link.optional() }).strict();
const position = z.tuple([z.number().nonnegative(), z.number().nonnegative()]);
const dimensions = z.tuple([z.number().positive(), z.number().positive()]);
const freeNode = node.extend({ at: position, size: dimensions }).strict();
const narrow = z.object({ width: z.literal(320), height: z.number().positive().max(16384), nodes: z.array(z.object({ id, at: position, size: dimensions }).strict()).max(1024) }).strict();
const edge = z.object({ id: id.optional(), from: id, to: id, label: text.optional(), kind: z.enum(["primary", "link", "default", "async"]).optional() }).strict();
const field = z.object({ name: text, type: text.optional(), key: z.enum(["PK", "FK"]).optional() }).strict();
const common = {
  id: id.optional(),
  layouts: z.object({ narrow }).strict().optional(),
  schema_version: z.literal(1), title: z.string().min(1).max(60), desc: text,
  size: z.enum(DIAGRAM_SIZES), link: link.optional(),
  groups: z.array(z.object({ id, label: text, members: z.array(id).min(1).max(1024) }).strict()).max(1024).optional(),
  edges: z.array(edge).max(4096),
  focal: z.array(id).max(2, "At most two focal elements are allowed").optional(),
  callouts: z.array(z.object({ target: id, text }).strict()).max(1024).optional(),
};
export const diagramSpecSchema = z.discriminatedUnion("type", [
  z.object({ ...common, type: z.literal("architecture"), nodes: z.array(freeNode.extend({ kind: z.enum(["compute", "endpoint", "managed"]).optional(), parent: id.optional(), target: id.optional() }).strict()).max(1024), edges: z.array(edge.extend({ peering: z.boolean().optional() }).strict()).max(4096), containment: z.object({ scopes: z.array(z.object({ id, label: text, kind: z.enum(["admin", "traffic"]), parent: id.optional(), at: position, size: dimensions }).strict()).min(1).max(1024) }).strict().optional() }).strict(),
  z.object({ ...common, type: z.literal("flowchart"), nodes: z.array(freeNode.extend({ shape: z.enum(["start", "end", "step", "decision", "merge"]).optional() }).strict()).max(1024) }).strict(),
  z.object({ ...common, type: z.literal("state-machine"), nodes: z.array(freeNode.extend({ shape: z.enum(["state", "initial", "final"]).optional() }).strict()).max(1024) }).strict(),
  z.object({ ...common, type: z.literal("tree"), hierarchy: z.literal(true).optional(), direction: z.enum(["down", "right"]).optional(), nodes: z.array(freeNode).max(1024) }).strict(),
  z.object({ ...common, type: z.literal("er"), nodes: z.array(freeNode.extend({ fields: z.array(field).max(1024).optional() }).strict()).max(1024), edges: z.array(edge.extend({ fromCardinality: z.enum(["1", "N", "0..1", "1..*"]).optional(), toCardinality: z.enum(["1", "N", "0..1", "1..*"]).optional() }).strict()).max(4096) }).strict(),
  z.object({ ...common, type: z.literal("dependency"), nodes: z.array(freeNode.extend({ rank: z.number().int().nonnegative().max(1024).optional() }).strict()).max(1024), edges: z.array(edge.extend({ cycle: z.boolean().optional() }).strict()).max(4096) }).strict(),
  z.object({ ...common, type: z.literal(AXIS_TYPES), axis: axisSchema.optional(), nodes: z.array(node).max(1024) }).strict(),
  z.object({ ...common, type: z.literal(FIXED_LAYOUT_TYPES), positional: positionalSchema.optional(), nodes: z.array(node).max(1024) }).strict(),
]);
export type DiagramSpec = z.infer<typeof diagramSpecSchema>;
/** Structural schema; reference, focal-role and geometry rules are checked separately. */
export const diagramSpecJsonSchema = z.toJSONSchema(diagramSpecSchema, { target: "draft-2020-12", io: "input" });
