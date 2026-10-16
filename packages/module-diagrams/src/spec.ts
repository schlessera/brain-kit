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
const common = {
  layouts: z.object({ narrow }).strict().optional(),
  schema_version: z.literal(1), title: z.string().min(1).max(60), desc: text,
  size: z.enum(DIAGRAM_SIZES), link: link.optional(),
  groups: z.array(z.object({ id, label: text, members: z.array(id).min(1).max(1024) }).strict()).max(1024).optional(),
  edges: z.array(z.object({ id: id.optional(), from: id, to: id, label: text.optional(),
    kind: z.enum(["primary", "link", "default", "async"]).optional() }).strict()).max(4096),
  focal: z.array(id).max(2, "At most two focal elements are allowed").optional(),
  callouts: z.array(z.object({ target: id, text }).strict()).max(1024).optional(),
};
export const diagramSpecSchema = z.discriminatedUnion("type", [
  z.object({ ...common, type: z.literal(FREE_LAYOUT_TYPES), nodes: z.array(freeNode).max(1024) }).strict(),
  z.object({ ...common, type: z.literal(AXIS_TYPES), axis: axisSchema.optional(), nodes: z.array(node).max(1024) }).strict(),
  z.object({ ...common, type: z.literal(FIXED_LAYOUT_TYPES), nodes: z.array(node).max(1024) }).strict(),
]);
export type DiagramSpec = z.infer<typeof diagramSpecSchema>;
/** Structural schema; reference, focal-role and geometry rules are checked separately. */
export const diagramSpecJsonSchema = z.toJSONSchema(diagramSpecSchema, { target: "draft-2020-12", io: "input" });
