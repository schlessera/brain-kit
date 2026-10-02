import { z } from "zod";
import type { ModuleSettingsField } from "./module-settings-types.js";

const text = z.string().min(1);
const path = z.string().regex(/^(?:[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)?$/);
const option = z.object({ value: z.string(), label: text, disabled: z.boolean().optional(), help: z.string().optional() }).strict();
const field: z.ZodType<ModuleSettingsField> = z.lazy(() => z.object({
  key: path, label: text,
  kind: z.enum(["text", "number", "toggle", "choice", "multichoice", "tags", "weights", "record", "list", "variant"]).optional(),
  help: z.string().optional(), group: text.optional(), order: z.number().optional(), unit: z.string().optional(), currency: text.optional(), minorUnits: z.boolean().optional(),
  min: z.number().optional(), max: z.number().optional(), step: z.number().positive().optional(), appliesAt: z.enum(["next-run", "restart"]).optional(),
  readOnly: z.object({ reason: text, whenInherited: z.boolean().optional() }).strict().optional(), options: z.array(option).optional(), fields: z.array(field).optional(),
  itemTitle: text.optional(), collapsible: z.boolean().optional(), orderMatters: z.boolean().optional(), minItems: z.number().int().nonnegative().optional(), uniqueBy: text.optional(), addLabel: text.optional(),
  variants: z.array(z.object({ key: text, label: text, fields: z.array(field) }).strict()).optional(), optional: z.object({ label: text, presentLabel: text.optional() }).strict().optional(), default: z.unknown().optional(),
}).strict().superRefine((value, ctx) => {
  if (!value.key && value.kind !== "variant") ctx.addIssue({ code: "custom", path: ["key"], message: "Only a record variant may use an empty key" });
}));
const callable = z.custom<(...args: never[]) => unknown>((value) => typeof value === "function", { message: "Expected a function" });
const description = z.object({
  fields: z.array(field),
  actions: z.array(z.object({ id: z.string().regex(/^[a-z][a-z0-9-]*$/), label: text, help: z.string(), command: z.array(text).min(1), confirm: text }).strict()).optional(),
  notes: callable.optional(),
  migration: z.object({ label: text, help: z.string().optional(), target: path.min(1).optional(), plan: callable }).strict().optional(),
}).strict();

export function validateSettingsMetadata(value: unknown, name: string): void {
  if (value === undefined) return;
  if (!/^[a-z][a-z0-9-]{0,30}$/.test(name)) throw new Error(`Module "${name}" settings require a lowercase module name`);
  const parsed = description.safeParse(value);
  if (!parsed.success) throw new Error(`Invalid settings description for module "${name}": ${parsed.error.message}`);
}
